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
   lower-commitment alternative is local installation. Hero and closing CTAs
   scroll to and focus the editor; neither requires an account. Account creation
   is offered only after value as `Create an API key`.
9. **Attention and UI:** create color hierarchy, varied density, semantic heading
   order, clear focal points, responsive rhythm, accessible focus, and restrained
   motion.
10. **Strangeness:** make a typeset PDF visibly emerge from a dark Markdown
    instrument. The contrast between plain source and polished artifact is the
    memorable product metaphor.

## Visual system

The selected archetype is **Editorial Baseline + Live Instrument**. The signature
is one authored typesetting path that reads left-to-right as source, render, and
PDF. It sits between the promise and the working renderer instead of crossing the
headline or imitating decorative product orbits.

- Canvas: cold white `#f5f7fc`.
- Structural ink: midnight `#111936`.
- Action: cobalt `#3d5afe`.
- Secondary surface: ice `#c8f0f4`.
- Tertiary surface: periwinkle `#d9deff`.
- Body: graphite `#161a23`.
- Reserved semantic colors: red, orange, yellow, and green are not decorative.
- Interface typography: Avenir/system geometric sans. Editorial serif is reserved
  for the word `document` in the promise and the rendered artifact, making the
  transformation visible without turning the whole page into a magazine theme.

The page uses a 12-column editorial grid, hairline registration rules, a folded-page
Pluma mark, and restrained physical depth on the live instrument. Rounded surfaces
are reserved for controls and the renderer, not repeated as generic SaaS cards.
Buttons have at least 44px hit areas, optical icon padding, `scale(.96)` press
feedback, and transitions limited to properties that change.

## Page architecture

### Header

An edge-to-edge editorial masthead uses a hairline rule, the folded-page Pluma
mark, a centered publishing-engine signal, Docs, Pricing, GitHub, sign-in state,
and one cobalt CTA. It does not use the centered floating capsule from the visual
reference. The CTA is `Render a PDF` and links to `/#pluma-playground`; on the
landing page it scrolls to and focuses `#demo-markdown`.

### Hero

- Eyebrow: public OSS/runtime fact.
- H1: `Your app writes Markdown. Pluma makes the document.`
- Lede: explains branded PDF generation without Chromium or print-template work.
- Primary CTA: render in the live instrument.
- Secondary CTA: copy or follow the local npm installation path.
- A directional baseline labels source, render, and PDF without acting as a
  performance claim.
- Live source-to-document instrument with a real render/download action.
- The idle paper is explicitly an illustrative preview. After rendering, the
  instrument embeds the returned PDF as the actual artifact preview, reports its
  real byte size and usage, then enables download. Mobile shows the same returned
  preview below the source editor.
- `Create an API key` appears beside Download only after a successful render. It
  routes to `/dashboard/keys`; unauthenticated visitors are redirected by the
  Dashboard to `/sign-in?next=/dashboard/keys`, while sessions open Keys directly.

The semantic document preview title is not a page heading; it is styled text inside
an `article` with an accessible label, preventing a skipped heading level.

### Removed work

An asymmetric section contrasts the operational stack users maintain today with
the small Pluma contract. It sells saved engineering work, not raw features.
Its heading is `A PDF should not require a browser fleet.` It names print CSS,
Chromium lifecycle, font and asset loading, and pagination drift. The Pluma
contract is Markdown, optional brand tokens, and PDF bytes.

### Deliverables

Four varied-use-case tiles demonstrate reports, audits, proposals, and briefs.
They are deliberately asymmetric and carry concrete output language.
All names, dates, quantities, and organizations in demonstrations are visibly
marked `Example data` and are obviously fictional.

- `Research reports`: citations, decisions, and recommendations stakeholders can forward.
- `Security audits`: findings, severity, evidence, and remediation with readable hierarchy.
- `Client proposals`: branded scope, timeline, and commercial terms.
- `Compliance briefs`: structured evidence in a stable, reviewable artifact.

### Technical trust

Show the minimal API call next to public facts: MIT core, predictable versioned output,
brand tokens, local or managed operation, and ephemeral Cloud behavior. Readers
remain a secondary documentation link.

The code example imports `Pluma` from `@ararahq/pluma-cloud`, initializes it with
`PLUMA_API_KEY`, passes agent-produced Markdown plus a `primaryColor` brand token
to `pluma.render`, and receives `pdf`. Its destination is `/docs/typescript`; the
interface is checked against `packages/cloud-sdk` before publication.

### Public claim contract

Every public claim needs a repository file, public URL, or executable check. The
approved claim set is deliberately narrow:

- `MIT-licensed rendering core`: `LICENSE:1` and `package.json:6`.
- `No Chromium or LaTeX runtime`: applies to Core rendering; verify the runtime
  dependency graph and qualify that the included Typst binding is the renderer;
  evidence is `README.md:3-5`, `README.md:268`, and the root lockfile.
