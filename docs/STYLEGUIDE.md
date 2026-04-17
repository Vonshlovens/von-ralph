# von-ralph TUI Style Guide

## Purpose

Define a consistent visual system for `ralph-tui` so it looks like a polished product: dark, focused, and information-dense, with an Alacritty-inspired tone.

This guide is intentionally constrained. We do not want to overdo styling. Every visual change must improve readability, hierarchy, or state clarity.

## Canonical Reference (Alacritty)

Before making UI styling changes, review these references:

1. Alacritty config docs (official defaults and color model):  
   https://alacritty.org/releases/0.14.0/config-alacritty.html
2. Alacritty project page (overall product tone):  
   https://alacritty.org/
3. Alacritty repo promo screenshot (real visual vibe):  
   https://raw.githubusercontent.com/alacritty/alacritty/master/extra/promo/alacritty-readme.png

Use Alacritty as inspiration for tone and restraint, not literal copying.

## Design Intent

- Dark-first UI with soft contrast and high legibility.
- Minimal chrome: borders and separators should support orientation, not decoration.
- Color encodes state and focus, not ornament.
- Dense but scannable: compact layout, clear hierarchy, no visual clutter.

## Non-Goals

- Do not imitate terminal-emulator-specific effects (GPU blur, transparency tricks, window chrome behavior).
- Do not introduce decorative gradients/patterns in the TUI.
- Do not add color for aesthetics alone.

## Color System

Use semantic tokens in code. Avoid hardcoded one-off hex values in widgets.

### Core tonal tokens

| Token | Hex | Usage |
|------|-----|-------|
| `bg.base` | `#181818` | Main canvas |
| `bg.elevated` | `#1f1f1f` | Panels/modals |
| `bg.subtle` | `#0f0f0f` | Log backgrounds / deep contrast regions |
| `fg.primary` | `#d8d8d8` | Primary text |
| `fg.muted` | `#828482` | Secondary text, metadata |
| `fg.strong` | `#f8f8f8` | High-emphasis text |
| `border.default` | `#6b6b6b` | Standard borders |
| `border.focused` | `#82b8c8` | Focused pane border |

### State tokens

| Token | Hex | Usage |
|------|-----|-------|
| `state.ok` | `#90a959` | Alive/healthy |
| `state.warn` | `#f4bf75` | Rate-limited/warning |
| `state.error` | `#ac4242` | Dead/failure |
| `state.info` | `#75b5aa` | Cost/info annotations |
| `state.accent` | `#6a9fb5` | Selection/highlight accents |

### Usage rules

- Prefer `fg.muted` over low-contrast custom grays for de-emphasis.
- Use bright/accent colors only for focus, status, and actionable elements.
- Keep most of the UI in neutral tones (`bg.*`, `fg.primary`, `fg.muted`).
- If a surface has no state or interaction importance, keep it neutral.

## Typography and Emphasis (Terminal Constraints)

- Default text: `fg.primary`.
- Secondary text: `fg.muted`.
- Use `bold` only for selected row, active pane title, or critical status changes.
- Avoid combining many emphases at once (e.g., bold + bright color + underline) unless critical.

## Layout and Chrome Rules

- Keep existing split-pane dashboard structure.
- Borders must be subtle; one focused pane may use `border.focused`.
- Pane titles should be concise and stable.
- Footer/help row should remain low-noise and functional.
- Modals should be visually elevated but still within the same dark tonal family.

## Interaction State Styling

- Selected item: clear background or accent shift plus optional bold.
- Focused pane: border/state emphasis, not full-surface recolor.
- Error state: `state.error` with plain language; avoid flashy treatment.
- Warning state: `state.warn`; reserved for actionable caution.
- Success/alive: `state.ok`; keep calm, not neon.

## Restraint Rules (Do Not Overdo)

- Every style change must answer: what usability problem does this fix?
- Avoid introducing new tokens without a concrete cross-screen use.
- No one-off “special” colors for individual widgets.
- No theme churn: prioritize consistency over novelty.
- Small, purposeful iterations beat large visual rewrites.

## Implementation Guidance for Agents

1. Read this guide and the Alacritty references before changing styles.
2. Add/extend centralized theme tokens first.
3. Replace hardcoded colors in touched components with semantic tokens.
4. Update one surface at a time (shell chrome first, then high-traffic widgets).
5. Validate readability in typical terminal themes and sizes.

## Review Checklist

- Is the UI still clearly Alacritty-inspired in tone (dark, restrained, sharp)?
- Are colors semantic and reusable rather than ad hoc?
- Are status/focus cues clearer than before?
- Is any new styling purely decorative? If yes, remove it.
- Does the result feel more polished without feeling busier?
