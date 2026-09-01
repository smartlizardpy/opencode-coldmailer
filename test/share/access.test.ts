/**
 * The boundary between the two surfaces.
 *
 * Everything here is about one question: can the shared link reach something it must not?
 * The allow-list is positive, so the most valuable test is not "is /api/settings blocked" -
 * it is "does a route nobody remembered still fail closed".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/server/db/index.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import {
  allows, anonymousAllows, createInvite, listInvites, listSessions, readCookie,
  redeemInvite, revokeEverything, revokeInvite, revokeSession, revokeSessionByToken,
  sessionCookie, sessionFor,
} from "../../src/server/http/access.ts";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

/* ------------------------------------------------------------------ scopes */

test("a route nobody added to the allow-list is closed to the shared surface", () => {
  // The whole design rests on this: forgetting about access.ts must fail shut, not open.
  assert.equal(allows("sender", "GET", "/api/something-invented-next-tuesday"), false);
  assert.equal(allows("sender", "POST", "/api/campaigns/x/some-new-action"), false);
});

test("the shared surface cannot read settings, keys, or the company profile", () => {
  for (const p of ["/api/settings", "/api/keys", "/api/company", "/api/llm-calls", "/api/integrity", "/api/share"]) {
    assert.equal(allows("sender", "GET", p), false, `GET ${p} must be owner-only`);
  }
  for (const p of ["/api/settings", "/api/keys", "/api/company", "/api/settings/test",
                   "/api/settings/send-test", "/api/settings/forget-password", "/api/models/probe",
                   "/api/share/start", "/api/share/invite", "/api/share/revoke-all"]) {
    assert.equal(allows("sender", "POST", p), false, `POST ${p} must be owner-only`);
  }
});

test("the shared surface cannot delete a campaign, because that deletes the send log", () => {
  // The daily cap counts what actually left in the last 24 hours, from send_log. Deleting a
  // campaign frees capacity, so it is a sending decision disguised as tidying up.
  assert.equal(allows("sender", "POST", "/api/campaigns/01ABC/delete"), false);
  assert.equal(allows("sender", "POST", "/api/campaigns/01ABC/settings"), true);
});

test("the shared surface cannot un-block an address someone deliberately blocked", () => {
  assert.equal(allows("sender", "POST", "/api/suppression"), true, "adding is part of sending");
  assert.equal(allows("sender", "POST", "/api/suppression/01ABC/delete"), false);
});

test("the shared surface can do the whole outreach loop", () => {
  const must: Array<[string, string]> = [
    ["GET", "/api/campaigns"], ["POST", "/api/campaigns"],
    ["POST", "/api/campaigns/01ABC/discover"], ["POST", "/api/campaigns/01ABC/run"],
    ["GET", "/api/campaigns/01ABC/drafts"], ["GET", "/api/drafts/01ABC"],
    ["POST", "/api/drafts/01ABC/approve"], ["POST", "/api/drafts/01ABC/unapprove"],
    ["POST", "/api/drafts/bulk-approve"], ["POST", "/api/send/start"], ["POST", "/api/send/pause"],
    ["GET", "/api/replies"], ["POST", "/api/replies/01ABC/draft"],
    ["POST", "/api/campaigns/reframe"], ["POST", "/api/campaigns/suggest"],
    ["POST", "/api/campaigns/test-target"],
    ["POST", "/api/share/replay"],
  ];
  for (const [m, p] of must) assert.equal(allows("sender", m, p), true, `${m} ${p} should be allowed`);
});

test("an id in the path cannot smuggle in another segment", () => {
  // ":id" compiles to [^/]+, so this must not match POST /api/campaigns/:id/settings.
  assert.equal(allows("sender", "POST", "/api/campaigns/a/b/settings"), false);
});

test("the owner surface is not filtered at all", () => {
  assert.equal(allows("owner", "POST", "/api/settings"), true);
  assert.equal(allows("owner", "GET", "/api/anything-at-all"), true);
});

test("without a session, only the join screen and its assets are reachable", () => {
  assert.equal(anonymousAllows("GET", "/"), true);
  assert.equal(anonymousAllows("GET", "/app.js"), true);
  assert.equal(anonymousAllows("POST", "/api/share/redeem"), true);
  assert.equal(anonymousAllows("GET", "/api/share/me"), true);
  assert.equal(anonymousAllows("GET", "/api/campaigns"), false);
  assert.equal(anonymousAllows("GET", "/api/drafts/01ABC"), false);
});

/* ----------------------------------------------------------------- invites */

test("an invite token is never stored, so the database is not a login", () => {
  const db = fresh();
  const { token } = createInvite(db, "Co-founder");
  const rows = db.prepare("SELECT token_hash FROM share_invite").all() as Array<{ token_hash: string }>;
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  // And the plaintext appears nowhere in the file.
  const dump = JSON.stringify(db.prepare("SELECT * FROM share_invite").all());
  assert.ok(!dump.includes(token), "the invite token must not be recoverable from the database");
});

