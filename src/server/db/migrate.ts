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

/**
 * Report rows whose parent no longer exists.
 *
 * The app always opens SQLite with foreign_keys=ON, so it cannot create these itself. Anything
 * else touching the file can: a sqlite3 shell (where foreign keys are OFF by default), a
 * restored backup, a sync tool. The symptom is not an error - it is a draft whose contact has
 * vanished, which then fails somewhere far away with a confusing message. Better to say so at
 * boot, in one line, than to let it surface as a mystery later.
 */
export function integrityReport(db: Db): { ok: boolean; violations: Array<{ table: string; count: number }> } {
  const rows = db.prepare("PRAGMA foreign_key_check").all() as Array<{ table?: string; "table": string }>;
  const byTable = new Map<string, number>();
  for (const r of rows) {
    const t = (r as { table: string }).table ?? "unknown";
    byTable.set(t, (byTable.get(t) ?? 0) + 1);
  }
  return {
    ok: rows.length === 0,
    violations: [...byTable.entries()].map(([table, count]) => ({ table, count })).sort((a, b) => b.count - a.count),
  };
}

/**
 * Resolve dangling references. Only ever called when the user asks: an orphan may be the only
 * remaining record of something, and silently deleting it at boot would be worse than the
 * inconsistency.
 *
 * Returns the number of VIOLATIONS resolved, which is not the same as rows deleted - a
 * reference declared ON DELETE SET NULL is nulled and its row kept.
 */
export function repairOrphans(db: Db): number {
  const count = (): number => (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
  const before = count();
  if (before === 0) return 0;

  return tx(db, () => {
    // Deleting a parent creates fresh orphans one level down, so this runs until the count
    // stops changing rather than once in a guessed order.
    // A reference declared ON DELETE SET NULL must be NULLED, not used as a reason to delete
    // the row: a claim whose cached page was removed is still a real verified claim, and
    // deleting it would destroy evidence an email may already be citing.
    db.exec(`
      UPDATE claim               SET source_page_id = NULL WHERE source_page_id IS NOT NULL AND source_page_id NOT IN (SELECT id FROM source_page);
      UPDATE contact             SET source_page_id = NULL WHERE source_page_id IS NOT NULL AND source_page_id NOT IN (SELECT id FROM source_page);
      UPDATE source_page         SET company_id     = NULL WHERE company_id     IS NOT NULL AND company_id     NOT IN (SELECT id FROM company);
      UPDATE email_draft_version SET llm_call_id    = NULL WHERE llm_call_id    IS NOT NULL AND llm_call_id    NOT IN (SELECT id FROM llm_call);
      UPDATE email_draft         SET follows_send_id= NULL WHERE follows_send_id IS NOT NULL AND follows_send_id NOT IN (SELECT id FROM send_log);
      UPDATE reply               SET llm_call_id    = NULL WHERE llm_call_id    IS NOT NULL AND llm_call_id    NOT IN (SELECT id FROM llm_call);
      UPDATE share_audit         SET session_id     = NULL WHERE session_id     IS NOT NULL AND session_id     NOT IN (SELECT id FROM share_session);
    `);

    for (let pass = 0; pass < 6; pass++) {
      const start = count();
      db.exec(`
        DELETE FROM campaign_company
          WHERE company_id NOT IN (SELECT id FROM company)
             OR campaign_id NOT IN (SELECT id FROM campaign);
        DELETE FROM contact       WHERE company_id NOT IN (SELECT id FROM company);
        DELETE FROM claim         WHERE company_id NOT IN (SELECT id FROM company);
        DELETE FROM email_draft
          WHERE contact_id NOT IN (SELECT id FROM contact)
             OR campaign_company_id NOT IN (SELECT id FROM campaign_company)
             OR campaign_id NOT IN (SELECT id FROM campaign);
        DELETE FROM email_draft_version WHERE draft_id NOT IN (SELECT id FROM email_draft);
        DELETE FROM send_log
          WHERE draft_id NOT IN (SELECT id FROM email_draft)
             OR version_id NOT IN (SELECT id FROM email_draft_version)
             OR contact_id NOT IN (SELECT id FROM contact)
             OR campaign_id NOT IN (SELECT id FROM campaign);
        DELETE FROM reply
          WHERE (send_log_id IS NOT NULL AND send_log_id NOT IN (SELECT id FROM send_log))
             OR (contact_id  IS NOT NULL AND contact_id  NOT IN (SELECT id FROM contact))
             OR (campaign_id IS NOT NULL AND campaign_id NOT IN (SELECT id FROM campaign));
        DELETE FROM interview_turn WHERE product_id NOT IN (SELECT id FROM product);
        DELETE FROM sequence_step  WHERE campaign_id NOT IN (SELECT id FROM campaign);
        DELETE FROM tool_call_log  WHERE llm_call_id NOT IN (SELECT id FROM llm_call);
        DELETE FROM share_session  WHERE invite_id IS NOT NULL AND invite_id NOT IN (SELECT id FROM share_invite);
      `);
      const now2 = count();
      if (now2 === 0 || now2 === start) break;
    }
    return before - count();
  });
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
