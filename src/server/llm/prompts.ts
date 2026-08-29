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

## Cover the ground
There are eight topics. Each question must target ONE of them, and you must say which:

  last_customer  who last paid, and what they were trying to get done
  alternative    what they tried before, and why it did not work
  without_you    what they would be doing if they had never found you
  surprise       what people are surprised by once they start working with you
  bad_fit        who you would turn down
  objection      the reason the last person who said no gave
  reputation     how a happy customer described you to someone else
  price          the smallest job worth doing, and what things cost

You will be told which topics are already covered. NEVER ask about a covered topic again.
Always pick an uncovered one. When all eight are covered, set done=true.

## Following up
At most ONE follow-up per topic, and only when the answer genuinely did not address it. A
follow-up still belongs to the same topic. If the answer was partial but usable, take it and
move on - the brief is written from the whole conversation, not from any single answer.
Never repeat a question you have already asked, in any wording.

## How to ask
- One question at a time. Short. Conversational.
- Ask about specific past events, never about abstractions. "Who was the last person who paid
  you?" not "who is your customer?".
- Never ask something you could already infer from what they have told you.
- Do not summarise their answers back to them. Just ask the next thing.`;

export const INTERVIEW_TOPICS = [
  "last_customer", "alternative", "without_you", "surprise",
  "bad_fit", "objection", "reputation", "price",
] as const;

export const INTERVIEW_NEXT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["done", "question", "topic"],
  properties: {
    done: { type: "boolean", description: "true once every topic is covered" },
    question: { type: "string", description: "the next question, or empty string when done" },
    topic: { type: "string", enum: [...INTERVIEW_TOPICS, ""], description: "which topic this question is for" },
    is_follow_up: { type: "boolean" },
  },
} as const;

export const PRODUCT_BRIEF_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "one_liner", "description", "audience", "job_to_be_done", "before_state",
             "objections", "proof_points", "disqualifiers", "signals", "price_anchor", "tone_sample"],
  properties: {
    name: { type: "string" },
    one_liner: { type: "string", description: "WHAT THEY DO for people, in the founder's own plain words. Never a price. Never one customer's specific request." },
    description: { type: "string" },
    audience: {
      type: "object", additionalProperties: false, required: ["who", "where"],
      properties: {
        who: { type: "string", description: "the kind of business or person who buys" },
        where: { type: "string", description: "geography, or empty if not geographic" },
      },
    },
    job_to_be_done: { type: "string", description: "the general job customers hire them for, generalised from the stories - not one customer's specific errand" },
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

export function interviewNextPrompt(
  turns: Array<{ role: string; content: string; topic?: string | null }>,
): string {
  if (turns.length === 0) {
    return `No questions asked yet. Every topic is uncovered: ${INTERVIEW_TOPICS.join(", ")}.
Ask your first question.`;
  }
  const transcript = turns.map((t) => `${t.role === "assistant" ? "You" : "Them"}: ${t.content}`).join("\n");
  const asked = turns.filter((t) => t.role === "assistant");
  // A topic counts as covered once it has been asked about AND answered.
  const covered = new Set<string>();
  turns.forEach((t, i) => {
    // Covered means asked AND answered: a question still awaiting a reply is not yet covered.
    if (t.role === "assistant" && t.topic && turns[i + 1]?.role === "user") covered.add(t.topic);
  });
  const remaining = INTERVIEW_TOPICS.filter((t) => !covered.has(t));
  return `Transcript so far:

${transcript}

Topics already covered (do NOT ask about these again): ${[...covered].join(", ") || "none yet"}
Topics still uncovered: ${remaining.join(", ") || "none - set done=true"}

Questions you have already asked, which you must not repeat in any wording:
${asked.map((t) => `- ${t.content}`).join("\n")}

Ask the next question about an UNCOVERED topic, or set done=true if none remain.`;
}

export function productBriefPrompt(turns: Array<{ role: string; content: string }>): string {
  const transcript = turns.map((t) => `${t.role === "assistant" ? "Q" : "A"}: ${t.content}`).join("\n");
  return `Here is the full interview.

${transcript}

Write the brief. Use their own words wherever you can, especially for tone_sample.

