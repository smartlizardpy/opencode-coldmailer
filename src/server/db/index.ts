/**
 * SQLite access via node:sqlite (built into Node >= 22.13.0, so zero native dependencies).
 *
 * node:sqlite has no better-sqlite3-style .transaction() helper, so tx() below wraps
 * BEGIN IMMEDIATE / COMMIT / ROLLBACK by hand.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export type Db = DatabaseSync;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastMs = 0;
let lastRandom: number[] = [];

/**
 * ULID: 48-bit timestamp + 80 bits of randomness, Crockford base32.
 * Lexicographically sortable, so `ORDER BY id` is chronological and we need no created_at index
 * for ordering. Monotonic within a millisecond so ids never collide in a tight loop.
 */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 9; i >= 0; i--) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }

  if (now === lastMs) {
    // Same millisecond: increment the previous randomness rather than redrawing, so ids
    // generated in a loop still sort in creation order.
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i] < 31) { lastRandom[i]++; break; }
      lastRandom[i] = 0;
    }
  } else {
    lastMs = now;
    lastRandom = Array.from(randomBytes(16)).slice(0, 16).map((b) => b % 32);
  }
  return time + lastRandom.map((r) => CROCKFORD[r]).join("");
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/** BEGIN IMMEDIATE so a concurrent writer fails fast instead of deadlocking mid-transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already unwound */ }
    throw err;
  }
}

export const now = (): number => Date.now();
