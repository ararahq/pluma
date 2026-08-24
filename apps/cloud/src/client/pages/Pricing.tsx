import { useEffect, useState } from "react";
import { Check, Arrow } from "../components/Icons";
import { MarketingLayout } from "../components/Shell";
import { api, ApiError, type PlanId } from "../lib/api";
import { Link, navigate } from "../lib/router";

const plans: Array<{
  id: PlanId;
  name: string;
  price: string;
  cadence?: string;
  units: string;
  description: string;
  features: string[];
  recommended?: boolean;
}> = [
  {
    id: "developer",
    name: "Developer",
    price: "$19",
    cadence: "/ month",
    units: "5,000 page units",
    description: "For products shipping their first customer-facing documents.",
    features: ["60 requests / minute", "4-request account queue", "30-day request metadata", "REST + TypeScript SDK"],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$79",
    cadence: "/ month",
    units: "50,000 page units",
    description: "For production apps delivering documents every day.",
    features: ["300 requests / minute", "20-request account queue", "90-day request metadata", "Usage and request history"],
    recommended: true,
  },
  {
    id: "scale",
    name: "Scale",
    price: "$249",
    cadence: "/ month",
    units: "250,000 page units",
    description: "For high-volume products with predictable throughput.",
    features: ["1,000 requests / minute", "60-request account queue", "90-day request metadata", "Usage and request history"],
  },
];

export function PricingPage() {
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeNeedsAuth, setResumeNeedsAuth] = useState<Exclude<PlanId, "open-source"> | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("plan");
    if (params.get("checkout") !== "resume" || (requested !== "developer" && requested !== "pro" && requested !== "scale")) return;
    let active = true;
    setBusy(requested);
    void (async () => {
      try {
        const session = await api.session();
        if (!active) return;
        if (!session) {
          setBusy(null);
          setResumeNeedsAuth(requested);
          return;
        }
        const checkout = await api.startCheckout(requested);
        if (active) window.location.assign(checkout.url);
      } catch (cause) {
        if (!active) return;
        setBusy(null);
        setError(cause instanceof Error ? cause.message : "Checkout is unavailable right now.");
      }
    })();
    return () => { active = false; };
  }, []);

  async function choose(plan: Exclude<PlanId, "open-source">) {
    setBusy(plan);
    setError(null);
    try {
      const session = await api.session();
      if (!session) {
        navigate(`/sign-up?plan=${plan}`);
        return;
      }
      const checkout = await api.startCheckout(plan);
      window.location.assign(checkout.url);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        navigate(`/sign-up?plan=${plan}`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Checkout is unavailable right now.");
      setBusy(null);
    }
  }

  return (
    <MarketingLayout>
      <section className="pricing-hero shell">
        <p className="eyebrow">Simple page-unit pricing</p>
        <h1>Pay for documents, not infrastructure.</h1>
        <p>One unit for each PDF page rendered or read. The open-source engine stays free and unlimited.</p>
      </section>

      <section className="pricing-grid shell" aria-label="Cloud plans">
        {plans.map((plan) => (
          <article key={plan.id} className={`price-card${plan.recommended ? " price-card--recommended" : ""}`}>
            {plan.recommended && <span className="recommendation">Recommended</span>}
            <header><h2>{plan.name}</h2><p>{plan.description}</p></header>
            <div className="price"><strong>{plan.price}</strong><span>{plan.cadence}</span></div>
            <p className="price-card__units">{plan.units} / month</p>
            <button type="button" className={`button${plan.recommended ? "" : " button--outline"}`} onClick={() => choose(plan.id as Exclude<PlanId, "open-source">)} disabled={busy !== null}>
              {busy === plan.id ? "Opening checkout…" : `Choose ${plan.name}`} <Arrow size={16} />
            </button>
            <ul>{plan.features.map((feature) => <li key={feature}><Check /> {feature}</li>)}</ul>
          </article>
        ))}
      </section>
      {resumeNeedsAuth && <p className="form-alert shell" role="status">Verify your email if requested, then <Link href={`/sign-in?plan=${resumeNeedsAuth}`}>sign in to continue {resumeNeedsAuth} checkout</Link>.</p>}
      {error && <p className="form-alert shell" role="alert">{error}</p>}

      <section className="oss-price shell">
        <div><span className="open-source-stamp">MIT / OPEN SOURCE</span><h2>Free and unlimited locally.</h2></div>
        <p>Install the package and run Pluma on your own machine or infrastructure. No hosted quota, no feature lock.</p>
        <a className="button button--outline" href="https://github.com/ararahq/pluma" target="_blank" rel="noreferrer">Open source <span aria-hidden="true">↗</span></a>
      </section>

      <section className="pricing-faq shell section-space">
        <h2>Clear limits. No surprise document retention.</h2>
        <div className="faq-grid">
          <article><h3>What is a page unit?</h3><p>One PDF page read or rendered is one unit. HTML and URL reads use one unit per started 100 KiB of decoded HTML.</p></article>
          <article><h3>Do failed jobs count?</h3><p>No. Failed, timed-out, unsafe, and unsupported operations are refunded automatically. Idempotent replays are never charged twice.</p></article>
          <article><h3>Do you store my documents?</h3><p>Raw inputs are not retained. Successful output may be encrypted briefly to safely replay idempotent requests.</p></article>
          <article><h3>Does v1 include OCR?</h3><p>Not yet. Pluma v1 handles PDFs with a text layer; the hosted API returns <code>scanned_pdf</code> without charging when no usable text layer exists.</p></article>
        </div>
        <p className="faq-link">Need the full contract? <Link href="/docs/limits">Read limits and metering.</Link></p>
      </section>
    </MarketingLayout>
  );
}
