/**
 * Polite HTTP fetching for company websites.
 *
 * All page fetching happens HERE, in Node, not via the model's webfetch tool. That gives us
 * robots.txt compliance, per-domain throttling, caching in source_page, and - critically - a
 * copy of the page text we can verify the model's quotes against later.
 */
import { createHash } from "node:crypto";
import { ulid, now, type Db } from "../db/index.ts";

export const USER_AGENT =
  "coldcall/0.1 (+https://github.com/coldcall/coldcall; local outreach research tool)";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
const PER_DOMAIN_GAP_MS = 2_000;
const RETRIES = 2;
const RETRY_BACKOFF_MS = [1_500, 4_000];

/**
 * Failures worth trying again. A transient socket error or timeout is not evidence that a
 * company has no website - but without a retry it permanently marks them failed and drops
 * them from the campaign. Observed live: five Turkish news sites all failed with "fetch
 * failed" during a busy crawl and every one returned 200 on the next attempt.
 */
function isTransient(error: string): boolean {
  return /fetch failed|econnreset|etimedout|econnrefused|epipe|socket|network|aborted|timeout|enotfound|eai_again|handshake/i
    .test(error);
}

/** Sites are inconsistent about www. If one host fails outright, the other usually works. */
function alternateHost(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith("www.")) u.hostname = u.hostname.slice(4);
    else u.hostname = `www.${u.hostname}`;
    return u.toString();
  } catch { return undefined; }
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  bytes: number;
  ok: boolean;
  error?: string;
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw;
  }
}

export function domainOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return raw.toLowerCase().replace(/^www\./, "");
  }
}

export function urlHash(url: string): string {
  return createHash("sha256").update(normalizeUrl(url)).digest("hex");
}

/** Minimal robots.txt: the rules that actually matter for a well-behaved crawler. */
export class RobotsCache {
  private readonly rules = new Map<string, { disallow: string[]; crawlDelayMs: number }>();

  async allowed(url: string): Promise<boolean> {
    const u = new URL(url);
    const origin = u.origin;
    let entry = this.rules.get(origin);
    if (!entry) {
      entry = await this.load(origin);
      this.rules.set(origin, entry);
    }
    // Longest matching disallow wins, mirroring the usual convention.
    const path = u.pathname + u.search;
    let worst = "";
    for (const d of entry.disallow) {
      if (d && path.startsWith(d) && d.length > worst.length) worst = d;
    }
    return worst === "";
  }

  crawlDelayMs(url: string): number {
    try { return this.rules.get(new URL(url).origin)?.crawlDelayMs ?? 0; } catch { return 0; }
  }

  private async load(origin: string): Promise<{ disallow: string[]; crawlDelayMs: number }> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { "user-agent": USER_AGENT }, signal: ctrl.signal, redirect: "follow",
      });
      clearTimeout(t);
      if (!res.ok) return { disallow: [], crawlDelayMs: 0 };
      const text = (await res.text()).slice(0, 100_000);
      return parseRobots(text);
    } catch {
      // A missing or unreachable robots.txt means no restrictions, per convention.
      return { disallow: [], crawlDelayMs: 0 };
    }
  }
}

export function parseRobots(text: string): { disallow: string[]; crawlDelayMs: number } {
  const disallow: string[] = [];
  let crawlDelayMs = 0;
  let applies = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase().includes("coldcall");
    } else if (applies && key === "disallow") {
      if (value) disallow.push(value);
    } else if (applies && key === "allow") {
      // An explicit Allow narrows a broader Disallow; drop exact matches.
      const i = disallow.indexOf(value);
      if (i >= 0) disallow.splice(i, 1);
    } else if (applies && key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) crawlDelayMs = Math.min(n * 1000, 30_000);
    }
  }
  return { disallow, crawlDelayMs };
}

/** One in-flight request per domain, with a gap between them. */
export class Fetcher {
  private readonly robots = new RobotsCache();
  private readonly lastHit = new Map<string, number>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly respectRobots: boolean;

