import { FormEvent, useState } from "react";
import { Arrow } from "../components/Icons";
import { Brand } from "../components/Shell";
import { api } from "../lib/api";
import { Link, navigate } from "../lib/router";

export function AuthAside() {
  return (
    <aside className="auth-aside">
      <div className="auth-aside__document" aria-hidden="true">
        <div className="auth-aside__paper"><span>P / 01</span><h2>Agent output,<br />ready to send.</h2><i /><i /><i /><blockquote>Documents are part of the product.</blockquote></div>
      </div>
      <div><h2>From first request to production PDF.</h2><p>Start with 5,000 page units on Developer. Keep the core library free and local.</p></div>
    </aside>
  );
}

export function AuthPage({ mode }: { mode: "sign-in" | "sign-up" }) {
  const isSignUp = mode === "sign-up";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (isSignUp) await api.signUp(name.trim(), email.trim(), password);
      else await api.signIn(email.trim(), password);
      const params = new URLSearchParams(window.location.search);
      const plan = params.get("plan");
      const next = params.get("next");
      const safeNext = next?.startsWith("/") && !next.startsWith("//") ? next : undefined;
      navigate(plan ? `/pricing?plan=${encodeURIComponent(plan)}&checkout=resume` : safeNext || "/dashboard");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "We could not complete this request.";
      if (message.toLowerCase().includes("verify")) setNotice("Check your inbox to verify your email, then sign in.");
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function github() {
    setBusy(true);
    setError(null);
    try {
      const plan = new URLSearchParams(window.location.search).get("plan");
      const callbackURL = plan === "developer" || plan === "pro" || plan === "scale"
        ? `/pricing?plan=${plan}&checkout=resume`
        : "/dashboard";
      const result = await api.signInGitHub(callbackURL);
      if (result.url) window.location.assign(result.url);
      else setError("GitHub sign-in is not configured on this deployment.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub sign-in is not configured.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <a className="skip-link" href="#auth-form">Skip to form</a>
      <section className="auth-panel">
        <div className="auth-panel__top"><Brand /><Link href="/docs">Docs</Link></div>
        <div className="auth-form-wrap" id="auth-form">
          <p className="eyebrow">Pluma Cloud</p>
          <h1>{isSignUp ? "Create your account" : "Welcome back"}</h1>
          <p>{isSignUp ? "Run your first hosted document operation in under five minutes." : "Sign in to manage keys, usage, and billing."}</p>

          <button type="button" className="button button--github" onClick={github} disabled={busy}>
            <span className="github-mark" aria-hidden="true">GH</span> Continue with GitHub
          </button>
          <div className="form-divider"><span>or continue with email</span></div>

          <form className="auth-form" onSubmit={submit}>
            {isSignUp && <label><span>Name</span><input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>}
            <label><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label><span>Password</span><input type="password" autoComplete={isSignUp ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} aria-describedby={isSignUp ? "password-hint" : undefined} /></label>
            {isSignUp && <small id="password-hint">Use at least 8 characters.</small>}
            {!isSignUp && <p className="auth-recovery-link"><Link href="/forgot-password">Forgot your password?</Link></p>}
            {error && <p className="form-alert" role="alert">{error}</p>}
            {notice && <p className="form-notice" role="status">{notice}</p>}
            <button type="submit" className="button button--large button--full" disabled={busy}>{busy ? "Please wait…" : isSignUp ? "Create account" : "Sign in"} {!busy && <Arrow />}</button>
          </form>
          <p className="auth-switch">{isSignUp ? "Already have an account?" : "New to Pluma?"} <Link href={isSignUp ? "/sign-in" : "/sign-up"}>{isSignUp ? "Sign in" : "Create an account"}</Link></p>
          {isSignUp && <p className="auth-terms">By continuing, you agree to use Pluma responsibly and acknowledge its <Link href="/docs/privacy">privacy model</Link>.</p>}
        </div>
      </section>
      <AuthAside />
    </main>
  );
}
