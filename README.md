# coldcall

A local cold-email system that runs on your own machine and costs nothing to run.

opencode does the thinking (free models, including web search). Your own mailbox does the sending,
over SMTP with an app password. Everything — the database, the drafts, your credentials — stays on
your machine. Nothing is uploaded anywhere and **no part of this product can generate a bill.**

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/smartlizardpy/opencode-coldmailer/main/install.sh | bash
```

Then:

```bash
opencode auth login   # once, if you've never signed in — free options available
coldcall              # opens the web UI
```

The installer never uses `sudo`, never touches your system Node, and installs a private Node 24
only if you don't already have ≥ 22.13.0 (the first version where `node:sqlite` works unflagged).

## How it works

1. **Product interview.** A short conversation that asks human questions — "who was the last
   person who paid you, and what were they trying to get done that week?" — and never says
   "value proposition". It produces an editable brief.
2. **Set the campaign target.** Who *this* campaign is looking for, which is often not your
   customer: partners, press, content sources. This is the filter discovery actually uses.
3. **Find companies.** opencode's web search, or paste a list. Nothing is researched until you
   tick it. After a company's site is fetched, it is re-judged against the target and dropped if
   it turns out to be the wrong kind of organisation.
4. **Find the right people.** A bounded, robots-aware crawl of each company's own site —
   homepage plus up to six contact/about/team pages, matched in seven languages — then the model
   picks who actually decides on *this* ask. Every contact carries the URL it came from.
5. **Write.** Short, plain-text emails in the language of the recipient's own website. Every
   personalised claim is traceable to a page and a verbatim quote.
6. **Review and send.** Quality flags surface the weak drafts first. You approve each one; sends
   are capped per day and spaced apart.
7. **Follow up.** Two steps by default, at 4 and 7 days. Anyone who replies leaves the sequence
   immediately.
8. **Replies.** IMAP matches replies to the thread and drafts a response you can edit or ignore.

## The screens

A sidebar app shell, not a settings page with a send button.

| | |
|---|---|
| **Dashboard** | What needs attention. A funnel showing where companies drop out *and why*, sends and replies over 14 days, a setup checklist |
| **Campaigns** | Target, discovery, and the company table with fit scores, verified-fact counts and per-company evidence |
| **Review** | A keyboard-driven queue — `j`/`k` to move, `a` to approve, `e` edit, `r` rewrite, `s` skip. Every claim shows its quote and source |
| **Outbox** | Daily cap, the send log, and the follow-up schedule |
| **Replies** | Matched to their thread, classified, with a drafted response you can copy |
| **Product** | The interview and the editable brief |
| **Settings** | Models, mailbox, limits, never-contact list |
| **Activity** | Every model call, including what a failed one returned |

`⌘K` / `Ctrl K` opens a command palette. `?` lists the shortcuts.

## Quality flags

Cold email fails in predictable ways, so the ones a careful reader would catch are detected when
a draft is written and shown at the top of review:

- empty praise ("dikkat çekici", "impressive", "love what you're doing")
- hedged offers ("gösterebilir… olabiliriz", "we could potentially")
- an ask the reader can't act on ("let me know if", "birlikte başlamak")
- no question at all, unfilled placeholders, nothing cited, too long or too short

Three of these block a bulk approve; the rest are advisory. They are never auto-rejected — a flag
means "read this one first", not "this is wrong".

## The one guarantee worth knowing

**An email cannot contain a fact about someone's business that we did not fetch and verify
ourselves.**

The model proposes a claim with a quote. Node re-fetches that page, normalises both sides, and
checks the quote actually appears. Only then is the claim marked `verified`. And a database
trigger rejects any draft that cites an unverified claim — so even if every layer above it fails,
a hallucinated fact still cannot reach a real person.

You can see this in the UI: every draft has a **Sources** button showing the quote and a link.

## What it will not do

- Send anything you have not approved.
- Send to anyone on the never-contact list — checked at the moment of sending, not at approval.
- Exceed the daily cap. That's counted from what actually left in the last 24 hours, so
  restarting the app cannot get round it.
- Run a shell command. The research agent is sandboxed at four independent layers; see below.
- Follow up anyone who replied, or anyone on the never-contact list.
- Add an opt-out footer, unless you switch it on in Settings. It's off by default.
- Cost you anything. There are no paid APIs in this product, at all.

## Sandboxing

The research agent reads attacker-controlled text — arbitrary company websites. It runs under
`OPENCODE_PERMISSION` and an inline agent config that deny everything except `websearch` and
`webfetch`, a per-request `tools` map that repeats the denial, and a runtime assertion that
inspects **every** tool call in the turn and aborts the campaign if anything unexpected appears.

Verified live: asked to run `whoami`, the agent replies *"My available tools are `webfetch` and
`websearch` only."* Run it yourself:

```bash
npm run verify:sandbox
```

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Full unit suite (no network, no model calls) |
| `npm run verify:sandbox` | 7 checks against a real sandboxed opencode |
| `npm run verify:llm` | End-to-end `llm()` against live models |
| `npm run verify:pipeline` | Research pipeline against real websites |

## Where your data lives

```
~/.coldcall/
  coldcall.db      everything: companies, contacts, drafts, send log, replies
  secrets.json     only if the macOS Keychain is unavailable (mode 0600)
  agent-cwd/       empty; opencode's working directory
  app/             the application itself
```

The SMTP password goes into the macOS login Keychain where available. That keeps it out of
`coldcall.db` — the file people back up and paste into bug reports. It does **not** stop another
process running as you from reading it, and nothing could, for an app that sends mail unattended.
The Setup screen tells you which of the two is in use.

## A note on the law

Unsolicited B2B email in the UK is governed by PECR and UK GDPR. In practice that means an
identifiable sender and a working way to opt out. The footer that does this is built in and
one checkbox away — it's off by default because you asked for it to be, not because it doesn't
matter.
