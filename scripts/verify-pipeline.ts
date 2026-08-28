/**
 * End-to-end research pipeline check against REAL websites.
 * Run: node scripts/verify-pipeline.ts
 */
import { OpencodeSupervisor } from "../src/server/opencode/supervisor.ts";
import { probeModels } from "../src/server/opencode/models.ts";
import { LlmService } from "../src/server/llm/index.ts";
import { openDb, ulid, now } from "../src/server/db/index.ts";
import { migrate } from "../src/server/db/migrate.ts";
import { seedDefaults } from "../src/server/db/settings.ts";
import { Fetcher } from "../src/server/research/fetcher.ts";
import { addManualCompanies, enrichCompany, findContacts } from "../src/server/research/pipeline.ts";

const sup = new OpencodeSupervisor({ startTimeoutMs: 45_000 });
let failures = 0;
const ok = (m: string) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m: string) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const db = openDb(":memory:"); migrate(db); seedDefaults(db);
const t = now();
const productId = ulid(), campaignId = ulid();
db.prepare(`INSERT INTO product (id,name,one_liner,description,audience,job_to_be_done,signals,
  proof_points,price_anchor,tone_sample,sender_name,sender_company,status,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?)`).run(
  productId, "WearSide Labs", "I build small business websites that actually bring in enquiries",
  "A one-person studio in Durham building fast websites and web apps for local businesses.",
  JSON.stringify({ who: "small local trade and service businesses", where: "Durham and the North East" }),
  "get found online and turn visits into phone calls",
  JSON.stringify([{ signal: "site is on a free website builder", how_to_check: "check the domain or page source" },
                  { signal: "no way to enquire online", how_to_check: "look for a contact form" }]),
  JSON.stringify(["fixed price, no retainers", "usually live within two weeks"]),
  "£100-£2,000 fixed price", "I keep it simple and I do the work myself. No account managers.",
  "Ozan", "WearSide Labs", t, t);
db.prepare("INSERT INTO campaign (id,product_id,name,goal,discovery_mode,contacts_per_company,created_at,updated_at) VALUES (?,?,?,?,'manual',2,?,?)")
  .run(campaignId, productId, "Durham trades", "get 15 minutes to talk about rebuilding their website", t, t);

try {
  await sup.start();
  console.log(`opencode ${sup.url}\nProbing models...`);
  const slots = await probeModels(sup.client!, { maxCandidates: 2 });
  console.log(`  research=${slots.research.active?.modelID ?? "NONE"}  writing=${slots.writing.active?.providerID}/${slots.writing.active?.modelID}\n`);

  const llm = new LlmService({ client: () => sup.client, slots: () => slots, db });
  const deps = { db, llm, fetcher: new Fetcher() };

  console.log("STEP 1: add companies by hand");
  const m = addManualCompanies(db, campaignId, [
    { name: "CR Design Services", website: "crdesignservices.co.uk" },
    { name: "Bethell & Co", website: "bethellandco.co.uk" },
    { name: "Hoot Architecture", website: "hootarchitecture.com" },
    { name: "Yell", website: "yell.com" },
  ]);
  console.log(`  added=${m.added} skipped=${JSON.stringify(m.skipped)}`);
  if (m.added === 3 && m.skipped.length === 1) ok("3 real companies added, directory rejected");
  else bad(`expected 3 added + 1 skipped, got ${m.added}/${m.skipped.length}`);

  const ccs = db.prepare("SELECT cc.id, c.name, c.domain FROM campaign_company cc JOIN company c ON c.id=cc.company_id WHERE cc.campaign_id=?").all(campaignId) as any[];

  for (const cc of ccs) {
    console.log(`\nSTEP 2: enrich ${cc.name} (${cc.domain})`);
    const e = await enrichCompany(deps, cc.id);
    console.log(`  pages=${e.pages} claims=${e.claims} verified=${e.verified}`);
    for (const r of e.rejected) console.log(`  \x1b[33mrejected\x1b[0m ${r}`);
    const rows = db.prepare("SELECT claim, quote, verified, verify_method, verify_score, source_url FROM claim WHERE campaign_company_id=?").all(cc.id) as any[];
    for (const r of rows) {
      console.log(`   ${r.verified ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.claim.slice(0, 80)}`);
      console.log(`      "${r.quote.slice(0, 80)}" [${r.verify_method} ${(r.verify_score * 100) | 0}%] ${r.source_url}`);
    }
    if (e.pages > 0) ok(`crawled ${e.pages} pages`); else bad("no pages crawled");

    console.log(`STEP 3: find recipients at ${cc.name}`);
    const f = await findContacts(deps, cc.id);
    console.log(`  added=${f.added} considered=${f.considered}`);
    for (const n of f.notes) console.log(`  note: ${n}`);
    const contacts = db.prepare("SELECT full_name,title,email,source_kind,confidence,source_url FROM contact WHERE company_id=(SELECT company_id FROM campaign_company WHERE id=?)").all(cc.id) as any[];
    for (const c of contacts) console.log(`   -> ${c.email}  [${c.source_kind} ${c.confidence}]  ${c.full_name ?? ""} ${c.title ?? ""}  src=${c.source_url}`);
  }

  console.log("\nSTEP 4: the guarantee - no contact without provenance, no unverified claim usable");
  const orphan = db.prepare("SELECT COUNT(*) c FROM contact WHERE source_url IS NULL OR source_url=''").get() as any;
  if (orphan.c === 0) ok("every contact has a source URL"); else bad(`${orphan.c} contacts without provenance`);

  const totals = db.prepare("SELECT COUNT(*) total, SUM(verified) v FROM claim").get() as any;
  console.log(`  claims: ${totals.v ?? 0}/${totals.total ?? 0} verified against pages we fetched ourselves`);
  const allEmails = db.prepare("SELECT email FROM contact").all() as any[];
  console.log(`  contacts found: ${allEmails.length}`);
  if (allEmails.length > 0) ok("real recipients discovered"); else bad("no recipients found");
} catch (e) {
  failures++;
  console.error("\nFATAL:", (e as Error).message);
  console.error(String((e as any).raw ?? "").slice(0, 500));
} finally { await sup.stop(); }

console.log(`\n${failures === 0 ? "\x1b[32mALL CHECKS PASSED\x1b[0m" : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