Check two things before you answer:
- Does one_liner say what they DO, rather than what it costs or what one customer asked for?
- Is job_to_be_done the general job, rather than a single customer's specific errand?

Do not invent proof points or numbers they did not give you. If something was never discussed,
use an empty string or an empty array.`;
}

export const BRIEF_SYSTEM = `You turn an interview transcript into a structured brief.

Never invent facts, numbers or claims the founder did not say. Prefer their exact phrasing over
polished marketing language.

Two fields are routinely got wrong, so be deliberate about them:

- one_liner is WHAT THEY DO for people. It is not a price, and it is not one customer's
  request. "I build small websites for local businesses that need to be found online" is a
  one-liner; "Four hundred quid for a small site" is a price and belongs in price_anchor.
- job_to_be_done is the GENERAL job, generalised from the specific stories. If one customer
  wanted a lunch menu online before summer, the job is getting a small business found online
  and turning that into orders - not "get a lunch menu online before the summer".

Everything else stays concrete and close to their words. Where a topic was never discussed, use
an empty string or an empty array rather than filling it in from imagination.`;

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

export function searchQueriesPrompt(brief: unknown, goal: string, target: string, extra: string): string {
  return `Who we are:\n${JSON.stringify(brief, null, 2)}

Campaign goal: ${goal}

TARGET - the kind of organisation to find:
${target}
${extra ? `\nExtra targeting instructions: ${extra}\n` : ""}
Write search queries that will surface INDIVIDUAL ORGANISATIONS OF THAT KIND. The target is the
thing being searched for - not us, and not our customers. Prefer queries that return company
sites over blog posts. Vary the wording so the queries do not all return the same page.`;
}

export const DISCOVER_SYSTEM = `You find real companies on the web that match a stated target.

The TARGET tells you what KIND of organisation to look for. It is the primary filter and it
overrides everything else. If the target says "small independent news websites", then a sports
club, an academy, a shop or a directory is WRONG no matter how relevant its subject matter is.
Matching the topic is not the same as matching the kind of organisation.

Before you report a company, ask yourself: is this organisation actually the kind of thing the
target describes? If it is not, leave it out.

Other rules you must not break:
- Only report companies you actually saw in search results or on a page you fetched.
- Every company must have a real website URL you saw. Never guess a domain.
- The name you report must be the name of the site at that exact domain. Do not attach a name
  from one search result to a URL from another.
- If you are not confident a company exists, leave it out. A short accurate list beats a long
  invented one.
- Do not report directories, marketplaces, aggregators, or the search engine itself.
- fit_score is how well it matches THE TARGET, not how interesting it is.`;

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
          website_url: { type: "string", format: "uri" },
          fit_score: { type: "number", minimum: 0, maximum: 100 },
          reason: { type: "string", maxLength: 200 },
          matched_signal: { type: "string" },
          entity_kind: { type: "string", description: "what kind of organisation this actually is, in your own words (e.g. 'local news website', 'tennis academy', 'online shop')" },
          source_url: { type: "string", format: "uri", description: "the page you actually saw this company on" },
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
          source_url: { type: "string", format: "uri" },
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
- Prefer a named person over a generic inbox, but list the generic inbox too if that is all there is.
- If the crawler has already extracted addresses from these pages, EVERY one of them must appear
  in your answer. They were read from the page text directly, so "I could not find an address" is
  not an available answer when the list below is non-empty. Rank them, do not drop them.`;

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
          source_url: { type: "string", format: "uri" },
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

