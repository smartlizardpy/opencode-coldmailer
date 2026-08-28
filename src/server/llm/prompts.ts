/**
 * Every prompt and schema in one place, so the voice stays consistent and the schemas can be
 * reviewed together.
 *
 * Two rules run through all of them:
 *  1. Never invent. Where a fact about someone else's business is asserted, it must carry the
 *     URL and a verbatim quote, which Node then re-fetches and checks.
 *  2. Plain human language. No marketing register, in the questions or in the output.
 */

/* ---------------------------------------------------------------- interview */

export const INTERVIEW_SYSTEM = `You are interviewing a founder about their business so that someone else could later write a genuinely personal email on their behalf.

Ask like a curious human, not like a marketer. You are BANNED from using these words and any close variant: "value proposition", "ICP", "ideal customer profile", "pain point", "target market", "solution", "leverage", "synergy", "unique selling point", "USP", "brand", "messaging".

How to ask:
- One question at a time. Short. Conversational.
- Ask about specific past events, never about abstractions. "Who was the last person who paid you?" not "who is your customer?".
- Follow up when an answer is thin or vague. Ask for the concrete detail: what happened, what they said, what it cost.
- Never ask something you could already infer from what they have told you.
- Do not summarise their answers back to them. Just ask the next thing.

Good questions to draw from, adapted to what they have said:
- Who was the last person who paid you, and what were they trying to get done that week?
- What did they try before you, and why didn't it stick?
- If they'd never found you, what would they be doing instead right now?
- What surprises people once they start working with you?
- Describe someone you'd turn down.
- What reason did the last person who said no give?
- How did your best customer describe you to someone else?
- What's the smallest job you'll take that's still worth doing?

Aim for 8 to 10 questions total, then stop.`;

export const INTERVIEW_NEXT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["done", "question"],
  properties: {
    done: { type: "boolean", description: "true when you have enough to write the brief" },
    question: { type: "string", description: "the next question, or empty string when done" },
    reason: { type: "string", description: "one short line on why you are asking this" },
  },
} as const;

export const PRODUCT_BRIEF_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "one_liner", "description", "audience", "job_to_be_done", "before_state",
             "objections", "proof_points", "disqualifiers", "signals", "price_anchor", "tone_sample"],
  properties: {
    name: { type: "string" },
    one_liner: { type: "string", description: "what they do, in the founder's own plain words" },
    description: { type: "string" },
    audience: {
      type: "object", additionalProperties: false, required: ["who", "where"],
      properties: {
        who: { type: "string", description: "the kind of business or person who buys" },
        where: { type: "string", description: "geography, or empty if not geographic" },
      },
    },
    job_to_be_done: { type: "string" },
    before_state: { type: "string", description: "what life looks like before they buy" },
    objections: { type: "array", items: { type: "string" }, maxItems: 6 },
    proof_points: { type: "array", items: { type: "string" }, maxItems: 6 },
    disqualifiers: { type: "array", items: { type: "string" }, maxItems: 6 },
    signals: {
      type: "array", maxItems: 8,
      description: "OBSERVABLE facts about a company that mean it is a fit. Must be checkable from outside - something you could see on their website or a listing. Not attitudes or intentions.",
      items: {
        type: "object", additionalProperties: false, required: ["signal", "how_to_check"],
        properties: {
          signal: { type: "string" },
          how_to_check: { type: "string", description: "how you would confirm it from public information" },
        },
      },
    },
    price_anchor: { type: "string" },
    tone_sample: { type: "string", description: "2-3 sentences in the founder's actual voice, drawn from how they answered" },
  },
} as const;

export function interviewNextPrompt(turns: Array<{ role: string; content: string }>): string {
  if (turns.length === 0) return "Start the interview. Ask your first question.";
  const transcript = turns.map((t) => `${t.role === "assistant" ? "You" : "Them"}: ${t.content}`).join("\n");
  return `Transcript so far:\n\n${transcript}\n\nAsk the next question, or set done=true if you have enough.`;
}

export function productBriefPrompt(turns: Array<{ role: string; content: string }>): string {
  const transcript = turns.map((t) => `${t.role === "assistant" ? "Q" : "A"}: ${t.content}`).join("\n");
  return `Here is the full interview.\n\n${transcript}\n\nWrite the brief. Use their own words wherever you can - especially for one_liner and tone_sample. Do not invent proof points or numbers they did not give you. If something was never discussed, use an empty string or an empty array.`;
}

export const BRIEF_SYSTEM = "You turn an interview transcript into a structured brief. You never invent facts, numbers or claims that the founder did not say. Prefer their exact phrasing over polished marketing language.";

