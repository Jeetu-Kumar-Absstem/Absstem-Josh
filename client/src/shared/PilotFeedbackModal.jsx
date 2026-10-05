import { useEffect, useState } from "react";
import { toast } from "./joshUi";
import { compressReceiptImage, formatBytes } from "../hr/compressImage";

const NOTE_TYPES = [
  { value: "blocked", label: "Blocked", hint: "Cannot finish the task" },
  { value: "confusing", label: "Confusing", hint: "Unclear where to go or what to do" },
  { value: "suggestion", label: "Suggestion", hint: "Could be simpler or faster" },
];

async function apiFetch(path, options = {}) {
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  const res = await fetch(path, {
    credentials: "include",
    ...options,
    headers: isForm ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export default function PilotFeedbackModal({
  open,
  onClose,
  deskPage = "home",
  deskLabel = "",
  companyCode = "",
  initialNoteType = null,
  initialNoteBody = "",
}) {
  const [noteType, setNoteType] = useState("blocked");
  const [noteBody, setNoteBody] = useState("");
  const [referenceNo, setReferenceNo] = useState("");
  const [screenshot, setScreenshot] = useState(null);
  const [compressNote, setCompressNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const allowed = NOTE_TYPES.some((row) => row.value === initialNoteType) ? initialNoteType : "blocked";
    setNoteType(allowed);
    setNoteBody(typeof initialNoteBody === "string" ? initialNoteBody : "");
    setReferenceNo("");
    setBusy(false);
    setError("");
    setCompressNote("");
    setScreenshot((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  }, [open, deskPage, initialNoteType, initialNoteBody]);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === "Escape" && !busy) onClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  useEffect(() => {
    return () => {
      if (screenshot?.previewUrl) URL.revokeObjectURL(screenshot.previewUrl);
    };
  }, [screenshot]);

  if (!open) return null;

  async function onPickScreenshot(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setCompressNote("Compressing screenshot…");
    setError("");
    try {
      if (screenshot?.previewUrl) URL.revokeObjectURL(screenshot.previewUrl);
      const result = await compressReceiptImage(file);
      setScreenshot(result);
      setCompressNote(result.label);
    } catch (err) {
      setScreenshot(null);
      if (err?.code === "HEIC_UNSUPPORTED") {
        setError("This iPhone photo format could not be converted. Use Most Compatible / JPEG / PNG.");
      } else if (err?.code === "IMAGE_DECODE_FAILED") {
        setError("Could not read that image. Try JPEG or PNG.");
      } else if (err?.code === "STILL_TOO_LARGE") {
        setError("Screenshot is still too large after compression. Crop tighter and try again.");
      } else {
        setError("Could not prepare the screenshot.");
      }
      setCompressNote("");
    }
  }

  function clearScreenshot() {
    if (screenshot?.previewUrl) URL.revokeObjectURL(screenshot.previewUrl);
    setScreenshot(null);
    setCompressNote("");
  }

  async function submit(e) {
    e.preventDefault();
    const body = noteBody.trim();
    if (body.length < 3) {
      setError("Write a short note about what you tried.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("note_type", noteType);
      form.append("desk_page", deskPage);
      form.append("desk_label", deskLabel || deskPage);
      if (companyCode) form.append("company_code", companyCode);
      if (referenceNo.trim()) form.append("reference_no", referenceNo.trim());
      form.append("note_body", body);
      if (screenshot?.file) form.append("screenshot", screenshot.file, "screenshot.jpg");

      await apiFetch("/hr/pilot-feedback", {
        method: "POST",
        body: form,
      });
      toast("Note sent to the pilot queue.", "success");
      onClose?.();
    } catch (err) {
      const code = err?.data?.error || (err?.status ? `HTTP ${err.status}` : "");
      setError(code ? `Could not send note (${code}). Try again.` : "Could not send note. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pilot-feedback-overlay" role="presentation" onClick={() => (!busy ? onClose?.() : null)}>
      <div
        className="pilot-feedback-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pilot-feedback-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pilot-feedback-head">
          <div>
            <div className="panel-kicker">Pilot note</div>
            <h3 id="pilot-feedback-title">Send a live note</h3>
            <p>
              From <strong>{deskLabel || deskPage}</strong>
              {companyCode ? <> · {companyCode}</> : null}. Access problems still go by reply-all on the welcome mail.
            </p>
          </div>
          <button type="button" className="button-ghost compact-button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        <form className="pilot-feedback-form" onSubmit={submit}>
          <fieldset className="pilot-feedback-types" disabled={busy}>
            <legend>What kind of note?</legend>
            <div className="pilot-feedback-type-row">
              {NOTE_TYPES.map((item) => (
                <label key={item.value} className={`pilot-feedback-type ${noteType === item.value ? "is-active" : ""}`}>
                  <input
                    type="radio"
                    name="pilot-note-type"
                    value={item.value}
                    checked={noteType === item.value}
                    onChange={() => setNoteType(item.value)}
                  />
                  <strong>{item.label}</strong>
                  <span>{item.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="pilot-feedback-field">
            <span>What happened?</span>
            <textarea
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              rows={5}
              maxLength={4000}
              placeholder="What you tried, what blocked you, or what should be simpler."
              disabled={busy}
              required
            />
          </label>

          <label className="pilot-feedback-field">
            <span>Doc / quote / PO no. (optional)</span>
            <input
              type="text"
              value={referenceNo}
              onChange={(e) => setReferenceNo(e.target.value)}
              maxLength={120}
              placeholder="e.g. Q-1042 or PO-883"
              disabled={busy}
            />
          </label>

          <label className="pilot-feedback-field">
            <span>Screenshot (optional)</span>
            <input
              type="file"
              accept="image/*,.heic,.heif"
              capture="environment"
              onChange={onPickScreenshot}
              disabled={busy}
            />
          </label>
          {compressNote ? <div className="pilot-feedback-compress">{compressNote}</div> : null}
          {screenshot?.previewUrl ? (
            <div className="pilot-feedback-preview">
              <img src={screenshot.previewUrl} alt="Screenshot preview" />
              <div className="pilot-feedback-preview-meta">
                <span>{formatBytes(screenshot.compressedBytes)} ready</span>
                <button type="button" className="button-ghost compact-button" onClick={clearScreenshot} disabled={busy}>
                  Remove
                </button>
              </div>
            </div>
          ) : null}

          {error ? <div className="pilot-feedback-error">{error}</div> : null}

          <div className="pilot-feedback-actions">
            <button type="button" className="button-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="button-primary" disabled={busy}>
              {busy ? "Sending…" : "Send note"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
