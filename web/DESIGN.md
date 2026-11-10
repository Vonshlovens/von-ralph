---
name: Ralph
description: A ruled, typographic workspace for supervising agent loops.
colors:
  paper: "#f2ece1"
  paper-raised: "#faf6ef"
  ink: "#1d1914"
  muted: "#655e55"
  mark: "#7d0000"
  on-mark: "#fbf3e6"
  running: "#1d5d78"
  running-wash: "#d5e1e2"
  done: "#2c6a2e"
  warning: "#765300"
  failed: "#a11d1a"
  dark-paper: "#171512"
  dark-ink: "#ece5d8"
typography:
  heading:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "24px"
    fontWeight: 700
  step:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "14px"
  section:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "16px"
    fontWeight: 600
  label:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "12px"
  body:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "0.9375rem"
    lineHeight: 1.6
  data:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "0.8125rem"
  narrative:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "16px"
    lineHeight: 1.7
rounded:
  none: "0"
spacing:
  small: "8px"
  medium: "16px"
  page: "24px"
  columns: "36px"
components:
  button-primary:
    backgroundColor: "{colors.mark}"
    textColor: "{colors.on-mark}"
    rounded: "{rounded.none}"
    padding: "7px 12px"
  working-step:
    backgroundColor: "{colors.running-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "14px 12px"
---

# Ralph design

## Overview

**Creative North Star: "The Typed Run Sheet"**

Ralph uses the shared von design system. The app is an operational workspace: show the plan,
what the agent is doing, and what happened in each iteration. Keep the existing
run controls, event feed, iteration data, and reports easy to reach.

The portable token snapshot is `src/lib/design-tokens.css`. Application aliases
and element defaults live in `src/app.css`. Refresh the snapshot deliberately
when adopting a shared-system change; the app has no runtime dependency on a
sibling checkout. JetBrains Mono is self-hosted in `static/fonts`, with its OFL.

## Colors

Use the paper/ink roles for surfaces and text. Identity red marks primary actions,
focus, and selection. Blue identifies the working step, green completed work,
amber blocked or unavailable states, and red failures. Always name the state in
text. Hairlines separate rows; use `--line-strong` for control boundaries.

Light and dark values come from the shared snapshot. No theme attribute follows
the operating system; `data-theme="light"` and `data-theme="dark"` override it.
The header cycles auto, light, dark and remembers the local preference.

## Typography

Use JetBrains Mono for controls, task labels, identifiers and measured data.
Use the system proportional stack for narrative summaries, at 16px/1.7 with a
70ch maximum measure. Page headings are 24px; section headings are 16px.
Long names, paths, and task titles wrap. Numeric data uses tabular figures.

## Layout

The page is centered at a maximum width of 1320px, with 24px gutters, reduced to
16px below 640px. The run overview has two columns (1.15fr / 1fr) with a 36px gap;
below 800px, the plan and activity stack. The header navigation wraps below 640px.
Run-list columns use `minmax(0, 1fr)` so long scope text cannot widen the page.
Wide iteration tables scroll within their own container.

## Elevation & Depth

Keep the dashboard flat. Use ruled sections, alignment and surface fills rather
than shadows. Existing report containers retain their boundaries; report totals
form a ruled strip. The active plan row has a blue wash and a 1px outline.

## Shapes

Controls and main surfaces are square. Only small live-status dots are circular.
Use authored SVG event icons with a consistent stroke. Native controls retain
their keyboard and touch behavior. The shared focus ring is 2px, offset 2px.

## Components

- **Plan:** show backend and scope, completion count and progress, all steps,
  explicit status, and expandable acceptance/notes. A running step says Working;
  an ended run never implies that an unfinished step is still being worked on.
- **Activity:** put the current narrative before loop history. Name unavailable,
  disabled, legacy, and loading states. Show when a summary came from a previous
  iteration. Summary text never changes task status.
- **Run history:** preserve finished-run snapshots. The separate Project plan
  page shows current repository state and identifies it as such.
- **Navigation:** Overview is the default run view. Events, Iterations and Report
  retain existing capabilities. Selected controls expose pressed/current states.
- **Actions:** strong identity fill for the primary action, outlined secondary
  actions, red text for destructive actions. Minimum button height is 36px, 44px
  on coarse pointers. Honor reduced motion across all app transitions.

## Do's and Don'ts

- Do preserve concrete state words, timestamps, errors and recovery context.
- Do keep narrative summaries and recorded validation outcomes distinct.
- Do show saved plan data alongside refresh errors when a prior snapshot exists.
- Don't use color alone to communicate progress or completion.
- Don't replace historical plans with the current project plan.
- Don't turn each row or fact into a floating card.
