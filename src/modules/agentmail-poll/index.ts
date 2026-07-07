import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { onShutdown } from '../../index.js';

const BASE_URL = 'https://api.agentmail.to/v0';
let pollInterval: NodeJS.Timeout | null = null;

interface Inbox {
  inbox_id: string;
  email: string;
}

interface Thread {
  thread_id: string;
  subject?: string;
  timestamp?: string;
  senders?: string[];
  preview?: string;
}

interface Message {
  message_id: string;
  from?: string;
  to?: string[];
  preview?: string;
  timestamp?: string;
}

function getAdminAgent(): { id: string; folder: string } | undefined {
  const row = getDb()
    .prepare(
      `SELECT ag.id, ag.folder FROM agent_groups ag
         JOIN container_configs cc ON cc.agent_group_id = ag.id
        WHERE cc.cli_scope = 'global'
        LIMIT 1`,
    )
    .get() as { id: string; folder: string } | undefined;
  return row;
}

function isThreadProcessed(threadId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM processed_email_threads WHERE thread_id = ?').get(threadId);
  return row !== undefined;
}

function markThreadProcessed(threadId: string, subject: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO processed_email_threads (thread_id, subject, processed_at) VALUES (?, ?, ?)')
    .run(threadId, subject, new Date().toISOString());
}

export function isMOHMediaReportSubject(subject: string): boolean {
  let clean = subject.trim().toLowerCase();
  let stripped = true;
  while (stripped) {
    stripped = false;
    const prefixes = ['fw:', 'fwd:', 're:', '[fw:]', '[fwd:]', '[re:]', '[external]'];
    for (const prefix of prefixes) {
      if (clean.startsWith(prefix)) {
        clean = clean.slice(prefix.length).trim();
        stripped = true;
      }
    }
  }
  return clean.startsWith('moh media report');
}

export interface ParsedArticle {
  category: string;
  title: string;
  cleanLink: string;
  linkText: string;
  description: string;
  number?: string;
}

export interface ParsedReport {
  date: string;
  formattedDate: string;
  sections: {
    category: string;
    articles: ParsedArticle[];
  }[];
}

export function cleanUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    const nestedUrl = url.searchParams.get('url');
    if (nestedUrl) {
      return decodeURIComponent(nestedUrl);
    }
  } catch {
    // Ignore and return original
  }
  return urlStr;
}

export function cleanAllLinksInText(text: string): string {
  let cleaned = text.replace(/<(https?:\/\/[^>]+)>/g, (match, url) => {
    return `<${cleanUrl(url)}>`;
  });
  cleaned = cleaned.replace(/(?<!<)(https?:\/\/[^\s\)]+)/g, (match, url) => {
    return cleanUrl(url);
  });
  return cleaned;
}

