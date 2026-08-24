import { useEffect, useRef, useState } from "react";
import { Link, navigate } from "../lib/router";
import { api, type Session } from "../lib/api";
import { Arrow, Close, Menu } from "./Icons";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className={`brand${compact ? " brand--compact" : ""}`} aria-label="Pluma home">
      <span className="brand__mark" aria-hidden="true">P</span>
      {!compact && <span>Pluma</span>}
    </Link>
  );
}

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null));
  }, []);

  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("popstate", close);
    return () => window.removeEventListener("popstate", close);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <header className="site-header">
      <div className="site-header__inner shell">
        <Brand />
        <nav className={`site-nav${open ? " site-nav--open" : ""}`} aria-label="Main navigation">
          <Link href="/docs">Docs</Link>
          <Link href="/pricing">Pricing</Link>
          <a href="https://github.com/ararahq/pluma" target="_blank" rel="noreferrer">GitHub</a>
          <span className="site-nav__divider" aria-hidden="true" />
          {session ? (
            <Link className="button button--small" href="/dashboard">Dashboard <Arrow size={15} /></Link>
          ) : (
            <>
              <Link href="/sign-in">Sign in</Link>
              <a className="button button--small" href="/#pluma-playground">Render a PDF <Arrow size={15} /></a>
            </>
          )}
        </nav>
        <button
          ref={menuButtonRef}
          type="button"
          className="menu-button"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <Close /> : <Menu />}
        </button>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell site-footer__main">
        <div>
          <Brand />
          <p>Production-ready PDFs from Markdown.</p>
        </div>
        <div className="site-footer__links">
          <div><strong>Product</strong><Link href="/pricing">Pricing</Link><Link href="/docs">Documentation</Link><Link href="/sign-up">Start building</Link></div>
          <div><strong>Developers</strong><Link href="/docs/rest">REST API</Link><Link href="/docs/typescript">TypeScript</Link><Link href="/docs/mcp">MCP</Link></div>
          <div><strong>Company</strong><Link href="/docs/privacy">Privacy</Link><Link href="/docs/limits">Limits</Link><a href="https://github.com/ararahq/pluma" target="_blank" rel="noreferrer">GitHub</a></div>
        </div>
      </div>
      <div className="shell site-footer__bottom">
        <span>© {new Date().getFullYear()} Pluma by AraraHQ.</span>
        <span>Files are ephemeral by default.</span>
      </div>
    </footer>
  );
}

export function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <><a className="skip-link" href="#main">Skip to content</a><SiteHeader /><main id="main">{children}</main><SiteFooter /></>;
}

export function DashboardLayout({
  children,
  active,
}: {
  children: React.ReactNode;
  active: "overview" | "keys" | "usage" | "billing";
}) {
  const links = [
    ["overview", "/dashboard", "Overview"],
    ["keys", "/dashboard/keys", "API keys"],
    ["usage", "/dashboard/usage", "Usage"],
    ["billing", "/dashboard/billing", "Billing"],
  ] as const;

  async function signOut() {
    await api.signOut().catch(() => undefined);
    navigate("/");
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <Brand />
        <nav aria-label="Dashboard navigation">
          {links.map(([id, href, label]) => <Link key={id} href={href} className={active === id ? "is-active" : ""}>{label}</Link>)}
        </nav>
        <div className="app-sidebar__bottom">
          <Link href="/docs">Documentation</Link>
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <div className="app-content">
        <header className="app-mobile-header"><Brand /><Link href="/docs">Docs</Link></header>
        <main>{children}</main>
        <nav className="app-tabbar" aria-label="Mobile dashboard navigation">
          {links.map(([id, href, label]) => <Link key={id} href={href} className={active === id ? "is-active" : ""}>{label}</Link>)}
        </nav>
      </div>
    </div>
  );
}
