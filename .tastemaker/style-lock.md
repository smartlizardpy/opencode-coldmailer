# Style lock — coldcall

Established: 2026-08-28. App-shell product (internal tool), not a marketing site.
Mood: **Premium / confident** — the mood table lists "B2B, SaaS, enterprise, professional
tools, admin/ops dashboard", and the brief asked for a corporate product.

## Color contract

Generated with `generate_palette.py --mood premium --seed 4127`, both modes from the same seed.
Dark mode is a real runtime toggle (three states: system default, explicit light, explicit dark),
because this is a tool people sit in for hours.

### Light
| role | hex |
|---|---|
| text | `#161b23` |
| bg | `#fafcff` |
| surface | `#edf2fa` |
| primary | `#2f6ecf` |
| on-primary | `#ffffff` |
| secondary | `#cddffc` |
| accent | `#bb5603` |
| border | `#dce1e9` |

Text-safe (>=4.5): text/on-primary, text/bg, text/surface, text/border, primary/on-primary,
bg/primary, accent/on-primary, bg/accent
UI-safe (>=3.0): surface/primary, surface/accent, primary/border, text/accent, accent/border,
text/primary

### Dark
| role | hex |
|---|---|
| text | `#ebf2fe` |
| bg | `#101419` |
| surface | `#1b1f25` |
| primary | `#3574d6` |
| on-primary | `#ffffff` |
| secondary | `#1c2e4a` |
| accent | `#ed7a30` |
| border | `#272b31` |

Text-safe (>=4.5): bg/on-primary, surface/on-primary, text/bg, text/surface, border/on-primary,
text/border, bg/accent, surface/accent, accent/border, primary/on-primary
UI-safe (>=3.0): bg/primary, text/primary, surface/primary, primary/border

### The one pairing that flips between modes

`accent` needs a different label color per mode and this is easy to get wrong:
- **light**: `accent/on-primary` is 4.72 → white text on the orange fill is legal.
- **dark**: `accent/on-primary` is decorative → white on orange is NOT legal. `bg/accent` is
  text-safe, so a filled accent chip in dark mode takes the near-black `bg` as its label colour.

Encoded as `--on-accent`, which resolves to `on-primary` in light and `bg` in dark. Never
hardcode white on accent.

## The other pairing that flips between modes

A panel recessed inside a `.card` (which is `raised`) needs a different ground per mode:
- **light**: `raised`/`surface` is 1.12 — surface is the more distinct of the two.
- **dark**: `raised`/`surface` is only 1.07, while `raised`/`bg` is 1.20. Dark recesses toward
  the page colour instead, which is also what people expect: inset means darker in a dark UI.

Encoded as `--inset`. Both are decorative boundaries with no WCAG floor, and both carry a
`--border` hairline as well — the token exists so the recession is visible at all in dark mode,
not to satisfy a contrast rule.

## Type

| role | family |
|---|---|
| display (wordmark, page titles) | Unbounded, 600 |
| UI + body | Albert Sans, 400/500/600 |
| data (emails, domains, ids, counts) | JetBrains Mono, 400/500 |

Mono is not decorative here: this app is mostly addresses, domains and identifiers, and a
proportional face makes them harder to scan and compare. Unbounded is used sparingly — the
wordmark and page titles only — because a display face on every heading gets tiring in a tool
people work in all day.

## Density & spacing

App shell density, not marketing density. 4px base scale.
`--s1:4 --s2:8 --s3:12 --s4:16 --s5:20 --s6:24 --s8:32 --s10:40 --s12:48 --s16:64`

- Table row height 40px, not 56. Default body 14px, data 13px.
- Card internal padding `--s5` (20px); grid gap `--s5`. Internal <= external holds.
- Sidebar 232px expanded, 60px collapsed.

## Shell chrome mapping

- Sidebar: `surface`, so the content area reads as the canvas.
- Content area: `bg` — the quietest surface, where the user's data lives.
- Topbar: `bg` with a `border` hairline. No second nav fill competing with the sidebar.
- Active nav item: filled `primary` pill. One treatment everywhere.
- Hover on inactive nav: a `bg`-on-`surface` shift, deliberately lighter than active.
- Breadcrumb: muted text except the current segment.

## Motion

App-shell track only. There is no scroll narrative in a tool. Panel/tab transitions, staggered
row entrances on data load, skeleton loading, animated counters on the dashboard. No scroll
storytelling, no parallax, no pinned sections.
All motion honours `prefers-reduced-motion`. Durations 120–220ms for UI, ease-out.

## Assets

Icons: Iconify, one set, tinted to the token colour at render via `currentColor`.
No photography and no illustration: this is an internal tool whose content is the user's own
data. A stock photo in a dashboard is decoration pretending to be information.
