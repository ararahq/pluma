# Pluma go-to-market

## Product decision

Pluma is the first commercial bet. It is a global developer product for small
teams whose applications or agents generate customer-facing deliverables.

The category line is **The open-source Markdown document engine.** The concrete
promise is: **turn Markdown into branded, production-ready PDFs without running
Chromium or building a document pipeline.**

The wedge is generation, not ingestion. The buyer already has Markdown and needs
to turn it into the report, proposal, audit, invoice, or brief their customer
actually receives. PDF/HTML/URL readers remain useful secondary capabilities,
but they do not define the market Pluma is entering.

## Initial ICP

- Team: 1–10 developers, usually TypeScript-first.
- Product: research, reporting, proposal, audit, compliance, diligence, or
  document-automation software that already produces Markdown.
- Trigger: PDF generation has become HTML/CSS template work, Chromium operations,
  or a visibly weak part of the customer experience.
- Buyer: founder, technical lead, or senior engineer who can buy a $19–$249
  developer tool without procurement.
- Success: the user's own Markdown becomes a branded PDF in under five minutes.

Do not lead with document ingestion, scanned-document OCR, browser scraping,
enterprise connectors, teams, SSO, or general file conversion. Those markets
reward breadth and compliance that Pluma v1 intentionally does not claim.

## Competitive frame

| Alternative | What it wins on | Why Pluma can still win |
| --- | --- | --- |
| Puppeteer / Playwright | Full browser rendering and arbitrary HTML/CSS | Pluma starts from Markdown and avoids browser-pool operations |
| DocRaptor | Mature HTML-to-PDF generation | Pluma does not require the user to design and maintain print HTML/CSS |
| Gotenberg | Free self-hosted conversion service | Pluma is an embeddable Markdown library plus CLI, MCP, and managed API |
| Typst directly | Maximum typesetting control | Pluma gives applications and agents a smaller Markdown and brand-token contract |
| A hand-built stack | Maximum control | Pluma removes template, typography, native-runtime, quota, idempotency, and sandbox work |

MCP and a TypeScript SDK are distribution surfaces, not a moat on their own. The
defensible product behavior is time-to-first-deliverable and the quality,
reliability, and portability of the Markdown document contract.

## Offer and unit economics

| Plan | Price | Included page units | Revenue / 1,000 units at full use | Maximum COGS / 1,000 units for 80% GM |
| --- | ---: | ---: | ---: | ---: |
| Developer | $19 | 5,000 | $3.80 | $0.76 |
| Pro | $79 | 50,000 | $1.58 | $0.316 |
| Scale | $249 | 250,000 | $0.996 | $0.199 |

Pro is the recommended plan. There is one metering axis, no overage in v1, and no
permanent hosted free tier: local use remains unlimited under MIT and the live
anonymous demo proves output before signup. If activated-to-paid conversion stays
below 2% after 500 activated accounts, the first pricing experiment is 1,000
one-time hosted page units—not a second value axis or a feature matrix rewrite.

Revenue scenarios, before payment fees, tax, support, and infrastructure:

- 12 Developer + 6 Pro + 2 Scale customers = **$1,200 MRR**.
- 60 Developer + 30 Pro + 10 Scale customers = **$6,000 MRR / $72,000 ARR**.
- At the second mix, all included quotas total 4.3 million page units. To preserve
  80% gross margin at full use, total variable COGS must stay below $1,200/month.

These are operating scenarios, not forecasts. Retention and utilization determine
whether the plan mix is healthy.

## Distribution order

1. **Package-led proof.** Publish the core, then list the
   stdio server in the official MCP Registry. The repository already carries the
   required Registry metadata, but publication requires explicit operator action.
2. **Three end-to-end examples.** Ship a research report, diligence memo, and
   proposal flow that each show `Markdown → branded PDF`, with the final PDF visible
   before the implementation details.
3. **Founder-led design partners.** Contact 30 narrowly matched teams whose product
   already emits Markdown. Ask for one representative customer deliverable, not
   a generic discovery call. Convert five into paying launch customers.
4. **Technical proof content.** Publish reproducible extraction fixtures, latency,
   output-size, and typography comparisons. State exactly what each benchmark
   measures and avoid claiming visual parity with browser output.
5. **Show HN after the public endpoint works.** Lead with the technical story and
   runnable repository, answer implementation questions directly, and measure
   activated accounts rather than traffic.
6. **Product Hunt after five customers.** Launch the working playground and the
   closed-loop story, with real examples and testimonials. Treat it as a feedback
   and awareness event, not the recurring acquisition engine.
7. **Use-case pages, not a feature directory.** Create pages for agent research
   reports, compliance/audit deliverables, proposals, and diligence. Each page
   should include input, Markdown, final PDF, code, limitations, and pricing.

## 90-day operating gates

- First 30 days: five international paying customers; median verified-signup to
  first successful hosted operation under five minutes.
- First 90 days: 20 paid logos and at least $1,000 MRR.
- Retained activation: at least three successful operations across two UTC days
  in a rolling week.
- Stop adding surface area if paid conversion is below 2%, repeated weekly use is
  below 30%, or variable COGS exceeds 20% of revenue.
- Keep AuthzDX and Jade as later bets. Do not split distribution until Pluma has
  either passed these gates or failed them with enough activated-user evidence.

## External release checklist

The repository can prepare but must not perform these without operator approval:

- create production Stripe products/prices and configure the signed webhook;
- approve legal Terms, a customer-facing Privacy Notice, refund/support policy,
  merchant identity, tax handling, and the signup consent copy;
- configure transactional email, DNS/TLS, Postgres backups, and production secrets;
- run the production image smoke on the target Linux container runtime;
- publish `@ararahq/pluma` to npm;
- validate and publish `@ararahq/pluma-cloud` only with the hosted product release;
- publish `server.json` to the official MCP Registry;
- deploy the Cloud image and submit launch posts.

## Market references checked 2026-08-23

- Unstructured pricing: https://unstructured.io/pricing
- LlamaIndex pricing: https://www.llamaindex.ai/pricing
- DocRaptor plans: https://docraptor.com/plans
- Gotenberg: https://gotenberg.dev/
- MCP Registry publishing: https://modelcontextprotocol.io/registry/quickstart
- Product Hunt launch guide: https://www.producthunt.com/launch
