import { FormEvent, useState } from "react";
import { Arrow } from "../components/Icons";
import { Brand } from "../components/Shell";
import { api } from "../lib/api";
import { Link } from "../lib/router";
import { AuthAside } from "./Auth";

export function PasswordRecoveryPage({ mode }: { mode: "forgot" | "reset" }) {
  const isReset = mode === "reset";
  const params = new URLSearchParams(window.location.search);
  const [token] = useState(() => params.get("token") ?? "");
  const [tokenError] = useState(() => params.get("error"));
  const invalidToken = isReset && (tokenError === "INVALID_TOKEN" || token.length === 0);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (isReset && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      if (isReset) {
        await api.resetPassword(password, token);
        history.replaceState({}, "", "/reset-password");
      }
      else await api.requestPasswordReset(email.trim(), `${window.location.origin}/reset-password`);
      setComplete(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not complete this request.");
    } finally {
      setBusy(false);
    }
  }

  const heading = isReset ? "Choose a new password" : "Reset your password";
  const introduction = isReset
    ? "Use a new password you have not used for this account before."
    : "Enter your account email. If it exists, we will send a secure reset link.";

  return (
    <main className="auth-layout">
      <a className="skip-link" href="#recovery-form">Skip to form</a>
      <section className="auth-panel">
        <div className="auth-panel__top"><Brand /><Link href="/docs">Docs</Link></div>
        <div className="auth-form-wrap" id="recovery-form">
          <p className="eyebrow">Account recovery</p>
          <h1>{heading}</h1>
          <p>{introduction}</p>

          {invalidToken ? (
            <div className="auth-form">
              <p className="form-alert" role="alert">This reset link is invalid or has expired.</p>
              <Link className="button button--large button--full" href="/forgot-password">Request a new link <Arrow /></Link>
            </div>
          ) : complete ? (
            <div className="auth-form">
              <p className="form-notice" role="status">
                {isReset ? "Your password has been updated. You can now sign in." : "If that email belongs to an account, a reset link is on its way."}
              </p>
              <Link className="button button--large button--full" href="/sign-in">Return to sign in <Arrow /></Link>
            </div>
          ) : (
            <form className="auth-form" onSubmit={submit}>
              {isReset ? (
                <>
                  <label><span>New password</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} maxLength={128} /></label>
                  <label><span>Confirm new password</span><input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required minLength={8} maxLength={128} /></label>
                  <small>Use between 8 and 128 characters.</small>
                </>
              ) : (
                <label><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
              )}
              {error && <p className="form-alert" role="alert">{error}</p>}
              <button type="submit" className="button button--large button--full" disabled={busy}>
                {busy ? "Please wait…" : isReset ? "Update password" : "Send reset link"} {!busy && <Arrow />}
              </button>
            </form>
          )}
          <p className="auth-switch"><Link href="/sign-in">Back to sign in</Link></p>
        </div>
      </section>
      <AuthAside />
    </main>
  );
}
