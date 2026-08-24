import { useEffect, useMemo, useState } from "react";
import { CodeBlock } from "../components/CodeBlock";
import { Arrow, Check, Copy, External, Key } from "../components/Icons";
import { DashboardLayout } from "../components/Shell";
import {
  api,
  ApiError,
  isConfigurationError,
  type ApiKey,
  type DashboardData,
  type PlanId,
  type RequestRecord,
} from "../lib/api";
import { Link, navigate } from "../lib/router";

type DashboardStatus =
  | { type: "loading" }
  | { type: "ready"; data: DashboardData }
  | { type: "unconfigured"; message: string }
  | { type: "error"; message: string };

const quickstart = `import { Pluma } from "@ararahq/pluma-cloud";

const pluma = new Pluma({
  apiKey: process.env.PLUMA_API_KEY!,
});

const { pdf } = await pluma.render({
  markdown: "# Hello from my agent",
});`;

const curlQuickstart = `curl https://api.pluma.dev/v1/render \\
  -H "Authorization: Bearer $PLUMA_API_KEY" \\
  -H "Idempotency-Key: $(openssl rand -hex 16)" \\
  -H "Content-Type: application/json" \\
  -d '{"markdown":"# Hello from my agent"}' \\
  --output result.pdf`;

const planLabels: Record<PlanId, string> = {
  "open-source": "Open source",
  developer: "Developer",
  pro: "Pro",
  scale: "Scale",
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function operationLabel(operation: RequestRecord["operation"]) {
  return ({ render: "Render PDF", read_pdf: "Read PDF", read_html: "Read HTML", read_url: "Read URL" })[operation];
}

function EmptyRuntime({ message }: { message: string }) {
  return (
    <div className="runtime-state" role="status">
      <span className="runtime-state__mark">LOCAL</span>
      <div><h2>Cloud runtime not configured</h2><p>{message}</p></div>
      <Link className="button button--outline" href="/docs/rest">Read setup contract</Link>
    </div>
  );
}

function DashboardLoading() {
  return (
    <div className="dashboard-page" aria-busy="true">
      <div className="skeleton skeleton--title" />
      <div className="skeleton-grid"><div className="skeleton skeleton--panel" /><div className="skeleton skeleton--panel" /></div>
      <div className="skeleton skeleton--table" />
    </div>
  );
}

function UsageMeter({ data }: { data: DashboardData }) {
  const percent = data.usage.limit ? Math.min(100, Math.round((data.usage.used / data.usage.limit) * 100)) : 0;
  return (
    <div className="usage-meter">
      <div className="usage-meter__head"><span>{planLabels[data.usage.plan]} plan</span><strong>{percent}%</strong></div>
      <progress className="meter-track" aria-label="Monthly page unit usage" max={Math.max(1, data.usage.limit)} value={Math.min(data.usage.used, Math.max(1, data.usage.limit))}>{percent}%</progress>
      <div className="usage-meter__foot"><span><strong>{formatNumber(data.usage.used)}</strong> used</span><span>{formatNumber(data.usage.limit)} page units</span></div>
    </div>
  );
}

function RequestsTable({ requests }: { requests: RequestRecord[] }) {
  if (!requests.length) {
    return (
      <div className="empty-state">
        <span className="empty-state__icon" aria-hidden="true">↳</span>
        <div><h3>No requests yet</h3><p>Your first successful operation will appear here—never the document contents.</p></div>
      </div>
    );
  }
  return (
    <div className="request-table-wrap">
      <table className="request-table">
        <thead><tr><th>Operation</th><th>Status</th><th>Units</th><th>Duration</th><th>Created</th><th>Request ID</th></tr></thead>
        <tbody>{requests.map((request) => <tr key={request.id}>
          <td>{operationLabel(request.operation)}</td>
          <td><span className={`status-label status-label--${request.status}`}>{request.status}</span></td>
          <td>{request.units}</td>
          <td>{request.durationMs ? `${request.durationMs} ms` : "—"}</td>
          <td>{formatDate(request.createdAt)}</td>
          <td><code>{request.id.slice(0, 12)}…</code></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

export function DashboardPage({ section }: { section: "overview" | "keys" | "usage" | "billing" }) {
  const [status, setStatus] = useState<DashboardStatus>({ type: "loading" });

  async function load() {
    setStatus({ type: "loading" });
    try {
      const data = await api.dashboard();
      setStatus({ type: "ready", data });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        navigate(`/sign-in?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      if (isConfigurationError(cause)) {
        setStatus({ type: "unconfigured", message: cause instanceof Error ? cause.message : "Start the cloud server and Postgres to enable account data." });
      } else {
        setStatus({ type: "error", message: cause instanceof Error ? cause.message : "Dashboard data could not be loaded." });
      }
    }
  }

  useEffect(() => { void load(); }, []);

  if (status.type === "loading") return <DashboardLayout active={section}><DashboardLoading /></DashboardLayout>;

  return (
    <DashboardLayout active={section}>
      <div className="dashboard-page">
        {status.type === "unconfigured" && <EmptyRuntime message={status.message} />}
        {status.type === "error" && <div className="runtime-state runtime-state--error" role="alert"><div><h2>Could not load the dashboard</h2><p>{status.message}</p></div><button className="button button--outline" onClick={load}>Try again</button></div>}
        {section === "overview" && <Overview data={status.type === "ready" ? status.data : null} />}
        {section === "keys" && <KeysPanel data={status.type === "ready" ? status.data : null} onRefresh={load} />}
        {section === "usage" && <UsagePanel data={status.type === "ready" ? status.data : null} />}
        {section === "billing" && <BillingPanel data={status.type === "ready" ? status.data : null} />}
      </div>
    </DashboardLayout>
  );
}

function Overview({ data }: { data: DashboardData | null }) {
  const [snippet, setSnippet] = useState<"typescript" | "curl">("typescript");
  return (
    <>
      <header className="dashboard-heading"><div><p className="eyebrow">Workspace</p><h1>Build the first round trip.</h1><p>Read a source, run your agent, render the final document.</p></div><Link href="/dashboard/keys" className="button">Create API key <Arrow size={16} /></Link></header>
      <section className="dashboard-grid dashboard-grid--top">
        <article className="dashboard-panel dashboard-panel--quickstart">
          <div className="panel-heading"><div><span className="panel-index">01</span><h2>Quickstart</h2></div><div className="segmented"><button className={snippet === "typescript" ? "is-active" : ""} onClick={() => setSnippet("typescript")}>TypeScript</button><button className={snippet === "curl" ? "is-active" : ""} onClick={() => setSnippet("curl")}>cURL</button></div></div>
          {!data?.apiKeys.length && <div className="quickstart-step"><span>Before running this</span><Link href="/dashboard/keys">Create an API key <Arrow size={14} /></Link></div>}
          <CodeBlock code={snippet === "typescript" ? quickstart : curlQuickstart} title={snippet === "typescript" ? "quickstart.ts" : "terminal"} />
          <Link href="/docs/typescript" className="text-link">Continue in the docs <External size={14} /></Link>
        </article>
        <article className="dashboard-panel dashboard-panel--usage">
          <div className="panel-heading"><div><span className="panel-index">02</span><h2>This month</h2></div><Link href="/dashboard/usage">Details</Link></div>
          {data ? <UsageMeter data={data} /> : <div className="usage-placeholder"><strong>—</strong><span>Usage will appear when the runtime is connected.</span></div>}
          <div className="usage-notes"><span><i className="legend-dot legend-dot--read" /> Read</span><span><i className="legend-dot legend-dot--render" /> Render</span></div>
        </article>
      </section>
      <section className="dashboard-panel dashboard-panel--requests">
        <div className="panel-heading"><div><span className="panel-index">03</span><h2>Recent requests</h2></div><span>Content is never logged</span></div>
        <RequestsTable requests={data?.recentRequests || []} />
      </section>
    </>
  );
}

function KeysPanel({ data, onRefresh }: { data: DashboardData | null; onRefresh: () => Promise<void> }) {
  const [name, setName] = useState("Production");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createKey() {
    setCreating(true); setError(null);
    try {
      const result = await api.createApiKey(name.trim());
      setSecret(result.secret);
      await onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create this key."); }
    finally { setCreating(false); }
  }

  async function revoke(key: ApiKey) {
    if (!window.confirm(`Revoke “${key.name}”? Requests using it will stop immediately.`)) return;
    try { await api.revokeApiKey(key.id); await onRefresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not revoke this key."); }
  }

  async function copySecret() {
    if (!secret) return;
    await navigator.clipboard.writeText(secret); setCopied(true); window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <header className="dashboard-heading"><div><p className="eyebrow">Credentials</p><h1>API keys</h1><p>Keys are shown once, hashed at rest, and revoked immediately.</p></div></header>
      {secret && <div className="secret-callout" role="status"><div><span>Copy this key now</span><code>{secret}</code><small>You will not be able to see it again.</small></div><button className="button" onClick={copySecret}>{copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy key"}</button></div>}
      <section className="dashboard-panel create-key-panel">
        <div><Key size={22} /><div><h2>Create a key</h2><p>Use a separate key for each deployed environment.</p></div></div>
        <label><span>Key name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} disabled={!data} /></label>
        <button className="button" onClick={createKey} disabled={!data || creating || !name.trim()}>{creating ? "Creating…" : "Create key"} {!creating && <Arrow size={16} />}</button>
      </section>
      {error && <p className="form-alert" role="alert">{error}</p>}
      <section className="dashboard-panel key-list-panel">
        <div className="panel-heading"><h2>Active keys</h2><span>{data?.apiKeys.filter((key) => !key.revokedAt).length || 0} active</span></div>
        {!data?.apiKeys.length ? <div className="empty-state"><span className="empty-state__icon">⌁</span><div><h3>No API keys</h3><p>Create one above to authenticate your first hosted operation.</p></div></div> :
          <div className="key-list">{data.apiKeys.map((key) => <div className="key-row" key={key.id}><div><strong>{key.name}</strong><code>{key.prefix}••••••••••••</code></div><div><span>Created {formatDate(key.createdAt)}</span><span>{key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : "Never used"}</span></div><button type="button" className="danger-link" onClick={() => revoke(key)} disabled={!!key.revokedAt}>{key.revokedAt ? "Revoked" : "Revoke"}</button></div>)}</div>}
      </section>
    </>
  );
}

function UsagePanel({ data }: { data: DashboardData | null }) {
  const used = data?.usage.used || 0;
  const operations = data?.usage.operationUnits;
  const breakdown = useMemo(() => [
    { label: "PDF pages read", value: operations?.read_pdf || 0 },
    { label: "HTML / URL units", value: (operations?.read_html || 0) + (operations?.read_url || 0) },
    { label: "PDF pages rendered", value: operations?.render ?? (operations ? 0 : used) },
  ], [operations, used]);
  return (
    <>
      <header className="dashboard-heading"><div><p className="eyebrow">Metering</p><h1>Usage</h1><p>One shared unit across document input and output.</p></div><Link href="/docs/limits" className="button button--outline">Read metering rules</Link></header>
      <section className="dashboard-panel usage-detail-panel">
        {data ? <UsageMeter data={data} /> : <div className="usage-placeholder"><strong>—</strong><span>Connect the cloud runtime to load usage.</span></div>}
        <div className="usage-breakdown">{breakdown.map((item) => <div key={item.label}><span>{item.label}</span><strong>{formatNumber(item.value)}</strong></div>)}</div>
        {data && <p className="usage-reset">Resets {formatDate(data.usage.resetsAt)} · Failed and unsupported jobs are refunded.</p>}
      </section>
      <section className="dashboard-panel dashboard-panel--requests"><div className="panel-heading"><h2>Request history</h2><span>Metadata only</span></div><RequestsTable requests={data?.recentRequests || []} /></section>
    </>
  );
}

function BillingPanel({ data }: { data: DashboardData | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = data?.account.plan || "open-source";
  async function portal() {
    setBusy(true); setError(null);
    try { const result = await api.billingPortal(); window.location.assign(result.url); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Billing is not available."); setBusy(false); }
  }
  return (
    <>
      <header className="dashboard-heading"><div><p className="eyebrow">Subscription</p><h1>Billing</h1><p>Change your plan or manage payment details.</p></div></header>
      <section className="dashboard-panel billing-current">
        <div><span>Current plan</span><h2>{planLabels[plan]}</h2><p>{data ? `${formatNumber(data.usage.limit)} page units per UTC month` : "No billing connection"}</p></div>
        <div className="billing-current__actions">{plan === "open-source" ? <Link href="/pricing" className="button">Choose a plan <Arrow size={16} /></Link> : <button className="button button--outline" onClick={portal} disabled={busy}>{busy ? "Opening…" : "Manage billing"} <External size={15} /></button>}</div>
      </section>
      {error && <p className="form-alert" role="alert">{error}</p>}
      <section className="billing-notes"><article><h3>No hidden overage</h3><p>V1 stops at the included quota. It does not silently add usage charges.</p></article><article><h3>Immediate upgrades</h3><p>Verified Stripe events update local entitlements and monthly limits.</p></article><article><h3>Local stays free</h3><p>Your Cloud subscription never changes the MIT package or local usage.</p></article></section>
    </>
  );
}
