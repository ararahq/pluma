import { CodeBlock } from "../components/CodeBlock";
import { Arrow, Book, File, Terminal } from "../components/Icons";
import { Brand } from "../components/Shell";
import { Link } from "../lib/router";

type DocPage = "overview" | "rest" | "typescript" | "cli" | "mcp" | "privacy" | "limits" | "deployment";

const nav: Array<{ group: string; items: Array<[DocPage, string, string]> }> = [
  { group: "Get started", items: [["overview", "/docs", "Overview"], ["typescript", "/docs/typescript", "TypeScript"]] },
  { group: "Interfaces", items: [["rest", "/docs/rest", "REST API"], ["cli", "/docs/cli", "CLI"], ["mcp", "/docs/mcp", "MCP server"]] },
  { group: "Operate", items: [["deployment", "/docs/deployment", "Deployment"], ["privacy", "/docs/privacy", "Privacy & security"], ["limits", "/docs/limits", "Limits & metering"]] },
];

const curlRender = `curl https://api.pluma.dev/v1/render \\
  -H "Authorization: Bearer $PLUMA_API_KEY" \\
  -H "Idempotency-Key: $(openssl rand -hex 16)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "markdown": "# Research brief\\n\\nReady to send.",
    "brand": { "primaryColor": "#e34824" }
  }' \\
  --output brief.pdf`;

const tsRoundtrip = `import { Pluma } from "@ararahq/pluma-cloud";

const pluma = new Pluma({
  apiKey: process.env.PLUMA_API_KEY!,
});

const source = await pluma.read({
  url: "https://example.com/report",
});

const result = await myAgent.run(source.markdown);

const { pdf } = await pluma.render({
  markdown: result,
  brand: { primaryColor: "#e34824" },
});`;

const mcpConfig = `{
  "mcpServers": {
    "pluma": {
      "command": "pluma",
      "args": ["mcp"]
    }
  }
}`;

function DocsLayout({ page, children }: { page: DocPage; children: React.ReactNode }) {
  return (
    <div className="docs-layout">
      <a className="skip-link" href="#docs-main">Skip to documentation</a>
      <header className="docs-topbar"><Brand /><div><Link href="/pricing">Pricing</Link><Link href="/dashboard">Dashboard</Link></div></header>
      <aside className="docs-sidebar">
        <div className="docs-search"><span aria-hidden="true">⌕</span><input aria-label="Search documentation" placeholder="Search docs" onChange={(event) => {
          const query = event.target.value.toLowerCase();
          document.querySelectorAll<HTMLElement>(".docs-sidebar a").forEach((item) => { item.hidden = !item.textContent?.toLowerCase().includes(query); });
        }} /></div>
        <nav aria-label="Documentation navigation">{nav.map((group) => <div key={group.group}><strong>{group.group}</strong>{group.items.map(([id, href, label]) => <Link key={id} href={href} className={page === id ? "is-active" : ""}>{label}</Link>)}</div>)}</nav>
        <a className="docs-github" href="https://github.com/ararahq/pluma" target="_blank" rel="noreferrer">GitHub <span>↗</span></a>
      </aside>
      <main className="docs-content" id="docs-main">{children}</main>
      <aside className="docs-toc" aria-label="On this page"><strong>On this page</strong><a href="#start">Start</a><a href="#contract">Contract</a><a href="#next">Next</a></aside>
    </div>
  );
}

function DocsHero({ title, description, label }: { title: string; description: string; label?: string }) {
  return <header className="docs-hero">{label && <p>{label}</p>}<h1>{title}</h1><div className="docs-rule" /><p>{description}</p></header>;
}

export function DocsPage({ page }: { page: DocPage }) {
  const pages: Record<DocPage, React.ReactNode> = {
    overview: <OverviewDocs />,
    rest: <RestDocs />,
    typescript: <TypeScriptDocs />,
    cli: <CliDocs />,
    mcp: <McpDocs />,
    privacy: <PrivacyDocs />,
    limits: <LimitsDocs />,
    deployment: <DeploymentDocs />,
  };
  return <DocsLayout page={page}>{pages[page]}</DocsLayout>;
}

