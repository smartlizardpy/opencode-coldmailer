/**
 * Deleting a campaign.
 *
 * The type-the-name gate exists for one specific reason: the send log goes with the campaign,
 * and the daily cap counts what is left, so deleting a campaign you have already sent from
 * quietly frees capacity. That reason does not apply to a campaign that never sent anything,
 * and a confirmation people learn to click through is worse than none.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, ulid, now } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { Router } from "../../src/server/http/server.ts";
import { registerRoutes } from "../../src/server/http/routes.ts";

function app() {
  const db = openDb(":memory:");
  migrate(db);
  const r = new Router();
  registerRoutes(r, {
    db, bus: { emit: () => {} }, log: () => {}, busy: new Map(), version: "test",
    supervisor: { status: "ready", stderrTail: [] }, llm: { queue: { stats: () => ({}) } },
    sender: { isRunning: false, start: () => {}, stop: () => {} },
    tunnel: { state: () => ({ status: "stopped", stderrTail: [] }), hostname: undefined },
    port: () => 0, slots: () => ({ research: {}, writing: {} }),
  } as never);
  return { db, r };
}

const call = (r: Router, method: string, path: string, body: unknown = {}) => {
  const m = r.match(method, path);
  if (!m) throw new Error(`no route for ${method} ${path}`);
  return m.handler({ params: m.params, body, query: new URLSearchParams(), role: "owner", remote: false } as never);
};

function seedCampaign(db: any, { sent = 0 } = {}) {
  const t = now();
  const p = ulid(), camp = ulid(), co = ulid(), cc = ulid();
  db.prepare("INSERT INTO product (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)").run(p, "P", "ready", t, t);
  db.prepare("INSERT INTO campaign (id,product_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(camp, p, "Haber Siteleri", t, t);
  db.prepare("INSERT INTO company (id,domain,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(co, "x.com", "X", t, t);
  db.prepare("INSERT INTO campaign_company (id,campaign_id,company_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(cc, camp, co, t, t);

  // One draft per send: send_log has a partial unique index allowing at most one live send per
  // draft, which is the schema saying a draft is sent once.
  const drafts = Math.max(1, sent);
  for (let i = 0; i < drafts; i++) {
    const ct = ulid(), d = ulid(), v = ulid();
    db.prepare("INSERT INTO contact (id,company_id,email,source_url,source_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(ct, co, `a${i}@x.com`, "https://x.com/c", "published", t, t);
    db.prepare("INSERT INTO email_draft (id,campaign_id,campaign_company_id,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(d, camp, cc, ct, t, t);
    db.prepare("INSERT INTO email_draft_version (id,draft_id,version,subject,body_text,author,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(v, d, 1, "s", "b", "llm", t);
    if (i < sent) {
      db.prepare(
        `INSERT INTO send_log (id,campaign_id,draft_id,version_id,contact_id,to_email,from_email,subject,message_id,status,sent_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(ulid(), camp, d, v, ct, `a${i}@x.com`, "me@x.com", "s", `<m${i}@x.com>`, "sent", t, t);
    }
  }
  return camp;
}

test("a campaign that never sent anything deletes without transcribing its name", () => {
  const { db, r } = app();
  const id = seedCampaign(db);
  const out = call(r, "POST", `/api/campaigns/${id}/delete`, {}) as any;
  assert.equal(out.ok, true);
  assert.equal(out.removed.drafts, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM campaign").get().n, 0);
});

test("a campaign that HAS sent still demands the name, and says why", () => {
  const { db, r } = app();
  const id = seedCampaign(db, { sent: 3 });
  assert.throws(() => call(r, "POST", `/api/campaigns/${id}/delete`, {}), (e: any) => {
    assert.equal(e.code, "CONFIRM_REQUIRED");
    assert.match(e.message, /daily cap/, "the reason for the friction has to be in the message");
    return true;
  });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM campaign").get().n, 1, "and nothing was deleted");
});

test("the right name gets a sent-from campaign deleted", () => {
  const { db, r } = app();
  const id = seedCampaign(db, { sent: 2 });
  const out = call(r, "POST", `/api/campaigns/${id}/delete`, { confirm: "Haber Siteleri" }) as any;
  assert.equal(out.removed.sent, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM send_log").get().n, 0);
});

test("the wrong name is refused", () => {
  const { db, r } = app();
  const id = seedCampaign(db, { sent: 1 });
  assert.throws(() => call(r, "POST", `/api/campaigns/${id}/delete`, { confirm: "haber siteleri" }));
});

test("the companies and their researched facts survive the campaign", () => {
  // They are shared across campaigns, and re-crawling sites we have already been polite to
  // once is not free.
  const { db, r } = app();
  const id = seedCampaign(db);
  call(r, "POST", `/api/campaigns/${id}/delete`, {});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM company").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM contact").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM campaign_company").get().n, 0, "but the link goes");
});
