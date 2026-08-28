/**
 * Forward-only migrations, gated on schema_migrations. Idempotent: running twice is a no-op,
 * which is what makes the installer's upgrade path safe to interrupt.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tx, now, type Db } from "./index.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface Migration { version: number; name: string; sql: string; noFk: boolean }

/**
 * A migration that rebuilds a table must run with foreign keys OFF.
 *
 * SQLite cannot drop a table-level constraint, so changing one means recreating the table -
 * and with FKs on, DROP TABLE performs an implicit DELETE FROM first, which cascades into
 * every child row. That would silently delete every draft version and send log. A migration
 * opts out by starting with the marker below.
 */
const NO_FK_MARKER = "-- coldcall:no-foreign-keys";

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const m = /^(\d+)_(.+)\.sql$/.exec(f);
      if (!m) throw new Error(`migration filename must be <version>_<name>.sql, got "${f}"`);
      const sql = readFileSync(join(dir, f), "utf8");
      return { version: Number(m[1]), name: m[2], sql, noFk: sql.includes(NO_FK_MARKER) };
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
    // PRAGMA foreign_keys is a no-op inside a transaction, so it has to be set before BEGIN.
    if (m.noFk) db.exec("PRAGMA foreign_keys = OFF");
    try {
      // Each migration is its own transaction, so a failure halfway through a set leaves the
      // earlier ones durably applied and the failing one fully rolled back.
      tx(db, () => {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(m.version, m.name, now());
      });
    } finally {
      if (m.noFk) {
        db.exec("PRAGMA foreign_keys = ON");
        // Prove the rebuild did not leave a dangling reference behind.
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(`migration ${m.version} left ${violations.length} foreign key violation(s): ${JSON.stringify(violations.slice(0, 3))}`);
        }
      }
    }
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
