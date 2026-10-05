import { useEffect, useState } from "react";
import { formatDate, vendorRequest } from "./api";

export default function VendorRegistration({ token, onBack }) {
  const [vendor, setVendor] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    vendorRequest(`/vendor-portal/register/${encodeURIComponent(token)}`)
      .then((payload) => {
        if (cancelled) return;
        setVendor(payload?.vendor || null);
        setExpiresAt(payload?.expires_at || null);
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError.message || "This onboarding invitation is invalid or expired.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      setError("Use 12–128 characters with uppercase, lowercase, number, and symbol characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await vendorRequest(`/vendor-portal/register/${encodeURIComponent(token)}`, {
        method: "POST",
        body: { password },
      });
      setComplete(true);
    } catch (requestError) {
      setError(requestError.message || "We could not finish your portal registration.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-auth">
      <section className="vp-auth-rail">
        <div className="vp-auth-brand"><span className="vp-brand-mark">AS</span><span>absstem / Josh</span></div>
        <div className="vp-auth-copy">
          <div className="vp-eyebrow">Invitation controlled access</div>
          <h1>Open your supplier workspace.</h1>
          <p>This secure link was issued by a Josh purchase executive. Set one portal password to respond to RFQs and maintain statutory records.</p>
        </div>
        <div className="vp-auth-signals">
          <div className="vp-auth-signal"><strong>01</strong><span>Verify invitation</span></div>
          <div className="vp-auth-signal"><strong>02</strong><span>Set credentials</span></div>
          <div className="vp-auth-signal"><strong>03</strong><span>Await activation</span></div>
        </div>
      </section>
      <section className="vp-auth-card">
        <div className="vp-auth-card-inner">
          {loading ? <div className="vp-state"><span className="vp-spinner" /><strong>Verifying invitation</strong><p>Checking the secure onboarding link.</p></div> : null}
          {!loading && !vendor ? <><div className="vp-eyebrow">Link unavailable</div><h2>Invitation closed</h2><p className="vp-auth-subhead">{error || "Ask your purchase executive for a fresh onboarding link."}</p><button className="vp-button secondary" type="button" onClick={onBack}>Return to portal</button></> : null}
          {!loading && vendor && !complete ? (
            <>
              <div className="vp-eyebrow">Vendor registration</div>
              <h2>{vendor.company_name}</h2>
              <p className="vp-auth-subhead">Vendor code <span className="vp-mono">{vendor.vendor_code}</span> · invitation expires {formatDate(expiresAt)}</p>
              <form className="vp-form" onSubmit={submit}>
                <div className="vp-field"><label htmlFor="registration-password">Create password</label><input id="registration-password" type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="12+ characters, symbol required" /></div>
                <div className="vp-field"><label htmlFor="registration-password-confirm">Confirm password</label><input id="registration-password-confirm" type="password" autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat password" /></div>
                {error ? <div className="vp-error" role="alert">{error}</div> : null}
                <button className="vp-button" type="submit" disabled={busy}>{busy ? "Securing account…" : "Set portal password"}</button>
              </form>
            </>
          ) : null}
          {!loading && complete ? (
            <>
              <div className="vp-token-mark">OK</div>
              <div className="vp-eyebrow">Registration complete</div>
              <h2>Access is pending activation.</h2>
              <p className="vp-auth-subhead">Your password is set for <strong>{vendor?.email}</strong>. Josh procurement must activate the account before your first sign-in.</p>
              <button className="vp-button" type="button" onClick={onBack}>Return to sign in</button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