function OverviewDocs() {
  return <>
    <DocsHero label="Documentation" title="Make documents a first-class interface." description="Read source material as Markdown. Let your agent work. Render the final answer as a production PDF." />
    <section className="docs-section" id="start"><h2>Choose an interface</h2><div className="doc-choice-grid">
      <Link href="/docs/typescript"><Terminal /><h3>TypeScript</h3><p>The shortest path to an agent round trip.</p><Arrow /></Link>
      <Link href="/docs/rest"><File /><h3>REST API</h3><p>Language-neutral, explicit HTTP contracts.</p><Arrow /></Link>
      <Link href="/docs/cli"><span className="choice-glyph">$</span><h3>CLI</h3><p>Local document I/O in scripts and terminals.</p><Arrow /></Link>
      <Link href="/docs/mcp"><Book /><h3>MCP</h3><p>Give compatible agents document tools directly.</p><Arrow /></Link>
    </div></section>
    <section className="docs-section" id="contract"><h2>The round-trip contract</h2><div className="contract-flow"><div><span>01</span><strong>Read</strong><small>PDF · HTML · URL</small></div><i>→</i><div><span>02</span><strong>Think</strong><small>Your agent + Markdown</small></div><i>→</i><div><span>03</span><strong>Render</strong><small>Production PDF</small></div></div>
      <div className="docs-callout"><strong>V1 scope</strong><p>PDF input requires a text layer. Pluma Cloud returns a <code>scanned_pdf</code> error without charging when no usable text layer exists; OCR is not included in v1.</p></div>
    </section>
    <section className="docs-section" id="next"><h2>Start with the SDK</h2><CodeBlock code="npm install @ararahq/pluma-cloud" language="shell" title="terminal" /><p>Prefer local-only rendering? Install <code>@ararahq/pluma</code>, the MIT core package.</p><Link href="/docs/typescript" className="button">TypeScript quickstart <Arrow size={16} /></Link></section>
  </>;
}

function RestDocs() {
  return <>
    <DocsHero label="HTTP interface" title="REST API" description="Four endpoints, one error shape, and request IDs on every successful document operation." />
    <section className="docs-section" id="start"><h2>Authentication</h2><p>Send a secret API key as a Bearer token. Keep it on the server—never expose it in client-side code.</p><CodeBlock code={'Authorization: Bearer pluma_live_••••••••••••'} title="request header" /></section>
    <section className="docs-section" id="contract"><h2>Endpoints</h2><div className="endpoint-list">
      <div><span className="method">POST</span><code>/v1/read/url</code><p>Public HTTP(S) page → Markdown and metadata.</p></div>
      <div><span className="method">POST</span><code>/v1/read/html</code><p>Streamed HTML → Markdown and metadata.</p></div>
      <div><span className="method">POST</span><code>/v1/read/pdf</code><p>Text-layer PDF → Markdown, page metadata, and warnings.</p></div>
      <div><span className="method">POST</span><code>/v1/render</code><p>Markdown + safe brand tokens → PDF response.</p></div>
    </div><h3>Render a PDF</h3><CodeBlock code={curlRender} language="shell" title="terminal" /></section>
    <section className="docs-section" id="next"><h2>Errors</h2><p>Every API error returns a stable code, a human-readable message, and the request ID to include when debugging.</p><CodeBlock code={`{
  "error": {
    "code": "invalid_input",
    "message": "markdown must be 500 KiB or less"
  },
  "request_id": "req_01J..."
}`} language="json" /></section>
  </>;
}

function TypeScriptDocs() {
  return <>
    <DocsHero label="SDK" title="TypeScript quickstart" description="Keep agent logic in your application and use one typed client at the document boundary." />
    <section className="docs-section" id="start"><h2>Install</h2><CodeBlock code="npm install @ararahq/pluma-cloud" language="shell" title="terminal" /><CodeBlock code="PLUMA_API_KEY=pluma_live_••••••••••••" title=".env" /></section>
    <section className="docs-section" id="contract"><h2>Complete round trip</h2><CodeBlock code={tsRoundtrip} title="document-agent.ts" /><div className="docs-callout"><strong>Keep control of the middle.</strong><p>Pluma does not call a model for you. The source Markdown and result pass through your own agent, prompts, and guardrails.</p></div></section>
    <section className="docs-section" id="next"><h2>Local core</h2><p>For in-process, unlimited local work, use the open-source package directly.</p><CodeBlock code={`import { readPdf, renderPdf } from "@ararahq/pluma";

const source = readPdf("report.pdf");
const pdf = renderPdf("# Result\\n\\nReady to send.");`} /></section>
  </>;
}

