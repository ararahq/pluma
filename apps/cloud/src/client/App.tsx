import { useEffect } from "react";
import { MarketingLayout } from "./components/Shell";
import { Arrow } from "./components/Icons";
import { usePathname, Link } from "./lib/router";
import { AuthPage } from "./pages/Auth";
import { DashboardPage } from "./pages/Dashboard";
import { DocsPage } from "./pages/Docs";
import { LandingPage } from "./pages/Landing";
import { PricingPage } from "./pages/Pricing";
import { PasswordRecoveryPage } from "./pages/PasswordRecovery";

const titles: Record<string, string> = {
  "/": "Pluma — Markdown to production-ready PDF",
  "/pricing": "Pricing — Pluma",
  "/sign-in": "Sign in — Pluma",
  "/sign-up": "Create an account — Pluma",
  "/forgot-password": "Reset your password — Pluma",
  "/reset-password": "Choose a new password — Pluma",
  "/dashboard": "Dashboard — Pluma",
  "/dashboard/keys": "API keys — Pluma",
  "/dashboard/usage": "Usage — Pluma",
  "/dashboard/billing": "Billing — Pluma",
  "/docs": "Documentation — Pluma",
  "/docs/rest": "REST API — Pluma Docs",
  "/docs/typescript": "TypeScript — Pluma Docs",
  "/docs/cli": "CLI — Pluma Docs",
  "/docs/mcp": "MCP server — Pluma Docs",
  "/docs/privacy": "Privacy & security — Pluma Docs",
  "/docs/limits": "Limits & metering — Pluma Docs",
  "/docs/deployment": "Deployment — Pluma Docs",
};

export function App() {
  const pathname = usePathname().replace(/\/$/, "") || "/";
  useEffect(() => { document.title = titles[pathname] || "Pluma"; }, [pathname]);

  if (pathname === "/") return <LandingPage />;
  if (pathname === "/pricing") return <PricingPage />;
  if (pathname === "/sign-in") return <AuthPage mode="sign-in" />;
  if (pathname === "/sign-up") return <AuthPage mode="sign-up" />;
  if (pathname === "/forgot-password") return <PasswordRecoveryPage mode="forgot" />;
  if (pathname === "/reset-password") return <PasswordRecoveryPage mode="reset" />;
  if (pathname === "/dashboard") return <DashboardPage section="overview" />;
  if (pathname === "/dashboard/keys") return <DashboardPage section="keys" />;
  if (pathname === "/dashboard/usage") return <DashboardPage section="usage" />;
  if (pathname === "/dashboard/billing") return <DashboardPage section="billing" />;
  if (pathname === "/docs") return <DocsPage page="overview" />;
  if (pathname === "/docs/rest") return <DocsPage page="rest" />;
  if (pathname === "/docs/typescript") return <DocsPage page="typescript" />;
  if (pathname === "/docs/cli") return <DocsPage page="cli" />;
  if (pathname === "/docs/mcp") return <DocsPage page="mcp" />;
  if (pathname === "/docs/privacy") return <DocsPage page="privacy" />;
  if (pathname === "/docs/limits") return <DocsPage page="limits" />;
  if (pathname === "/docs/deployment") return <DocsPage page="deployment" />;

  return (
    <MarketingLayout>
      <section className="not-found shell">
        <span>404 / PAGE NOT FOUND</span>
        <h1>This page left no paper trail.</h1>
        <p>The address may have changed, or the document never existed.</p>
        <Link href="/" className="button">Return home <Arrow size={16} /></Link>
      </section>
    </MarketingLayout>
  );
}