export const COMPOSE_SYSTEM = `You write short cold emails that read like one busy person wrote to another.

LANGUAGE
Write in the language the recipient's own website is written in. If their site is Turkish, write
Turkish - naturally, not translated. Match how people actually write email in that language.

STRUCTURE - three short paragraphs, in this order:
1. Why you are writing to THEM specifically. Use a verified fact as the REASON, not as a
   compliment. The fact must connect to the ask: the reader should finish the sentence
   understanding why they got this email and not someone else.
2. What you are offering or asking for, concretely. Say the actual thing.
3. One ask they can answer in a sentence.

BANNED - these are what make an email obviously automated:
- Any evaluative adjective about them: "dikkat çekici", "etkileyici", "harika", "impressive",
  "great", "fantastic", "love what you're doing", "really interesting". State facts, never
  grade them. If you delete the adjective and the sentence still works, the adjective was filler.
- Stacked hedging: "-abilir/-ebiliriz", "we could potentially", "might be able to". Say what you
  will do, not what could theoretically happen.
- Vague joint activity: "birlikte başlamak", "let's explore", "hop on a quick call to discuss
  synergies", "touch base", "circle back", "partner up". Name the actual next step instead.
- Anything about yourself before you have given them a reason to keep reading.
- Apologising for the email, or saying you will "keep it brief".

THE ASK must be answerable. Good: "Denemek isterseniz üç haberinizi bu hafta yayına alabilirim -
uygun mu?" / "Would Tuesday or Wednesday suit for 15 minutes?" Bad: "Would you like to start this
together?" - because the reader cannot tell what saying yes commits them to.

FACTS
- Every sentence asserting something about them must trace to a verified fact you were given.
  List the ids you used in used_claim_ids.
- If you have no verified facts, do not invent a reason. Open with the concrete offer instead.
- Never claim to be a customer, never invent a mutual connection, never imply you have met.

FORM
- Under 110 words. Plain text. No bullet lists, no bold, no links unless the ask needs one.
- Subject: lowercase, six words or fewer, a noun phrase naming the actual subject. Not a question,
  not a verb phrase, not "quick question".
- Do NOT write a signature or sign-off block - that is added separately.`;

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

What you want from this email (this is the ask - make it concrete and answerable):
${args.goal}

Who you are writing to:
- Company: ${args.company.name} (${args.company.domain})
- What they do: ${args.company.summary || "unknown"}
- Person: ${args.contact.full_name ?? "(no name - this is a shared inbox)"}${args.contact.title ? `, ${args.contact.title}` : ""}
- Address: ${args.contact.email}${args.contact.is_role_account ? " (a general inbox, so do not open with a first name)" : ""}
- Their website is ${args.company.domain} - write in the language that site uses.

VERIFIED facts about them. You may only assert things from this list:
${facts}
${args.instruction ? `
Extra instruction from the sender: ${args.instruction}

Follow it, and keep citing at least one of the verified facts above unless the instruction
specifically asks you to drop it. "Make it shorter" means cut the pitch, not the one specific
thing that proves this email was written for them - an email that loses that is a mail-merge,
which is the only thing this is trying not to be.` : ""}

Write ${args.instruction ? "one revised variant" : "two variants"}.`;
}

/* ---------------------------------------------------------------- replies */

export const REPLY_CLASSIFY_SYSTEM = `You classify replies to cold emails.

Be conservative: only mark unsubscribe when they clearly want no further contact. Marking it
wrongly suppresses a real lead permanently.

Write the summary in the SAME LANGUAGE as the reply you are reading. The person reading it is
the one who sent the original email, and switching to English for one reply out of three makes
the list look like it was written by three different tools.`;

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


/* --------------------------------------------------------- verify after fetching */

export const RECHECK_SYSTEM = `You check whether a company is actually what a web search implied, now that its own website has been fetched.

Search results are often wrong: a name from one result gets attached to a URL from another, or a
site turns out to be a different kind of organisation entirely. You are the correction step.

Judge ONLY from the page text you are given, never from the name you were told. If the page says
this is a shooting and hunting club, then it is a shooting and hunting club, whatever the search
result called it.

Work in this order, and fill the fields in this order:
1. target_kind - what KIND of organisation the target is asking for, in your own words, as a
   category noun. Not the topic. "local news website", "dental practice", "letting agent".
2. entity_kind - what kind this organisation actually is, from its own pages.
3. matches_target - true ONLY if entity_kind is the same KIND of thing as target_kind.

Sharing a subject is not being the same kind of thing. A tennis academy and a sports news site
are both about sport; only one of them is a news site. A hospital and a medical equipment
supplier are both about healthcare; only one of them treats patients. If you find yourself
justifying a match by the topic they have in common rather than by what the organisation IS,
the answer is false.

