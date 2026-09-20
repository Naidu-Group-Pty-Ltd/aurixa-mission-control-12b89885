# The console design system

_Structure is hard. Surface is glass._

Mission Control was a dark "terminal-grade neon" dashboard whose problem was not
that it looked cheap — it was that every page shouted at the same volume. Read
the fleet page as it stood: six bordered stat boxes each with its own coloured
numeral and an icon in a grey square, then twelve records each carrying a
checkbox, a name, three coloured badges, free tags, a status pill, an AI-count
pill, a repo path, one bordered chip per module, three link chips and a
timestamp. Well over a hundred bordered, tinted rectangles on one screen, none
of them more important than any other, and finding the one clone that had failed
meant reading all of it.

This is what replaced it and, more usefully, the rules that keep it.

---

## The two materials

**Glass is the panel.** `.glass` (`src/styles.css`) is a frosted plane over the
page's own atmosphere: a translucent wash, an 18px backdrop blur, a hairline
border and a single inset highlight on the top edge. Depth is the blur;
structure is the border. Neither needs a drop shadow, and a panel that carries
one reads as a floating widget rather than a pane of the console.

**Brutalism is the frame.** Every radius token is `0px`, borders are visible
rather than implied, and the only raised object in the system is `.brut-raise` —
a hard 4px offset slab, no blur, reserved for things that are genuinely lifted.

The body carries a 44px grid and three soft radial washes placed **over the
content, not at the page edges**, because glass with nothing behind it is just a
grey rectangle. The blur has to have something to refract.

### Three rules the browser enforces and the source does not

1. **`backdrop-filter: blur(var(--token))` silently does nothing.** Lightning
   CSS cannot statically validate a custom property inside a filter function and
   drops the whole declaration. Write the length literally.
2. **A hand-written `-webkit-backdrop-filter` beside it drops _both_.**
   Lightning CSS adds the prefix itself when the build targets need it.
3. **A call-site `bg-*` utility beats `.glass`.** Utilities outrank components in
   Tailwind's cascade, so `<Card className="bg-card">` is a flat rectangle with a
   wasted compositing pass. 475 such class names were stripped.

Each of these leaves something that looks _almost_ right, which is why the first
two went unnoticed twice. The way to check is to read the emitted rule in the
browser (`document.styleSheets` → `cssRules`), never the source.

---

## The signature: a status spine

A record's state is a **3px hard edge down its left side**, coloured by state,
plus one uppercase mono word. `.spine` + `.spine-ok` / `-warn` / `-bad` /
`-live` / `-idle`.

It replaces the coloured border, the tinted background and the filled status
pill that used to say the same thing three times. Down a column of records the
spine is what the eye finds; the word is the detail you read once you have
stopped.

Two rules:

- **`.spine-live` is `--color-info`, not `--color-accent`.** The accent is a lime
  at hue 130 and success is a green at hue 152. Set as two 10px mono words beside
  each other, "cascading" and "in sync" were the same colour — the one thing a
  status colour must never be.
- **A state is not an action.** `StatusPill` is bare text now, because a filled
  rectangle reads as something you can press.

---

## `MetricBar` — one plane, not six tiles

`src/components/metric-bar.tsx`. A single glass plane divided by hairline rules.
`MetricBar` takes the whole row; `MetricCell` is one cell for a page that keeps
its own grid.

**Colour appears only where `alarm` is true.** A healthy fleet renders entirely
monochrome, so the one amber numeral is the thing you see. Setting a tone on a
metric that is _always_ coloured — a total, a count of everything — is exactly
how the old version lost its signal.

Nineteen pages had grown their own `StatCard` / `StatTile` / `Stat`: the same
three lines of markup, nineteen slightly different paddings, type sizes and tone
rules, and in one case a raw `text-amber-300` outside the token system. Fourteen
of them now delegate to `MetricCell`.

**The hairlines are `-ml-px -mt-px` plus `overflow-hidden` on the container**, not
`divide-x`. Each cell draws its own top and left rule; the ones on the first row
and first column land outside the padding box and are clipped; neighbours share a
single line instead of doubling it. `divide-x` draws nothing at all on a second
row, which is what a wrapping stat grid always has.

---

## `RecordRow` — a row is not a pane of glass

`src/components/record-row.tsx`. Twenty-two list sites rendered a `<Card>` per
item, so a page showing forty schedules asked the compositor for forty
backdrop-filter passes — and drew forty frosted planes at the same depth as the
panel containing them. When everything is glass, nothing reads as raised.

