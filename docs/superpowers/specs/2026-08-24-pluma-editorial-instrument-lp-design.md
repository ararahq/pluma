# Pluma Editorial Instrument landing page

## Objective

Redesign the Pluma landing page so a developer immediately understands the paid
outcome: Markdown produced by an application or agent becomes a polished,
customer-facing PDF without operating Chromium or maintaining print HTML/CSS.

The page must feel like a precise publishing instrument, not an AI-generated SaaS
template. It must use only public, verifiable product facts. Internal customer
information, private repository data, unverified metrics, conversations, and
commercial assumptions must never appear in the public interface.

## Conversion diagnosis

The redesign is approved only if it passes these ten gates.

1. **Context:** optimize for a developer arriving from GitHub, npm, technical
   content, search, or a founder post. The first viewport must continue that
   technical conversation on desktop and mobile.
2. **ICP:** speak to developers and small teams whose product already emits
   Markdown and must deliver reports, proposals, audits, invoices, or briefs.
3. **Awareness:** assume solution-aware traffic. Explain the mechanism and
   contrast against Chromium, LaTeX, and hand-maintained print templates early.
4. **Message:** a stranger must understand `Markdown -> client-ready PDF` within
   five seconds. Avoid category abstractions such as “document infrastructure.”
5. **Sales structure:** promise -> live proof -> removed operational burden ->
   deliverable use cases -> technical trust -> integration -> offer -> CTA.
6. **Value proposition:** headline states the outcome, subheadline explains the
   mechanism, and the live renderer plus public OSS/npm facts provide confidence.
7. **Proof and objections:** answer setup, lock-in, runtime weight, privacy, and
   visual-quality objections where they arise. Do not invent testimonials or logos.
8. **Friction and CTA:** one primary action is `Render your first PDF`; the
   lower-commitment alternative is local installation. State what happens next.
9. **Attention and UI:** create color hierarchy, varied density, semantic heading
   order, clear focal points, responsive rhythm, accessible focus, and restrained
   motion.
10. **Strangeness:** make a typeset PDF visibly emerge from a dark Markdown
    instrument. The contrast between plain source and polished artifact is the
    memorable product metaphor.

## Visual system

The selected archetype is **Soft Structuralism + Z-axis document cascade**.

- Canvas: cold white `#f5f7fc`.
- Structural ink: midnight `#111936`.
- Action: cobalt `#3d5afe`.
- Secondary surface: ice `#c8f0f4`.
- Tertiary surface: periwinkle `#d9deff`.
- Body: graphite `#161a23`.
- Reserved semantic colors: red, orange, yellow, and green are not decorative.
- Interface typography: Geist/system geometric sans. Editorial serif appears only
  inside the rendered document, making transformation visible.

Major surfaces use concentric radii and layered transparent shadows. Dividers may
use hairlines; cards must not rely on generic gray borders for elevation. Buttons
have at least 44px hit areas, optical icon padding, `scale(.96)` press feedback,
and transitions limited to properties that change.

## Page architecture

### Header

A compact floating navigation instrument rather than an edge-to-edge bar. It
contains the Pluma mark, Docs, Pricing, GitHub, sign-in state, and one cobalt CTA.

### Hero

- Eyebrow: public OSS/runtime fact.
- H1: `Markdown in. Client-ready documents out.`
- Lede: explains branded PDF generation without Chromium or print-template work.
- Primary CTA: render in the live instrument.
- Secondary CTA: copy or follow the local npm installation path.
- Public proof strip: MIT licensed, no browser runtime, qualified warm benchmark.
- Live source-to-document instrument with a real render/download action.

The semantic document preview title is not a page heading; it is styled text inside
an `article` with an accessible label, preventing a skipped heading level.

### Removed work

An asymmetric section contrasts the operational stack users maintain today with
the small Pluma contract. It sells saved engineering work, not raw features.

### Deliverables

Four varied-use-case tiles demonstrate reports, audits, proposals, and briefs.
They are deliberately asymmetric and carry concrete output language.

### Technical trust

Show the minimal API call next to public facts: MIT core, deterministic output,
brand tokens, local or managed operation, and ephemeral Cloud behavior. Readers
remain a secondary documentation link.

### Offer and CTA

The final section separates the free local engine from managed production. It
repeats the same primary action without introducing a new decision.

## Interaction and accessibility

- Use CSS transitions for hover, press, tabs, and focus; no `transition: all`.
- Initial hero reveal is split into eyebrow, headline, lede/actions, and product
  proof with short staggered one-shot animations.
- Respect `prefers-reduced-motion`.
- Maintain visible keyboard focus and minimum 44px pointer targets.
- Use `text-wrap: balance` for headings and `text-wrap: pretty` for body copy.
- Use tabular numerals for runtime and pricing figures.
- Mobile collapses to one column, removes document rotation/overlap, keeps the
  editor usable, and does not hide the generated result entirely.

## Verification

- Run the attached ten-gate conversion checklist without publishing its private
  working notes.
- Confirm one H1 and sequential heading hierarchy.
- Verify no private strings or unsubstantiated customer claims enter the bundle.
- Run typecheck, tests, production build, and GitHub CI.
- Exercise the anonymous render endpoint and download response.
- Inspect desktop and mobile at the live local URL.
- Compare the final page against the supplied screenshot for removal of crushed
  headline, cream palette, nested-card clutter, and undirected color usage.