export function extractReportDate(text: string, subject: string): string {
  const candidates = [subject, text];
  for (const candidate of candidates) {
    const match = candidate.match(
      /MOH\s+Media\s+Report\s+(?:Test\s+)?(?:(?:[\(\[])?\s*(?:\d{1,2}\s*[-–—]\s*)?(\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{1,2}\s+[A-Za-z]+)\b)/i,
    );
    if (match) {
      return match[1].trim();
    }
  }
  return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateToYYYYMMDD(dateStr: string): string {
  try {
    const clean = dateStr.replace(/[\(\)\[\]]/g, '').trim();
    const months: Record<string, string> = {
      jan: '01',
      feb: '02',
      mar: '03',
      apr: '04',
      may: '05',
      jun: '06',
      jul: '07',
      aug: '08',
      sep: '09',
      oct: '10',
      nov: '11',
      dec: '12',
      january: '01',
      february: '02',
      march: '03',
      april: '04',
      june: '06',
      july: '07',
      august: '08',
      september: '09',
      october: '10',
      november: '11',
      december: '12',
    };
    const parts = clean.split(/\s+/);
    const day = parts[0].padStart(2, '0');
    const monthName = parts[1].toLowerCase();
    const month = months[monthName] || '01';
    let year = parts[2] || new Date().getFullYear().toString();
    if (year.length === 2) year = '20' + year;
    return `${year}-${month}-${day}`;
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 50) return false;
  if (!/^[A-Z0-9\s&\-\/]+$/.test(trimmed)) return false;
  const excludes = ['FW', 'FWD', 'RE', 'FROM', 'TO', 'DATE', 'SUBJECT', 'MOH MEDIA REPORT'];
  if (excludes.includes(trimmed)) return false;
  return true;
}

export function parseMOHMediaReport(text: string, subject: string): ParsedReport {
  const lines = text.split('\n');
  const reportDateStr = extractReportDate(text, subject);
  const formattedDate = formatDateToYYYYMMDD(reportDateStr);

  const sections: { category: string; articles: ParsedArticle[] }[] = [];
  let currentCategory = '';
  let currentArticles: ParsedArticle[] = [];

  const flushSection = () => {
    if (currentCategory && currentArticles.length > 0) {
      sections.push({ category: currentCategory, articles: [...currentArticles] });
    }
    currentArticles = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (isHeading(line)) {
      flushSection();
      currentCategory = line;
      i++;
      continue;
    }

    if (currentCategory) {
      const numberedMatch = line.match(/^(\d+)\)\s*(.*)/);
      const isNumbered = !!numberedMatch;
      const hasLink = line.includes('http://') || line.includes('https://') || line.includes('<http');

      if (isNumbered || (hasLink && line.length > 15)) {
        const articleLine = isNumbered ? numberedMatch![2].trim() : line;
        const number = isNumbered ? numberedMatch![1] : undefined;

        let titleText = articleLine;
        let cleanLink = '';
        let linkText = '';

        const urlMatch = articleLine.match(/(.*?)<(https?:\/\/[^>]+)>(.*)/);
        if (urlMatch) {
          titleText = urlMatch[1].trim();
          cleanLink = cleanUrl(urlMatch[2].trim());
          const rest = urlMatch[3].trim();
          const sourceMatch = rest.match(/^\(([^)]+)\)/) || rest.match(/^([^)]+)/);
          if (sourceMatch) {
            linkText = sourceMatch[1].trim();
          }
        }

        let description = '';
        i++;

        while (i < lines.length) {
          const nextRawLine = lines[i];
          const nextLine = nextRawLine.trim();

          if (isHeading(nextLine)) {
            break;
          }

          if (nextLine.match(/^\d+\)\s+/)) {
            break;
          }

          const nextHasLink =
            nextLine.includes('http://') || nextLine.includes('https://') || nextLine.includes('<http');
          if (nextHasLink) {
            if (!isNumbered && nextLine.length > 15) {
              break;
            }
            i++;
            continue;
          }

          if (nextLine !== '') {
            description += (description ? '\n' : '') + nextRawLine;
          } else if (description !== '') {
            let lookAhead = i + 1;
            let peekLine = '';
            while (lookAhead < lines.length && peekLine === '') {
              peekLine = lines[lookAhead].trim();
              lookAhead++;
            }
            if (
              isHeading(peekLine) ||
              peekLine.match(/^\d+\)\s+/) ||
              (!isNumbered && peekLine.includes('<http') && peekLine.length > 15)
            ) {
              break;
            }
            description += '\n';
          }
          i++;
        }

        currentArticles.push({
          category: currentCategory,
          title: titleText,
          cleanLink,
          linkText,
          description: cleanAllLinksInText(description).trim(),
          number,
        });

        continue;
      }
    }
    i++;
  }

  flushSection();

  return {
    date: reportDateStr,
    formattedDate,
    sections,
  };
}

