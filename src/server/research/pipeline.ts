/**
 * The research pipeline: discover companies -> crawl them -> verify claims -> find recipients.
 *
 * The model proposes; Node verifies. Every fact that can reach an email is re-fetched by us and
 * checked against the page it was supposedly quoted from. A claim the model invented simply
 * never becomes `verified`, and the database will not let an unverified claim be used.
 */
import type { LlmService } from "../llm/index.ts";
import { ulid, now, tx, type Db } from "../db/index.ts";
import { Fetcher, domainOf, getCachedPage, normalizeUrl, storePage } from "./fetcher.ts";
import { extractPage, htmlToText, isRoleAccount, pickContactPages, quoteAppearsIn, cleanEmail,
         inferEmailPattern, applyEmailPattern } from "./extract.ts";
import * as P from "../llm/prompts.ts";

export interface PipelineDeps { db: Db; llm: LlmService; fetcher: Fetcher }

/* ------------------------------------------------------------------ helpers */

function getCampaign(db: Db, campaignId: string) {
  const c = db.prepare("SELECT * FROM campaign WHERE id = ?").get(campaignId) as any;
  if (!c) throw new Error(`campaign ${campaignId} not found`);
  const p = db.prepare("SELECT * FROM product WHERE id = ?").get(c.product_id) as any;
  return { campaign: c, product: p };
}

/**
 * What THIS campaign is looking for.
 *
 * A product's signals describe its customers. A campaign may be aimed at someone else
 * entirely - partners, content sources, press - so the campaign's own target wins when set.
 * Falling back to product signals for a campaign with a different audience is how a search
 * for news sites comes back full of sports academies.
 */
export function targetOf(campaign: any, product: any): string {
  const explicit = String(campaign.target_description ?? "").trim();
  if (explicit) return explicit;
  const signals = JSON.parse(product.signals || "[]") as Array<{ signal: string; how_to_check?: string }>;
  const audience = JSON.parse(product.audience || "{}") as { who?: string; where?: string };
  const lines = [
    audience.who ? `Organisations of this kind: ${audience.who}` : "",
    audience.where ? `Located in: ${audience.where}` : "",
    ...signals.map((x) => `- ${x.signal}`),
  ].filter(Boolean);
  return lines.join("\n") || "Any organisation that would plausibly want what we offer.";
}

/** The brief as the prompts want to see it. */
export function briefOf(product: any) {
  return {
    name: product.name,
    one_liner: product.one_liner,
    description: product.description,
    audience: JSON.parse(product.audience || "{}"),
    job_to_be_done: product.job_to_be_done,
    before_state: product.before_state,
    objections: JSON.parse(product.objections || "[]"),
    proof_points: JSON.parse(product.proof_points || "[]"),
    disqualifiers: JSON.parse(product.disqualifiers || "[]"),
    signals: JSON.parse(product.signals || "[]"),
    price_anchor: product.price_anchor,
    tone_sample: product.tone_sample,
    sender: { name: product.sender_name, title: product.sender_title, company: product.sender_company },
  };
}

