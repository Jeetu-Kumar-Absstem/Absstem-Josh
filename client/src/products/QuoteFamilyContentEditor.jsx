import React, { useEffect, useMemo, useState } from "react";

function effectiveEntry(family) {
  const builtIn = family?.built_in || {};
  const saved = family?.saved || {};
  const pickText = (field) => (String(saved[field] || "").trim() ? saved[field] : builtIn[field] || "");
  const pickList = (field) => (Array.isArray(saved[field]) && saved[field].length ? saved[field] : builtIn[field] || []);
  return {
    title: pickText("title"),
    tagline: pickText("tagline"),
    source_url: pickText("source_url"),
    write_up: pickText("write_up"),
    unique_features: pickList("unique_features"),
    design_rows: pickList("design_rows"),
  };
}

function toForm(entry) {
  return {
    title: entry.title || "",
    tagline: entry.tagline || "",
    source_url: entry.source_url || "",
    write_up: entry.write_up || "",
    features_text: (entry.unique_features || []).join("\n"),
    design_text: (entry.design_rows || []).map((row) => `${row.label} | ${row.value}`).join("\n"),
  };
}

function fromForm(form) {
  return {
    title: form.title,
    tagline: form.tagline,
    source_url: form.source_url,
    write_up: form.write_up,
    unique_features: form.features_text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean),
    design_rows: form.design_text
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("|");
        if (idx < 0) return null;
        return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
      })
      .filter((row) => row && row.label && row.value),
  };
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    const code = data?.error || `HTTP_${res.status}`;
    const err = new Error(code);
    err.code = code;
    throw err;
  }
  return data;
}

function errorText(code) {
  if (code === "FORBIDDEN" || code === "HTTP_403") return "Only Marketing or an administrator can change quote write-ups.";
  if (code === "MIGRATION_PENDING") return "The database update for write-ups has not been applied yet.";
  return `Could not save (${code}).`;
}

export default function QuoteFamilyContentEditor() {
  const [families, setFamilies] = useState([]);
  const [canEdit, setCanEdit] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load(keepKey) {
    setLoading(true);
    setError("");
    try {
      const data = await requestJson("/quotes/family-content");
      const list = Array.isArray(data.families) ? data.families : [];
      setFamilies(list);
      setCanEdit(data.can_edit === true);
      const key = keepKey && list.some((f) => f.content_key === keepKey) ? keepKey : list[0]?.content_key || "";
      setSelectedKey(key);
      const fam = list.find((f) => f.content_key === key);
      setForm(fam ? toForm(effectiveEntry(fam)) : null);
    } catch (e) {
      setError(`Could not load write-ups (${e.code || e.message}).`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const selected = useMemo(() => families.find((f) => f.content_key === selectedKey) || null, [families, selectedKey]);

  function selectFamily(key) {
    setSelectedKey(key);
    setMessage("");
    setError("");
    const fam = families.find((f) => f.content_key === key);
    setForm(fam ? toForm(effectiveEntry(fam)) : null);
  }

  async function save() {
    if (!selectedKey || !form) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await requestJson(`/quotes/family-content/${encodeURIComponent(selectedKey)}`, {
        method: "PUT",
        body: JSON.stringify(fromForm(form)),
      });
      await load(selectedKey);
      setMessage("Saved. New quote PDFs will use this text.");
    } catch (e) {
      setError(errorText(e.code || e.message));
    } finally {
      setBusy(false);
    }
  }

  async function resetToBuiltIn() {
    if (!selectedKey) return;
    if (!window.confirm("Discard the edited text and go back to the standard write-up for this family?")) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await requestJson(`/quotes/family-content/${encodeURIComponent(selectedKey)}`, { method: "DELETE" });
      await load(selectedKey);
      setMessage("Reset to the standard write-up.");
    } catch (e) {
      setError(errorText(e.code || e.message));
    } finally {
      setBusy(false);
    }
  }

  const field = (key, props = {}) => ({
    value: form?.[key] ?? "",
    onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
    disabled: busy,
    readOnly: !canEdit,
    style: { width: "100%", boxSizing: "border-box" },
    ...props,
  });

  const labelStyle = { fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 4, display: "block" };

  if (loading) return <div style={{ padding: 16 }}>Loading write-ups…</div>;

  return (
    <div style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
        This text appears on the technical pages of quote PDFs for each product family. Technical numbers for the quoted model
        always come from the product's Product Master captions: if a parameter below has the same name as a caption, the PDF
        shows the caption value and hides this row.
      </div>
      {!canEdit ? (
        <div style={{ fontSize: 12, color: "#9a5a00", background: "#fff7ea", border: "1px solid #f0d9a8", borderRadius: 8, padding: "8px 10px" }}>
          View only. Marketing or an administrator maintains this text.
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select value={selectedKey} onChange={(e) => selectFamily(e.target.value)} disabled={busy} className="pd-select">
          {families.map((f) => (
            <option key={f.content_key} value={f.content_key}>
              {f.family_name} ({f.content_key}){f.saved ? " • edited" : ""}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: selected?.saved ? "#9a5a00" : "#136b3c" }}>
          {selected?.saved
            ? `Edited text in use${selected.saved.updated_at ? ` (last saved ${new Date(selected.saved.updated_at).toLocaleString("en-IN")})` : ""}`
            : "Standard write-up in use"}
        </span>
      </div>

      {form ? (
        <>
          <div>
            <label style={labelStyle}>Title</label>
            <input type="text" {...field("title")} />
          </div>
          <div>
            <label style={labelStyle}>Tagline</label>
            <input type="text" {...field("tagline")} />
          </div>
          <div>
            <label style={labelStyle}>Website page (reference for the wording; not fetched when PDFs are made)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="url" {...field("source_url")} />
              {form.source_url ? (
                <a href={form.source_url} target="_blank" rel="noopener noreferrer" className="pd-btn secondary" style={{ whiteSpace: "nowrap" }}>
                  Open page
                </a>
              ) : null}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Write-up</label>
            <textarea rows={7} {...field("write_up")} />
          </div>
          <div>
            <label style={labelStyle}>Unique features (one per line)</label>
            <textarea rows={7} {...field("features_text")} />
          </div>
          <div>
            <label style={labelStyle}>Design parameters (one per line, as "Parameter | Value")</label>
            <textarea rows={8} {...field("design_text")} style={{ width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 12 }} />
          </div>

          {error ? <div style={{ color: "#9f2042", fontSize: 13 }}>{error}</div> : null}
          {message ? <div style={{ color: "#136b3c", fontSize: 13 }}>{message}</div> : null}

          {canEdit ? (
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="pd-btn" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save write-up"}
            </button>
            <button type="button" className="pd-btn secondary" onClick={resetToBuiltIn} disabled={busy || !selected?.saved}>
              Reset to standard
            </button>
          </div>
          ) : null}
        </>
      ) : (
        <div>{error || "No families found."}</div>
      )}
    </div>
  );
}