function CliDocs() {
  return <>
    <DocsHero label="Local interface" title="Command line" description="Read and render documents from scripts, CI jobs, or your terminal—without a browser." />
    <section className="docs-section" id="start"><h2>Install</h2><CodeBlock code="npm install --global @ararahq/pluma" language="shell" title="terminal" /></section>
    <section className="docs-section" id="contract"><h2>Commands</h2><CodeBlock language="shell" title="terminal" code={`pluma document.md                         # writes document.pdf
pluma report.pdf --pages 1-3             # writes report.md
pluma page.html -o page.md               # HTML → Markdown
pluma https://example.com/post           # URL → Markdown on stdout
pluma report.pdf --json                   # structured result
pluma proposal.md --watch                 # render on every save`} /></section>
    <section className="docs-section" id="next"><h2>Brand conventions</h2><p>Place <code>brand.json</code> and an optional <code>fonts/</code> directory next to your Markdown. Pluma discovers both without flags.</p><CodeBlock language="json" code={`{
  "fonts": { "body": "Geist", "mono": "Geist Mono" },
  "colors": { "accent": "#e34824" },
  "footer": "Acme Research"
}`} title="brand.json" /></section>
  </>;
}

function McpDocs() {
  return <>
    <DocsHero label="Agent interface" title="MCP server" description="Expose Pluma’s local document tools to any compatible agent over standard input and output." />
    <section className="docs-section" id="start"><h2>Register the server</h2><p>Install the CLI, then add this server entry to your MCP client.</p><CodeBlock code={mcpConfig} language="json" title="mcp.json" /></section>
    <section className="docs-section" id="contract"><h2>Available tools</h2><div className="tool-list"><div><code>read_pdf</code><p>Read a local text-layer PDF into Markdown.</p></div><div><code>read_html</code><p>Convert an HTML string without making a network request.</p></div><div><code>read_url</code><p>Fetch a bounded HTTP(S) URL and return Markdown.</p></div><div><code>render_pdf</code><p>Render Markdown to a local PDF path.</p></div></div></section>
    <section className="docs-section" id="next"><h2>Trust boundary</h2><div className="docs-callout docs-callout--warning"><strong>Safe mode is the default.</strong><p>PDF reads and rendered outputs stay inside the server’s current working directory; raw Typst, images, custom font paths, and filesystem roots are rejected. Use <code>pluma mcp --trusted-local</code> only for agents and documents you trust.</p></div></section>
  </>;
}

function PrivacyDocs() {
  return <>
    <DocsHero label="Trust model" title="Privacy & security" description="A narrow data surface: process document content for the request, retain metadata, discard raw files." />
    <section className="docs-section" id="start"><h2>Ephemeral document processing</h2><p>Pluma Cloud does not retain raw PDF, HTML, URL response bodies, Markdown, or generated PDFs as account history. Recent requests show operation metadata only.</p><div className="privacy-diagram"><div><strong>Request body</strong><span>Memory / isolated job</span></div><i>→</i><div><strong>Document output</strong><span>Streamed to caller</span></div><i>→</i><div><strong>After request</strong><span>Raw content discarded</span></div></div></section>
    <section className="docs-section" id="contract"><h2>What is retained</h2><div className="retention-grid"><article><h3>Request metadata</h3><p>Request ID, account, operation, status, units, duration, warning codes, and timestamp for 30 days on Developer or 90 days on Pro/Scale.</p></article><article><h3>Short replay envelope</h3><p>Successful responses may be encrypted for 15 minutes to replay an idempotent request without charging twice.</p></article><article><h3>Credentials</h3><p>API keys are stored as peppered HMAC-SHA-256 digests. Secret values are shown only once.</p></article><article><h3>Billing operations</h3><p>Final quota reservations are kept 90 days and completed webhook IDs 180 days. Stripe payment data remains with Stripe; aggregate monthly usage remains the billing ledger.</p></article></div></section>
    <section className="docs-section" id="next"><h2>Hosted safety</h2><p>The Cloud API rejects raw Typst, filesystem paths, remote images, caller-provided fonts, and unsafe URL targets. Local Pluma remains unrestricted for trusted documents.</p></section>
  </>;
}