  constructor(opts: { respectRobots?: boolean } = {}) {
    this.respectRobots = opts.respectRobots ?? true;
  }

  async fetch(rawUrl: string): Promise<FetchResult> {
    const url = normalizeUrl(rawUrl);
    const domain = domainOf(url);
    const prev = this.chains.get(domain) ?? Promise.resolve();
    const task = prev.catch(() => {}).then(() => this.doFetch(url, domain));
    this.chains.set(domain, task.catch(() => {}));
    return task;
  }

  private async doFetch(url: string, domain: string): Promise<FetchResult> {
    const base: FetchResult = { url, finalUrl: url, status: 0, contentType: "", html: "", bytes: 0, ok: false };

    if (this.respectRobots && !(await this.robots.allowed(url))) {
      return { ...base, error: "disallowed by robots.txt" };
    }

    let last: FetchResult = base;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1] ?? 4_000));
      last = await this.attempt(url, domain);
      if (last.ok || !last.error || !isTransient(last.error)) break;
    }
    if (last.ok) return last;

    // Still failing after retries: the host itself may be the problem, not the network.
    const alt = alternateHost(url);
    if (alt && last.error && isTransient(last.error)) {
      const altResult = await this.attempt(alt, domainOf(alt));
      if (altResult.ok) return { ...altResult, url };
    }
    return last;
  }

  private async attempt(url: string, domain: string): Promise<FetchResult> {
    const base: FetchResult = { url, finalUrl: url, status: 0, contentType: "", html: "", bytes: 0, ok: false };

    const gap = Math.max(PER_DOMAIN_GAP_MS, this.robots.crawlDelayMs(url));
    const since = Date.now() - (this.lastHit.get(domain) ?? 0);
    if (since < gap) await new Promise((r) => setTimeout(r, gap - since));
    this.lastHit.set(domain, Date.now());

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-GB,en;q=0.9",
        },
        redirect: "follow",
        signal: ctrl.signal,
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml/i.test(contentType) && res.ok) {
        return { ...base, finalUrl: res.url || url, status: res.status, contentType, error: "not html" };
      }

      // Stream with a hard cap so one huge page cannot exhaust memory.
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
          chunks.push(value);
        }
      }
      const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      return { url, finalUrl: res.url || url, status: res.status, contentType, html, bytes, ok: res.ok };
    } catch (e) {
      return { ...base, error: (e as Error).message.slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Persist a fetch so quotes can be verified later and pages are never fetched twice. */
export function storePage(db: Db, r: FetchResult, text: string, title: string, companyId?: string): string {
  const hash = urlHash(r.finalUrl);
  const existing = db.prepare("SELECT id FROM source_page WHERE url_hash = ?").get(hash) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE source_page SET http_status=?, text=?, title=?, bytes=?, fetched_at=?, error=? WHERE id=?")
      .run(r.status, text.slice(0, 200_000), title, r.bytes, now(), r.error ?? null, existing.id);
    return existing.id;
  }
  const id = ulid();
  db.prepare(
    "INSERT INTO source_page (id,url,url_hash,company_id,http_status,content_type,title,text,bytes,fetched_at,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, r.finalUrl, hash, companyId ?? null, r.status, r.contentType, title, text.slice(0, 200_000), r.bytes, now(), r.error ?? null);
  return id;
}

export function getCachedPage(db: Db, url: string, maxAgeMs = 7 * 24 * 3600_000):
  { id: string; url: string; text: string; title: string } | undefined {
  const row = db.prepare("SELECT id,url,text,title,fetched_at FROM source_page WHERE url_hash = ? AND error IS NULL")
    .get(urlHash(url)) as { id: string; url: string; text: string; title: string; fetched_at: number } | undefined;
  if (!row) return undefined;
  if (Date.now() - row.fetched_at > maxAgeMs) return undefined;
  return row;
}
