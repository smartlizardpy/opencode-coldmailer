/** The JSON API. Every long job runs in the background and reports progress over SSE. */
import type { Router, RouteCtx } from "./server.ts";
import type { AppContext } from "../context.ts";
import { readImapConfig, readSmtpConfig, type SmtpSettings } from "../context.ts";
import { ulid, now, tx } from "../db/index.ts";
import { getSetting, setSetting, type SendingSettings } from "../db/settings.ts";
import { probeModels } from "../opencode/models.ts";
import { deleteSecret, getSecret, setSecret, storageDescription } from "../mail/secrets.ts";
import { verifySmtp, GMAIL_PRESET } from "../mail/smtp.ts";
import { verifyImap, pollReplies, fetchReplyBody, GMAIL_IMAP } from "../mail/imap.ts";
import { approveDraft, contactedElsewhere, isSuppressed, sendGuards, sendOne, suppress } from "../queue/sendQueue.ts";
import { addManualCompanies, discoverCompanies, enrichCompany, findContacts, prefetchCompanies, briefOf } from "../research/pipeline.ts";
import { composeDraft, saveHumanEdit } from "../research/compose.ts";
import * as P from "../llm/prompts.ts";
import { dashboardStats, toCsv, EXPORTS } from "../stats.ts";
import { DEFAULT_FOLLOWUPS, dueFollowUps, listSteps, seedDefaultSteps, setSteps, upcomingFollowUps } from "../queue/sequences.ts";

const bad = (msg: string, code = "BAD_REQUEST", status = 400) => Object.assign(new Error(msg), { code, status });

/** One background job at a time per key, so a double-click cannot start two pipelines. */
function background(app: AppContext, key: string, label: string, fn: () => Promise<unknown>): { started: boolean; label: string } {
  if (app.busy.has(key)) return { started: false, label: app.busy.get(key)!.label };
  app.busy.set(key, { label, startedAt: Date.now() });
  app.bus.emit("job:start", { key, label });
  void (async () => {
    try {
      const result = await fn();
      app.bus.emit("job:done", { key, label, result });
    } catch (e) {
      const err = e as any;
      app.log(`job ${key} failed: ${err?.message}`);
      app.bus.emit("job:error", { key, label, error: err?.message ?? String(e), code: err?.code });
    } finally {
      app.busy.delete(key);
      app.bus.emit("job:end", { key });
    }
  })();
  return { started: true, label };
}

