#!/usr/bin/env bun
/**
 * agentmail — AgentMail inbox CLI (runs inside agent containers on Bun).
 *
 * Credentials are resolved in order:
 *   1. Env vars injected at container spawn (AGENTMAIL_API_KEY, AGENTMAIL_EMAIL)
 *      These come from groups/<folder>/agent.env read by container-runner at spawn.
 *   2. /workspace/agent/agent.env read directly — written by `agentmail save` and
 *      available immediately within the same container session without a restart.
 *
 * Usage:
 *   agentmail list [--limit N]
 *   agentmail read <thread-id>
 *   agentmail search "<query>" [--limit N]
 *   agentmail save --api-key <key> --email <email>
 *   agentmail check                              # test credentials, print inbox address
 */
import { execFileSync } from 'child_process';
import fs from 'fs';

const BASE_URL = 'https://api.agentmail.to/v0';
const AGENT_ENV_PATH = '/workspace/agent/agent.env';

// ── Credential resolution ──────────────────────────────────────────────────

function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && val) result[key] = val;
  }
  return result;
}

function getCredentials(): { apiKey: string; email: string } {
  let apiKey = process.env.AGENTMAIL_API_KEY?.trim() ?? '';
  let email = process.env.AGENTMAIL_EMAIL?.trim() ?? '';

  // Fallback: read agent.env directly (written by `agentmail save`).
  // This makes credentials available immediately in the same session
  // without needing a container restart.
  if (!apiKey && fs.existsSync(AGENT_ENV_PATH)) {
    const stored = parseEnvContent(fs.readFileSync(AGENT_ENV_PATH, 'utf-8'));
    if (stored.AGENTMAIL_API_KEY) apiKey = stored.AGENTMAIL_API_KEY;
    if (stored.AGENTMAIL_EMAIL) email = stored.AGENTMAIL_EMAIL;
  }

  if (!apiKey) {
    // Exit code 2 = credentials missing. instructions.md teaches the agent
    // to catch this and run the onboarding flow.
    console.error('AGENTMAIL_CREDENTIALS_MISSING');
    process.exit(2);
  }

  return { apiKey, email: email || '' };
}

// ── HTTP ───────────────────────────────────────────────────────────────────

