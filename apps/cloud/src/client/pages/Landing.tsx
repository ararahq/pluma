import { CodeBlock } from "../components/CodeBlock";
import { Arrow, Check, File, Terminal } from "../components/Icons";
import { Playground } from "../components/Playground";
import { MarketingLayout } from "../components/Shell";
import { Link } from "../lib/router";

const sdkCode = `import { Pluma } from "@ararahq/pluma-cloud";

const pluma = new Pluma({ apiKey: process.env.PLUMA_API_KEY! });

const markdown = await agent.run(reportPrompt);
const { pdf } = await pluma.render({
  markdown,
  brand: { primaryColor: "#e34824" },
});`;

export function LandingPage() {
  return (
    <MarketingLayout>
      <section className="hero shell">
        <div className="hero__copy reveal">
          <p className="eyebrow">Open-source document generation</p>
          <h1>Turn agent output into a document worth sending.</h1>
          <p className="hero__lede">Generate branded, production-ready PDFs from Markdown—without running Chromium or building a document pipeline.</p>
          <div className="button-row">
            <Link href="/sign-up" className="button button--large">Render your first PDF <Arrow /></Link>
            <a href="https://github.com/ararahq/pluma" target="_blank" rel="noreferrer" className="text-link">Run it locally <span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <div className="hero__proof reveal reveal--delay">
          <Playground />
        </div>
      </section>

      <section className="format-rail" aria-label="Markdown document workflow">
        <div className="shell format-rail__inner">
          <span>Your app</span><i>→</i><span>Your agent</span><i>→</i>
          <strong>Markdown</strong><i>→</i><span>Branded PDF</span><i>→</i><span>Customer</span>
        </div>
      </section>

      <section className="workflow-section shell section-space">
        <div className="section-heading">
          <h2>Your customer pays for the deliverable, not the pipeline.</h2>
          <p>Keep your product in Markdown. Let Pluma handle the typography, pagination, branding, and PDF runtime.</p>
        </div>
        <div className="workflow-grid">
          <article className="workflow-step workflow-step--source">
            <span className="step-number">01</span>
            <File size={24} />
            <h3>Generate naturally</h3>
            <p>Your application or agent produces plain Markdown—the format it already knows best.</p>
            <code>agent.run(prompt)</code>
          </article>
          <article className="workflow-step workflow-step--agent">
            <span className="step-number">02</span>
            <Terminal size={24} />
            <h3>Render once</h3>
            <p>Apply brand tokens and real typesetting without HTML templates, CSS print rules, or a browser pool.</p>
            <code>pluma.render(markdown)</code>
          </article>
          <article className="workflow-step workflow-step--output">
            <span className="step-number">03</span>
            <span className="page-glyph" aria-hidden="true">P</span>
            <h3>Deliver the value</h3>
            <p>Send a consistent report, proposal, audit, or brief your customer can review and forward.</p>
            <code>send(pdf)</code>
          </article>
        </div>
      </section>

      <section className="sdk-section section-space">
        <div className="shell sdk-section__grid">
          <div className="sdk-section__copy">
            <h2>One API call replaces the PDF stack.</h2>
            <p>The hosted API handles typesetting, isolation, limits, idempotency, and ephemeral processing. Your product keeps the content and customer workflow.</p>
            <ul className="check-list">
              <li><Check /> No Chromium process or browser pool</li>
              <li><Check /> Brand tokens instead of HTML/CSS templates</li>
              <li><Check /> REST, TypeScript, CLI, and MCP</li>
              <li><Check /> Open-source locally, managed in production</li>
            </ul>
            <Link href="/docs/typescript" className="text-link">TypeScript quickstart <Arrow size={16} /></Link>
          </div>
          <CodeBlock code={sdkCode} title="agent.ts" />
        </div>
      </section>

      <section className="local-section shell section-space">
        <div className="local-intro">
          <span className="open-source-stamp">MIT / OPEN SOURCE</span>
          <h2>Own the engine. Skip the operations.</h2>
          <p>The MIT-licensed engine remains free and unlimited. Use Cloud when running, isolating, metering, and scaling document generation stops being the work your customers pay for.</p>
          <a href="https://github.com/ararahq/pluma" target="_blank" rel="noreferrer" className="button button--outline">View on GitHub <span aria-hidden="true">↗</span></a>
        </div>
        <div className="local-facts">
          <div><strong>~25 ms</strong><span>example render after warm-up on an M-series Mac</span></div>
          <div><strong>0</strong><span>browser dependencies</span></div>
          <div><strong>4</strong><span>interfaces: REST, TS, CLI, MCP</span></div>
        </div>
      </section>

      <section className="privacy-section section-space">
        <div className="shell privacy-section__inner">
          <div className="privacy-mark" aria-hidden="true"><span>P</span></div>
          <div>
            <h2>Ephemeral by default.</h2>
            <p>Raw documents are processed for the request, then discarded. Request metadata never includes document content.</p>
          </div>
          <Link href="/docs/privacy" className="text-link">Privacy model <Arrow size={16} /></Link>
        </div>
      </section>

      <section className="closing-cta shell section-space">
        <div>
          <h2>Ship the deliverable, not another dashboard.</h2>
          <p>Start with the open-source engine. Move to the hosted API when documents become part of your customer experience.</p>
        </div>
        <div className="button-row">
          <Link href="/sign-up" className="button button--large">Render your first PDF <Arrow /></Link>
          <Link href="/pricing" className="text-link">Compare plans</Link>
        </div>
      </section>
    </MarketingLayout>
  );
}