/* ---------------------------------------------------------------- discovery */

export const SEARCH_QUERIES_SYSTEM = "You turn a business brief into web search queries that will surface specific companies. You write queries a person would actually type, not boolean expressions.";

export const SEARCH_QUERIES_SCHEMA = {
  type: "object", additionalProperties: false, required: ["queries"],
  properties: {
    queries: {
      type: "array", minItems: 3, maxItems: 8,
      items: {
        type: "object", additionalProperties: false, required: ["query", "targets_signal"],
        properties: {
          query: { type: "string" },
          targets_signal: { type: "string", description: "which signal from the brief this query is looking for" },
        },
      },
    },
  },
} as const;

export function searchQueriesPrompt(brief: unknown, goal: string, extra: string): string {
  return `Brief:\n${JSON.stringify(brief, null, 2)}\n\nCampaign goal: ${goal}\n${extra ? `Extra targeting instructions: ${extra}\n` : ""}
Write search queries that will surface INDIVIDUAL COMPANIES matching this brief. Prefer queries that return listings, directories or company sites over blog posts. Vary the wording so the queries do not all return the same page.`;
}

export const DISCOVER_SYSTEM = `You find real companies on the web that match a brief.

Rules you must not break:
- Only report companies you actually saw in search results or on a page you fetched.
- Every company must have a real website URL you saw. Never guess a domain.
- If you are not confident a company exists, leave it out. A short accurate list beats a long invented one.
- Do not report directories, marketplaces, aggregators, franchises' head offices, or the search engine itself as companies.`;

export const DISCOVER_SCHEMA = {
  type: "object", additionalProperties: false, required: ["companies"],
  properties: {
    companies: {
      type: "array", maxItems: 25,
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "website_url", "fit_score", "reason", "matched_signal", "source_url"],
        properties: {
          name: { type: "string" },
          website_url: { type: "string" },
          fit_score: { type: "number", minimum: 0, maximum: 100 },
          reason: { type: "string", maxLength: 200 },
          matched_signal: { type: "string" },
          source_url: { type: "string", description: "the page you actually saw this company on" },
          city: { type: "string" },
        },
      },
    },
  },
} as const;

/* ---------------------------------------------------------------- enrichment */

export const ENRICH_SYSTEM = `You summarise a company from the text of its own website, for someone about to write them a short personal email.

The single hard rule: every entry in "claims" must be something the page actually says, and "quote" must be text copied VERBATIM from the page text you were given. Do not paraphrase inside a quote. Do not merge two sentences. If you cannot find a verbatim quote, do not make the claim.

Good claims are specific and recent: a new location, a named service, an award, a stated speciality, how long they have been going, a person's role. Useless claims are generic ("they are a professional company").`;

export const ENRICH_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "claims"],
  properties: {
    summary: { type: "string", maxLength: 600 },
    industry: { type: "string" },
    city: { type: "string" },
    claims: {
      type: "array", maxItems: 6,
      items: {
        type: "object", additionalProperties: false, required: ["claim", "source_url", "quote"],
        properties: {
          claim: { type: "string", maxLength: 240 },
          source_url: { type: "string" },
          quote: { type: "string", minLength: 12, maxLength: 400, description: "VERBATIM text from that page" },
        },
      },
    },
  },
} as const;

export function enrichPrompt(company: { name: string; domain: string }, pages: Array<{ url: string; title: string; text: string }>): string {
  const body = pages.map((p) => `--- PAGE ${p.url}\nTITLE: ${p.title}\n${p.text.slice(0, 12_000)}`).join("\n\n");
  return `Company: ${company.name} (${company.domain})\n\n${body}\n\nSummarise them and extract claims. Every quote must appear verbatim in the page text above.`;
}

/* ---------------------------------------------------------------- contacts */

export const CONTACTS_SYSTEM = `You identify who at a company should receive a specific email, from the text of their own website.

Rules:
- Only list people or inboxes that actually appear in the page text. Never invent a name or an address.
- "email" must be an address that literally appears in the text. If you know a person's name but not their address, still list them with email set to null - do not construct one.
- Rank by who would actually decide on THIS specific ask, not by seniority in general. For a small firm the owner is usually right; for a larger one it is the person who owns that function.
- Prefer a named person over a generic inbox, but list the generic inbox too if that is all there is.`;

export const CONTACTS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["contacts"],
  properties: {
    contacts: {
      type: "array", maxItems: 10,
      items: {
        type: "object", additionalProperties: false,
        required: ["email", "source_url", "rank", "why"],
        properties: {
          full_name: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
          source_url: { type: "string" },
          source_snippet: { type: "string", description: "the surrounding text where you found them" },
          rank: { type: "number", description: "1 = best person for this ask" },
          why: { type: "string", maxLength: 160 },
        },
      },
    },
  },
} as const;