function get<T = unknown>(url: string, apiKey: string): T {
  let raw: string;
  try {
    raw = execFileSync(
      'curl',
      ['-fsSL', '--max-time', '20', '-H', `Authorization: Bearer ${apiKey}`, url],
      { encoding: 'utf-8' },
    );
  } catch {
    console.error(`agentmail: request failed: ${url}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.error(`agentmail: invalid JSON from ${url}: ${raw.slice(0, 200)}`);
    process.exit(1);
  }
}

// ── Types (actual AgentMail API shapes) ────────────────────────────────────

interface Inbox { inbox_id: string; email: string }
interface Thread {
  thread_id: string; subject?: string; preview?: string;
  timestamp?: string; senders?: string[]; recipients?: string[];
  attachments?: { filename: string }[];
}
interface Message {
  message_id: string; subject?: string; from?: string; to?: string[];
  preview?: string; timestamp?: string;
  attachments?: { filename: string; content_type: string }[];
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function getInboxId(apiKey: string, targetEmail: string): string {
  const data = get<{ inboxes?: Inbox[] }>(`${BASE_URL}/inboxes`, apiKey);
  const inboxes = data.inboxes ?? [];
  if (inboxes.length === 0) {
    console.error('agentmail: no inboxes found — check your API key');
    process.exit(1);
  }
  if (targetEmail) {
    const match = inboxes.find((i) => i.email === targetEmail || i.inbox_id === targetEmail);
    if (match) return match.inbox_id;
  }
  if (inboxes.length === 1) return inboxes[0].inbox_id;
  console.error(`agentmail: multiple inboxes found. Set AGENTMAIL_EMAIL to one of: ${inboxes.map((i) => i.email).join(', ')}`);
  process.exit(1);
}

// ── Commands ───────────────────────────────────────────────────────────────

function cmdSave(args: string[]): void {
  let apiKey = '';
  let email = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-key' && args[i + 1]) apiKey = args[++i].trim();
    if (args[i] === '--email' && args[i + 1]) email = args[++i].trim();
  }
  if (!apiKey) { console.error('agentmail save: --api-key is required'); process.exit(1); }
  if (!email)  { console.error('agentmail save: --email is required');   process.exit(1); }

  fs.writeFileSync(AGENT_ENV_PATH, `AGENTMAIL_API_KEY=${apiKey}\nAGENTMAIL_EMAIL=${email}\n`);
  console.log(`Credentials saved. Inbox: ${email}`);
}

function cmdCheck(): void {
  const { apiKey, email } = getCredentials();
  const inboxId = getInboxId(apiKey, email);
  console.log(`Connected: ${inboxId}`);
}

function cmdList(args: string[]): void {
  let limit = 10;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = Math.max(1, parseInt(args[++i], 10) || 10);
  }
  const { apiKey, email } = getCredentials();
  const inboxId = getInboxId(apiKey, email);
  const data = get<{ threads?: Thread[]; count?: number }>(
    `${BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/threads?limit=${limit}`, apiKey,
  );
  const threads = data.threads ?? [];
  if (threads.length === 0) { console.log('Inbox is empty.'); return; }

  console.log(`${data.count ?? threads.length} thread(s) in ${inboxId}:\n`);
  for (const t of threads) {
    const sender = t.senders?.[0] ?? '(unknown)';
    const date = fmtDate(t.timestamp);
    const attach = t.attachments?.length ? ` [${t.attachments.map((a) => a.filename).join(', ')}]` : '';
    const preview = t.preview ? `\n    ${t.preview.trim().slice(0, 120)}` : '';
    console.log(`[${t.thread_id}] ${date ? date + ' · ' : ''}${sender}\n  ${t.subject ?? '(no subject)'}${attach}${preview}\n`);
  }
}

function cmdRead(args: string[]): void {
  const threadId = args[0];
  if (!threadId) { console.error('agentmail read: thread-id required'); process.exit(1); }
  const { apiKey, email } = getCredentials();
  const inboxId = getInboxId(apiKey, email);
  const data = get<{ messages?: Message[] }>(
    `${BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/messages?thread_id=${threadId}`, apiKey,
  );
  const messages = data.messages ?? [];
  if (messages.length === 0) { console.log('No messages in this thread.'); return; }

  console.log(`Thread: ${messages[0]?.subject ?? '(no subject)'}\n${'─'.repeat(60)}`);
  for (const msg of messages) {
    const date = fmtDate(msg.timestamp);
    console.log(`\nFrom: ${msg.from ?? '(unknown)'}${date ? '  ·  ' + date : ''}`);
    if (msg.to?.length) console.log(`To:   ${msg.to.join(', ')}`);
    if (msg.attachments?.length) {
      console.log(`Attachments: ${msg.attachments.map((a) => `${a.filename} (${a.content_type})`).join(', ')}`);
    }
    console.log('─'.repeat(40));
    console.log(msg.preview?.trim() || '(no preview)');
  }
}

function cmdSearch(args: string[]): void {
  let query = '';
  let limit = 10;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = Math.max(1, parseInt(args[++i], 10) || 10);
    else if (!args[i].startsWith('--')) query += (query ? ' ' : '') + args[i];
  }
  if (!query.trim()) { console.error('agentmail search: query required'); process.exit(1); }
  const { apiKey, email } = getCredentials();
  const inboxId = getInboxId(apiKey, email);
  const data = get<{ threads?: Thread[] }>(
    `${BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/threads?query=${encodeURIComponent(query.trim())}&limit=${limit}`, apiKey,
  );
  const threads = data.threads ?? [];
  if (threads.length === 0) { console.log(`No threads matching: ${query}`); return; }

  console.log(`${threads.length} result(s) for "${query}":\n`);
  for (const t of threads) {
    const sender = t.senders?.[0] ?? '(unknown)';
    const date = fmtDate(t.timestamp);
    const preview = t.preview ? `\n    ${t.preview.trim().slice(0, 120)}` : '';
    console.log(`[${t.thread_id}] ${date ? date + ' · ' : ''}${sender}\n  ${t.subject ?? '(no subject)'}${preview}\n`);
  }
}

// ── Entry ──────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'save':   cmdSave(rest);   break;
  case 'check':  cmdCheck();      break;
  case 'list':   cmdList(rest);   break;
  case 'read':   cmdRead(rest);   break;
  case 'search': cmdSearch(rest); break;
  default:
    console.error('Usage: agentmail <save|check|list|read|search> [...]');
    console.error('  agentmail save --api-key <key> --email <email>');
    console.error('  agentmail check');
    console.error('  agentmail list [--limit N]');
    console.error('  agentmail read <thread-id>');
    console.error('  agentmail search "<query>" [--limit N]');
    process.exit(cmd ? 1 : 0);
}