A row inside a panel is `.glass-inset`: the same border, a flat 4% wash, no blur.
`RecordRow` takes an optional `spine` tone.

---

## Typography

`Archivo` (variable, 62–125 width) for display and body; `JetBrains Mono` for
labels and data. Three recipes carry it:

| class        | what it is                                                        |
| ------------ | ----------------------------------------------------------------- |
| `font-display` | Archivo at 125% width, 600, `-0.035em`. Page and record titles.  |
| `numeral`      | Archivo at 125% width, tabular figures. Every metric.           |
| `label-mono`   | 10px mono, uppercase, `0.18em`. Every eyebrow and column head.  |

`font-stretch: 125%` — **not** `font-variation-settings: "wdth" 125`, which does
not select Google's static instances.

45 hand-rolled `<h1>` class strings and 38 hand-written copies of the eyebrow
recipe were folded into these.

> **Unverified in this environment:** the sandbox this was built in never
> reaches `fonts.googleapis.com` — zero faces load and no request is even
> attempted, with no CSP present and the URL returning 200 to `curl`. Every
> screenshot below therefore shows the fallback stack. The `<link>` in
> `__root.tsx` is the valid variable-range form
> (`Archivo:wdth,wght@62..125,400..700`); the multi-axis `@100;125,400;500`
> spelling returns **400** and must not be reintroduced. Confirm the real faces
> render on a deployed preview.

---

## Where the noise went, page by page

- **Fleet (`/dashboard`)** — the six stat cards became one `MetricBar`; the clone
  card's twelve competing objects became a spine, one status word, and middot-
  separated metadata. The three destination links appear on hover and on
  keyboard focus, because an operator opens one perhaps once a session. Nothing
  was dropped: method, wrapper, security cycle, modules and tags are all still
  on the card — they have stopped pretending to be buttons.
- **Bulk actions** — the inline `ml-auto` cluster moved into the shared sticky
  `BulkActionBar`, which is `glass-strong` with an info spine so the list stays
  legible behind it.
- **Settings** — thirteen filled pills became a divided strip where the active
  tab is the one that is lit.
- **Shell** — the active nav item is a spine, not a filled block; sections are
  separated by a rule rather than by whitespace alone.

## What is still open

- **44 pages still hand-roll their header block, and the obstacle is the
  component rather than per-page patience.** Re-measured 20 Sep 2026: 137 route
  files, 28 importing `PageHeader`, and of the 109 that do not, 64 draw no
  header at all (layouts, redirects, sub-panels) and 45 draw a `font-display`
  `<h1>` — one of them `__root.tsx`'s 404 boundary, so 44 real page headers.
  The "~50" this bullet used to carry was right; a first re-measurement said
  109 and was counting every route file rather than every route with a header.

  Two things block adoption, and both are measured on the component:

  - **It offers one title size and the pages use two, and the second is not
    drift.** 26 of the 44 set `text-[2.125rem] leading-[1.05]` and 18 set
    `text-[1.75rem] leading-[1.1]` — and 11 of those 18 are `settings.*`
    sub-pages sitting under the settings tab strip, the rest detail routes
    (`cascades.$eventId`, `clones.$cloneId.secrets`, `handoffs.$handoffId`, …).
    That is a second-level tier, consistently applied. `PageHeader` hardcodes
    `text-[2.125rem]`, so adopting it on those 18 would enlarge a deliberate
    tier by 21%.
  - **It is not the visual no-op its own header comment claims.** `PageHeader`
    draws `mt-2` between eyebrow and title. Of the 44, **23 draw `mt-1`, 21
    draw no `mt-` at all, and none draws `mt-2`** — so adoption moves the title
    on every page it lands on.

  A `level` prop would close the first and a decision on the gap would close
  the second. Neither is written here, because this repository's own rule is
  that a component is not shipped until something renders it, and an unused
  prop is that rule's exact shape. What is recorded is the measurement, so the
  next person starts from it rather than from "the surrounding markup varies".
- The largest pages (`modules.tsx` at 2,094 lines, `handoffs.$handoffId.tsx` at
  1,617, `branding.tsx`) have had their stat strips and headers restyled but not
  their overall information architecture.
- Verification here was done against a design lab route reproducing the real
  components with mock data, in both themes. The protected pages need a session,
  so their converted stat strips were checked by type, lint, test and build
  rather than by eye.
