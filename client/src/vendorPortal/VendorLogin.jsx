import { useState } from "react";
import { setVendorToken, vendorRequest } from "./api";

export default function VendorLogin({ onAuthenticated }) {
  const [form, setForm] = useState({ email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload = await vendorRequest("/vendor-portal/auth/login", {
        method: "POST",
        body: form,
      });
      const token = payload?.token || payload?.access_token || payload?.data?.token;
      if (!token) throw new Error("Your account is awaiting activation. Procurement will send access once it is approved.");
      setVendorToken(token);
      onAuthenticated(payload);
    } catch (requestError) {
      setError(requestError.message || "We could not sign you in. Check your details and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-auth">
      <section className="vp-auth-rail">
        <div className="vp-auth-brand">
          <span className="vp-brand-mark">AS</span>
          <span>absstem / Josh</span>
        </div>
        <div className="vp-auth-copy">
          <div className="vp-eyebrow">External supplier access</div>
          <h1>A clear line into procurement.</h1>
          <p>Respond to live requests, keep statutory records current, and see exactly what is waiting on your team.</p>
        </div>
        <div className="vp-auth-signals">
          <div className="vp-auth-signal"><strong>01</strong><span>RFQ response</span></div>
          <div className="vp-auth-signal"><strong>02</strong><span>Compliance locker</span></div>
          <div className="vp-auth-signal"><strong>03</strong><span>Submission trail</span></div>
        </div>
      </section>
      <section className="vp-auth-card">
        <div className="vp-auth-card-inner">
          <div className="vp-eyebrow">Registered vendor</div>
          <h2>Sign in to your portal</h2>
          <p className="vp-auth-subhead">Use the email approved by the absstem procurement team.</p>
          <form className="vp-form" onSubmit={submit}>
            <div className="vp-field">
              <label htmlFor="vendor-email">Contact email</label>
              <input id="vendor-email" type="email" autoComplete="username" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="contact@supplier.com" />
            </div>
            <div className="vp-field">
              <label htmlFor="vendor-password">Password</label>
              <input id="vendor-password" type="password" autoComplete="current-password" required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Your portal password" />
            </div>
            {error ? <div className="vp-error" role="alert">{error}</div> : null}
            <button className="vp-button" type="submit" disabled={busy}>{busy ? "Checking access…" : "Enter supplier portal"}</button>
          </form>
          <div className="vp-lock-note"><span aria-hidden="true">▣</span><span>New registrations require procurement activation. You will not be able to sign in until the vendor account is approved.</span></div>
          <div className="vp-auth-switch">Need access? Ask your Josh purchase executive for a secure invitation link.</div>
        </div>
      </section>
    </div>
  );
}