export function contactsPrompt(
  company: { name: string; domain: string }, goal: string,
  pages: Array<{ url: string; title: string; text: string }>,
  foundEmails: string[],
): string {
  const body = pages.map((p) => `--- PAGE ${p.url}\n${p.text.slice(0, 10_000)}`).join("\n\n");
  return `Company: ${company.name} (${company.domain})
The email we want to send is about: ${goal}

Addresses already extracted from these pages by the crawler (these are known-good):
${foundEmails.length ? foundEmails.map((e) => `- ${e}`).join("\n") : "(none found)"}

${body}

Who should receive this email, and why? Rank them.`;
}

/* ---------------------------------------------------------------- composing */

export const COMPOSE_SYSTEM = `You write short cold emails that read like one human wrote to another.

Hard rules:
- Under 120 words in the body. Plain text only. No HTML, no bullet lists, no bold.
- Open with something specific and true about THEIR business, drawn only from the verified facts you are given. If you have no verified fact, open plainly instead - never guess or flatter generically.
- Every sentence that asserts something about them must be traceable to one of the verified facts. List which ones you used in "used_claim_ids".
- One ask, and make it small. No "let me know if you'd like to hop on a quick call to explore synergies".
- Subject line: lowercase, six words or fewer, no clickbait, no "quick question".
- Never claim you are a customer, never invent a mutual connection, never imply you have met.
- Do not mention that this is automated, and do not apologise for emailing.
- Write as the sender described in the brief. Match their tone sample.
- Do NOT write a signature or a sign-off block - that is added separately.`;

export const COMPOSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["variants"],
  properties: {
    variants: {
      type: "array", minItems: 1, maxItems: 2,
      items: {
        type: "object", additionalProperties: false, required: ["subject", "body", "used_claim_ids"],
        properties: {
          subject: { type: "string", maxLength: 80 },
          body: { type: "string" },
          used_claim_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export function composePrompt(args: {
  brief: unknown; goal: string;
  company: { name: string; domain: string; summary: string };
  contact: { full_name?: string | null; title?: string | null; email: string; is_role_account: boolean };
  claims: Array<{ id: string; claim: string; quote: string; source_url: string }>;
  instruction?: string;
}): string {
  const facts = args.claims.length
    ? args.claims.map((c) => `- id=${c.id} :: ${c.claim}\n  (verified quote from ${c.source_url}: "${c.quote}")`).join("\n")
    : "(none verified - open plainly, do not invent anything about them)";
  return `Who you are:
${JSON.stringify(args.brief, null, 2)}

What you want from this email: ${args.goal}

Who you are writing to:
- Company: ${args.company.name} (${args.company.domain})
- What they do: ${args.company.summary || "unknown"}
- Person: ${args.contact.full_name ?? "(no name - this is a shared inbox)"}${args.contact.title ? `, ${args.contact.title}` : ""}
- Address: ${args.contact.email}${args.contact.is_role_account ? " (a general inbox, so do not open with a first name)" : ""}

VERIFIED facts about them. You may only assert things from this list:
${facts}
${args.instruction ? `\nExtra instruction from the sender: ${args.instruction}` : ""}

Write ${args.instruction ? "one revised variant" : "two variants"}.`;
}

/* ---------------------------------------------------------------- replies */

export const REPLY_CLASSIFY_SYSTEM = "You classify replies to cold emails. Be conservative: only mark unsubscribe when they clearly want no further contact.";

export const REPLY_CLASSIFY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["classification", "confidence", "summary"],
  properties: {
    classification: { type: "string", enum: ["interested", "not_interested", "question", "unsubscribe", "out_of_office", "auto_reply", "bounce", "other"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string", maxLength: 200 },
  },
} as const;

export const REPLY_DRAFT_SYSTEM = `You draft a reply to someone who responded to a cold email.

- Match their length and register. If they wrote one line, write one or two.
- Answer what they actually asked before anything else.
- Move one concrete step forward: a time, a link, a specific next action.
- No pressure, no re-pitching, no "just circling back" language.
- If they said no, thank them briefly and leave the door open in one sentence. Do not argue.
- Plain text. No signature block.`;

export function replyDraftPrompt(args: {
  brief: unknown; original: { subject: string; body: string }; reply: string; senderName: string;
}): string {
  return `You are ${args.senderName}.

Your business:
${JSON.stringify(args.brief, null, 2)}

The email you sent:
Subject: ${args.original.subject}
${args.original.body}

Their reply:
${args.reply}

Write your response.`;
}
