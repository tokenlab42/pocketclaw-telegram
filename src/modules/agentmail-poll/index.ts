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

      // 5. Format as Markdown
      let md = `# Email Thread: ${subject}\n\n`;
      for (const msg of messages) {
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

        const date = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '(unknown date)';
        md += `**From:** ${msg.from ?? '(unknown)'}  \n`;
        if (msg.to?.length) md += `**To:** ${msg.to.join(', ')}  \n`;
        md += `**Date:** ${date}\n\n`;
        md += `---\n\n`;
        md += `${fullText.trim()}\n\n`;
      }

      // 6. Save file to groups/global/news/
      const globalNewsDir = path.join(GROUPS_DIR, 'global', 'news');
      fs.mkdirSync(globalNewsDir, { recursive: true });
      const mdFilename = `${thread.thread_id}.md`;
      const filePath = path.join(globalNewsDir, mdFilename);
      fs.writeFileSync(filePath, md, 'utf-8');

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
          attachments: [
            {
              name: mdFilename,
              localPath: `global/news/${mdFilename}`,
            },
          ],
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
