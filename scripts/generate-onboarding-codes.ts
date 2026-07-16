#!/usr/bin/env tsx
/**
 * scripts/generate-onboarding-codes.ts
 *
 * One-off script: generates unique 5-character onboarding codes, inserts
 * them into the `onboarding_codes` table (running migrations first if the
 * table doesn't exist yet), and writes the full list to onboarding-codes.txt
 * (project root, gitignored) for distribution.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-onboarding-codes.ts [count]
 *   (default count: 200)
 *
 * Safe to re-run — skips codes already in the table and only tops up the
 * difference if some already exist. The same file also gets rewritten
 * automatically by the live host every time a code is redeemed, so it
 * always reflects current used/available status — no manual refresh needed.
 */
import path from 'path';

import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { insertCodes, getAllCodes, exportCodesToFile, ONBOARDING_CODES_FILE } from '../src/db/onboarding-codes.js';

// Avoids visually-confusable characters (0/O, 1/I/L) since codes are typed
// by hand on a phone keyboard.
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return code;
}

function generateUniqueCodes(count: number, existing: Set<string>): string[] {
  const fresh = new Set<string>();
  while (fresh.size < count) {
    const c = randomCode();
    if (!existing.has(c) && !fresh.has(c)) fresh.add(c);
  }
  return [...fresh];
}

const targetCount = Number(process.argv[2]) || 200;
const dbPath = path.resolve('data/v2.db');

const db = initDb(dbPath);
runMigrations(db);

const existingCodes = getAllCodes();
const existingSet = new Set(existingCodes.map((c) => c.code));
const toGenerate = Math.max(0, targetCount - existingCodes.length);

if (toGenerate > 0) {
  const fresh = generateUniqueCodes(toGenerate, existingSet);
  insertCodes(fresh);
  console.error(`Generated ${fresh.length} new code(s).`);
} else {
  console.error(`Already have ${existingCodes.length} code(s) — nothing to generate.`);
}

exportCodesToFile();
console.error(`Wrote ${getAllCodes().length} code(s) to ${ONBOARDING_CODES_FILE}`);
