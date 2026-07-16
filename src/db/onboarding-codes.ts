import fs from 'fs';
import path from 'path';

import { getDb } from './connection.js';

/** Distribution list — project root, gitignored (contains real redeemable codes). */
export const ONBOARDING_CODES_FILE = path.resolve(process.cwd(), 'onboarding-codes.txt');

export interface OnboardingCode {
  code: string;
  used_at: string | null;
  used_by: string | null;
  created_at: string;
}

/** Normalize user input to the stored form — uppercase, trimmed. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Returns the code row only if it exists and hasn't been redeemed yet. */
export function findUnusedCode(code: string): OnboardingCode | undefined {
  return getDb()
    .prepare('SELECT * FROM onboarding_codes WHERE code = ? AND used_at IS NULL')
    .get(normalizeCode(code)) as OnboardingCode | undefined;
}

/**
 * Marks a code as redeemed. The `used_at IS NULL` guard makes this atomic
 * against a double-redeem race (two messages hitting the same code before
 * either finishes) — whichever call lands first wins; returns false to the
 * loser so it can no-op instead of provisioning a second agent.
 */
export function markCodeUsed(code: string, usedBy: string): boolean {
  const result = getDb()
    .prepare('UPDATE onboarding_codes SET used_at = ?, used_by = ? WHERE code = ? AND used_at IS NULL')
    .run(new Date().toISOString(), usedBy, normalizeCode(code));
  return result.changes > 0;
}

/** Bulk insert for the code-generation script. Skips duplicates. */
export function insertCodes(codes: string[]): void {
  const now = new Date().toISOString();
  const insert = getDb().prepare(
    'INSERT OR IGNORE INTO onboarding_codes (code, used_at, used_by, created_at) VALUES (?, NULL, NULL, ?)',
  );
  const insertMany = getDb().transaction((rows: string[]) => {
    for (const c of rows) insert.run(normalizeCode(c), now);
  });
  insertMany(codes);
}

export function getAllCodes(): OnboardingCode[] {
  return getDb().prepare('SELECT * FROM onboarding_codes ORDER BY created_at').all() as OnboardingCode[];
}

/**
 * Writes the current full code list to disk. Called after every successful
 * redemption (and by the generator script) so the distribution file always
 * reflects live status — no separate manual export/refresh step needed.
 */
export function exportCodesToFile(filePath: string = ONBOARDING_CODES_FILE): void {
  const lines = getAllCodes().map(
    (row) => `${row.code}\t${row.used_at ? `used by ${row.used_by} at ${row.used_at}` : 'available'}`,
  );
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}