- The warm-render number: publish only with hardware/OS, bundled fixture, one
  warmup, ten measured runs, arithmetic mean, and an in-process measurement
  boundary. Remove it if that provenance cannot be displayed succinctly.
- `Raw input is not kept as document history` for the anonymous demo:
  `apps/cloud/src/server/app.ts:287-303` passes input directly to the bounded
  worker and returns the response without the idempotency store;
  `apps/cloud/src/server/logger.ts:7` excludes document/body keys from logs.
  The encrypted 15-minute replay in `apps/cloud/src/server/app.ts:165-211` applies
  to authenticated idempotent API calls and is disclosed on the Privacy page,
  not as behavior of the anonymous demo.
- `20 KiB UTF-8 / 3 output pages`: `apps/cloud/src/client/pages/Docs.tsx:176` and
  server validation/demo enforcement. Do not publish if the server check diverges.
- `Predictable, versioned rendering`: do not promise pixel identity across
  external asset/font changes or engine upgrades.

No testimonial, customer logo, savings percentage, scale figure, security claim,
or commercial metric may ship without matching public evidence and approval.

### Offer and CTA

The final section separates the free local engine from managed production. It
repeats the same primary action without introducing a new decision.

- Local: npm install, MIT license, and `No Pluma render quota on your compute`.
- Managed: hosted execution, isolation, quotas, and API keys. Do not imply an SLA.

## Interaction and accessibility

- Use CSS transitions for hover, press, tabs, and focus; no `transition: all`.
- Initial hero reveal is split into eyebrow, headline, lede/actions, and product
  proof with short staggered one-shot animations.
- Under `prefers-reduced-motion`, remove stagger, translate, rotation, scale,
  cascade, and press transforms; content appears immediately.
- Maintain visible keyboard focus and minimum 44px pointer targets.
- Meet WCAG 2.2 AA contrast for every text/surface pairing. Never communicate
  loading, stale, success, or error through color alone.
- Preserve logical DOM/focus order and reflow at 200% and 400% zoom.
- Sample controls remain ordinary buttons with `aria-pressed`; Tab, Enter, and
  Space must work. The active sample is announced.
- Rendering sets `aria-busy`, announces result/error in a live region, preserves
  source on failure, and offers retry. Icons receive accessible names.
- The mobile menu closes on Escape and restores focus to its trigger.
- Use `text-wrap: balance` for headings and `text-wrap: pretty` for body copy.
- Use tabular numerals for runtime and pricing figures.
- Mobile collapses to one column, removes document rotation/overlap, keeps the
  editor usable, and does not hide the generated result entirely.

The preview is `<article aria-labelledby="preview-title">`; the visible title
with that id is styled text, not an `h3`.

### Renderer state contract

- Idle: show a clearly labeled illustrative preview.
- Edited/stale: revoke the previous object URL and mark its result stale.
- Loading: freeze or track the submitted snapshot and expose `aria-busy`.
- Success: show actual returned bytes/usage plus download.
- Timeout, rate-limit, and render error: keep the Markdown and show a retry path.
- Adjacent demo disclosure, conditional on matching server checks: `Your Markdown is
  sent to Pluma Cloud for this render. Raw input is not kept as document history.
  Demo limit: 20 KiB UTF-8 and 3 output pages.` Link Privacy
  for the exact retention, logging, subprocess, and abuse-control contract.

### Responsive contract

- 360px: one column, 16px gutters, editor/result at least 300px wide, full-width
  primary action, compact header, and no horizontal overflow.
- 768px: copy and instrument stack; split panes only when at least 680px is
  available inside the component.
- 1280px and 1440px: preserve the asymmetric composition without clipping.
- 200% zoom at 1280px follows the tablet composition; 400% becomes one column.

## Verification

- Run the attached ten-gate conversion checklist without publishing its private
  working notes.
- Confirm one H1 and sequential heading hierarchy.
- Verify no private strings or unsubstantiated customer claims enter the bundle.
- Review visible copy, built assets, examples, and source maps for private strings.
- Run `npm run typecheck:all`, `npm run test:all`, `npm run build:all`, and the
  GitHub `CI / verify` workflow.
- Exercise the anonymous render endpoint and download response.
- Exercise idle, edited/stale, loading, success, timeout/rate-limit/error, retry,
  keyboard, menu Escape/focus restore, reduced motion, zoom, and contrast states.
- Inspect 360px, 768px, 1280px, and 1440px at the live local URL.
- Compare against the review criteria extracted from the user-supplied screenshot:
  no crushed or clipped headline, cream palette, nested-card clutter, skipped
  heading level, or undirected color usage. The temporary source screenshot is
  advisory context, not a repository or CI dependency.
