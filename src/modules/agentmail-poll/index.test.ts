import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DIR = '/tmp/nanoclaw-test-agentmail-poll';
const GROUPS_DIR = path.join(TEST_DIR, 'groups');
const DATA_DIR = path.join(TEST_DIR, 'data');

// Mock Config
vi.mock('../../config.js', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    GROUPS_DIR,
    DATA_DIR,
  };
});

// Mock Wake Container
const wakeContainerMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../container-runner.js', () => ({
  wakeContainer: wakeContainerMock,
}));

// Mock env loader to follow vitest env stubs rather than host .env file
vi.mock('../../env.js', () => ({
  readEnvFile: () => ({
    ADMIN_AGENTMAIL_API_KEY: process.env.ADMIN_AGENTMAIL_API_KEY || '',
    ADMIN_AGENTMAIL_EMAIL: process.env.ADMIN_AGENTMAIL_EMAIL || '',
  }),
}));

describe('AgentMail news poller', () => {
  let db: any;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Initialize in-memory test database and migrations
    const { initTestDb } = await import('../../db/connection.js');
    const { runMigrations } = await import('../../db/migrations/index.js');
    db = initTestDb();
    runMigrations(db);

    // Setup base fixtures (agent group + global config)
    const { createAgentGroup } = await import('../../db/agent-groups.js');
    createAgentGroup({
      id: 'ag-admin',
      name: 'Nano',
      folder: 'nano-admin',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    const { ensureContainerConfig, updateContainerConfigScalars } = await import('../../db/container-configs.js');
    ensureContainerConfig('ag-admin');
    updateContainerConfigScalars('ag-admin', { cli_scope: 'global' });

    vi.stubEnv('ADMIN_AGENTMAIL_API_KEY', 'test-key');
    vi.stubEnv('ADMIN_AGENTMAIL_EMAIL', 'admin@agentmail.to');
    wakeContainerMock.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const { closeDb } = await import('../../db/connection.js');
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('skips polling if credentials are not configured', async () => {
    vi.stubEnv('ADMIN_AGENTMAIL_API_KEY', '');
    vi.stubEnv('ADMIN_AGENTMAIL_EMAIL', '');

    const { startAgentMailPoll, stopAgentMailPoll } = await import('./index.js');
    const fetchSpy = vi.spyOn(global, 'fetch');

    startAgentMailPoll();
    expect(fetchSpy).not.toHaveBeenCalled();

    stopAgentMailPoll();
  });

  it('successfully polls, filters MOH Media Report, parses, writes index and articles, and triggers embedding', async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/inboxes')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ inboxes: [{ inbox_id: 'inbox-1', email: 'admin@agentmail.to' }] }),
        });
      }
      if (url.includes('/threads')) {
        // Verify that the query parameter was passed correctly
        expect(url).toContain('query=MOH%20Media%20Report');
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              threads: [
                {
                  thread_id: 'thread-news-1',
                  subject: 'FW: MOH Media Report (3 July 2026)',
                  timestamp: '2026-07-02T00:00:00.000Z',
                  senders: ['reporter@news.com'],
                  preview: 'Breaking news: AgentMail is integrated!',
                },
                {
                  thread_id: 'thread-spam-1',
                  subject: 'Buy cheap things',
                  timestamp: '2026-07-02T00:00:00.000Z',
                  senders: ['spammer@spam.com'],
                  preview: 'Cheap things details',
                },
              ],
            }),
        });
      }
      if (url.includes('/messages?thread_id=')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              messages: [
                {
                  message_id: 'msg-1',
                  from: 'reporter@news.com',
                  to: ['admin@agentmail.to'],
                  preview: 'Breaking news: AgentMail is integrated!',
                  timestamp: '2026-07-02T00:00:00.000Z',
                },
              ],
            }),
        });
      }
      if (url.includes('/messages/msg-1')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              text: `
CYBERSECURITY NEWS

Singapore Expands Cybersecurity Measures Amid AI-Driven Threats<https://ddei5-0-ctp.trendmicro.com:443/wis/clicktime/v1/query?url=https%3a%2f%2fopengovasia.com%2fsingapore-expands-cybersecurity-measures-amid-ai-driven-threats%2f&umid=123> (OpenGov Asia, 1 Jul)

CSA's Singapore Cyber Landscape 2025/2026 report...

STANDARDS AND REGULATIONS

1)      Non-emergency 1777 ambulance hotline to cease from Jan 1, 2027<https://ddei5-0-ctp.trendmicro.com:443/wis/clicktime/v1/query?url=https%3a%2f%2fwww.straitstimes.com%2fsingapore%2fnon-emergency-1777&umid=123> (ST Online, 1 Jul)
SCDF to cease non-emergency hotline 1777 in 2027<https://content.isentia.io/?url=https%3a%2f%2fwww.channelnewsasia.com%2f> (CNA Online, 1 Jul)

The Singapore Civil Defence Force's (SCDF)...
`,
            }),
        });
      }
      return Promise.reject(new Error('Unknown url: ' + url));
    });

    vi.stubGlobal('fetch', fetchSpy);

    const { startAgentMailPoll, stopAgentMailPoll } = await import('./index.js');
    startAgentMailPoll();

    // Give asynchronous polling chain a brief moment to complete the details fetch
    await new Promise((r) => setTimeout(r, 200));

    // Verify report index was written with decoded and cleaned links
    const reportPath = path.join(GROUPS_DIR, 'global', 'news', 'report-2026-07-03.md');
    expect(fs.existsSync(reportPath)).toBe(true);
    const reportContent = fs.readFileSync(reportPath, 'utf-8');
    expect(reportContent).toContain('# MOH Media Report (3 July 2026)');
    expect(reportContent).toContain('## CYBERSECURITY NEWS');
    expect(reportContent).toContain('## STANDARDS AND REGULATIONS');
    expect(reportContent).toContain(
      '* 1) Singapore Expands Cybersecurity Measures Amid AI-Driven Threats (OpenGov Asia, 1 Jul)',
    );
    expect(reportContent).toContain(
      '* 2) Non-emergency 1777 ambulance hotline to cease from Jan 1, 2027 (ST Online, 1 Jul)',
    );

    // Verify individual article files were written
    const art1Path = path.join(GROUPS_DIR, 'global', 'news', 'article-2026-07-03-1.md');
    const art2Path = path.join(GROUPS_DIR, 'global', 'news', 'article-2026-07-03-2.md');
    expect(fs.existsSync(art1Path)).toBe(true);
    expect(fs.existsSync(art2Path)).toBe(true);

    const art1Content = fs.readFileSync(art1Path, 'utf-8');
    expect(art1Content).toContain(
      '# [CYBERSECURITY NEWS] 1) Singapore Expands Cybersecurity Measures Amid AI-Driven Threats',
    );
    expect(art1Content).toContain("CSA's Singapore Cyber Landscape 2025/2026 report...");

    const art2Content = fs.readFileSync(art2Path, 'utf-8');
    expect(art2Content).toContain(
      '# [STANDARDS AND REGULATIONS] 2) Non-emergency 1777 ambulance hotline to cease from Jan 1, 2027',
    );
    expect(art2Content).toContain("The Singapore Civil Defence Force's (SCDF)...");
    expect(art2Content).not.toContain('CNA Online'); // Secondary source should be discarded

    // Verify database processed_email_threads row was inserted
    const row = db.prepare('SELECT * FROM processed_email_threads WHERE thread_id = ?').get('thread-news-1') as any;
    expect(row).toBeDefined();
    expect(row.subject).toBe('FW: MOH Media Report (3 July 2026)');

    // Verify session message was written to inbound.db
    const { findSessionByAgentGroup } = await import('../../db/sessions.js');
    const session = findSessionByAgentGroup('ag-admin');
    expect(session).toBeDefined();

    const { inboundDbPath } = await import('../../session-manager.js');
    const { openInboundDb } = await import('../../db/session-db.js');
    const sdb = openInboundDb(inboundDbPath('ag-admin', session!.id));
    const sdbRow = sdb.prepare('SELECT * FROM messages_in WHERE id LIKE ?').get('embed-%') as any;
    expect(sdbRow).toBeDefined();
    expect(sdbRow.kind).toBe('system');

    const content = JSON.parse(sdbRow.content);
    expect(content.action).toBe('embed_file');
    expect(content.collectionId).toBe('news');
    expect(content.attachments).toHaveLength(3); // index report + 2 articles
    expect(content.attachments[0].name).toBe('report-2026-07-03.md');
    expect(content.attachments[1].name).toBe('article-2026-07-03-1.md');
    expect(content.attachments[2].name).toBe('article-2026-07-03-2.md');

    // Verify wakeContainer was triggered
    expect(wakeContainerMock).toHaveBeenCalled();

    stopAgentMailPoll();
  });

  describe('isMOHMediaReportSubject', () => {
    it('matches valid MOH Media Report subjects with different forward/reply prefixes', async () => {
      const { isMOHMediaReportSubject } = await import('./index.js');
      expect(isMOHMediaReportSubject('MOH Media Report (3 July 2026)')).toBe(true);
      expect(isMOHMediaReportSubject('FW: MOH Media Report (3 July 2026)')).toBe(true);
      expect(isMOHMediaReportSubject('Fwd: MOH Media Report')).toBe(true);
      expect(isMOHMediaReportSubject('RE: MOH Media Report (3 July)')).toBe(true);
      expect(isMOHMediaReportSubject('FW: Fwd: RE: MOH Media Report (3 July)')).toBe(true);
      expect(isMOHMediaReportSubject('[EXTERNAL] FW: MOH Media Report')).toBe(true);
      expect(isMOHMediaReportSubject('   fw:   [external]  moh media report  ')).toBe(true);
    });

    it('rejects subjects that do not start with MOH Media Report', async () => {
      const { isMOHMediaReportSubject } = await import('./index.js');
      expect(isMOHMediaReportSubject('MOH Media Updates')).toBe(false);
      expect(isMOHMediaReportSubject('Check out MOH Media Report')).toBe(false);
      expect(isMOHMediaReportSubject('Something else')).toBe(false);
      expect(isMOHMediaReportSubject('')).toBe(false);
    });
  });

  describe('URL Cleaning & Parsing helpers', () => {
    it('cleans TrendMicro and Isentia redirect URLs', async () => {
      const { cleanUrl } = await import('./index.js');
      const tm =
        'https://ddei5-0-ctp.trendmicro.com:443/wis/clicktime/v1/query?url=https%3a%2f%2fwww.straitstimes.com%2fsingapore%2fnon-emergency-1777&umid=123';
      const isentia = 'https://content.isentia.io/?url=https%3a%2f%2fwww.channelnewsasia.com%2f';
      const normal = 'https://www.google.com';

      expect(cleanUrl(tm)).toBe('https://www.straitstimes.com/singapore/non-emergency-1777');
      expect(cleanUrl(isentia)).toBe('https://www.channelnewsasia.com/');
      expect(cleanUrl(normal)).toBe('https://www.google.com');
    });

    it('cleans all links inside a block of text', async () => {
      const { cleanAllLinksInText } = await import('./index.js');
      const input =
        'Read more here <https://ddei5-0-ctp.trendmicro.com:443/wis/clicktime/v1/query?url=https%3a%2f%2fwww.straitstimes.com%2f> or visit https://content.isentia.io/?url=https%3a%2f%2fwww.zaobao.com.sg';
      const expected = 'Read more here <https://www.straitstimes.com/> or visit https://www.zaobao.com.sg';
      expect(cleanAllLinksInText(input)).toBe(expected);
    });

    it('extracts date from subject or text', async () => {
      const { extractReportDate } = await import('./index.js');
      expect(extractReportDate('', 'FW: MOH Media Report (3 July 2026)')).toBe('3 July 2026');
      expect(extractReportDate('Subject: MOH Media Report 2 Jul 2026\nDear staff', '')).toBe('2 Jul 2026');
      expect(extractReportDate('', 'FWD: [EXTERNAL] MOH Media Report 2 Jul')).toBe('2 Jul');
      expect(extractReportDate('', 'FW: MOH Media Report 4-6 July 2026')).toBe('6 July 2026');
      expect(extractReportDate('', 'FW: MOH Media Report 4 - 6 July 2026')).toBe('6 July 2026');
    });

    it('formats date to YYYY-MM-DD', async () => {
      const { formatDateToYYYYMMDD } = await import('./index.js');
      expect(formatDateToYYYYMMDD('3 July 2026')).toBe('2026-07-03');
      expect(formatDateToYYYYMMDD('2 Jul 2026')).toBe('2026-07-02');
      expect(formatDateToYYYYMMDD('2 Jul')).toBe(`${new Date().getFullYear()}-07-02`);
    });
  });
});
