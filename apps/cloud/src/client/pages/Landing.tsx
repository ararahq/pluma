import { useEffect } from "react";
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
  brand: { primaryColor: "#3d5afe" },
});`;

const deliverables = [
  ["01", "Research reports", "Turn citations, decisions, and recommendations into a document stakeholders can forward."],
  ["02", "Security audits", "Give findings, severity, evidence, and remediation a readable hierarchy."],
  ["03", "Client proposals", "Apply a consistent brand to scope, timeline, and commercial terms."],
  ["04", "Compliance briefs", "Package structured evidence into a stable, reviewable artifact."],
];

function focusInstrument() {
  window.requestAnimationFrame(() => document.getElementById("demo-markdown")?.focus({ preventScroll: true }));
}

export function LandingPage() {
  useEffect(() => {
    const sections = [...document.querySelectorAll<HTMLElement>("[data-reveal-section]")];
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target); }
    }), { threshold: .14 });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return (
    <MarketingLayout>
      <div className="landing-page" onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty("--pointer-x", `${event.clientX - bounds.left}px`);
        event.currentTarget.style.setProperty("--pointer-y", `${event.clientY - bounds.top}px`);
      }}>
        <section className="hero shell">
          <div className="hero-atmosphere" aria-hidden="true"><i /><i /><i /><span>MD</span><span>PDF</span></div>
          <div className="hero__copy reveal">
            <p className="eyebrow"><span aria-hidden="true" /> MIT-licensed rendering core</p>
            <h1>Markdown in.<br /><em>Client-ready</em> documents out.</h1>
            <p className="hero__lede">Your app already writes Markdown. Pluma turns it into a polished PDF—without Chromium, print CSS, or a document pipeline to babysit.</p>
            <div className="button-row">
              <a href="#pluma-playground" onClick={focusInstrument} className="button button--large">Render your first PDF <Arrow /></a>
              <a href="https://github.com/ararahq/pluma" target="_blank" rel="noreferrer" className="text-link">Run it locally <span aria-hidden="true">↗</span></a>
            </div>
            <dl className="hero__facts" aria-label="Product facts">
              <div><dt>Runtime</dt><dd>No browser process</dd></div>
              <div><dt>Input</dt><dd>Markdown + brand tokens</dd></div>
              <div><dt>Output</dt><dd>PDF bytes</dd></div>
            </dl>
          </div>
          <div className="hero__proof reveal reveal--delay"><Playground /></div>
        </section>

        <section className="format-rail" aria-label="Markdown document workflow">
          <div className="shell format-rail__inner">
            <span>Your product</span><i aria-hidden="true">→</i><strong>Markdown</strong><i aria-hidden="true">→</i><strong className="is-output">Pluma</strong><i aria-hidden="true">→</i><span>A document worth sending</span>
          </div>
        </section>

        <section className="burden-section shell section-space" data-reveal-section>
          <div className="section-kicker">What disappears</div>
          <div className="burden-section__grid">
            <div><h2>A PDF should not require a browser fleet.</h2><p>Every workaround becomes infrastructure. The output improves; the operational surface gets smaller.</p></div>
            <div className="burden-stack" aria-label="Work removed by Pluma">
              <div><span>Remove</span><strong>Chromium lifecycle</strong><small>cold starts · crashes · memory</small></div>
              <div><span>Remove</span><strong>Print CSS</strong><small>page breaks · margins · overflow</small></div>
              <div><span>Remove</span><strong>Asset plumbing</strong><small>fonts · images · loading races</small></div>
              <div className="burden-stack__contract"><span>Keep</span><strong>Markdown → PDF bytes</strong><small>one versioned rendering contract</small></div>
            </div>
          </div>
        </section>

        <section className="deliverables-section section-space" data-reveal-section>
          <div className="shell">
            <div className="section-heading section-heading--split">
              <div><p className="section-kicker">The actual product</p><h2>Your customer pays for the deliverable.</h2></div>
              <p>Reports, audits, proposals, and briefs leave your app with enough structure to review, approve, and trust.</p>
            </div>
            <div className="deliverable-grid">
              {deliverables.map(([number, title, copy]) => <article key={number} className={`deliverable deliverable--${number}`}><span>{number}</span><h3>{title}</h3><p>{copy}</p><File size={22} /></article>)}
            </div>
          </div>
        </section>

        <section className="sdk-section section-space" data-reveal-section>
          <div className="shell sdk-section__grid">
            <div className="sdk-section__copy">
              <p className="section-kicker">A smaller contract</p><h2>Keep content generation where it belongs.</h2><p>Your agent writes. Pluma typesets. Your product owns the workflow.</p>
              <ul className="check-list"><li><Check /> No Chromium or LaTeX runtime</li><li><Check /> Brand tokens, not print templates</li><li><Check /> REST, TypeScript, CLI, and MCP</li><li><Check /> Local engine or managed API</li></ul>
              <Link href="/docs/typescript" className="text-link">Read the TypeScript quickstart <Arrow size={16} /></Link>
            </div>
            <CodeBlock code={sdkCode} title="report.ts" />
          </div>
        </section>

        <section className="offer-section shell section-space" data-reveal-section>
          <div className="section-heading section-heading--split"><div><p className="section-kicker">Start at your boundary</p><h2>Own the engine. Buy back the operations.</h2></div><p>The core stays open. Cloud becomes useful when rendering is part of the customer experience—not another service your team wants to operate.</p></div>
          <div className="offer-grid">
            <article className="offer-card offer-card--local"><div><Terminal /><span>Local / MIT</span></div><h3>No Pluma render quota on your compute.</h3><code>npm i @ararahq/pluma</code><p>Use the CLI or library, keep every byte inside your environment, and inspect the full engine.</p><a href="https://github.com/ararahq/pluma" target="_blank" rel="noreferrer" className="text-link">View the source <span aria-hidden="true">↗</span></a></article>
            <article className="offer-card offer-card--cloud"><div><span className="cloud-pulse" aria-hidden="true" /><span>Managed / Cloud</span></div><h3>Send Markdown. Receive PDF.</h3><p>Hosted execution, isolation, quotas, idempotency, and API keys for production workflows.</p><Link href="/pricing" className="text-link">Compare plans <Arrow size={16} /></Link></article>
          </div>
        </section>

        <section className="privacy-section section-space" data-reveal-section>
          <div className="shell privacy-section__inner"><div className="privacy-index" aria-hidden="true">P/01</div><div><p className="section-kicker">A document is not telemetry</p><h2>Ephemeral by default.</h2><p>Raw input is not kept as document history. Successful idempotent responses may be encrypted for 15 minutes; operational metadata excludes document content.</p></div><Link href="/docs/privacy" className="text-link">Read the privacy model <Arrow size={16} /></Link></div>
        </section>

        <section className="closing-cta shell section-space" data-reveal-section><div><p className="section-kicker">One useful minute</p><h2>Give your Markdown a destination.</h2><p>Edit the example, render a real PDF, and decide from the artifact—not the pitch.</p></div><a href="#pluma-playground" onClick={focusInstrument} className="button button--large">Render your first PDF <Arrow /></a></section>
      </div>
    </MarketingLayout>
  );
}
