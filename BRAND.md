# Prism — Brand & Design System

## Positioning

**Prism is the generative visualization API.**

- *6 words:* Signals in. Live visuals out.
- *15 words:* Prism is the real-time visualization API — audio, biometrics, pose, cursor, any stream becomes visuals.
- *30 words:* Prism is the visualization layer for any AI app or agent with a real-time signal. Audio reactivity is one case. Heartbeat, breath, pose, cursor, MIDI, game state — same engine, same skill catalog.

The canonical modality row Prism slots into:

| Modality | API |
|---|---|
| Voice | ElevenLabs |
| Image | Stability / Midjourney |
| Music | Suno |
| Video | Runway / Sora |
| **Visualization** | **Prism** |

## Aesthetic frame: **Creative Cockpit**

Not "quiet stage, wild content." Instead: a maximalist signal-rich workspace where chrome is glassy and translucent, telemetry never stops, the canvas is full-bleed and underlies everything, and the interface itself breathes with the same signals driving the visualization.

**References to study:** Resolume Arena, TouchDesigner, Notch, Spline, Vercel v0, Apple Vision Pro UI, Halo / Cyberpunk HUDs, Apple Logic Pro.

**Anti-references:** B2B SaaS marketing sites, hero + feature-grid + footer layouts, purple gradient aesthetics, anything that "explains" before it "shows."

**The brand mnemonic:** the landing page background visualization reacts to the cursor before any permission is granted. Within 3 seconds, the visitor's mouse has involuntarily discovered the product mechanic.

## Color

Signal-coded palette. Each input modality has a dedicated color that flows wherever that signal influences the UI.

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#0a0a0d` | underlying canvas (often hidden by viz) |
| `--glass` | `rgba(20, 22, 28, 0.55)` | floating panel background, + backdrop-blur(20px) |
| `--glass-border` | `rgba(255, 255, 255, 0.10)` | translucent panel borders |
| `--fg` | `#f5f3ee` | primary text — warm white, **never** `#ffffff` |
| `--fg-muted` | `#6a6a72` | secondary labels, panel chrome |
| `--mid` | `#3a3a42` | dividers, off-state indicators |
| `--cyan` | `#3dffe5` | **audio / bass / live indicators / cursor glow** |
| `--orange` | `#ff7847` | **vitals / heart / treble / warmth** |
| `--lime` | `#b7ff5c` | **camera / pose / external sensors** |
| `--hot` | `#ff2e63` | **beats / recording / critical alerts** |

**Hard rule: no purple.** Across every gradient, accent, glow, and overlay. Purple shows up by default in WebGPU/AI tooling and reads as generic AI slop in 2026. Prism opts out completely.

**Usage:** accents are *structural*, not decorative. A bass meter is cyan because it's audio. A pulse indicator is orange because it's vitals. A pose marker is lime. Don't apply colors aesthetically; apply them as signal taxonomy.

## Typography

70% mono · 25% display · 5% body — the cockpit ratio.

| Slot | Primary (aspirational) | Free fallback (default) | Usage |
|---|---|---|---|
| Display | **GT Maru** (paid) | **Switzer** (Fontshare, free) | logo, headlines, prompt placeholder — *moments only* |
| Body | **Plus Jakarta Sans** (Google, free) | same | the rare paragraph — minimize text |
| Monospace | **Berkeley Mono** (paid) | **JetBrains Mono** (Google, free) | every numeric readout, signal label, status, panel chrome |

**Default until paid fonts are licensed:** Switzer + Plus Jakarta Sans + JetBrains Mono.

**Sizing scale (rem):**

```
xs    0.6875   tiny telemetry labels
sm    0.8125   panel labels, body small
base  1.0      body default
md    1.25     section headings inside panels
lg    1.75     prompt placeholder
xl    3.5      landing headline
2xl   6.0      logo wordmark
```

**Tracking:** display headlines use `letter-spacing: -0.04em` (tight). Mono uses `letter-spacing: 0`. Body uses `0` to `0.01em`.

**Casing:** the `prism` wordmark is always lowercase. Telemetry labels are always UPPERCASE in mono. Body text is sentence case.

## Motion

**Default state has motion everywhere** — bars pulse to FFT, numbers count micro-jitter, cursor leaves trail, fork-tree nodes breathe. The chrome is alive even when nothing is happening.

| Token | Curve / value | Use |
|---|---|---|
| `--ease-spring` | `cubic-bezier(0.3, 0, 0, 1)` | Apple-style physical spring; default for all motion |
| `--ease-snap` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | sharper, for state changes (panel show/hide) |
| `--dur-quick` | `120ms` | hover, focus, micro |
| `--dur-base` | `280ms` | panel transitions |
| `--dur-page` | `800ms` | orchestrated page load reveal |
| `--glow-decay` | `600ms` | cursor trail / signal pulses fading |

**No skeleton loaders. No spinners.** When generating, show partial output streaming in. The visualization is alive while it forms — that *is* the loading state.

**Cursor:** itself glows; leaves a cyan trail (`--cyan` at `0.6` opacity, fading over `--glow-decay`).

## Layout

**Full-bleed canvas extending under everything.** No "page" or "section" — one continuous creative space, like Figma or Spline.

**Floating glass panels** carry all controls. Specs:

```css
background: var(--glass);
backdrop-filter: blur(20px) saturate(1.2);
border: 1px solid var(--glass-border);
border-radius: 10px;
box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.6),
            inset 0 1px 0 rgba(255, 255, 255, 0.06);
```

Panels can be dragged, collapsed, hidden. None of them is sticky to a corner by default — placement is suggestive, not imprisoning.

**Status bar at top** (height 36px) is the only piece of permanent chrome. Glass, sub-bg `rgba(10,10,13,0.7)`, mono labels, live indicators on the right.

## Voice & copy

Short. Direct. Technical-poetic. No corporate verbs. No AI cliches.

| ✅ | ❌ |
|---|---|
| Generative visualization. | AI-powered visual experiences. |
| Signals in. Live visuals out. | Transform data into stunning visuals. |
| Describe a visualization. | Get started by entering a prompt below. |
| Bring your music. | Connect your audio source to begin. |
| 17 forks · cyan · audio | Forks: 17, Color: Cyan, Modality: Audio |
| Built for agents. | Designed for the AI-native era. |

**Banned words:** *amazing, stunning, beautiful, powerful, unlock, empower, leverage, transform, reimagine, redefine, the future of, next-generation.*

**Preferred verbs:** *describe, drop, hear, see, fork, save, run, share.*

**Numbers and labels prefer mono.** "17 forks" not "Forks: 17" — drop the colon, drop the label when the unit is obvious.

## Anti-patterns

Things Prism actively rejects:

- Purple gradients on dark backgrounds (the AI app cliche)
- Hero section + feature grid + testimonial wall layout
- Skeleton loaders, spinners, loading bars
- Inter, Roboto, Space Grotesk, Geist — overused defaults
- Glassmorphism that's purely decorative (ours is functional — panels need to float over a live canvas)
- Marketing-speak superlatives
- CTAs that say "Get Started" or "Try Now"
- Light-mode default (Prism is dark-first; light mode is a future option, not a peer)
- Mobile parity (Prism is desktop-first; mobile is a constrained subset)

## Implementation

- Design tokens live in `src/tokens.css` as CSS custom properties.
- Components reference tokens, never raw hex / px.
- Web fonts are self-hosted under `/public/fonts/` (no Google Fonts CDN — privacy + load perf).
- All visual choices defer to this document; deviations require updating the doc first.