test("redeeming an invite yields a session, and the session token is hashed too", () => {
  const db = fresh();
  const { token } = createInvite(db, "Co-founder");
  const r = redeemInvite(db, token, "Firefox");
  assert.equal(r.ok, true);
  assert.ok(r.token);
  const s = sessionFor(db, r.token);
  assert.equal(s?.role, "sender");
  assert.equal(s?.label, "Co-founder");
  const stored = db.prepare("SELECT token_hash FROM share_session").get() as { token_hash: string };
  assert.notEqual(stored.token_hash, r.token);
});

test("a wrong token is refused and says nothing about why", () => {
  const db = fresh();
  createInvite(db, "Co-founder");
  const r = redeemInvite(db, "not-a-real-token", "curl");
  assert.equal(r.ok, false);
  assert.equal(r.error, "that invite link is not valid");
});

test("an expired invite cannot be redeemed", () => {
  const db = fresh();
  const { token } = createInvite(db, "Late", -1000);
  assert.equal(redeemInvite(db, token, "").ok, false);
});

test("revoking an invite ends the sessions it created — otherwise revoking is theatre", () => {
  const db = fresh();
  const { invite, token } = createInvite(db, "Co-founder");
  const a = redeemInvite(db, token, "laptop");
  const b = redeemInvite(db, token, "phone");
  assert.equal(listSessions(db).length, 2);

  const ended = revokeInvite(db, invite.id);
  assert.equal(ended, 2);
  assert.equal(sessionFor(db, a.token), undefined);
  assert.equal(sessionFor(db, b.token), undefined);
  assert.equal(redeemInvite(db, token, "again").ok, false, "a revoked invite cannot be reused");
});

test("one device can be signed out without ending the other", () => {
  const db = fresh();
  const { token } = createInvite(db, "Co-founder");
  const laptop = redeemInvite(db, token, "laptop");
  const phone = redeemInvite(db, token, "phone");
  revokeSession(db, sessionFor(db, laptop.token)!.id);
  assert.equal(sessionFor(db, laptop.token), undefined);
  assert.ok(sessionFor(db, phone.token), "revoking one device must not sign the other out");
});

test("revoke-all leaves nothing usable", () => {
  const db = fresh();
  const { token } = createInvite(db, "Co-founder");
  const s = redeemInvite(db, token, "laptop");
  const counts = revokeEverything(db);
  assert.equal(counts.invites, 1);
  assert.equal(counts.sessions, 1);
  assert.equal(sessionFor(db, s.token), undefined);
  assert.equal(redeemInvite(db, token, "x").ok, false);
  assert.equal(listInvites(db).every((i) => i.revoked_at), true);
});

test("a teammate signing out ends their own session and nobody else's", () => {
  const db = fresh();
  const { token } = createInvite(db, "Co-founder");
  const a = redeemInvite(db, token, "laptop");
  const b = redeemInvite(db, token, "phone");
  assert.equal(revokeSessionByToken(db, a.token), true);
  assert.equal(sessionFor(db, a.token), undefined);
  assert.ok(sessionFor(db, b.token));
});

test("an expired session stops working without anyone having to sweep the table", () => {
  const db = fresh();
  const { token } = createInvite(db, "Co-founder");
  const s = redeemInvite(db, token, "laptop");
  db.prepare("UPDATE share_session SET expires_at=?").run(Date.now() - 1);
  assert.equal(sessionFor(db, s.token), undefined);
  assert.equal(listSessions(db).length, 0);
});

test("no cookie at all is not a session", () => {
  const db = fresh();
  assert.equal(sessionFor(db, undefined), undefined);
  assert.equal(sessionFor(db, ""), undefined);
});

/* ----------------------------------------------------------------- cookies */

test("the session cookie cannot travel over plaintext or be read by script", () => {
  const c = sessionCookie("abc", 100);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);          // the shared surface is only ever HTTPS
  assert.match(c, /SameSite=Lax/);    // half of the CSRF story; the Origin check is the other
});

test("cookie parsing picks the right name out of a crowded header", () => {
  assert.equal(readCookie("a=1; cc_share=xyz; b=2", "cc_share"), "xyz");
  assert.equal(readCookie("cc_share_other=no", "cc_share"), undefined);
  assert.equal(readCookie(undefined, "cc_share"), undefined);
});

/* --------------------------------------------------- campaign deletion gate */

test("the audit feed, replay scrollback and campaign deletion stay owner-only", () => {
  assert.equal(allows("sender", "GET", "/api/share/activity"), false);
  assert.equal(allows("sender", "GET", "/api/share/replays"), false);
  assert.equal(allows("sender", "GET", "/api/share/replays/01ABC/events"), false);
  assert.equal(allows("sender", "POST", "/api/share/control/request"), false);
  assert.equal(allows("sender", "POST", "/api/share/control/command"), false);
  assert.equal(allows("sender", "POST", "/api/campaigns/01ABC/delete"), false);
});