async function fetchJson<T = any>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function pollInbox(apiKey: string, email: string): Promise<void> {
  // 1. Resolve Admin Agent
  const adminAgent = getAdminAgent();
  if (!adminAgent) {
    log.warn('AgentMail news poll: no global admin agent configured in DB, skipping poll');
    return;
  }

  // 2. Resolve Inbox ID
  const inboxesData = await fetchJson<{ inboxes?: Inbox[] }>(`${BASE_URL}/inboxes`, apiKey);
  const inboxes = inboxesData.inboxes ?? [];
  const match = inboxes.find((i) => i.email === email || i.inbox_id === email);
  if (!match) {
    log.warn('AgentMail news poll: no matching inbox found for email', { email });
    return;
  }
  const inboxId = match.inbox_id;

  // 3. Fetch Threads matching MOH Media Report
  const threadsData = await fetchJson<{ threads?: Thread[] }>(
    `${BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/threads?query=${encodeURIComponent('MOH Media Report')}&limit=10`,
    apiKey,
  );
  const threads = threadsData.threads ?? [];

  // Filter for unprocessed threads that match MOH Media Report subject pattern
  const newsThreads = threads.filter((t) => {
    const subject = t.subject ?? '';
    return isMOHMediaReportSubject(subject) && !isThreadProcessed(t.thread_id);
  });

  if (newsThreads.length === 0) {
    return;
  }

  log.info(`AgentMail news poll: found ${newsThreads.length} new MOH Media Report email(s) to process.`);

  for (const thread of newsThreads) {
    try {
      const subject = thread.subject ?? '(no subject)';
      log.info('AgentMail news poll: processing thread', { threadId: thread.thread_id, subject });

      // 4. Fetch full messages in thread
      const messagesData = await fetchJson<{ messages?: Message[] }>(
        `${BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/messages?thread_id=${thread.thread_id}`,
        apiKey,
      );
      const messages = messagesData.messages ?? [];

      if (messages.length === 0) {
        log.warn('AgentMail news poll: thread contains no messages, skipping', { threadId: thread.thread_id });
        continue;
      }

      // 5. Gather full text from the latest message in the thread (disregarding historical/stale replies)
      let combinedText = '';
      if (messages.length > 0) {
        const msg = messages[0];
        let fullText = msg.preview ?? '';
        try {
          const detail = await fetchJson<{ text?: string; extracted_text?: string }>(
            `${BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(msg.message_id)}`,
            apiKey,
          );
          fullText = detail.text || detail.extracted_text || msg.preview || '(no content)';
        } catch (err) {
          log.error('AgentMail news poll: failed to fetch message detail, falling back to preview', {
            messageId: msg.message_id,
            err,
          });
        }
        combinedText = fullText;
      }

      // 6. Parse Media Report into Index summary and Article files
      const parsed = parseMOHMediaReport(combinedText, subject);
      const dateKey = parsed.formattedDate;

      // Re-number all parsed articles sequentially across all sections
      let nextNum = 1;
      for (const sec of parsed.sections) {
        for (const art of sec.articles) {
          art.number = String(nextNum);
          nextNum++;
        }
      }

      // 6a. Format Report summary markdown
      let reportMd = `# MOH Media Report (${parsed.date})\n\n`;
      for (const sec of parsed.sections) {
        reportMd += `## ${sec.category}\n\n`;
        for (const art of sec.articles) {
          const numPrefix = art.number ? `${art.number}) ` : '';
          const srcSuffix = art.linkText ? ` (${art.linkText})` : '';
          reportMd += `* ${numPrefix}${art.title}${srcSuffix}\n`;
        }
        reportMd += `\n`;
      }

      // 6b. Save files to global news directory and prepare attachments to embed
      const attachments: { name: string; localPath: string }[] = [];
      const globalNewsDir = path.join(GROUPS_DIR, 'global', 'news');
      fs.mkdirSync(globalNewsDir, { recursive: true });

      // Save report index
      const reportFilename = `report-${dateKey}.md`;
      fs.writeFileSync(path.join(globalNewsDir, reportFilename), reportMd, 'utf-8');
      attachments.push({
        name: reportFilename,
        localPath: `global/news/${reportFilename}`,
      });

      // Save individual articles
      for (const sec of parsed.sections) {
        for (const art of sec.articles) {
          let artMd = `# [${sec.category}] ${art.number ? `${art.number}) ` : ''}${art.title}\n\n`;
          if (art.cleanLink) {
            artMd += `**Source:** [${art.linkText || 'Link'}](${art.cleanLink})\n\n`;
          }
          artMd += `**Content:**\n${art.description}\n`;

          const artFilename = `article-${dateKey}-${art.number}.md`;
          fs.writeFileSync(path.join(globalNewsDir, artFilename), artMd, 'utf-8');
          attachments.push({
            name: artFilename,
            localPath: `global/news/${artFilename}`,
          });
        }
      }

      // 7. Write system embedding message to the admin agent group
      // Use 'agent-shared' mode to get the primary administrative/global session of the admin agent.
      const { session } = resolveSession(adminAgent.id, null, null, 'agent-shared');

      const systemMsgId = `embed-${thread.thread_id}-${Date.now()}`;
      writeSessionMessage(adminAgent.id, session.id, {
        id: systemMsgId,
        kind: 'system',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({
          action: 'embed_file',
          attachments,
          collectionId: 'news',
          originalEvent: {
            message: {
              id: `news-${thread.thread_id}`,
            },
          },
        }),
        trigger: 1,
      });

      // Wake the admin container
      const freshSession = getSession(session.id);
      if (freshSession) {
        await wakeContainer(freshSession);
      }

      // 8. Mark thread as processed
      markThreadProcessed(thread.thread_id, subject);
      log.info('AgentMail news poll: successfully queued thread for embedding', { threadId: thread.thread_id });
    } catch (err) {
      log.error('AgentMail news poll: failed to process thread', { threadId: thread.thread_id, err });
    }
  }
}

import { readEnvFile } from '../../env.js';

export function startAgentMailPoll(): void {
  const env = readEnvFile(['ADMIN_AGENTMAIL_API_KEY', 'ADMIN_AGENTMAIL_EMAIL']);
  const apiKey = process.env.ADMIN_AGENTMAIL_API_KEY?.trim() || env.ADMIN_AGENTMAIL_API_KEY?.trim();
  const email = process.env.ADMIN_AGENTMAIL_EMAIL?.trim() || env.ADMIN_AGENTMAIL_EMAIL?.trim();

  if (!apiKey || !email) {
    log.warn('AgentMail news poll skipped — ADMIN_AGENTMAIL_API_KEY or ADMIN_AGENTMAIL_EMAIL not configured');
    return;
  }

  log.info('Starting AgentMail news poller', { email });

  // Initial execution
  void pollInbox(apiKey, email).catch((err) => log.error('Initial AgentMail poll failed', { err }));

  // Every 15 seconds (temporary for demo/testing)
  pollInterval = setInterval(() => {
    void pollInbox(apiKey, email).catch((err) => log.error('AgentMail poll loop failed', { err }));
  }, 15 * 1000);
}

export function stopAgentMailPoll(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    log.info('AgentMail news poller stopped');
  }
}

onShutdown(() => {
  stopAgentMailPoll();
});
