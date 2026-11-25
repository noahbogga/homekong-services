# FiveM Launcher — UI/UX Color & Design Brief

## Design Direction

Luxury civic aesthetic. Think high-end government portal meets private members' club — authoritative but warm, prestigious without being gaudy. Dark, immersive, typographically elegant.

---

## Color Palette

### Primary Colors

| Role | Hex | Usage |
|------|-----|-------|
| Background (deep) | `#081026` | Page base, deep sections |
| Background (standard) | `#0C1838` | Headers, cards, panels |
| Background (surface) | `rgba(15, 20, 35, 0.8)` | Modals, floating panels, overlays |
| Gold (primary accent) | `#C2A35A` | Buttons, active states, highlights, spinners |
| Gold (soft/hover) | `#D8C188` | Hover text, secondary accent, subtle highlights |
| Gold (rich/shadow) | `#8A6F33` | Borders on gold buttons, depth |
| Cream (text) | `#F5F0E6` | Primary body text |
| Cream (dim) | `rgba(245, 240, 230, 0.7)` | Secondary text, descriptions |
| Cream (faint) | `rgba(245, 240, 230, 0.4)` | Tertiary text, captions, timestamps |

### Semantic Colors

| Role | Hex | Usage |
|------|-----|-------|
| Danger/Error | `#ef4444` | Destructive actions, error states |
| Success | `#22c55e` | Confirmations, connected states |
| Info/Selection | `#60a5fa` | Drag targets, selection outlines, info badges |
| Warning | `#f59e0b` | Caution states, pending actions |

---

## Gradients

| Name | Value | Usage |
|------|-------|-------|
| Gold text gradient | `linear-gradient(180deg, #E7D9A8, #C2A35A 45%, #8A6F33)` | Headline text (clip to text) |
| Gold button | `linear-gradient(180deg, #E7D9A8, #C2A35A 55%, #A9883F)` | Primary CTA buttons |
| Hero overlay | `linear-gradient(180deg, rgba(8,16,38,0.7), rgba(8,16,38,0.85) 60%, #081026)` | Over background images/videos |
| Divider rule | `linear-gradient(90deg, transparent, rgba(194,163,90,0.7), transparent)` | Section separators |
| Header scroll | `rgba(8, 16, 38, 0.92)` + `backdrop-filter: blur(8px)` | Sticky header on scroll |

---

## Typography

| Role | Font | Weight | Style |
|------|------|--------|-------|
| Headlines / Titles | `Cinzel`, serif | 700–900 | Uppercase, letter-spacing: 0.12–0.18em |
| Subheadings / Labels | `Cinzel`, serif | 600 | Uppercase, letter-spacing: 0.14–0.32em |
| Body text | `Cormorant Garamond`, serif | 400 | Normal case, line-height: 1.7–1.8 |
| Chinese text | `Noto Serif HK`, serif | 400–600 | For CJK content |
| UI / Small text | `Inter`, sans-serif | 400–500 | Captions, footer links, technical labels |

**Key rules:**
- Headlines are always serif (Cinzel), always uppercase, generous letter-spacing
- Body is elegant serif (Cormorant Garamond), never sans-serif for paragraphs
- Only use Inter for tiny functional UI text (timestamps, version numbers, footer)
- Chinese/CJK uses Noto Serif HK to match the serif aesthetic

---

## Component Patterns

### Buttons

**Primary (Gold):**
```
background: linear-gradient(180deg, #E7D9A8, #C2A35A 55%, #A9883F)
border: 1px solid #8A6F33
color: #1a1306 (dark text on gold)
padding: 14px 36px
border-radius: 3px
font: Cinzel 700, 0.8rem, letter-spacing: 0.14em, uppercase
box-shadow: 0 8px 24px -8px rgba(194,163,90,0.5)
hover: translateY(-2px), box-shadow intensifies
```

**Secondary (Outline):**
```
background: transparent
border: 1px solid rgba(194,163,90,0.5)
color: #D8C188
hover: background rgba(194,163,90,0.1), border-color: #C2A35A, color: #fff
```

### Cards / Panels

```
background: rgba(15, 20, 35, 0.6–0.8)
backdrop-filter: blur(12–20px)
border: 1px solid rgba(255,255,255,0.06–0.08)
border-radius: 4px (cards) or 12–16px (modals)
hover: translateY(-4 to -6px), border-color: rgba(194,163,90,0.4–0.5)
box-shadow on hover: 0 20–30px 40–60px -20px rgba(0,0,0,0.8–0.9)
```

### Section Eyebrow Labels

```
font: Cinzel, 0.7rem, letter-spacing: 0.32em, uppercase
color: #C2A35A
Flanked by horizontal gold lines:
  ::before / ::after — width: 34px, height: 1px
  background: linear-gradient(90deg, transparent, #C2A35A) and reverse
```

### Borders & Dividers

- Panel borders: `rgba(255, 255, 255, 0.04–0.08)` (white at very low opacity)
- Gold dividers: `rgba(194, 163, 90, 0.15–0.2)` for structural separation
- Active/hover borders: `rgba(194, 163, 90, 0.5–0.7)`
- Section rules: centered gradient fade (gold to transparent on both ends)

### Scrollbars

```
::-webkit-scrollbar — width: 6px
::-webkit-scrollbar-thumb — background: rgba(255,255,255,0.1), border-radius: 4px
::-webkit-scrollbar-thumb:hover — rgba(255,255,255,0.2)
```

---

## Interaction & Motion

- Hover lifts: `translateY(-2px to -6px)` with box-shadow growth
- Transitions: 0.25–0.5s ease on transforms, 0.2–0.4s on colors/opacity
- Backdrop blur: 8–20px depending on layer depth
- Selection highlight: `rgba(194, 163, 90, 0.35)` background
- Loading spinners: gold border-top on transparent circle, 0.7s linear infinite rotation
- No flashy animations. Subtle, confident motion only.

---

## General Rules

1. **Dark-first.** The background is always deep navy/near-black. Never use light backgrounds.
2. **Gold is the accent, not the base.** Use sparingly for emphasis — buttons, active states, highlights. Too much gold looks cheap.
3. **Glass/acrylic effect** on all floating elements (modals, tooltips, dropdowns): semi-transparent dark bg + backdrop-blur + thin white/gold border.
4. **Text hierarchy through opacity**, not size alone. Primary text is full cream, secondary is 70% opacity, tertiary is 40%.
5. **Serif dominance.** This is a premium brand. Sans-serif is only for functional micro-text.
6. **Restraint.** No gradients on backgrounds. No neon. No heavy borders. Luxury = breathing room + precise details.
7. **Border-radius is minimal.** 3–4px for cards/buttons. Only modals get larger radius (12–16px). Never fully rounded (no pill shapes).
8. **Shadows are deep and diffuse**, not sharp or colorful. Always dark (black/navy), never colored shadows except gold glow on gold buttons.

---

## Do NOT

- Use bright colors or saturated hues as backgrounds
- Use rounded/pill-shaped buttons
- Use sans-serif for headings
- Use white or light-mode anything
- Use colored shadows (no blue glow, no purple haze)
- Make gold elements too large or too frequent — it should feel rare and valuable
- Use emojis in UI text
- Use thick borders anywhere
