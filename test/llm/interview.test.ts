/**
 * Interview coverage.
 *
 * The failure this guards against, observed on a real run: the interviewer followed up so hard
 * that six of eight questions were about the same customer, two were verbatim identical, and it
 * never reached objections, disqualifiers or price. A brief written from that transcript is
 * missing most of what the emails need.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { interviewNextPrompt, INTERVIEW_TOPICS, INTERVIEW_SYSTEM, INTERVIEW_NEXT_SCHEMA,
         BRIEF_SYSTEM, productBriefPrompt, PRODUCT_BRIEF_SCHEMA } from "../../src/server/llm/prompts.ts";

test("the first prompt lists every topic as uncovered", () => {
  const p = interviewNextPrompt([]);
  for (const t of INTERVIEW_TOPICS) assert.ok(p.includes(t), `missing ${t}`);
});

test("an answered question marks its topic covered", () => {
  const p = interviewNextPrompt([
    { role: "assistant", content: "Who last paid you?", topic: "last_customer" },
    { role: "user", content: "A cafe owner." },
  ]);
  assert.match(p, /covered \(do NOT ask about these again\): last_customer/);
  assert.ok(!/Topics still uncovered:[^\n]*last_customer/.test(p));
});

test("a question still awaiting an answer is NOT yet covered", () => {
  const p = interviewNextPrompt([
    { role: "assistant", content: "Who last paid you?", topic: "last_customer" },
  ]);
  assert.match(p, /covered[^\n]*: none yet/);
  assert.match(p, /uncovered:[^\n]*last_customer/);
});

test("every previously asked question is listed so it cannot be repeated", () => {
  const p = interviewNextPrompt([
    { role: "assistant", content: "Who last paid you?", topic: "last_customer" },
    { role: "user", content: "A cafe owner." },
    { role: "assistant", content: "What had she tried before?", topic: "alternative" },
    { role: "user", content: "Wix." },
  ]);
  assert.ok(p.includes("Who last paid you?"));
  assert.ok(p.includes("What had she tried before?"));
  assert.match(p, /must not repeat in any wording/);
});

test("when everything is covered the prompt says to finish", () => {
  const turns = INTERVIEW_TOPICS.flatMap((t) => [
    { role: "assistant", content: `Q about ${t}`, topic: t as string },
    { role: "user", content: "an answer" },
  ]);
  const p = interviewNextPrompt(turns);
  assert.match(p, /uncovered: none - set done=true/);
});

test("the system prompt bans marketing language and names the topics", () => {
  for (const banned of ["value proposition", "ICP", "pain point", "target market"]) {
    assert.ok(INTERVIEW_SYSTEM.includes(banned), `${banned} must be listed as banned`);
  }
  assert.match(INTERVIEW_SYSTEM, /at most ONE follow-up per topic/i);
  for (const t of INTERVIEW_TOPICS) assert.ok(INTERVIEW_SYSTEM.includes(t), `topic ${t} missing`);
});

test("the schema forces the model to name the topic it is asking about", () => {
  assert.ok((INTERVIEW_NEXT_SCHEMA.required as readonly string[]).includes("topic"));
  const en = (INTERVIEW_NEXT_SCHEMA.properties.topic as { enum: string[] }).enum;
  for (const t of INTERVIEW_TOPICS) assert.ok(en.includes(t));
});

test("the brief prompt guards the two fields that come out wrong", () => {
  // Observed on a real run: one_liner came back as the price answer and job_to_be_done as one
  // customer's errand ("Get a lunch menu online before the summer").
  assert.match(BRIEF_SYSTEM, /one_liner is WHAT THEY DO/);
  assert.match(BRIEF_SYSTEM, /not a price/i);
  assert.match(BRIEF_SYSTEM, /job_to_be_done is the GENERAL job/);
  const p = productBriefPrompt([{ role: "assistant", content: "q" }, { role: "user", content: "a" }]);
  assert.match(p, /rather than what it costs/);
  assert.match((PRODUCT_BRIEF_SCHEMA.properties.one_liner as { description: string }).description, /Never a price/);
});