export function registerRoutes(r: Router, app: AppContext): void {
  const { db } = app;

  /* ------------------------------------------------------------- health */
  r.get("/api/health", () => {
    const slots = app.slots();
    const smtp = getSetting<SmtpSettings>(db, "smtp", {});
    const guards = sendGuards(db);
    return {
      version: app.version,
      opencode: {
        status: app.supervisor.status, url: app.supervisor.url,
        binPath: app.supervisor.binPath, stderrTail: app.supervisor.stderrTail.slice(-20),
      },
      model: {
        research: { active: slots.research.active, status: slots.research.status, ranking: slots.research.ranking },
        writing: { active: slots.writing.active, status: slots.writing.status, ranking: slots.writing.ranking },
        probedAt: slots.probedAt,
      },
      smtp: {
        configured: !!smtp.configured, user: smtp.user ?? null,
        lastVerifiedAt: smtp.lastVerifiedAt ?? null, lastError: smtp.lastError ?? null,
      },
      sending: { ...guards, running: app.sender.isRunning, lastOutcome: app.sender.lastOutcome, nextSendAt: app.sender.nextSendAt },
      review: { needsReview: (db.prepare("SELECT COUNT(*) c FROM email_draft WHERE status='needs_review'").get() as any).c },
      replies: { unhandled: (db.prepare("SELECT COUNT(*) c FROM reply WHERE handled=0").get() as any).c },
      jobs: [...app.busy.entries()].map(([key, v]) => ({ key, ...v })),
      queue: app.llm.queue.stats(),
      ok: app.supervisor.status === "ready" && slots.writing.status === "ok",
    };
  });

  r.get("/api/stats", ({ query }: RouteCtx) => {
    const campaignId = query.get("campaign") ?? undefined;
    const stats = dashboardStats(db, campaignId);
    // The funnel is a DB query; follow-ups need the sequence rules, so they are filled here.
    stats.followUpsDue = dueFollowUps(db, campaignId, 500).length;
    return stats;
  });

  /* ----------------------------------------------------------- settings */
  r.get("/api/settings", async () => ({
    smtp: getSetting<SmtpSettings>(db, "smtp", {}),
    sending: getSetting<SendingSettings>(db, "sending", {} as SendingSettings),
    opencode: getSetting(db, "opencode", {}),
    hasPassword: !!(await getSecret(db, "smtp.password")),
    secretStorage: (db.prepare("SELECT storage FROM secret_ref WHERE name='smtp.password'").get() as any)?.storage ?? null,
    defaults: { smtp: GMAIL_PRESET, imap: GMAIL_IMAP },
  }));

  r.post("/api/settings", async ({ body }: RouteCtx) => {
    if (body.sending) setSetting(db, "sending", { ...getSetting(db, "sending", {}), ...body.sending });
    if (body.opencode) setSetting(db, "opencode", { ...getSetting(db, "opencode", {}), ...body.opencode });
    if (body.smtp) {
      const prev = getSetting<SmtpSettings>(db, "smtp", {});
      // Never echo or store the password here - it goes to the Keychain only.
      const { password, ...rest } = body.smtp;
      setSetting(db, "smtp", { ...prev, ...rest });
      if (password) {
        const storage = await setSecret(db, "smtp.password", password);
        app.log(`SMTP password stored: ${storageDescription(storage)}`);
      }
    }
    return { ok: true };
  });

  r.post("/api/settings/test", async ({ body }: RouteCtx) => {
    const s = { ...getSetting<SmtpSettings>(db, "smtp", {}), ...(body.smtp ?? {}) };
    if (!s.user) throw bad("enter your email address first");
    const password = body.smtp?.password ?? (await getSecret(db, "smtp.password"));
    if (!password) throw bad("enter your app password first");
    const cfg = { host: s.host ?? GMAIL_PRESET.host, port: s.port ?? GMAIL_PRESET.port,
      secure: s.secure ?? GMAIL_PRESET.secure, user: s.user, fromEmail: s.fromEmail ?? s.user, fromName: s.fromName ?? "" };

    const smtpRes = await verifySmtp(cfg, password);
    const imapRes = await verifyImap({ host: s.imapHost ?? GMAIL_IMAP.host, port: s.imapPort ?? GMAIL_IMAP.port,
      secure: s.imapSecure ?? GMAIL_IMAP.secure, user: s.user }, password);

    setSetting(db, "smtp", {
      ...s, configured: smtpRes.ok,
      lastVerifiedAt: smtpRes.ok ? now() : null,
      lastError: smtpRes.ok ? null : smtpRes.error ?? null,
    });
    if (smtpRes.ok && password) await setSecret(db, "smtp.password", password);
    return { smtp: smtpRes, imap: imapRes };
  });

  r.post("/api/settings/forget-password", async () => { await deleteSecret(db, "smtp.password"); return { ok: true }; });

  r.post("/api/models/probe", () => background(app, "probe", "Probing models", async () => {
    const client = app.supervisor.client;
    if (!client) throw bad("opencode is not running", "OPENCODE_DOWN", 503);
    const enableExa = (getSetting<{ enableExa?: boolean }>(db, "opencode", {}) ?? {}).enableExa ?? false;
    const slots = await probeModels(client, { enableExa, maxCandidates: 3 });
    app.setSlots(slots);
    setSetting(db, "model_slots", slots);
    return slots;
  }));

  /* ---------------------------------------------------------- interview */
  r.get("/api/product", () => db.prepare("SELECT * FROM product ORDER BY id DESC LIMIT 1").get() ?? null);

  r.post("/api/interview/start", () => {
    const id = ulid();
    db.prepare("INSERT INTO product (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(id, "Untitled", now(), now());
    return { productId: id, turns: [] };
  });

  r.get("/api/interview/:productId", ({ params }: RouteCtx) =>
    db.prepare("SELECT seq, role, content, field_hint AS topic FROM interview_turn WHERE product_id=? ORDER BY seq")
      .all(params.productId));

  r.post("/api/interview/:productId/next", async ({ params, body }: RouteCtx) => {
    const productId = params.productId;
    // field_hint carries which topic each question was for, so coverage survives a restart.
    const turns = db.prepare("SELECT seq, role, content, field_hint AS topic FROM interview_turn WHERE product_id=? ORDER BY seq")
      .all(productId) as Array<{ seq: number; role: string; content: string; topic: string | null }>;
    if (typeof body.answer === "string" && body.answer.trim()) {
      db.prepare("INSERT INTO interview_turn (id,product_id,seq,role,content,created_at) VALUES (?,?,?,'user',?,?)")
        .run(ulid(), productId, turns.length, body.answer.trim(), now());
      turns.push({ seq: turns.length, role: "user", content: body.answer.trim(), topic: null });
    }
    const r2 = await app.llm.run<{ done: boolean; question: string; topic?: string; is_follow_up?: boolean }>({
      task: "interview.next_question", system: P.INTERVIEW_SYSTEM,
      prompt: P.interviewNextPrompt(turns), schema: P.INTERVIEW_NEXT_SCHEMA,
      priority: "interactive", subject: { type: "product", id: productId },
    });
    if (!r2.value.done && r2.value.question) {
      db.prepare("INSERT INTO interview_turn (id,product_id,seq,role,content,field_hint,created_at) VALUES (?,?,?,'assistant',?,?,?)")
        .run(ulid(), productId, turns.length, r2.value.question, r2.value.topic || null, now());
    }
    return { done: r2.value.done, question: r2.value.question, topic: r2.value.topic ?? null, count: turns.length };
  });

  r.post("/api/interview/:productId/finish", async ({ params }: RouteCtx) => {
    const productId = params.productId;
    const turns = db.prepare("SELECT role, content FROM interview_turn WHERE product_id=? ORDER BY seq")
      .all(productId) as Array<{ role: string; content: string }>;
    if (turns.length === 0) throw bad("nothing to summarise yet");
    const r2 = await app.llm.run<any>({
      task: "interview.extract_product", system: P.BRIEF_SYSTEM,
      prompt: P.productBriefPrompt(turns), schema: P.PRODUCT_BRIEF_SCHEMA,
      priority: "interactive", subject: { type: "product", id: productId },
    });
    const b = r2.value;
    db.prepare(
      `UPDATE product SET name=?, one_liner=?, description=?, audience=?, job_to_be_done=?, before_state=?,
        objections=?, proof_points=?, disqualifiers=?, signals=?, price_anchor=?, tone_sample=?,
        status='ready', updated_at=? WHERE id=?`,
    ).run(b.name || "Untitled", b.one_liner ?? "", b.description ?? "", JSON.stringify(b.audience ?? {}),
          b.job_to_be_done ?? "", b.before_state ?? "", JSON.stringify(b.objections ?? []),
          JSON.stringify(b.proof_points ?? []), JSON.stringify(b.disqualifiers ?? []),
          JSON.stringify(b.signals ?? []), b.price_anchor ?? "", b.tone_sample ?? "", now(), productId);
    return db.prepare("SELECT * FROM product WHERE id=?").get(productId);
  });

  r.post("/api/product/:id", ({ params, body }: RouteCtx) => {
    const allowed = ["name", "one_liner", "description", "job_to_be_done", "before_state", "price_anchor",
                     "tone_sample", "sender_name", "sender_title", "sender_company"];
    const jsonFields = ["audience", "objections", "proof_points", "disqualifiers", "signals"];
    for (const k of allowed) if (k in body) db.prepare(`UPDATE product SET ${k}=?, updated_at=? WHERE id=?`).run(String(body[k] ?? ""), now(), params.id);
    for (const k of jsonFields) if (k in body) db.prepare(`UPDATE product SET ${k}=?, updated_at=? WHERE id=?`).run(JSON.stringify(body[k]), now(), params.id);
    return db.prepare("SELECT * FROM product WHERE id=?").get(params.id);
  });

  /* ---------------------------------------------------------- campaigns */
  r.get("/api/campaigns", () => db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM campaign_company cc WHERE cc.campaign_id=c.id) companies,
      (SELECT COUNT(*) FROM email_draft d WHERE d.campaign_id=c.id) drafts,
      (SELECT COUNT(*) FROM send_log s WHERE s.campaign_id=c.id AND s.status='sent') sent
     FROM campaign c ORDER BY c.id DESC`).all());

  r.post("/api/campaigns", ({ body }: RouteCtx) => {
    const product = db.prepare("SELECT id FROM product WHERE status='ready' ORDER BY id DESC LIMIT 1").get() as { id: string } | undefined;
    if (!product) throw bad("finish the product interview first");
    const id = ulid();
    db.prepare(
      `INSERT INTO campaign (id,product_id,name,goal,target_description,discovery_mode,contacts_per_company,
        allow_inferred_emails,daily_send_limit,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, product.id, body.name || "Untitled campaign", body.goal || "", body.target_description || "",
          body.discovery_mode === "manual" ? "manual" : "opencode_search",
          Math.min(5, Math.max(1, Number(body.contacts_per_company) || 3)),
          body.allow_inferred_emails ? 1 : 0,
          Math.max(1, Number(body.daily_send_limit) || 30), now(), now());
    seedDefaultSteps(db, id);
    return db.prepare("SELECT * FROM campaign WHERE id=?").get(id);
  });

  r.get("/api/campaigns/:id", ({ params }: RouteCtx) => {
    const c = db.prepare("SELECT * FROM campaign WHERE id=?").get(params.id);
    if (!c) throw bad("campaign not found", "NOT_FOUND", 404);
    return c;
  });

  r.post("/api/campaigns/:id/settings", ({ params, body }: RouteCtx) => {
    for (const k of ["name", "goal", "target_description", "contacts_per_company", "allow_inferred_emails", "daily_send_limit", "min_gap_seconds", "max_gap_seconds"]) {
      if (k in body) db.prepare(`UPDATE campaign SET ${k}=?, updated_at=? WHERE id=?`).run(body[k], now(), params.id);
    }
    return db.prepare("SELECT * FROM campaign WHERE id=?").get(params.id);
  });

  r.get("/api/campaigns/:id/companies", ({ params }: RouteCtx) => db.prepare(
    `SELECT cc.id, cc.status, cc.relevance_score, cc.relevance_reason, cc.matched_signal, cc.selected,
       cc.discovered_via, cc.discovered_url, cc.error_code, cc.error_message, cc.rejected_reason,
       cc.contact_notes,
       co.id company_id, co.name, co.domain, co.website_url, co.city, co.summary,
       (SELECT COUNT(*) FROM claim cl WHERE cl.campaign_company_id=cc.id AND cl.verified=1) verified_claims,
       (SELECT COUNT(*) FROM contact ct WHERE ct.company_id=co.id) contacts,
       (SELECT COUNT(*) FROM email_draft d WHERE d.campaign_company_id=cc.id) drafts
     FROM campaign_company cc JOIN company co ON co.id=cc.company_id
     WHERE cc.campaign_id=? ORDER BY cc.relevance_score DESC NULLS LAST, cc.id`).all(params.id));

  r.post("/api/campaigns/:id/discover", ({ params, body }: RouteCtx) =>
    background(app, `discover:${params.id}`, "Finding companies", async () => {
      const out = await discoverCompanies({ db, llm: app.llm, fetcher: app.fetcher }, params.id, { extra: body.extra });
      app.bus.emit("companies:changed", { campaignId: params.id });
      return out;
    }));

  r.post("/api/campaigns/:id/manual", ({ params, body }: RouteCtx) => {
    const entries = String(body.text ?? "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
      .map((line) => { const [website, ...name] = line.split(/\s+/); return { website, name: name.join(" ") || undefined }; });
    if (entries.length === 0) throw bad("paste at least one domain");
    const out = addManualCompanies(db, params.id, entries);
    app.bus.emit("companies:changed", { campaignId: params.id });
    return out;
  });

  r.post("/api/campaigns/:id/select-all", ({ params, body }: RouteCtx) => {
    // Rejected companies are never bulk-selected: they were already judged not to be the
    // target kind, and re-including them silently undoes that.
    const res = db.prepare(
      "UPDATE campaign_company SET selected=?, updated_at=? WHERE campaign_id=? AND status != 'rejected'",
    ).run(body.selected ? 1 : 0, now(), params.id);
    return { changed: Number(res.changes) };
  });

  r.post("/api/drafts/bulk-approve", ({ body }: RouteCtx) => {
    const ids: string[] = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
    let approved = 0, skipped = 0;
    tx(db, () => {
      for (const id of ids) {
        const d = db.prepare("SELECT contact_id FROM email_draft WHERE id=? AND status IN ('draft','needs_review')").get(id) as any;
        if (!d) { skipped++; continue; }
        const ct = db.prepare("SELECT email FROM contact WHERE id=?").get(d.contact_id) as { email: string } | undefined;
        // Suppression is re-checked here as well as at send: approving a suppressed address
        // should not even be possible.
        if (!ct || isSuppressed(db, ct.email).suppressed) { skipped++; continue; }
        approveDraft(db, id);
        approved++;
      }
    });
    app.bus.emit("drafts:changed", {});
    return { approved, skipped };
  });

  r.post("/api/companies/:ccId/select", ({ params, body }: RouteCtx) => {
    db.prepare("UPDATE campaign_company SET selected=?, updated_at=? WHERE id=?").run(body.selected ? 1 : 0, now(), params.ccId);
    return { ok: true };
  });

  /** Put one company back in the queue. Clears the failure so it is genuinely re-attempted. */
  r.post("/api/companies/:ccId/retry", ({ params }: RouteCtx) => {
    const cc = db.prepare("SELECT campaign_id FROM campaign_company WHERE id=?").get(params.ccId) as any;
    if (!cc) throw bad("not found", "NOT_FOUND", 404);
    db.prepare(
      `UPDATE campaign_company SET status='discovered', selected=1, error_code=NULL,
         error_message=NULL, rejected_reason=NULL, contact_notes='[]', updated_at=? WHERE id=?`,
    ).run(now(), params.ccId);
    // Drop the cached pages too: a retry that reads the same cached failure is not a retry.
    db.prepare("DELETE FROM source_page WHERE company_id=(SELECT company_id FROM campaign_company WHERE id=?)")
      .run(params.ccId);
    app.bus.emit("companies:changed", { campaignId: cc.campaign_id });
    return { ok: true };
  });

  r.get("/api/companies/:ccId", ({ params }: RouteCtx) => {
    const cc = db.prepare(
      `SELECT cc.*, co.name, co.domain, co.website_url, co.summary, co.city
       FROM campaign_company cc JOIN company co ON co.id=cc.company_id WHERE cc.id=?`).get(params.ccId) as any;
    if (!cc) throw bad("not found", "NOT_FOUND", 404);
    return {
      ...cc,
      claims: db.prepare("SELECT id,claim,quote,source_url,verified,verify_method,verify_score FROM claim WHERE campaign_company_id=? ORDER BY verified DESC, id").all(params.ccId),
      contacts: db.prepare("SELECT * FROM contact WHERE company_id=? ORDER BY confidence DESC").all(cc.company_id),
      pages: db.prepare("SELECT id,url,title,http_status,bytes FROM source_page WHERE company_id=? ORDER BY id").all(cc.company_id),
    };
  });

  /** The whole pipeline for the selected companies, sequentially, with live progress. */
  r.post("/api/campaigns/:id/run", ({ params }: RouteCtx) =>
    background(app, `run:${params.id}`, "Researching and drafting", async () => {
      const rows = db.prepare("SELECT id FROM campaign_company WHERE campaign_id=? AND selected=1 ORDER BY relevance_score DESC NULLS LAST")
        .all(params.id) as Array<{ id: string }>;
      if (rows.length === 0) throw bad("tick at least one company first");
      const summary = { companies: rows.length, enriched: 0, contacts: 0, drafts: 0, failures: [] as string[] };

      db.prepare("UPDATE campaign SET status='researching', updated_at=? WHERE id=?").run(now(), params.id);

      // Fetch every selected company's pages first, several hosts at a time. The model stages
      // below are serialised anyway, so this is where the wall-clock actually comes back.
      app.bus.emit("run:progress", { campaignId: params.id, index: 0, total: rows.length, stage: "fetching sites" });
      await prefetchCompanies({ db, llm: app.llm, fetcher: app.fetcher }, rows.map((r) => r.id), 4,
        (doneN, total) => app.bus.emit("run:progress", {
          campaignId: params.id, index: doneN, total, stage: "fetching sites",
        }));

      for (const [i, row] of rows.entries()) {
        const co = db.prepare("SELECT co.name FROM campaign_company cc JOIN company co ON co.id=cc.company_id WHERE cc.id=?").get(row.id) as { name: string };
        app.bus.emit("run:progress", { campaignId: params.id, index: i + 1, total: rows.length, company: co?.name, stage: "researching" });
        try {
          const e = await enrichCompany({ db, llm: app.llm, fetcher: app.fetcher }, row.id);
          summary.enriched++;
          if (e.recheck && !e.recheck.matches_target) {
            summary.failures.push(`${co?.name}: not the target kind - it is a ${e.recheck.entity_kind}`);
            app.bus.emit("run:progress", { campaignId: params.id, index: i + 1, total: rows.length, company: co?.name, stage: "rejected" });
            continue;   // do not spend contact-finding or writing on something we just rejected
          }
          app.bus.emit("run:progress", { campaignId: params.id, index: i + 1, total: rows.length, company: co?.name, stage: "finding contacts", verified: e.verified });

          const f = await findContacts({ db, llm: app.llm, fetcher: app.fetcher }, row.id);
          summary.contacts += f.added;
          if (f.added === 0) { summary.failures.push(`${co?.name}: no publishable address`); continue; }

          const contacts = db.prepare(
            "SELECT ct.id FROM contact ct JOIN campaign_company cc ON cc.company_id=ct.company_id WHERE cc.id=? ORDER BY ct.confidence DESC",
          ).all(row.id) as Array<{ id: string }>;
          app.bus.emit("run:progress", { campaignId: params.id, index: i + 1, total: rows.length, company: co?.name, stage: "writing" });
          for (const c of contacts) {
            try { await composeDraft({ db, llm: app.llm }, row.id, c.id); summary.drafts++; }
            catch (err) { summary.failures.push(`${co?.name}: draft failed - ${(err as Error).message.slice(0, 120)}`); }
          }
        } catch (err) {
          summary.failures.push(`${co?.name}: ${(err as Error).message.slice(0, 140)}`);
        }
      }
      db.prepare("UPDATE campaign SET status='ready', updated_at=? WHERE id=?").run(now(), params.id);
      app.bus.emit("drafts:changed", { campaignId: params.id });
      return summary;
    }));

  /* ------------------------------------------------------------- drafts */
  r.get("/api/campaigns/:id/drafts", ({ params }: RouteCtx) => db.prepare(
    `SELECT d.draft_id, d.status, d.subject, d.body_text, d.version, d.author, d.personalization,
       d.step_number, d.word_count, d.quality_flags,
       ct.email, ct.full_name, ct.title, ct.source_kind, ct.source_url, ct.confidence,
       co.name company, co.domain,
       (SELECT sent_at FROM send_log s WHERE s.draft_id=d.draft_id AND s.status='sent') sent_at
     FROM email_draft_current d
     JOIN contact ct ON ct.id=d.contact_id JOIN campaign_company cc ON cc.id=d.campaign_company_id
     JOIN company co ON co.id=cc.company_id
     WHERE d.campaign_id=? ORDER BY d.status, co.name`).all(params.id));

  r.get("/api/drafts/:id", ({ params }: RouteCtx) => {
    const d = db.prepare("SELECT * FROM email_draft_current WHERE draft_id=?").get(params.id) as any;
    if (!d) throw bad("draft not found", "NOT_FOUND", 404);
    const cited = JSON.parse(d.personalization || "[]") as Array<{ claim_id: string }>;
    const claims = cited.length
      ? db.prepare(`SELECT id,claim,quote,source_url,verified FROM claim WHERE id IN (${cited.map(() => "?").join(",")})`).all(...cited.map((c) => c.claim_id))
      : [];
    const company = db.prepare(
      `SELECT co.name FROM campaign_company cc JOIN company co ON co.id=cc.company_id WHERE cc.id=?`,
    ).get(d.campaign_company_id) as { name: string } | undefined;
    return {
      ...d, claims, company: company?.name ?? "",
      // Shown as a warning in review, so it is seen before approving rather than as a
      // silent refusal at send time.
      alreadyContacted: contactedElsewhere(db, d.contact_id, d.campaign_id),
      versions: db.prepare("SELECT version,subject,author,edit_note,created_at FROM email_draft_version WHERE draft_id=? ORDER BY version DESC").all(params.id),
      contact: db.prepare("SELECT * FROM contact WHERE id=?").get(d.contact_id),
    };
  });

  r.post("/api/drafts/:id/edit", ({ params, body }: RouteCtx) => {
    if (!body.subject?.trim() || !body.body?.trim()) throw bad("subject and body are required");
    const version = saveHumanEdit(db, params.id, body.subject.trim(), body.body, body.note);
    return { version };
  });

  r.post("/api/drafts/:id/regenerate", async ({ params, body }: RouteCtx) => {
    const d = db.prepare("SELECT campaign_company_id, contact_id FROM email_draft WHERE id=?").get(params.id) as any;
    if (!d) throw bad("draft not found", "NOT_FOUND", 404);
    return composeDraft({ db, llm: app.llm }, d.campaign_company_id, d.contact_id,
      { instruction: body.instruction, priority: "interactive" });
  });

  r.post("/api/drafts/:id/approve", ({ params }: RouteCtx) => {
    const d = db.prepare("SELECT contact_id FROM email_draft WHERE id=?").get(params.id) as any;
    if (!d) throw bad("draft not found", "NOT_FOUND", 404);
    const ct = db.prepare("SELECT email FROM contact WHERE id=?").get(d.contact_id) as { email: string };
    const s = isSuppressed(db, ct.email);
    if (s.suppressed) throw bad(`${ct.email} is on the suppression list (${s.reason})`, "SUPPRESSED");
    approveDraft(db, params.id);
    app.bus.emit("drafts:changed", {});
    return { ok: true };
  });

  r.post("/api/drafts/:id/skip", ({ params }: RouteCtx) => {
    db.prepare("UPDATE email_draft SET status='discarded', updated_at=? WHERE id=?").run(now(), params.id);
    return { ok: true };
  });

  r.post("/api/drafts/:id/send-now", async ({ params }: RouteCtx) => {
    const cfg = readSmtpConfig(db);
    if (!cfg) throw bad("configure SMTP first", "NO_SMTP");
    approveDraft(db, params.id);
    const out = await sendOne(db, params.id, cfg);
    app.bus.emit("drafts:changed", {});
    return out;
  });

  /* ------------------------------------------------------------ sending */
  r.get("/api/send/status", () => ({
    ...sendGuards(db), running: app.sender.isRunning,
    lastOutcome: app.sender.lastOutcome, nextSendAt: app.sender.nextSendAt,
    approved: (db.prepare("SELECT COUNT(*) c FROM email_draft WHERE status='approved'").get() as any).c,
    recent: db.prepare(
      `SELECT s.to_email, s.subject, s.status, s.sent_at, s.error_message
       FROM send_log s ORDER BY s.id DESC LIMIT 25`).all(),
  }));

  r.post("/api/send/start", () => {
    if (!readSmtpConfig(db)) throw bad("configure and test SMTP first", "NO_SMTP");
    setSetting(db, "sending", { ...getSetting(db, "sending", {}), paused: false });
    app.sender.start();
    return { running: true };
  });

  r.post("/api/send/pause", () => {
    setSetting(db, "sending", { ...getSetting(db, "sending", {}), paused: true });
    app.sender.stop();
    return { running: false };
  });

  /* ---------------------------------------------------------- sequences */
  r.get("/api/campaigns/:id/sequence", ({ params }: RouteCtx) => ({
    steps: listSteps(db, params.id),
    defaults: DEFAULT_FOLLOWUPS,
    due: dueFollowUps(db, params.id),
    upcoming: upcomingFollowUps(db, params.id),
  }));

  r.post("/api/campaigns/:id/sequence", ({ params, body }: RouteCtx) => {
    if (!Array.isArray(body.steps)) throw bad("steps must be a list");
    setSteps(db, params.id, body.steps);
    return { steps: listSteps(db, params.id) };
  });

  /** Draft every follow-up that is due. Nothing is approved or sent - they land in Review. */
  r.post("/api/campaigns/:id/sequence/draft-due", ({ params }: RouteCtx) =>
    background(app, `followups:${params.id}`, "Drafting follow-ups", async () => {
      const due = dueFollowUps(db, params.id);
      const out = { drafted: 0, failures: [] as string[] };
      for (const [i, f] of due.entries()) {
        app.bus.emit("run:progress", { campaignId: params.id, index: i + 1, total: due.length, company: f.company, stage: `follow-up #${f.step}` });
        try {
          await composeDraft({ db, llm: app.llm }, f.campaignCompanyId, f.contactId, {
            instruction: f.instruction, step: f.step, followsSendId: f.followsSendId, dueAt: f.dueAt,
          });
          out.drafted++;
        } catch (e) {
          out.failures.push(`${f.company}: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      app.bus.emit("drafts:changed", { campaignId: params.id });
      return out;
    }));

  /* ------------------------------------------------------------- export */
  r.get("/api/campaigns/:id/export/:kind", ({ params, res }: RouteCtx) => {
    const kind = params.kind as keyof typeof EXPORTS;
    if (!(kind in EXPORTS)) throw bad("unknown export");
    const rows = EXPORTS[kind](db, params.id) as Array<Record<string, unknown>>;
    const csv = toCsv(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="coldcall-${kind}-${stamp}.csv"`,
    });
    res.end("\ufeff" + csv);   // BOM so Excel reads UTF-8 correctly
    return undefined;
  });

  /* -------------------------------------------------------- suppression */
  r.get("/api/suppression", () => db.prepare("SELECT * FROM suppression ORDER BY id DESC").all());
  r.post("/api/suppression", ({ body }: RouteCtx) => {
    const raw = String(body.pattern ?? "").trim();
    if (!raw) throw bad("enter an address or @domain");
    suppress(db, raw, body.reason ?? "manual", body.note);
    return { ok: true };
  });
  r.post("/api/suppression/:id/delete", ({ params }: RouteCtx) => {
    db.prepare("DELETE FROM suppression WHERE id=?").run(params.id);
    return { ok: true };
  });

  /* ------------------------------------------------------------ replies */
  r.get("/api/replies", () => db.prepare(
    `SELECT rp.*, ct.email contact_email, ct.full_name, co.name company
     FROM reply rp LEFT JOIN contact ct ON ct.id=rp.contact_id
     LEFT JOIN company co ON co.id=ct.company_id ORDER BY rp.received_at DESC LIMIT 100`).all());

  r.post("/api/replies/poll", () => background(app, "poll", "Checking for replies", async () => {
    const cfg = readImapConfig(db);
    if (!cfg) throw bad("configure IMAP first", "NO_IMAP");
    const oldest = db.prepare("SELECT MIN(sent_at) m FROM send_log WHERE status='sent'").get() as { m: number | null };
    const out = await pollReplies(db, cfg, { sinceMs: oldest.m ? oldest.m - 3600_000 : undefined });
    app.bus.emit("replies:changed", out);
    return out;
  }));

  r.post("/api/replies/:id/body", async ({ params }: RouteCtx) => {
    const cfg = readImapConfig(db);
    if (!cfg) throw bad("configure IMAP first", "NO_IMAP");
    return { body: await fetchReplyBody(db, cfg, params.id) };
  });

  r.post("/api/replies/:id/draft", async ({ params }: RouteCtx) => {
    const rp = db.prepare("SELECT * FROM reply WHERE id=?").get(params.id) as any;
    if (!rp) throw bad("reply not found", "NOT_FOUND", 404);
    let bodyText: string = rp.body_text;
    if (!bodyText) {
      const cfg = readImapConfig(db);
      if (cfg) bodyText = await fetchReplyBody(db, cfg, params.id);
    }
    const send = db.prepare("SELECT * FROM send_log WHERE id=?").get(rp.send_log_id) as any;
    const version = send ? db.prepare("SELECT subject, body_text FROM email_draft_version WHERE id=?").get(send.version_id) as any : null;
    const campaign = db.prepare("SELECT * FROM campaign WHERE id=?").get(rp.campaign_id) as any;
    const product = campaign ? db.prepare("SELECT * FROM product WHERE id=?").get(campaign.product_id) as any : null;

    const cls = await app.llm.run<{ classification: string; confidence: number; summary: string }>({
      task: "reply.classify", system: P.REPLY_CLASSIFY_SYSTEM,
      prompt: `Reply from ${rp.from_email}:\n\n${bodyText || rp.subject}`,
      schema: P.REPLY_CLASSIFY_SCHEMA, priority: "interactive", subject: { type: "reply", id: params.id },
    });
    db.prepare("UPDATE reply SET classification=?, classification_confidence=?, body_text=? WHERE id=?")
      .run(cls.value.classification, cls.value.confidence, bodyText ?? "", params.id);

    const draft = await app.llm.run<string>({
      task: "reply.draft", system: P.REPLY_DRAFT_SYSTEM,
      prompt: P.replyDraftPrompt({
        brief: product ? briefOf(product) : {},
        original: { subject: version?.subject ?? send?.subject ?? "", body: version?.body_text ?? "" },
        reply: bodyText || rp.subject, senderName: product?.sender_name ?? "",
      }),
      priority: "interactive", subject: { type: "reply", id: params.id },
    });
    return { classification: cls.value, draft: draft.value, suggestSuppress: cls.value.classification === "unsubscribe" };
  });

  r.post("/api/replies/:id/handled", ({ params }: RouteCtx) => {
    db.prepare("UPDATE reply SET handled=1 WHERE id=?").run(params.id);
    return { ok: true };
  });

  /* --------------------------------------------------------------- logs */
  r.get("/api/llm-calls", ({ query }: RouteCtx) => db.prepare(
    `SELECT id,task,slot,provider_id,model_id,attempts,repaired,search_calls,ok,error_code,
       error_message,duration_ms,created_at,substr(response_text,1,600) response_text
     FROM llm_call ${query.get("failed") ? "WHERE ok=0" : ""} ORDER BY id DESC LIMIT 100`).all());
}