fit_score is how well it fits the whole target once the kind matches. If matches_target is
false, fit_score must be 0.`;

export const RECHECK_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["actual_name", "target_kind", "entity_kind", "matches_target", "fit_score", "reason"],
  properties: {
    actual_name: { type: "string", description: "the organisation's real name, as the page gives it" },
    target_kind: { type: "string", description: "the KIND of organisation the target asks for, as a category noun" },
    entity_kind: { type: "string", description: "what kind of organisation it actually is" },
    matches_target: { type: "boolean" },
    fit_score: { type: "number", minimum: 0, maximum: 100 },
    reason: { type: "string", maxLength: 200 },
  },
} as const;

export function recheckPrompt(args: {
  target: string; claimedName: string; domain: string;
  pages: Array<{ url: string; title: string; text: string }>;
}): string {
  const body = args.pages.map((p) => `--- PAGE ${p.url}\nTITLE: ${p.title}\n${p.text.slice(0, 8_000)}`).join("\n\n");
  return `TARGET - the kind of organisation we are looking for:
${args.target}

The search result claimed this domain is: "${args.claimedName}" (${args.domain})

Here is what the site actually says:

${body}

Name the kind the target asks for, name the kind this actually is, then decide. Being about the
same subject is not enough - it has to BE the same kind of organisation.`;
}

/* ---------------------------------------------------------------- reframe */

export const REFRAME_SYSTEM = `You turn a rough, half-finished campaign description into the two
fields the tool actually needs. The person is describing their own work quickly, often mixing
languages, often writing one run-on sentence that mixes what their product IS with what they
want from the email. That is normal. Your job is to separate those and make each one usable.

**goal** is what you want THIS EMAIL to achieve - the ask, in one line. Not a description of
your product, not your business model. "agree an in-app advertising partnership" is a goal.
"our new app that we will launch and advertising inside it" is not: it describes the product.
If the ask is implied rather than stated, name the smallest concrete first step a stranger
could say yes to.

**target_description** is the KIND of organisation to look for. It must name a category of
organisation, not a topic, because a search filter built on a topic returns everything adjacent
to it. Include size, independence, and geography when you can infer them. Keep the person's own
local-language term for the category alongside the English one - the search runs in their market
and "spor salonu" finds things "gym" does not.

Rules:
- Never invent a place, a size, a budget or an industry the person did not imply. If geography
  is only implied by the language they wrote in, say so in notes rather than asserting it.
- Keep proper nouns exactly as written. A product called Avenza stays Avenza.
- If the input is too thin to reframe honestly, say so in notes and leave that field close to
  what they wrote rather than inventing detail.
- Write goal and target_description in the language the person used for that field. Keep the
  local category term either way.
- notes describe what THIS TOOL did, impersonally: "Split the product description out of the
  ask", not "you separated the product description". Never write them as if the person did the
  rewriting - they did not, and it reads as the tool being confused about who is who.
- notes must not contradict the fields. If a note says an attribute was not assumed, that
  attribute must not appear in target_description. This is the single most damaging failure
  here: a target that quietly asserts "independent" while the note says independence was not
  assumed is worse than either alone, because it looks checked.
- notes are how they catch you being wrong, so they matter more than the polish.`;

export const REFRAME_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "goal", "target_description", "notes"],
  properties: {
    name: { type: "string", maxLength: 60, description: "a short campaign name, their words" },
    goal: { type: "string", maxLength: 200, description: "the ask, one line" },
    target_description: { type: "string", maxLength: 500, description: "the KIND of organisation" },
    notes: {
      type: "array", maxItems: 5, items: { type: "string", maxLength: 160 },
      description: "what you changed, and anything you guessed",
    },
  },
} as const;

export function reframePrompt(a: { name?: string; goal?: string; target?: string }): string {
  return `Here is what they typed. Some or all of it may be rough, mixed-language, or empty.

Campaign name: ${a.name?.trim() || "(blank)"}
What they want from the email: ${a.goal?.trim() || "(blank)"}
Who they are looking for: ${a.target?.trim() || "(blank)"}

Rewrite these into a name, a goal, and a target_description, and tell them what you changed.`;
}
