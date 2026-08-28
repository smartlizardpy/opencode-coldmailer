/**
 * End-to-end check of the real stack: supervisor -> model probe -> llm().
 * Run: node scripts/verify-llm.ts
 */
import { OpencodeSupervisor } from "../src/server/opencode/supervisor.ts";
import { probeModels } from "../src/server/opencode/models.ts";
import { LlmService } from "../src/server/llm/index.ts";
import { openDb } from "../src/server/db/index.ts";
import { migrate } from "../src/server/db/migrate.ts";
import { seedDefaults } from "../src/server/db/settings.ts";

const sup = new OpencodeSupervisor({ startTimeoutMs: 45_000 });
let failures = 0;
const ok = (m: string) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m: string) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const db = openDb(":memory:"); migrate(db); seedDefaults(db);

try {
  console.log("Starting sandboxed opencode...");
  await sup.start();
  console.log(`  ${sup.url}\n`);

  console.log("Probing models (this makes real calls, ~1-2 min)...");
  const slots = await probeModels(sup.client!, { maxCandidates: 2 });
  console.log(`  research: ${slots.research.active ? `${slots.research.active.providerID}/${slots.research.active.modelID}` : "NONE"} (${slots.research.status})`);
  for (const m of slots.research.ranking) console.log(`     ${m.providerID}/${m.modelID} ok=${m.ok} search=${m.searchProbe} ${m.latencyMs}ms`);
  console.log(`  writing:  ${slots.writing.active ? `${slots.writing.active.providerID}/${slots.writing.active.modelID}` : "NONE"} (${slots.writing.status})`);
  for (const m of slots.writing.ranking) console.log(`     ${m.providerID}/${m.modelID} ok=${m.ok} ${m.latencyMs}ms`);
  if (slots.research.status === "ok") ok("a search-capable model was found"); else bad("no search-capable model");
  if (slots.writing.status === "ok") ok("a writing model was found"); else bad("no writing model");

  const llm = new LlmService({ client: () => sup.client, slots: () => slots, db });

  console.log("\nTEST A: structured extraction against a real model");
  const a = await llm.run<{ name: string; kind: string; is_local: boolean }>({
    task: "company.judge",
    system: "You classify businesses. Be terse and factual.",
    prompt: 'Classify this business: "Bethell & Co, a joinery and building firm in Durham UK."',
    schema: {
      type: "object", additionalProperties: false,
      required: ["name", "kind", "is_local"],
      properties: { name: { type: "string" }, kind: { type: "string" }, is_local: { type: "boolean" } },
    },
  });
  console.log(`       -> ${JSON.stringify(a.value)}  (${a.meta.attempts} attempt(s), ${a.meta.durationMs}ms, repaired=${a.meta.repaired})`);
  if (a.value && typeof a.value.name === "string" && typeof a.value.is_local === "boolean") ok("valid schema-conformant object returned");
  else bad("object did not conform");

  console.log("\nTEST B: prose generation");
  const b = await llm.run<string>({
    task: "email.draft",
    system: "You write plain, short, human email. No marketing language.",
    prompt: "Write a two-sentence note to a joinery firm asking for 15 minutes to talk about their website.",
  });
  console.log(`       -> ${JSON.stringify(b.value.slice(0, 180))}`);
  if (b.value.trim().length > 20) ok("prose returned"); else bad("no prose");

  if (slots.research.status === "ok") {
    console.log("\nTEST C: research task with real websearch + citation harvesting");
    const c = await llm.run<{ findings: Array<{ claim: string; source_url: string }> }>({
      task: "company.enrich",
      system: "You research companies using web search. Every claim must cite the URL you saw it on.",
      prompt: 'Search the web for the opencode AI CLI and report two factual claims about it, each with the source_url you actually saw.',
      schema: {
        type: "object", additionalProperties: false, required: ["findings"],
        properties: {
          findings: {
            type: "array", minItems: 1, maxItems: 4,
            items: {
              type: "object", additionalProperties: false, required: ["claim", "source_url"],
              properties: { claim: { type: "string" }, source_url: { type: "string" } },
            },
          },
        },
      },
      timeoutMs: 300_000,
    });
    console.log(`       searchCalls=${c.meta.searchCalls} harvestedUrls=${c.harvestedUrls.length}`);
    for (const f of c.value.findings) console.log(`       - ${f.claim.slice(0, 90)}  [${f.source_url}]`);
    if (c.meta.searchCalls > 0) ok("websearch actually ran"); else bad("websearch did not run");
    if (c.harvestedUrls.length > 0) ok(`${c.harvestedUrls.length} urls harvested for verification`); else bad("no urls harvested");

    // The citation guard: a claimed source must be one the model actually saw.
    const unseen = c.value.findings.filter((f) => !c.harvestedUrls.some((u) => u.startsWith(f.source_url) || f.source_url.startsWith(u)));
    console.log(`       claimed-but-unharvested sources: ${unseen.length}/${c.value.findings.length}`);
  }

  console.log("\nTEST D: llm_call audit trail");
  const rows = db.prepare("SELECT task, ok, model_id, attempts, search_calls FROM llm_call ORDER BY id").all() as any[];
  for (const r of rows) console.log(`       ${r.task} ok=${r.ok} ${r.model_id} attempts=${r.attempts} search=${r.search_calls}`);
  if (rows.length >= 2) ok(`${rows.length} calls logged`); else bad("calls not logged");
} catch (e) {
  failures++;
  console.error("\nFATAL:", (e as Error).message);
  console.error((e as any).raw ? `raw: ${String((e as any).raw).slice(0, 400)}` : "");
  console.error(sup.stderrTail.slice(-15).join("\n"));
} finally {
  await sup.stop();
}
console.log(`\n${failures === 0 ? "\x1b[32mALL CHECKS PASSED\x1b[0m" : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
