import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "../shared/joshUi";
import { compressReceiptImage, formatBytes } from "./compressImage";

const CATEGORIES = ["Travel", "Local travel", "Client visit", "Office", "Other"];
const DUTY_DRAFT_KEY = "josh-my-duty-draft-v1";
const EXPENSE_DRAFT_KEY = "josh-my-expense-draft-meta-v1";

function money(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function localTimeHms() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function loadJson(key) {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveJson(key, value) {
  try {
    if (!value) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

async function fetchJson(path, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      credentials: "include",
      signal: controller.signal,
      ...options,
      headers: options.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error || "Request failed");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeout = new Error("NETWORK_TIMEOUT");
      timeout.code = "NETWORK_TIMEOUT";
      throw timeout;
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

export default function MyDutyExpenses() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [bootstrap, setBootstrap] = useState(null);
  const [dutyDraft, setDutyDraft] = useState(() => loadJson(DUTY_DRAFT_KEY));
  const [form, setForm] = useState({
    purpose: "",
    category: "Travel",
    amount: "",
    reference_no: "",
    job_card_id: "",
    service_case_id: "",
  });
  const [receipt, setReceipt] = useState(null);
  const [compressNote, setCompressNote] = useState("");

  const duty = bootstrap?.duty || null;
  const claims = Array.isArray(bootstrap?.claims) ? bootstrap.claims : [];
  const jobCards = Array.isArray(bootstrap?.job_cards) ? bootstrap.job_cards : [];
  const serviceCases = Array.isArray(bootstrap?.service_cases) ? bootstrap.service_cases : [];

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchJson("/hr/self/bootstrap");
      setBootstrap(data);
    } catch (err) {
      setError(err?.code === "NETWORK_TIMEOUT" ? "Network timed out. Tap retry when signal returns." : err?.data?.error || "Could not load My Duty & Expenses.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    return () => {
      if (receipt?.previewUrl) URL.revokeObjectURL(receipt.previewUrl);
    };
  }, [receipt]);

  const openClaims = useMemo(
    () => claims.filter((c) => c.status === "manager_pending" || c.status === "accounts_pending").length,
    [claims]
  );

  async function startDuty() {
    const intended = dutyDraft?.intended_in_time || localTimeHms();
    saveJson(DUTY_DRAFT_KEY, { action: "start", intended_in_time: intended, at: Date.now() });
    setDutyDraft({ action: "start", intended_in_time: intended });
    setBusy("duty-start");
    setError("");
    try {
      const data = await fetchJson("/hr/self/duty", {
        method: "POST",
        body: JSON.stringify({ intended_in_time: intended }),
      });
      setBootstrap((prev) => ({ ...(prev || {}), duty: data.duty }));
      saveJson(DUTY_DRAFT_KEY, null);
      setDutyDraft(null);
      toast(data.already_started ? "Duty already started today." : "Duty started.", "success");
    } catch (err) {
      setError(
        err?.code === "NETWORK_TIMEOUT"
          ? `Signal dropped. Your start time ${intended.slice(0, 5)} is saved — tap Retry.`
          : err?.data?.error || "Could not start duty."
      );
    } finally {
      setBusy("");
    }
  }

  async function endDuty() {
    if (!duty?.id) return;
    const intended = dutyDraft?.intended_out_time || localTimeHms();
    saveJson(DUTY_DRAFT_KEY, { action: "end", duty_id: duty.id, intended_out_time: intended, at: Date.now() });
    setDutyDraft({ action: "end", duty_id: duty.id, intended_out_time: intended });
    setBusy("duty-end");
    setError("");
    try {
      const data = await fetchJson(`/hr/self/duty/${duty.id}`, {
        method: "PATCH",
        body: JSON.stringify({ intended_out_time: intended }),
      });
      setBootstrap((prev) => ({ ...(prev || {}), duty: data.duty }));
      saveJson(DUTY_DRAFT_KEY, null);
      setDutyDraft(null);
      toast("Duty ended.", "success");
    } catch (err) {
      setError(
        err?.code === "NETWORK_TIMEOUT"
          ? `Signal dropped. Your end time ${intended.slice(0, 5)} is saved — tap Retry.`
          : err?.data?.error || "Could not end duty."
      );
    } finally {
      setBusy("");
    }
  }

  function retryDuty() {
    if (dutyDraft?.action === "end") endDuty();
    else startDuty();
  }

  async function onPickReceipt(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setCompressNote("Compressing photo…");
    setError("");
    try {
      if (receipt?.previewUrl) URL.revokeObjectURL(receipt.previewUrl);
      const result = await compressReceiptImage(file);
      setReceipt(result);
      setCompressNote(result.label);
      saveJson(EXPENSE_DRAFT_KEY, { ...form, has_receipt: true, compressedBytes: result.compressedBytes });
    } catch (err) {
      setReceipt(null);
      if (err?.code === "HEIC_UNSUPPORTED") {
        setError("This iPhone photo format could not be converted. In Camera, set Formats to Most Compatible, or choose a JPEG/PNG.");
      } else if (err?.code === "IMAGE_DECODE_FAILED") {
        setError("Could not read that image. Try JPEG or PNG.");
      } else if (err?.code === "STILL_TOO_LARGE") {
        setError("Photo is still too large after compression. Move closer and retake a clearer, closer shot of the bill.");
      } else {
        setError("Could not prepare the receipt photo.");
      }
      setCompressNote("");
    }
  }

  async function submitExpense() {
    if (!form.purpose.trim() || !String(form.amount).trim()) {
      setError("Enter purpose and amount.");
      return;
    }
    if (!receipt?.file) {
      setError("Add one receipt photo for this claim.");
      return;
    }
    setBusy("expense");
    setError("");
    saveJson(EXPENSE_DRAFT_KEY, { ...form, has_receipt: true });
    try {
      const body = new FormData();
      body.append("purpose", form.purpose.trim());
      body.append("category", form.category);
      body.append("amount", String(form.amount).trim());
      if (form.reference_no.trim()) body.append("reference_no", form.reference_no.trim());
      if (form.job_card_id) body.append("job_card_id", form.job_card_id);
      if (form.service_case_id) body.append("service_case_id", form.service_case_id);
      body.append("receipt", receipt.file, "receipt.jpg");

      const data = await fetchJson("/hr/self/expenses", { method: "POST", body }, 45000);
      setBootstrap((prev) => ({
        ...(prev || {}),
        claims: [data.claim, ...(prev?.claims || [])],
      }));
      if (receipt?.previewUrl) URL.revokeObjectURL(receipt.previewUrl);
      setReceipt(null);
      setForm({ purpose: "", category: "Travel", amount: "", reference_no: "", job_card_id: "", service_case_id: "" });
      setCompressNote("");
      saveJson(EXPENSE_DRAFT_KEY, null);
      toast("Claim submitted for approval.", "success");
    } catch (err) {
      setError(
        err?.code === "NETWORK_TIMEOUT"
          ? "Signal dropped while uploading. Your claim draft and photo are still here — tap Submit again."
          : err?.data?.error === "RECEIPT_TOO_LARGE"
            ? "Receipt still too large for upload. Retake a closer photo."
            : err?.data?.error || "Could not submit claim."
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="my-duty-shell">
      <header className="my-duty-hero">
        <div className="panel-kicker">Self service</div>
        <h2>My Duty &amp; Expenses</h2>
        <p>Mark your day and submit one claim per expense head with a compressed receipt photo. Works on phone.</p>
        <div className="my-duty-hero-stats">
          <span>{bootstrap?.me?.name || "—"}</span>
          <span>{openClaims} open claims</span>
          <span>{bootstrap?.today || ""}</span>
        </div>
      </header>

      {error ? (
        <div className="my-duty-error" role="alert">
          <p>{error}</p>
          {dutyDraft || error.toLowerCase().includes("retry") ? (
            <button type="button" className="button-primary compact-button" onClick={retryDuty} disabled={Boolean(busy)}>
              Retry duty
            </button>
          ) : null}
          <button type="button" className="button-ghost compact-button" onClick={loadBootstrap} disabled={loading}>
            Reload
          </button>
        </div>
      ) : null}

      <section className="my-duty-card">
        <div className="panel-kicker">Today</div>
        <h3>Duty mark</h3>
        {loading ? <p className="my-duty-muted">Loading…</p> : null}
        {!loading && !duty ? (
          <>
            <p className="my-duty-muted">Start when you begin work. Time is kept if the network drops so you can retry.</p>
            <button type="button" className="button-primary my-duty-primary" onClick={startDuty} disabled={busy === "duty-start"}>
              {busy === "duty-start" ? "Starting…" : "Start duty"}
            </button>
          </>
        ) : null}
        {!loading && duty ? (
          <div className="my-duty-duty-row">
            <div>
              <strong>In {duty.in_time || "—"}</strong>
              <em>Out {duty.out_time || "still on duty"}</em>
            </div>
            {!duty.out_time ? (
              <button type="button" className="button-primary my-duty-primary" onClick={endDuty} disabled={busy === "duty-end"}>
                {busy === "duty-end" ? "Ending…" : "End duty"}
              </button>
            ) : (
              <span className="my-duty-done-chip">Day closed</span>
            )}
          </div>
        ) : null}
      </section>

      <section className="my-duty-card">
        <div className="panel-kicker">New claim</div>
        <h3>Expense with receipt</h3>
        <p className="my-duty-muted">One photo per claim so different heads stay separate (hotel, food, travel).</p>
        <div className="my-duty-form">
          <label>
            <span>Purpose</span>
            <input
              value={form.purpose}
              onChange={(e) => setForm((c) => ({ ...c, purpose: e.target.value }))}
              placeholder="What was this for?"
              disabled={Boolean(busy)}
            />
          </label>
          <label>
            <span>Head / category</span>
            <select value={form.category} onChange={(e) => setForm((c) => ({ ...c, category: e.target.value }))} disabled={Boolean(busy)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Amount (INR)</span>
            <input
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => setForm((c) => ({ ...c, amount: e.target.value }))}
              placeholder="0"
              disabled={Boolean(busy)}
            />
          </label>
          <label>
            <span>Reference (quote / SO / PO / case)</span>
            <input
              value={form.reference_no}
              onChange={(e) => setForm((c) => ({ ...c, reference_no: e.target.value }))}
              placeholder="Optional"
              disabled={Boolean(busy)}
            />
          </label>
          {jobCards.length ? (
            <label>
              <span>Job card (optional)</span>
              <select value={form.job_card_id} onChange={(e) => setForm((c) => ({ ...c, job_card_id: e.target.value }))} disabled={Boolean(busy)}>
                <option value="">None</option>
                {jobCards.map((jc) => (
                  <option key={jc.id} value={String(jc.id)}>
                    {jc.job_card_number}
                    {jc.customer_name ? ` · ${jc.customer_name}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {serviceCases.length ? (
            <label>
              <span>Service case (optional)</span>
              <select
                value={form.service_case_id}
                onChange={(e) => setForm((c) => ({ ...c, service_case_id: e.target.value }))}
                disabled={Boolean(busy)}
              >
                <option value="">None</option>
                {serviceCases.map((sc) => (
                  <option key={sc.id} value={String(sc.id)}>
                    {sc.case_number}
                    {sc.customer_name ? ` · ${sc.customer_name}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="my-duty-file">
            <span>Receipt photo</span>
            <input type="file" accept="image/*,.heic,.heif" capture="environment" onChange={onPickReceipt} disabled={Boolean(busy)} />
          </label>
          {compressNote ? <div className="my-duty-compress">{compressNote}</div> : null}
          {receipt?.previewUrl ? (
            <div className="my-duty-preview">
              <img src={receipt.previewUrl} alt="Receipt preview" />
              <span>{formatBytes(receipt.compressedBytes)} ready to upload</span>
            </div>
          ) : null}
          <button type="button" className="button-primary my-duty-primary" onClick={submitExpense} disabled={busy === "expense"}>
            {busy === "expense" ? "Submitting…" : "Submit claim"}
          </button>
        </div>
      </section>

      <section className="my-duty-card">
        <div className="panel-kicker">My claims</div>
        <h3>Recent status</h3>
        <div className="my-duty-claims">
          {claims.map((item) => (
            <article key={item.id} className="my-duty-claim">
              <div className="my-duty-claim-top">
                <strong>{item.category}</strong>
                <span>{String(item.status || "").replace(/_/g, " ")}</span>
              </div>
              <p>{item.purpose}</p>
              <div className="my-duty-claim-meta">
                <span>INR {money(item.amount)}</span>
                {item.reference_no ? <span>Ref {item.reference_no}</span> : null}
                {item.has_receipt ? (
                  <a href={`/hr/self/expenses/${item.id}/receipt`} target="_blank" rel="noreferrer">
                    Receipt
                  </a>
                ) : null}
              </div>
            </article>
          ))}
          {!loading && !claims.length ? <p className="my-duty-muted">No claims yet.</p> : null}
        </div>
      </section>
    </div>
  );
}
