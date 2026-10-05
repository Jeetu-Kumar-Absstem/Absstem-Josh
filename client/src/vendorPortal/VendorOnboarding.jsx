import { useState } from "react";
import { vendorRequest } from "./api";

const initialForm = { vendor_code: "", company_name: "", contact_name: "", email: "", phone: "", password: "", confirmPassword: "" };

export default function VendorOnboarding({ onBack }) {
  const [form, setForm] = useState(initialForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  function update(key, value) { setForm((current) => ({ ...current, [key]: value })); }

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (!/^[A-Za-z0-9-_]{3,32}$/.test(form.vendor_code.trim())) return setError("Enter the vendor code provided by absstem (3–32 letters, numbers, or hyphens).");
    if (form.password.length < 12 || !/[A-Z]/.test(form.password) || !/[a-z]/.test(form.password) || !/[0-9]/.test(form.password) || !/[^A-Za-z0-9]/.test(form.password)) return setError("Use at least 12 characters with uppercase, lowercase, number, and symbol characters.");
    if (form.password !== form.confirmPassword) return setError("Passwords do not match.");
    setBusy(true);
    try {
      await vendorRequest("/vendor-portal/auth/register", {
        method: "POST",
        body: {
          vendor_code: form.vendor_code.trim(),
          company_name: form.company_name.trim(),
          contact_name: form.contact_name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          password: form.password,
        },
      });
      setComplete(true);
    } catch (requestError) {
      setError(requestError.message || "We could not submit your onboarding request.");
    } finally {
      setBusy(false);
    }
  }

  if (complete) {
    return (
      <div className="vp-auth">
        <section className="vp-auth-rail">
          <div className="vp-auth-brand"><span className="vp-brand-mark">AS</span><span>absstem / Josh</span></div>
          <div className="vp-auth-copy"><div className="vp-eyebrow">Onboarding received</div><h1>Your access is in the queue.</h1><p>Procurement will validate the vendor code and activate the account. Keep this email handy for the activation notice.</p></div>
          <div className="vp-auth-signals"><div className="vp-auth-signal"><strong>✓</strong><span>Request logged</span></div><div className="vp-auth-signal"><strong>→</strong><span>Procurement review</span></div><div className="vp-auth-signal"><strong>○</strong><span>Activation next</span></div></div>
        </section>
        <section className="vp-auth-card"><div className="vp-auth-card-inner"><div className="vp-token-mark">OK</div><div className="vp-eyebrow">Pending activation</div><h2>Registration submitted</h2><p className="vp-auth-subhead">Your account is not active yet. Once approved, sign in with <strong>{form.email}</strong>.</p><button className="vp-button" type="button" onClick={onBack}>Return to sign in</button></div></section>
      </div>
    );
  }

  return (
    <div className="vp-auth">
      <section className="vp-auth-rail">
        <div className="vp-auth-brand"><span className="vp-brand-mark">AS</span><span>absstem / Josh</span></div>
        <div className="vp-auth-copy"><div className="vp-eyebrow">Vendor onboarding</div><h1>Set up the right access.</h1><p>One request connects your approved supplier identity to RFQs, compliance documents, and submission history.</p></div>
        <div className="vp-auth-signals"><div className="vp-auth-signal"><strong>12+</strong><span>Password characters</span></div><div className="vp-auth-signal"><strong>1</strong><span>Vendor code</span></div><div className="vp-auth-signal"><strong>0</strong><span>Shared credentials</span></div></div>
      </section>
      <section className="vp-auth-card">
        <div className="vp-auth-card-inner">
          <div className="vp-eyebrow">Request access</div><h2>Vendor onboarding</h2><p className="vp-auth-subhead">Tell us who should receive RFQs and compliance prompts.</p>
          <form className="vp-form" onSubmit={submit}>
            <div className="vp-form-grid">
              <div className="vp-field"><label htmlFor="vendor-code">Vendor code</label><input id="vendor-code" required value={form.vendor_code} onChange={(event) => update("vendor_code", event.target.value)} placeholder="e.g. SUP-042" /></div>
              <div className="vp-field"><label htmlFor="company-name">Company name</label><input id="company-name" required value={form.company_name} onChange={(event) => update("company_name", event.target.value)} placeholder="Registered supplier name" /></div>
              <div className="vp-field"><label htmlFor="contact-name">Primary contact</label><input id="contact-name" required value={form.contact_name} onChange={(event) => update("contact_name", event.target.value)} placeholder="Full name" /></div>
              <div className="vp-field"><label htmlFor="contact-phone">Phone</label><input id="contact-phone" value={form.phone} onChange={(event) => update("phone", event.target.value)} placeholder="+91 ..." /></div>
              <div className="vp-field full"><label htmlFor="register-email">Contact email</label><input id="register-email" type="email" required value={form.email} onChange={(event) => update("email", event.target.value)} placeholder="contact@supplier.com" /></div>
              <div className="vp-field"><label htmlFor="register-password">Create password</label><input id="register-password" type="password" required value={form.password} onChange={(event) => update("password", event.target.value)} placeholder="12+ characters" /><small>Uppercase, lowercase, number, and symbol required.</small></div>
              <div className="vp-field"><label htmlFor="register-confirm">Confirm password</label><input id="register-confirm" type="password" required value={form.confirmPassword} onChange={(event) => update("confirmPassword", event.target.value)} placeholder="Repeat password" /></div>
            </div>
            {error ? <div className="vp-error" role="alert">{error}</div> : null}
            <button className="vp-button" type="submit" disabled={busy}>{busy ? "Submitting request…" : "Submit onboarding request"}</button>
          </form>
          <div className="vp-auth-switch">Already have an activated account? <button type="button" onClick={onBack}>Return to sign in →</button></div>
        </div>
      </section>
    </div>
  );
}