function upsertCompany(db: Db, c: { name: string; website_url?: string; city?: string; industry?: string }): string {
  const domain = domainOf(c.website_url ?? c.name);
  const existing = db.prepare("SELECT id FROM company WHERE domain = ?").get(domain) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = ulid();
  db.prepare("INSERT INTO company (id,domain,name,website_url,city,industry,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, domain, c.name, c.website_url ?? null, c.city ?? null, c.industry ?? null, now(), now());
  return id;
}

/** Search results and directories are not prospects. */
const NOT_A_COMPANY = /^(www\.)?(google|bing|duckduckgo|yelp|yell|facebook|instagram|linkedin|twitter|x|tripadvisor|checkatrade|trustpilot|indeed|glassdoor|wikipedia|reddit|youtube|amazon|ebay|gumtree|thomsonlocal|scoot|cylex|bark|houzz|rated-people|mybuilder)\./i;

export function isPlausibleCompanyDomain(url: string): boolean {
  const d = domainOf(url);
  if (!d || !d.includes(".")) return false;
  if (NOT_A_COMPANY.test(`${d}.`)) return false;
  return true;
}

/* ---------------------------------------------------------------- discovery */

export interface DiscoverResult { found: number; added: number; queries: string[]; skipped: string[] }

export async function discoverCompanies(
  deps: PipelineDeps, campaignId: string, opts: { extra?: string } = {},
): Promise<DiscoverResult> {
  const { db, llm } = deps;
  const { campaign, product } = getCampaign(db, campaignId);
  const brief = briefOf(product);
  const skipped: string[] = [];

  db.prepare("UPDATE campaign SET status='researching', updated_at=? WHERE id=?").run(now(), campaignId);

  const target = targetOf(campaign, product);
  const q = await llm.run<{ queries: Array<{ query: string; targets_signal: string }> }>({
    task: "search.queries",
    system: P.SEARCH_QUERIES_SYSTEM,
    prompt: P.searchQueriesPrompt(brief, campaign.goal, target, opts.extra ?? ""),
    schema: P.SEARCH_QUERIES_SCHEMA,
    subject: { type: "campaign", id: campaignId },
  });
  const queries = q.value.queries.map((x) => x.query);

  type Found = { name: string; website_url: string; fit_score: number; reason: string; matched_signal: string; source_url: string; city?: string };
  const found: Found[] = [];

  if (campaign.discovery_mode === "opencode_search") {
    // One research call per query keeps each session small and stops one bad query from
    // poisoning the rest.
    for (const query of queries.slice(0, 5)) {
      try {
        const r = await llm.run<{ companies: Found[] }>({
          task: "company.enrich",
          system: P.DISCOVER_SYSTEM,
          prompt: `Search the web for: ${query}

TARGET - the kind of organisation to find:
${target}

Who we are (context only - do NOT look for organisations like us):
${JSON.stringify(brief, null, 2)}

Report only organisations that are genuinely the KIND of thing the target describes, and that you actually saw.`,
          schema: P.DISCOVER_SCHEMA,
          subject: { type: "campaign", id: campaignId },
        });
        // A company whose URL the model never actually visited is not evidence of anything.
        const seen = new Set(r.harvestedUrls.map((u) => domainOf(u)));
        for (const c of r.value.companies) {
          if (!c.website_url) continue;
          if (seen.size > 0 && !seen.has(domainOf(c.website_url)) && !seen.has(domainOf(c.source_url ?? ""))) {
            skipped.push(`${c.name} (${c.website_url}) - not in any page the model actually opened`);
            continue;
          }
          found.push({ ...c, discovered_via: query } as Found);
        }
      } catch (e) {
        skipped.push(`query "${query}" failed: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }

  // Dedupe by domain, keeping the highest-scoring sighting.
  const byDomain = new Map<string, Found>();
  for (const c of found) {
    if (!isPlausibleCompanyDomain(c.website_url)) { skipped.push(`${c.website_url} - directory or search engine`); continue; }
    const d = domainOf(c.website_url);
    const prev = byDomain.get(d);
    if (!prev || c.fit_score > prev.fit_score) byDomain.set(d, c);
  }

  let added = 0;
  tx(db, () => {
    for (const c of byDomain.values()) {
      const companyId = upsertCompany(db, c);
      const dup = db.prepare("SELECT id FROM campaign_company WHERE campaign_id=? AND company_id=?").get(campaignId, companyId);
      if (dup) continue;
      db.prepare(
        `INSERT INTO campaign_company (id,campaign_id,company_id,status,relevance_score,relevance_reason,
           matched_signal,discovered_via,discovered_url,created_at,updated_at)
         VALUES (?,?,?,'discovered',?,?,?,?,?,?,?)`,
      ).run(ulid(), campaignId, companyId, Math.max(0, Math.min(100, c.fit_score)) / 100,
            c.reason ?? "", c.matched_signal ?? "", (c as any).discovered_via ?? "", c.source_url ?? "", now(), now());
      added++;
    }
    db.prepare("UPDATE campaign SET status='ready', updated_at=? WHERE id=?").run(now(), campaignId);
  });

  return { found: byDomain.size, added, queries, skipped };
}

/* --------------------------------------------------------------- enrichment */

export interface CrawledPage { id: string; url: string; title: string; text: string; emails: string[] }

/** Homepage plus a bounded set of contact-ish pages. Cached, so re-runs are cheap and polite. */
export async function crawlCompany(deps: PipelineDeps, companyId: string, maxPages = 7): Promise<CrawledPage[]> {
  const { db, fetcher } = deps;
  const company = db.prepare("SELECT * FROM company WHERE id = ?").get(companyId) as any;
  const home = normalizeUrl(company.website_url || `https://${company.domain}`);
  const out: CrawledPage[] = [];

  const visit = async (url: string): Promise<{ page?: CrawledPage; links: string[] }> => {
    const cached = getCachedPage(db, url);
    if (cached) {
      const emails = [...new Set((cached.text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])
        .map(cleanEmail).filter((e): e is string => !!e))];
      return { page: { id: cached.id, url: cached.url, title: cached.title, text: cached.text, emails }, links: [] };
    }
    const res = await fetcher.fetch(url);
    if (!res.ok || !res.html) {
      if (res.error) storePage(db, res, "", "", companyId);
      return { links: [] };
    }
    const ex = extractPage(res.html, res.finalUrl);
    const id = storePage(db, res, ex.text, ex.title, companyId);
    return { page: { id, url: res.finalUrl, title: ex.title, text: ex.text, emails: ex.emails }, links: ex.links };
  };

  const first = await visit(home);
  if (first.page) out.push(first.page);
  const candidates = pickContactPages(first.links, home, maxPages - 1);
  for (const url of candidates) {
    if (out.length >= maxPages) break;
    const r = await visit(url);
    if (r.page) out.push(r.page);
  }
  return out;
}

export interface EnrichResult {
  pages: number; claims: number; verified: number; rejected: string[];
  recheck?: { actual_name: string; entity_kind: string; matches_target: boolean; fit_score: number; reason: string };
}

export async function enrichCompany(deps: PipelineDeps, campaignCompanyId: string): Promise<EnrichResult> {
  const { db, llm } = deps;
  const cc = db.prepare("SELECT * FROM campaign_company WHERE id = ?").get(campaignCompanyId) as any;
  const company = db.prepare("SELECT * FROM company WHERE id = ?").get(cc.company_id) as any;
  db.prepare("UPDATE campaign_company SET status='enriching', updated_at=? WHERE id=?").run(now(), campaignCompanyId);

  let pages: CrawledPage[];
  try {
    pages = await crawlCompany(deps, company.id);
  } catch (e) {
    // 'enriching' is not a terminal state. Leaving a row in it hides the company from every
    // status filter and it silently never gets picked up again.
    db.prepare("UPDATE campaign_company SET status='failed', error_code='CRAWL_ERROR', error_message=?, updated_at=? WHERE id=?")
      .run((e as Error).message.slice(0, 300), now(), campaignCompanyId);
    throw e;
  }
  if (pages.length === 0) {
    db.prepare("UPDATE campaign_company SET status='failed', error_code='NO_PAGES', error_message=?, updated_at=? WHERE id=?")
      .run("could not fetch any page from this site", now(), campaignCompanyId);
    return { pages: 0, claims: 0, verified: 0, rejected: ["site unreachable"] };
  }

  let r;
  try {
    r = await llm.run<{ summary: string; industry?: string; city?: string; claims: Array<{ claim: string; source_url: string; quote: string }> }>({
      task: "contact.extract",
      system: P.ENRICH_SYSTEM,
      prompt: P.enrichPrompt({ name: company.name, domain: company.domain }, pages),
      schema: P.ENRICH_SCHEMA,
      subject: { type: "campaign_company", id: campaignCompanyId },
    });
  } catch (e) {
    db.prepare("UPDATE campaign_company SET status='failed', error_code=?, error_message=?, updated_at=? WHERE id=?")
      .run((e as { code?: string }).code ?? "ENRICH_FAILED", (e as Error).message.slice(0, 300), now(), campaignCompanyId);
    throw e;
  }

  // VERIFY. This is the step that makes citations trustworthy: the quote must actually appear
  // in the page text WE fetched and stored, not in something the model remembered.
  const byUrl = new Map(pages.map((p) => [normalizeUrl(p.url), p]));
  const rejected: string[] = [];
  let verified = 0;

  tx(db, () => {
    db.prepare("UPDATE company SET summary=?, industry=COALESCE(NULLIF(?,''),industry), city=COALESCE(NULLIF(?,''),city), enriched_at=?, updated_at=? WHERE id=?")
      .run(r.value.summary ?? "", r.value.industry ?? "", r.value.city ?? "", now(), now(), company.id);
    db.prepare("DELETE FROM claim WHERE campaign_company_id = ?").run(campaignCompanyId);

    for (const c of r.value.claims ?? []) {
      const page = byUrl.get(normalizeUrl(c.source_url))
        ?? pages.find((p) => normalizeUrl(p.url).startsWith(normalizeUrl(c.source_url)));
      let ok = false, method: string = "failed", score = 0;
      if (!page) {
        rejected.push(`"${c.claim.slice(0, 60)}" - cited ${c.source_url}, which we never fetched`);
      } else {
        const m = quoteAppearsIn(c.quote, page.text);
        ok = m.ok; method = m.method; score = m.score;
        if (!ok) rejected.push(`"${c.claim.slice(0, 60)}" - quote not found on ${page.url} (best match ${(score * 100) | 0}%)`);
      }
      if (ok) verified++;
      db.prepare(
        `INSERT INTO claim (id,company_id,campaign_company_id,claim,source_url,source_page_id,quote,
           harvested,verified,verify_method,verify_score,verified_at,llm_call_id,created_at)
         VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
      ).run(ulid(), company.id, campaignCompanyId, c.claim, page?.url ?? c.source_url, page?.id ?? null,
            c.quote, ok ? 1 : 0, method, score, ok ? now() : null, r.meta.llmCallId, now());
    }
    db.prepare("UPDATE campaign_company SET status='qualified', updated_at=? WHERE id=?").run(now(), campaignCompanyId);
  });

  // Now that we have the real site, check the search result was not simply wrong about what
  // this organisation is. Search routinely attaches a name from one result to a URL from
  // another, and a topic match is not a kind match.
  const campaign = db.prepare("SELECT * FROM campaign WHERE id=?").get(cc.campaign_id) as any;
  const product = db.prepare("SELECT * FROM product WHERE id=?").get(campaign.product_id) as any;
  let recheck: EnrichResult["recheck"];
  try {
    const rc = await llm.run<{ actual_name: string; entity_kind: string; matches_target: boolean; fit_score: number; reason: string }>({
      task: "company.judge",
      system: P.RECHECK_SYSTEM,
      prompt: P.recheckPrompt({
        target: targetOf(campaign, product),
        claimedName: company.name, domain: company.domain, pages,
      }),
      schema: P.RECHECK_SCHEMA,
      subject: { type: "campaign_company", id: campaignCompanyId },
    });
    recheck = rc.value;
    tx(db, () => {
      // Trust the page over the search result for the name.
      if (rc.value.actual_name && rc.value.actual_name.trim()) {
        db.prepare("UPDATE company SET name=?, updated_at=? WHERE id=?").run(rc.value.actual_name.trim(), now(), company.id);
      }
      db.prepare("UPDATE campaign_company SET relevance_score=?, relevance_reason=?, updated_at=? WHERE id=?")
        .run(rc.value.fit_score / 100, rc.value.reason, now(), campaignCompanyId);
      if (!rc.value.matches_target) {
        db.prepare("UPDATE campaign_company SET status='rejected', selected=0, rejected_reason=?, updated_at=? WHERE id=?")
          .run(`not the target kind - it is a ${rc.value.entity_kind}`, now(), campaignCompanyId);
      }
    });
  } catch {
    // A failed recheck must not lose the enrichment we already did.
  }

  return { pages: pages.length, claims: (r.value.claims ?? []).length, verified, rejected, recheck };
}

/* ----------------------------------------------------------------- contacts */

export interface ContactsResult { added: number; considered: number; notes: string[] }

export async function findContacts(deps: PipelineDeps, campaignCompanyId: string): Promise<ContactsResult> {
  const { db, llm } = deps;
  const cc = db.prepare("SELECT * FROM campaign_company WHERE id = ?").get(campaignCompanyId) as any;
  const campaign = db.prepare("SELECT * FROM campaign WHERE id = ?").get(cc.campaign_id) as any;
  const company = db.prepare("SELECT * FROM company WHERE id = ?").get(cc.company_id) as any;

  const pages = await crawlCompany(deps, company.id);
  if (pages.length === 0) return { added: 0, considered: 0, notes: ["site unreachable"] };

  const crawlerEmails = [...new Set(pages.flatMap((p) => p.emails))];
  const notes: string[] = [];

  const r = await llm.run<{ contacts: Array<{ full_name?: string | null; title?: string | null; email: string | null; source_url: string; source_snippet?: string; rank: number; why: string }> }>({
    task: "contact.extract",
    system: P.CONTACTS_SYSTEM,
    prompt: P.contactsPrompt({ name: company.name, domain: company.domain }, campaign.goal, pages, crawlerEmails),
    schema: P.CONTACTS_SCHEMA,
    subject: { type: "campaign_company", id: campaignCompanyId },
  });

  const pageByUrl = new Map(pages.map((p) => [normalizeUrl(p.url), p]));
  const allText = pages.map((p) => p.text).join("\n").toLowerCase();
  const wanted = campaign.contacts_per_company ?? 3;
  const candidates = [...(r.value.contacts ?? [])];

  // Learn the domain's address pattern from what it actually publishes, for the opt-in tier.
  const pattern = inferEmailPattern(
    candidates.filter((c) => c.email && c.full_name).map((c) => ({ email: c.email!, fullName: c.full_name! })),
  );

  /**
   * Deterministic fallback.
   *
   * The crawler already found these addresses in text we fetched and stored - that is a fact,
   * not a judgement. Observed live: futbolamator.com publishes verhaber@gmail.com on /kunye/
   * and the model still returned an empty contact list, so the company was reported as having
   * no publishable address. Where Node has better information than the model, Node wins.
   */
  const modelEmails = new Set(
    candidates.map((c) => (c.email ? cleanEmail(c.email) : undefined)).filter(Boolean) as string[],
  );
  for (const email of crawlerEmails) {
    if (modelEmails.has(email)) continue;
    const page = pages.find((p) => p.emails.includes(email)) ?? pages[0];
    candidates.push({
      full_name: null, title: null, email,
      source_url: page.url, source_snippet: "",
      rank: 90 + candidates.length,   // after anything the model ranked
      why: "found on the site by the crawler",
    });
    notes.push(`added ${email} from ${new URL(page.url).pathname} - the crawler found it but the model did not list it`);
  }

  candidates.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  let added = 0;
  tx(db, () => {
    for (const c of candidates) {
      if (added >= wanted) break;
      let email = c.email ? cleanEmail(c.email) : undefined;
      let sourceKind: "published" | "generic" | "inferred" = "published";

      if (email) {
        // The model may only report an address that literally appears on a page we fetched.
        if (!allText.includes(email)) {
          notes.push(`dropped ${email} - does not appear on any page we fetched`);
          continue;
        }
        if (isRoleAccount(email)) sourceKind = "generic";
      } else if (campaign.allow_inferred_emails && pattern && c.full_name) {
        const guess = applyEmailPattern(pattern, c.full_name, company.domain);
        if (!guess) { notes.push(`no address for ${c.full_name}`); continue; }
        email = guess; sourceKind = "inferred";
        notes.push(`inferred ${email} for ${c.full_name} from the "${pattern}" pattern`);
      } else {
        notes.push(`skipped ${c.full_name ?? "unnamed contact"} - no published address${c.full_name && !campaign.allow_inferred_emails ? " (inference is off)" : ""}`);
        continue;
      }

      const page = pageByUrl.get(normalizeUrl(c.source_url)) ?? pages[0];
      const confidence = sourceKind === "published" ? 0.9 : sourceKind === "generic" ? 0.7 : 0.4;
      const dup = db.prepare("SELECT id FROM contact WHERE company_id=? AND lower(email)=lower(?)").get(company.id, email);
      if (dup) { added++; continue; }

      db.prepare(
        `INSERT INTO contact (id,company_id,full_name,first_name,title,email,email_status,source_url,
           source_kind,source_snippet,source_page_id,confidence,is_role_account,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'syntax_ok',?,?,?,?,?,?,?,?)`,
      ).run(ulid(), company.id, c.full_name ?? null, (c.full_name ?? "").split(/\s+/)[0] || null,
            c.title ?? null, email, page.url, sourceKind, (c.source_snippet ?? "").slice(0, 500),
            page.id, confidence, isRoleAccount(email) ? 1 : 0, now(), now());
      added++;
    }
    db.prepare("UPDATE campaign_company SET status=?, updated_at=? WHERE id=?")
      .run(added > 0 ? "contacts_found" : "failed", now(), campaignCompanyId);
    if (added === 0) {
      db.prepare("UPDATE campaign_company SET error_code='NO_CONTACTS', error_message=? WHERE id=?")
        .run("no publishable address found on the site", campaignCompanyId);
    }
  });

  return { added, considered: candidates.length, notes };
}

/* ------------------------------------------------------------------- manual */

/** The escape hatch: paste domains or names you already know you want. */
export function addManualCompanies(
  db: Db, campaignId: string, entries: Array<{ name?: string; website: string }>,
): { added: number; skipped: string[] } {
  const skipped: string[] = [];
  let added = 0;
  tx(db, () => {
    for (const e of entries) {
      let website = e.website.trim();
      if (!website) continue;
      if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
      if (!isPlausibleCompanyDomain(website)) { skipped.push(`${e.website} - not a company domain`); continue; }
      const companyId = upsertCompany(db, { name: e.name || domainOf(website), website_url: normalizeUrl(website) });
      const dup = db.prepare("SELECT id FROM campaign_company WHERE campaign_id=? AND company_id=?").get(campaignId, companyId);
      if (dup) { skipped.push(`${domainOf(website)} - already in this campaign`); continue; }
      db.prepare(
        `INSERT INTO campaign_company (id,campaign_id,company_id,status,relevance_score,relevance_reason,
           discovered_via,selected,created_at,updated_at)
         VALUES (?,?,?,'discovered',NULL,'added by hand','manual',1,?,?)`,
      ).run(ulid(), campaignId, companyId, now(), now());
      added++;
    }
  });
  return { added, skipped };
}

/** Judge already-discovered companies against the brief without re-searching. */
export async function judgeCompany(deps: PipelineDeps, campaignCompanyId: string): Promise<{ score: number; reason: string }> {
  const { db, llm } = deps;
  const cc = db.prepare("SELECT * FROM campaign_company WHERE id=?").get(campaignCompanyId) as any;
  const company = db.prepare("SELECT * FROM company WHERE id=?").get(cc.company_id) as any;
  const { product } = getCampaign(db, cc.campaign_id);
  const claims = db.prepare("SELECT claim FROM claim WHERE campaign_company_id=? AND verified=1").all(campaignCompanyId) as Array<{ claim: string }>;

  const r = await llm.run<{ fit_score: number; reason: string; matched_signal: string }>({
    task: "company.judge",
    system: "You judge whether a company fits a brief. Be strict: a weak fit wastes a real person's time. Score 0-100.",
    prompt: `Brief:\n${JSON.stringify(briefOf(product), null, 2)}\n\nCompany: ${company.name} (${company.domain})\nWhat they do: ${company.summary}\nVerified facts:\n${claims.map((c) => `- ${c.claim}`).join("\n") || "(none)"}\n\nScore the fit.`,
    schema: {
      type: "object", additionalProperties: false, required: ["fit_score", "reason", "matched_signal"],
      properties: {
        fit_score: { type: "number", minimum: 0, maximum: 100 },
        reason: { type: "string", maxLength: 200 },
        matched_signal: { type: "string" },
      },
    },
    subject: { type: "campaign_company", id: campaignCompanyId },
  });

  db.prepare("UPDATE campaign_company SET relevance_score=?, relevance_reason=?, matched_signal=?, updated_at=? WHERE id=?")
    .run(r.value.fit_score / 100, r.value.reason, r.value.matched_signal, now(), campaignCompanyId);
  return { score: r.value.fit_score, reason: r.value.reason };
}
