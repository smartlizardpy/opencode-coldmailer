/**
 * Forward-only migrations, gated on schema_migrations. Idempotent: running twice is a no-op,
 * which is what makes the installer's upgrade path safe to interrupt.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tx, now, type Db } from "./index.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface Migration { version: number; name: string; sql: string }

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const m = /^(\d+)_(.+)\.sql$/.exec(f);
      if (!m) throw new Error(`migration filename must be <version>_<name>.sql, got "${f}"`);
      return { version: Number(m[1]), name: m[2], sql: readFileSync(join(dir, f), "utf8") };
    })
    .sort((a, b) => a.version - b.version);
}

function appliedVersions(db: Db): Set<number> {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (!exists) return new Set();
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

export function migrate(db: Db, dir?: string): number[] {
  const applied = appliedVersions(db);
  const pending = loadMigrations(dir).filter((m) => !applied.has(m.version));
  const ran: number[] = [];

  for (const m of pending) {
    // Each migration is its own transaction, so a failure halfway through a set leaves the
    // earlier ones durably applied and the failing one fully rolled back.
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(m.version, m.name, now());
    });
    ran.push(m.version);
  }
  return ran;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row?.v ?? 0;
}

/**
 * Crash recovery, run once at boot.
 *
 * A `running` job is one we were mid-way through when the process died: safe to re-run.
 * A `sending` send_log row is NOT safe to re-run - the message may already have left the
 * building - so it is failed rather than retried.
 */
export function recoverAfterCrash(db: Db): { jobsReset: number; sendsFailed: number } {
  return tx(db, () => {
    const jobs = db
      .prepare("UPDATE job SET status='pending', locked_at=NULL, updated_at=? WHERE status='running'")
      .run(now());
    const sends = db
      .prepare("UPDATE send_log SET status='failed', error_code='INTERRUPTED' WHERE status='sending'")
      .run();
    return { jobsReset: Number(jobs.changes), sendsFailed: Number(sends.changes) };
  });
}
