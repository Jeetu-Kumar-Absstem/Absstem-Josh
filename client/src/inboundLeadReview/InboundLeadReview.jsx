import { useEffect, useState } from "react";
import ConfirmDraftCard from "../components/ConfirmDraftCard";
import { buildInboundLeadExtractDraft } from "../shared/aiDrafts";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error("Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

export default function InboundLeadReview({ onOpenLead = null }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState("pending");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({ pending: 0, converted: 0, linked_existing: 0, ignored: 0 });
  const [linkLeadId, setLinkLeadId] = useState({});
  const [leadDraft, setLeadDraft] = useState(null);
  const [extractBusyId, setExtractBusyId] = useState(null);
  const [pasteSubject, setPasteSubject] = useState("");
  const [pasteFromName, setPasteFromName] = useState("");
  const [pasteFromEmail, setPasteFromEmail] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);

  async function loadQueue() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (query.trim()) params.set("q", query.trim());
      const data = await apiFetch(`/inbound-lead-review?${params.toString()}`);
      setItems(Array.isArray(data?.items) ? data.items : []);
      setSummary(data?.summary || { pending: 0, converted: 0, linked_existing: 0, ignored: 0 });
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load inbound lead review queue."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadQueue();
  }, [status]);

  async function draftFromItem(item) {
    if (!item?.id) return;
    setExtractBusyId(item.id);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/extraction/inbound-email", {
        method: "POST",
        body: JSON.stringify({
          inbound_email_id: item.id,
          subject: item.subject,
          from_name: item.from_name,
          from_email: item.from_email,
          body_text: item.body_preview || "",
          body_preview: item.body_preview || "",
        }),
      });
      const draft = buildInboundLeadExtractDraft({
        extraction: data.extraction,
        inboundEmailId: item.id,
        item,
      });
      if (!draft) {
        setError("Could not build a lead draft from this email.");
        return;
      }
      setLeadDraft(draft);
      setNotice(
        data.extraction?.used_slm
          ? "Extract used heuristics + mock SLM. Confirm to create the lead."
          : "Extract used heuristics. Confirm to create the lead."
      );
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to extract lead fields."));
    } finally {
      setExtractBusyId(null);
    }
  }

  async function draftFromPaste() {
    if (!pasteBody.trim() && !pasteSubject.trim()) {
      setError("Paste an email subject/body to extract.");
      return;
    }
    setPasteBusy(true);
    setError("");
    setNotice("");
    try {
      // Create a temporary inbound-like extract; for paste-only we still need an inbound id to convert.
      // So: extract for preview, then create lead via /leads if no inbound id — use confirmMode override.
      const data = await apiFetch("/extraction/inbound-email", {
        method: "POST",
        body: JSON.stringify({
          subject: pasteSubject,
          from_name: pasteFromName,
          from_email: pasteFromEmail,
          body_text: pasteBody,
        }),
      });
      const fields = data.extraction?.fields || {};
      // Paste path: confirm posts to /leads directly (no inbound queue row).
      const draft = {
        id: `extract-lead-paste-${Date.now()}`,
        intent: "inbound_lead_paste",
        title: "Draft: create lead from pasted email",
        rationale: data.extraction?.used_slm
          ? "Heuristics + mock SLM filled the lead shell from pasted email. Confirm creates the lead."
          : "Heuristics filled the lead shell from pasted email. Confirm creates the lead.",
        confidence: data.extraction?.confidence_label || "medium",
        source: data.extraction?.source || "heuristic",
        sourceLabel: data.extraction?.used_slm ? "heuristic+mock SLM" : "heuristic",
        summary: [
          { label: "Subject", value: pasteSubject || "—" },
          { label: "From", value: `${pasteFromName || "—"} <${pasteFromEmail || fields.email || "—"}>` },
          { label: "Confidence", value: `${Math.round(Number(data.extraction?.confidence || 0) * 100)}%` },
          { label: "Need", value: fields.need_summary || "—" },
        ],
        editableFields: [
          { key: "company_name", label: "Company", type: "text" },
          { key: "contact_name", label: "Contact name", type: "text" },
          { key: "email", label: "Email", type: "text" },
          { key: "phone", label: "Phone", type: "text" },
          { key: "need_summary", label: "Need / enquiry", type: "textarea", rows: 2 },
        ],
        payload: {
          company_name: fields.company_name || "",
          contact_name: fields.contact_name || "",
          email: fields.email || pasteFromEmail || "",
          phone: fields.phone || "",
          need_summary: fields.need_summary || "",
          subject: pasteSubject || "",
        },
        confirmLabel: "Confirm create lead",
        cancelLabel: "Discard",
        confirmEndpoint: "/leads",
        confirmMethod: "POST",
      };
      setLeadDraft(draft);
      setNotice("Paste extract ready — review and confirm to create the lead.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to extract pasted email."));
    } finally {
      setPasteBusy(false);
    }
  }

  async function confirmLeadDraft(data, working) {
    setLeadDraft(null);
    const leadId = data?.lead_id || data?.lead?.id;
    const leadNumber = data?.lead_number || data?.lead?.lead_number;
    setNotice(leadNumber ? `Lead ${leadNumber} created.` : "Lead created.");
    if (leadId && typeof onOpenLead === "function") onOpenLead(Number(leadId));
    setPasteSubject("");
    setPasteFromName("");
    setPasteFromEmail("");
    setPasteBody("");
    await loadQueue();
  }

  async function linkItem(itemId) {
    const leadId = Number(linkLeadId[itemId]);
    if (!Number.isFinite(leadId) || leadId <= 0) {
      setError("Enter an existing lead id to link.");
      return;
    }
    setError("");
    setNotice("");
    try {
      await apiFetch(`/inbound-lead-review/${itemId}/link`, {
        method: "POST",
        body: JSON.stringify({ lead_id: leadId }),
      });
      setNotice(`Linked to lead #${leadId}.`);
      await loadQueue();
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to link inbound email."));
    }
  }

  async function ignoreItem(itemId) {
    setError("");
    setNotice("");
    try {
      await apiFetch(`/inbound-lead-review/${itemId}/ignore`, {
        method: "POST",
        body: JSON.stringify({ notes: "Ignored from inbound review desk" }),
      });
      setNotice("Inbound email ignored.");
      await loadQueue();
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to ignore inbound email."));
    }
  }

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Inbound Lead Review</h2>
        <button type="button" onClick={loadQueue} disabled={loading}>
          Refresh
        </button>
      </div>
      <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8 }}>
        Extract → Confirm draft lead → create. Heuristics first; mock SLM only fills gaps (no paid API).
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginTop: 14 }}>
        {[
          ["pending", summary.pending],
          ["converted", summary.converted],
          ["linked_existing", summary.linked_existing],
          ["ignored", summary.ignored],
        ].map(([key, value]) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatus(key)}
            style={{
              border: status === key ? "1px solid #96b5ff" : "1px solid #e5e5e5",
              background: status === key ? "#eef4ff" : "#fff",
              borderRadius: 10,
              padding: 12,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.7, textTransform: "capitalize" }}>{key.replaceAll("_", " ")}</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search subject / from / company"
          style={{ flex: 1, minWidth: 220, padding: 10, border: "1px solid #d8d8d8", borderRadius: 6 }}
        />
        <button type="button" onClick={loadQueue} disabled={loading}>
          Search
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0b6b38", marginTop: 12 }}>{notice}</div> : null}

      {leadDraft ? (
        <div style={{ marginTop: 14 }}>
          <ConfirmDraftCard
            draft={leadDraft}
            onCancel={() => setLeadDraft(null)}
            onConfirmed={confirmLeadDraft}
            onError={(e) => setError(getApiErrorMessage(e, "Failed to create lead from draft."))}
          />
        </div>
      ) : null}

      <div style={{ marginTop: 16, padding: 14, border: "1px solid #e5e5e5", borderRadius: 12, background: "#fbfcfe", display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>Paste email → extract lead draft</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <input value={pasteSubject} onChange={(e) => setPasteSubject(e.target.value)} placeholder="Subject" style={{ padding: 8, borderRadius: 6, border: "1px solid #d8d8d8" }} />
          <input value={pasteFromName} onChange={(e) => setPasteFromName(e.target.value)} placeholder="From name" style={{ padding: 8, borderRadius: 6, border: "1px solid #d8d8d8" }} />
          <input value={pasteFromEmail} onChange={(e) => setPasteFromEmail(e.target.value)} placeholder="From email" style={{ padding: 8, borderRadius: 6, border: "1px solid #d8d8d8" }} />
        </div>
        <textarea
          rows={4}
          value={pasteBody}
          onChange={(e) => setPasteBody(e.target.value)}
          placeholder="Paste email body…"
          style={{ padding: 10, borderRadius: 6, border: "1px solid #d8d8d8", width: "100%" }}
        />
        <div>
          <button type="button" onClick={draftFromPaste} disabled={pasteBusy || Boolean(leadDraft)}>
            {pasteBusy ? "Extracting…" : "Extract paste → draft"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
        {loading ? <div>Loading…</div> : null}
        {!loading && !items.length ? <div style={{ opacity: 0.7 }}>No inbound emails match the current filters.</div> : null}
        {items.map((item) => (
          <div key={item.id} style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 12, background: "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 700 }}>{item.subject || "(no subject)"}</div>
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                  {item.from_name || "—"} &lt;{item.from_email || "—"}&gt; · {item.mailbox_key || "mailbox"}
                  {item.received_at ? ` · ${new Date(item.received_at).toLocaleString()}` : ""}
                </div>
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", opacity: 0.7 }}>{item.review_status}</div>
            </div>
            <div style={{ fontSize: 13, marginTop: 8, opacity: 0.85 }}>
              Company: {item.parse_company_name || "—"} · Contact: {item.parse_contact_name || "—"} · Phone: {item.parse_phone || "—"}
            </div>
            {item.body_preview ? (
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.78, whiteSpace: "pre-wrap" }}>{item.body_preview}</div>
            ) : null}
            {item.review_status === "pending" ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
                <button type="button" onClick={() => draftFromItem(item)} disabled={Boolean(leadDraft) || extractBusyId === item.id}>
                  {extractBusyId === item.id ? "Extracting…" : "Draft lead (extract)"}
                </button>
                <input
                  value={linkLeadId[item.id] || ""}
                  onChange={(e) => setLinkLeadId((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  placeholder="Lead id"
                  style={{ width: 110, padding: 8, border: "1px solid #d8d8d8", borderRadius: 6 }}
                />
                <button type="button" onClick={() => linkItem(item.id)}>
                  Link existing
                </button>
                <button type="button" onClick={() => ignoreItem(item.id)}>
                  Ignore
                </button>
              </div>
            ) : (
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                {item.converted_lead_number ? `Converted lead: ${item.converted_lead_number}` : null}
                {item.matched_lead_number ? `Linked lead: ${item.matched_lead_number}` : null}
                {item.converted_lead_id && typeof onOpenLead === "function" ? (
                  <button type="button" style={{ marginLeft: 8 }} onClick={() => onOpenLead(Number(item.converted_lead_id))}>
                    Open lead
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