function LimitsDocs() {
  return <>
    <DocsHero label="Usage contract" title="Limits & metering" description="Predictable page units, bounded requests, and explicit failures instead of silent quality loss." />
    <section className="docs-section" id="start"><h2>Page units</h2><div className="unit-grid"><article><strong>1</strong><span>per PDF page read</span></article><article><strong>1</strong><span>per PDF page rendered</span></article><article><strong>1</strong><span>per started 100 KiB of HTML</span></article></div><p>Failed, timed-out, unsafe, and scanned-without-text jobs are refunded. Idempotent replays are never charged twice.</p></section>
    <section className="docs-section" id="contract"><h2>Plan limits</h2><div className="limits-table-wrap"><table className="limits-table"><thead><tr><th>Plan</th><th>Page units</th><th>Account job cap</th><th>Requests / minute</th></tr></thead><tbody><tr><td>Developer</td><td>5,000</td><td>2</td><td>60</td></tr><tr><td>Pro</td><td>50,000</td><td>10</td><td>300</td></tr><tr><td>Scale</td><td>250,000</td><td>30</td><td>1,000</td></tr></tbody></table></div><p>Job caps are per-account admission ceilings; simultaneous throughput is also bounded by the deployment’s global worker pool. Quotas reset on the first day of each UTC calendar month. Queue overflow returns <code>429</code> with <code>Retry-After</code>.</p></section>
    <section className="docs-section" id="next"><h2>Hard boundaries</h2><div className="boundary-list"><div><strong>JSON / Markdown</strong><span>512 KiB / 500 KiB UTF-8</span></div><div><strong>Brand data</strong><span>16 KiB serialized</span></div><div><strong>Direct HTML</strong><span>5 MiB decoded</span></div><div><strong>PDF input</strong><span>25 MiB / 500 pages</span></div><div><strong>URL fetch</strong><span>2 MiB compressed / 5 MiB decoded</span></div><div><strong>URL redirects</strong><span>3 hops / 10 s total</span></div><div><strong>Generated output</strong><span>25 MiB / 200 PDF pages</span></div><div><strong>Anonymous demo</strong><span>20 KiB / 3 output pages</span></div></div><div className="docs-callout"><strong>OCR is outside v1.</strong><p>Scanned PDFs return the <code>scanned_pdf</code> error and consume no page units.</p></div></section>
  </>;
}

function DeploymentDocs() {
  return <>
    <DocsHero label="Self-hosting" title="Deploy Pluma Cloud" description="Run the same API, dashboard, billing, and isolated document workers on any Linux host with Docker and Postgres." />
    <section className="docs-section" id="start"><h2>Start locally</h2><CodeBlock code={"docker compose up -d postgres\ndocker compose --profile app up --build"} language="shell" title="terminal" /><p>The app profile waits for Postgres, runs numbered migrations once, then starts the API and prebuilt web client on port 8787.</p></section>
    <section className="docs-section" id="contract"><h2>Production contract</h2><div className="retention-grid"><article><h3>Linux isolation</h3><p>The image requires bubblewrap and prlimit. Startup renders a real PDF and verifies that workers cannot read host files or reach the network.</p></article><article><h3>Secrets and providers</h3><p>Set an HTTPS public origin, Postgres, independent auth/API/replay secrets, transactional email, Stripe keys, webhook secret, and all three price IDs.</p></article><article><h3>Readiness</h3><p><code>/health</code> is liveness and <code>/ready</code> checks Postgres plus the latest migration. Stripe catalog validation is warmed independently; checkout fails closed during a provider outage without taking document APIs offline.</p></article><article><h3>One replica in v1</h3><p>Admission, rate limiting, and anonymous-demo limits are process-local. Keep one application replica; horizontal scaling requires a shared queue and limiter.</p></article></div></section>
    <section className="docs-section" id="next"><h2>Capacity and operations</h2><p>Start with <code>PLUMA_WORKER_CONCURRENCY=2</code>, load-test with your document mix, and raise it only with sufficient memory and CPU. Run <code>npm --workspace @pluma/cloud run reconcile:stripe:prod</code> after webhook incidents.</p><p>The complete vendor-neutral runbook lives in <code>docs/deployment.md</code> in the source repository.</p></section>
  </>;
}
