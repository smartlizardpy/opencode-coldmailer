# coldcall

A local cold-email system that runs on your own machine and costs nothing to run.

opencode does the thinking (free models, including web search). Your own mailbox does the sending,
over SMTP with an app password. The database, the drafts and your credentials stay on your machine,
and **no part of this product can generate a bill.**

There are two ways in. The **local** one, on `127.0.0.1`, is yours: the mailbox, the keys, your
company details, the models. The **shared** one is a link you can open for one other person — a
co-founder who runs the campaigns and sends the mail — and it is the only thing here that leaves
the machine. It is off by default, you open it by hand, and it closes when you close the app. See
[Two surfaces](#two-surfaces).

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
   it turns out to be the wrong kind of organisation — see The targeting gate below.
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
   A bounce is not a reply and an out-of-office is not a reply; both are sorted out and only a
   person answering stops the sequence.

## The targeting gate

Search finds things that are *about* your subject. That is not the same as being the *kind* of
organisation you want, and the gap between those two is where cold outreach goes wrong. A
campaign looking for small local news sites once drafted a genuinely well-written email to a
tennis academy: both are about sport, only one publishes news.

So after a site is fetched, before anyone is contacted, it has to survive two independent
checks:

- **Kind.** The model has to name the kind you asked for and the kind it actually found, then
  match them. Naming both is the point — a single "does this fit?" boolean is exactly the call a
  model will talk itself into for a near-miss.
- **Fit.** A per-campaign score floor, default 45. A number does not negotiate.

Both are recorded, so a rejection reads as *"not the target kind — looking for small local news
website, this is a tennis academy"* rather than a silent disappearance.

**Check one site first.** On the New campaign screen, and again under *Find companies* → *Check
one site before running the whole campaign*, paste a domain and see the gate's reasoning in a
single fetch. It commits nothing, and shares the page cache with the real crawl, so checking a
site and then running it for real does not fetch it twice. The version on the New campaign screen
runs against the words still sitting in the form — which is the moment a vague target is cheapest
to fix, rather than after a run has been spent finding out. Against the case this was built for:

| site | verdict | read as |
|---|---|---|
| `pta.com.tr` | rejected, fit 0 | tennis academy |
| `bethellandco.co.uk` | rejected, fit 0 | architectural design firm |
| `thenorthernecho.co.uk` | **included**, fit 88 | local news website |

That last row is the one that matters. A gate that rejects everything is not strict, it is
broken.

**When it is wrong.** A stricter gate makes a wrong rejection more likely, not less. *Include
anyway* on a rejected row overrules it, keeps the recorded reason, badges the row `overruled`,
and survives re-running the pipeline. (*Retry* is not an override — it clears the rejection and
re-runs the same gate against the same site, reaching the same verdict.)

**When the whole campaign is wrong.** The campaign page groups rejections by the kind that was
rejected. "23 rejected, mostly tennis academies" tells you the target is being read as a topic
rather than a kind of organisation — which a count alone cannot say. Past 60% rejected it says
so plainly instead of just reporting the number.

## The screens

A sidebar app shell, not a settings page with a send button.

| | |
|---|---|
| **Dashboard** | What needs attention. A funnel showing where companies drop out *and why*, sends and replies over 14 days, a setup checklist |
| **Campaigns** | Target, discovery, and the company table with fit scores, verified-fact counts and per-company evidence |
| **Review** | A keyboard-driven queue — `j`/`k` to move, `a` to approve, `u` to take that back, `e` edit, `r` rewrite, `s` skip. Every claim shows its quote and source |
| **Outbox** | Daily cap, the send log, and the follow-up schedule |
| **Replies** | Matched to their thread, classified, with a drafted response you can copy. Bounces and out-of-office replies are kept separate from people |
| **Deliverability** | Whether your mail will be accepted at all: SPF, DKIM, DMARC and MX on your sending domain, each with what to do about it |
| **Product** | The interview and the editable brief |
| **Settings** | Your company, keys, models, mailbox, limits, never-contact list, and the shared link |
| **Activity** | Every model call, including what a failed one returned |

`⌘K` / `Ctrl K` opens a command palette. `?` lists the shortcuts.

## Two surfaces

Cold outreach is usually two jobs and often two people: someone sets the thing up, and someone
sits with the queue. Those need very different amounts of access, and the second one does not
need a laptop with your Gmail app password on it.

**The local surface** is what you already have: `http://127.0.0.1:7788`, no password, because
anything reaching it is already running as you on your own machine. It is where the mailbox, the
keys, your company details, the model settings and the product interview live.

**The shared surface** is a Cloudflare quick tunnel pointed at the same server. Settings → *Share
with a teammate* → **Open the link** starts `cloudflared` and gives you a `*.trycloudflare.com`
URL. On its own that URL gets nobody in: it shows a sign-in screen. You then create an **invite**,
which is a link you send once.

What the shared surface can do — the whole outreach loop:

> set a campaign up, search for companies or paste a list, research them, read every draft with
> its sources, approve, unapprove, edit, rewrite, send, start and pause sending, add someone to
> the never-contact list, and work the replies.

What it cannot do, enforced on the server and not in the UI:

> read or change the mailbox, the app password, or any stored key · see your company details ·
> change the models, the daily cap, the sending window or the opt-out footer · read the Activity
> log, which quotes prompts and raw model output · edit the product brief · delete a campaign,
> because that deletes the send log the daily cap is counted from · un-block an address someone
> deliberately blocked · create or revoke invites.

Sends still happen from your machine, through your mailbox, under your caps and your window.
Nothing about handing someone the link changes who the mail comes from or how fast it goes out.

The Shared access screen also has a co-browse view for the shared coldcall tab: cursor, clicks,
scroll, keyboard shortcuts, focused fields, typed text inside coldcall and a replayable scrollback
linked to the action feed. It is not desktop sharing and it cannot see other tabs or windows.
Passwords, tokens and secret-looking fields are redacted before they leave the shared tab, and the
join screen explains what is recorded. The owner may request control of the coldcall tab, but it
only becomes active after the teammate allows it; an active control pill and Stop control action
remain visible on that tab.

**How it is held shut.** The server only answers two `Host` headers: the loopback, and the exact
hostname the tunnel is currently answering on — so a closed tunnel is not a hostname anything will
trust, and DNS rebinding has nothing to aim at. An invite is 256 bits and is stored only as a
SHA-256 digest, so a copy of `coldcall.db` is not a login. Redeeming one sets an `HttpOnly`,
`Secure`, `SameSite=Lax` session cookie; cross-site POSTs are refused by origin as well. Redemption
is rate-limited per address. Revoking an invite signs out every device that used it, immediately,
with no restart. The API is a positive allow-list, route by route: an endpoint added tomorrow is
invisible to the shared link until someone adds it there on purpose.

The invite token travels in the URL **fragment**, which browsers do not send to servers and do not
put in a `Referer` — so it appears in no access log, ours or Cloudflare's, and the page strips it
out of the address bar as soon as it is redeemed.

**What it costs you.** Traffic goes through Cloudflare, which is a third party that did not exist
in this product before you pressed the button, and a public URL is a public URL for as long as it
is open. It is off by default for that reason, `coldcall doctor` says whether it is available, and
closing the app closes it.

```bash
coldcall --share      # open the link at startup instead of clicking
```

`cloudflared` is not bundled. If you do not have it, the panel offers to fetch it into
`~/.coldcall/bin`, or you can install it yourself (`brew install cloudflared` and friends).

## Your company, and keys

Two things the local surface sets up that used to have nowhere to live.

**Your company.** Who is writing: your name and title, the trading and registered names, address,
website, company and VAT numbers. The identity footer UK PECR expects is built from this rather
than retyped into every campaign — *Use this as the opt-out footer* fills it in, and it is still
off until you tick the box.

**Keys.** Anything else this machine has to remember. Values are AES-256-GCM ciphertext in
`coldcall.db`; the key that opens them is `~/.coldcall/vault.key`, mode 0600, deliberately outside
the database — so `coldcall.db` stays what it has always been, a file that is safe to back up and
safe to attach to a bug report. A stored value is never sent back to the browser, only its last
four characters, which is enough to tell two keys apart and not enough to use one.

Stated plainly, because a vault invites the wrong assumption: this does not stop another program
running as you from reading both files. Nothing could, for an app that sends mail while you are
asleep. What it buys is that the two have to be stolen together, and only one of them is the file
people copy around.

## Finding a contact

Most of the difficulty in cold email is not writing it, it is finding who to write to. Of six
Turkish news sites tested, five initially came back as "no publishable address" and only one of
those was actually true.

- **Contact pages are matched in seven languages.** An English-only matcher reduces every
  non-English site to a homepage-only crawl and then reports it as having no address — a wrong
  answer that looks like a correct one. `/iletisim`, `/künye`, `/impressum`, `/contacto` and
  their relatives are all followed, and `/%C4%B0leti%C5%9Fim` folds to the same word.
- **Cloudflare-obfuscated addresses are decoded.** Cloudflare replaces the address with a hex
  string and decodes it in the browser; it is a single-byte XOR, so it decodes server-side. Four
  of those six sites published their address this way.
- **Addresses in JSON-LD are read** — common on news sites and invisible to a human reading the page.
- **If the homepage nav is JavaScript-built**, the site's own sitemap is consulted for contact pages.
- **A transient network error is retried**, because one dropped connection is not evidence that a
  company has no website.
- **The web provider's address is not the company's.** Sites routinely publish their CMS vendor's
  support address next to their own. Addresses are classified own-domain, freemail or
  third-party, and a third-party address is only ever a last resort.
- **When there genuinely is no address** — many sites take enquiries through a form — it says so,
  and you can add a contact by hand. It is recorded as such, never dressed up as something the
  site published.

Every contact carries the page it came from and one of four tiers: `published`, `generic`
(info@ / hello@), `inferred` (a pattern guess, off by default) or `manual`.

## Deliverability

Cold email fails at the mailbox provider long before it fails at the recipient, and the causes are
boringly mechanical. All of it is checkable locally, so none of it costs anything or sends anything.

**Your sending domain**, over DNS: MX, SPF, DKIM across nine common selectors, DMARC, and the
volume ceiling on a personal mailbox. Every check says what is wrong and what to do about it, and
shows the record verbatim so you can compare it against your DNS panel.

Two things it is careful about. A DNS lookup that *failed* is reported as "could not check", never
as "you have no SPF" — telling someone their domain is misconfigured when the resolver timed out is
a confident lie about their infrastructure. And `~all` is not a finding: every large sender uses it,
and flagging Stripe for it would only prove the check was wrong.

**Each message**, on the review screen: the phrases filters actually weight, link count, a shouted
subject, length, and stray HTML in a plain-text send. Scored on the message the recipient receives,
signature included. It only appears when something is wrong — a green "0 issues" panel on every
draft trains you to skip the box exactly when it matters.

## When it sends

A cold email that lands at 03:14 on a Sunday is read as a machine before it is read at all. Set a
window in Settings — hours and days, in your own timezone, which the page names — and sends outside
it are refused rather than queued. Nothing is lost: approved drafts wait, and sending picks up on
its own when the window opens. The Outbox says which window is in force and how long until it opens.

Off by default, so a first send while you are testing is not silently refused because it is Sunday.

### Not three at once

Drafts are approved a company at a time, so plain oldest-first sending puts three people at one
publisher into the queue back to back. Sixty to a hundred and eighty seconds apart, that arrives
as a blast: the recipients compare notes, and the receiving server sees three near-identical
cold emails to one domain inside ten minutes.

So a company is left alone for four hours after anyone there is emailed, and among what is
eligible the queue prefers whichever organisation has been left alone longest — a company never
contacted always goes first. The gap spans campaigns, because two campaigns reaching the same
organisation on the same afternoon is the same problem wearing a different hat. A *failed* send
does not start the clock: nothing arrived.

Set it to zero in Settings to send back to back. That turns off the waiting, not the
preference — given a choice, an untouched company still goes first.

## Bounces

A bounce arrives in the same mailbox as a reply and matches the same thread. Until it was sorted
out, all three of bounce, out-of-office and reply were recorded as "they replied" — which marks the
company as answered, stops the follow-up sequence, and points the reply drafter at MAILER-DAEMON.
The expensive half is invisible: an address that hard-bounced was never suppressed, so other
campaigns kept mailing a mailbox that does not exist, and repeatedly mailing dead addresses is one
of the fastest ways to lose a sending reputation.

They are told apart by header rather than by wording, so a reply that happens to say "I am away
next week" is still a reply. Addresses that come back as non-existent (5.1.x, 5.4.4) are suppressed
automatically — the mailbox is gone, nothing is lost by never writing to it again. A 5.7.1 policy
rejection is deliberately *not* suppressed: that can be about the content or a temporary block, and
silently discarding a real lead over one would be worse than the bounce.

## Quality flags

Cold email fails in predictable ways, so the ones a careful reader would catch are detected when
a draft is written and shown at the top of review:

- empty praise ("dikkat çekici", "impressive", "love what you're doing")
- hedged offers ("gösterebilir… olabiliriz", "we could potentially")
- an ask the reader can't act on ("let me know if", "birlikte başlamak")
- no question at all, unfilled placeholders, nothing cited, too long or too short

Three of these block a bulk approve; the rest are advisory. They are never auto-rejected — a flag
means "read this one first", not "this is wrong".

The rules know which email in the sequence they are reading. A first touch must cite something
specific and must ask for something. A follow-up need not re-cite — repeating the same quote in
every email is itself what makes a sequence read like a mail-merge — and the closing email, whose
whole job is to say "I'll stop here" without asking again, is exempt from both. Applying first-touch
rules to a sign-off flagged every single one of them, which is how a person learns to ignore flags.

## The one guarantee worth knowing

**An email cannot contain a fact about someone's business that we did not fetch and verify
ourselves.**

The model proposes a claim with a quote. Node re-fetches that page, normalises both sides, and
checks the quote actually appears. Only then is the claim marked `verified`. And a database
trigger rejects any draft that cites an unverified claim — so even if every layer above it fails,
a hallucinated fact still cannot reach a real person.

You can see this in the UI: every draft has a **Sources** button showing the quote and a link.

## What it will not do

- Send anything you have not approved. `u` puts an approval back in the queue, right up until the
  moment a send is attempted — after that it says so rather than pretending mail can be recalled.
- Send to anyone on the never-contact list — checked at the moment of sending, not at approval.
- Exceed the daily cap. That's counted from what actually left in the last 24 hours, so
  restarting the app cannot get round it.
- Run a shell command. The research agent is sandboxed at four independent layers; see below.
- Follow up anyone who replied, or anyone on the never-contact list. A bounce and an
  out-of-office are not replies and do not stop a sequence; a person answering does.
- Send outside your sending window, if you set one. Refused, not queued — the drafts wait.
- Keep mailing an address that came back as non-existent.
- Email the same person from two different campaigns. Two unrelated cold emails from one sender
  is the fastest way to be marked as spam, and nothing else would have caught it.
- Add an opt-out footer, unless you switch it on in Settings. It's off by default.
- Cost you anything. There are no paid APIs in this product, at all.
- Open the shared link on its own. It is off by default, you press the button, and it closes when
  coldcall does.
- Let the shared link read a credential, change how this machine sends, or delete a send log.

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

## Commands

| | |
|---|---|
| `coldcall` | Start the app and open the web UI |
| `coldcall --share` | Start it and open the shared link straight away |
| `coldcall doctor` | Report what is and is not working, then exit |
| `coldcall repair` | Resolve references left dangling by an editor outside the app |
| `coldcall where` | Print where your data lives |
| `coldcall --help` | The list above |

Companies can be pasted however you happen to have them — `domain`, `domain Name`, `Name domain`,
`Name - domain`, a bulleted list, a numbered one, or a CSV — it works out which, and says which
lines it could not read rather than rejecting the paste. Companies, contacts, drafts and the send log all export back out as CSV, and the export
re-imports cleanly.

`coldcall doctor` on a working install:

```
coldcall 0.1.0

  ok    opencode               /Users/you/.opencode/bin/opencode
  ok    node                   24.11.0
  ok    database               /Users/you/.coldcall/coldcall.db (schema v8)
  ok    integrity              no dangling references
  ok    writing model          openai/gpt-5.6-terra-pro
  ok    research model         opencode/big-pickle
  ok    mailbox                you@gmail.com
  ok    your company           Ozan at WearSide Labs
  ok    keys                   2 stored, encrypted (/Users/you/.coldcall/vault.key)
  ok    sharing                cloudflared at /Users/you/.coldcall/bin/cloudflared
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
  coldcall.db      everything: companies, contacts, drafts, send log, replies, encrypted keys
  vault.key        opens the encrypted keys (mode 0600) - kept OUT of coldcall.db on purpose
  secrets.json     only if the macOS Keychain is unavailable (mode 0600)
  bin/             cloudflared, if you let coldcall fetch it
  agent-cwd/       empty; opencode's working directory
  app/             the application itself
```

The SMTP password goes into the macOS login Keychain where available. That keeps it out of
`coldcall.db` — the file people back up and paste into bug reports. Every write to the settings
row is sanitised and so is every read, and a database written by an older build that has a
password in it is cleaned up on the next start. It does **not** stop another
process running as you from reading it, and nothing could, for an app that sends mail unattended.
The Setup screen tells you which of the two is in use.

## A note on the law

Unsolicited B2B email in the UK is governed by PECR and UK GDPR. In practice that means an
identifiable sender and a working way to opt out. The footer that does this is built in and
one checkbox away — it's off by default because you asked for it to be, not because it doesn't
matter.
