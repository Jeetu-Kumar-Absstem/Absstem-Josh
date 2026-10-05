import { useEffect, useMemo, useState } from "react";
import { toast } from "../shared/joshUi";
import { apiFetch } from "./quoteShared";

const COVER_ERRORS = {
  COVER_USER_REQUIRED: "Pick who will cover.",
  COVER_SAME_USER: "A person cannot cover their own quotes.",
  COVER_DATES_REQUIRED: "Pick a start and end date.",
  COVER_DATES_INVALID: "The end date must be on or after the start date.",
  COVER_USER_INACTIVE: "The selected colleague is inactive.",
  FORBIDDEN: "You can only set cover for yourself or your own team.",
};

const OWNER_ERRORS = {
  OWNER_REQUIRED: "Pick the new owner.",
  OWNER_UNCHANGED: "That person already owns this quote.",
  OWNER_INACTIVE: "The selected person is inactive.",
};

function errorText(e, map, fallback) {
  const code = e?.data?.error;
  if (code === "COVER_OVERLAP") {
    const x = e.data.existing;
    return x
      ? `${x.to_user_name} already covers ${String(x.start_date).slice(0, 10)} to ${String(x.end_date).slice(0, 10)}. Cancel that cover first or pick other dates.`
      : "An overlapping cover already exists.";
  }
  return e?.data?.detail || map[code] || code || fallback;
}

const dateOnly = (v) => String(v || "").slice(0, 10);

function Modal({ title, subtitle, onClose, children, width = 560 }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(17, 28, 49, 0.42)", display: "grid", placeItems: "center", zIndex: 40, padding: 16 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: `min(${width}px, 100%)`,
          maxHeight: "90vh",
          overflowY: "auto",
          background: "#fff",
          borderRadius: 16,
          padding: 18,
          boxShadow: "0 24px 48px rgba(17,28,49,0.22)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.55 }}>{subtitle}</div>
            <h3 style={{ margin: "6px 0 12px" }}>{title}</h3>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CoverRow({ row, meId, onCancel, busy }) {
  const mine = Number(row.from_user_id) === Number(meId);
  const label = mine
    ? `${row.to_user_name} covers you`
    : Number(row.to_user_id) === Number(meId)
      ? `You cover ${row.from_user_name}`
      : `${row.to_user_name} covers ${row.from_user_name}`;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 10px", border: "1px solid #e7ebf3", borderRadius: 10, alignItems: "center" }}>
      <div style={{ fontSize: 13 }}>
        <div style={{ fontWeight: 700 }}>
          {label}
          {row.is_active_today ? <span style={{ marginLeft: 8, color: "#0b6b38", fontSize: 11 }}>ACTIVE NOW</span> : null}
        </div>
        <div style={{ opacity: 0.7, fontSize: 12 }}>
          {dateOnly(row.start_date)} to {dateOnly(row.end_date)}
          {row.note ? ` · ${row.note}` : ""}
        </div>
      </div>
      <button type="button" disabled={busy} onClick={() => onCancel(row)}>
        Cancel
      </button>
    </div>
  );
}

export function QuoteCoverDialog({ me, onClose, onChanged }) {
  const meId = Number(me?.id);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ from_user_id: String(meId || ""), to_user_id: "", start_date: "", end_date: "", note: "", hr_leave_request_id: null });

  async function load() {
    try {
      setData(await apiFetch("/quotes/covers"));
    } catch (e) {
      setError(errorText(e, COVER_ERRORS, "Could not load cover details."));
    }
  }

  useEffect(() => {
    load();
  }, []);

  const fromOptions = useMemo(() => {
    const list = Array.isArray(data?.reportees) && data.reportees.length ? data.reportees : [{ id: meId, full_name: me?.full_name || "Me" }];
    return list;
  }, [data, meId, me]);

  const toOptions = useMemo(() => {
    const colleagues = Array.isArray(data?.colleagues) ? data.colleagues : [];
    const fromId = Number(form.from_user_id);
    const list = colleagues.filter((c) => Number(c.id) !== fromId);
    if (fromId !== meId && !list.some((c) => Number(c.id) === meId)) list.unshift({ id: meId, full_name: `${me?.full_name || "Me"} (me)` });
    return list;
  }, [data, form.from_user_id, meId, me]);

  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiFetch("/quotes/covers", {
        method: "POST",
        body: JSON.stringify({ ...form, from_user_id: Number(form.from_user_id), to_user_id: Number(form.to_user_id) }),
      });
      toast("Cover saved. Both people were notified.", "success");
      setForm((prev) => ({ ...prev, to_user_id: "", start_date: "", end_date: "", note: "", hr_leave_request_id: null }));
      await load();
      onChanged?.();
    } catch (e) {
      setError(errorText(e, COVER_ERRORS, "Could not save the cover."));
    } finally {
      setBusy(false);
    }
  }

  async function cancelCover(row) {
    if (!window.confirm("Cancel this cover? The other person will be notified.")) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/quotes/covers/${row.id}`, { method: "DELETE" });
      await load();
      onChanged?.();
    } catch (e) {
      setError(errorText(e, COVER_ERRORS, "Could not cancel the cover."));
    } finally {
      setBusy(false);
    }
  }

  const allCovers = [...(data?.given || []), ...(data?.received || []), ...(data?.team || [])].filter(
    (row, i, arr) => arr.findIndex((x) => x.id === row.id) === i
  );

  return (
    <Modal title="Leave cover for quotes" subtitle="Quotes" onClose={onClose}>
      <div style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.6, marginBottom: 12 }}>
        While someone is away, the person covering can open, send and approve their quotes (and their team's). The cover ends by itself on the end date.
      </div>
      {error ? <div style={{ color: "#b00020", marginBottom: 10 }}>{error}</div> : null}

      {(data?.leave_suggestions || []).length ? (
        <div style={{ padding: 10, borderRadius: 12, background: "#fff9ec", border: "1px solid #f2dfb0", marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>You have approved leave without a cover</div>
          {data.leave_suggestions.map((lv) => (
            <button
              key={lv.id}
              type="button"
              style={{ marginRight: 6, marginBottom: 4 }}
              onClick={() =>
                setForm((prev) => ({
                  ...prev,
                  from_user_id: String(meId),
                  start_date: dateOnly(lv.start_date),
                  end_date: dateOnly(lv.end_date),
                  hr_leave_request_id: lv.id,
                  note: prev.note || `${lv.leave_type || "Leave"}`,
                }))
              }
            >
              Use {dateOnly(lv.start_date)} to {dateOnly(lv.end_date)}
            </button>
          ))}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          Person away
          <select value={form.from_user_id} onChange={(e) => set("from_user_id", e.target.value)} disabled={fromOptions.length <= 1}>
            {fromOptions.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {Number(u.id) === meId ? `${u.full_name} (me)` : u.full_name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          Covered by
          <select value={form.to_user_id} onChange={(e) => set("to_user_id", e.target.value)}>
            <option value="">Select colleague</option>
            {toOptions.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.full_name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          From
          <input type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          To
          <input type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12, gridColumn: "1 / -1" }}>
          Note (optional)
          <input value={form.note} onChange={(e) => set("note", e.target.value)} maxLength={500} />
        </label>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
        <button type="button" className="button-primary" disabled={busy || !form.to_user_id || !form.start_date || !form.end_date} onClick={save}>
          {busy ? "Saving…" : "Set cover"}
        </button>
      </div>

      <div style={{ marginTop: 16, fontWeight: 700, fontSize: 13 }}>Current and upcoming covers</div>
      <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
        {allCovers.length ? (
          allCovers.map((row) => <CoverRow key={row.id} row={row} meId={meId} onCancel={cancelCover} busy={busy} />)
        ) : (
          <div style={{ fontSize: 12, opacity: 0.65 }}>No covers set.</div>
        )}
      </div>
    </Modal>
  );
}

export function QuoteReassignDialog({ quote, members, onClose, onDone }) {
  const [toUserId, setToUserId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options = (members || []).filter((m) => Number(m.id) !== Number(quote?.owner_user_id));

  async function save() {
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${quote.id}/owner`, {
        method: "POST",
        body: JSON.stringify({ to_user_id: Number(toUserId), reason }),
      });
      toast(`${quote.quote_number} now belongs to ${data?.owner_name || "the new owner"}.`, "success");
      onDone?.(data);
    } catch (e) {
      setError(errorText(e, OWNER_ERRORS, "Could not reassign the quote."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={quote?.quote_number || "Reassign quote"} subtitle="Reassign owner" onClose={onClose} width={440}>
      <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}>
        Current owner: <strong>{quote?.owner_name || "Unassigned"}</strong>. The old and new owner are both notified.
      </div>
      {error ? <div style={{ color: "#b00020", marginBottom: 10 }}>{error}</div> : null}
      <label style={{ display: "grid", gap: 4, fontSize: 12, marginBottom: 10 }}>
        New owner
        <select value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
          <option value="">Select person</option>
          {options.map((m) => (
            <option key={m.id} value={String(m.id)}>
              {m.full_name}
              {m.designation ? ` · ${m.designation}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
        Reason (optional)
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} style={{ resize: "vertical" }} />
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="button-primary" onClick={save} disabled={busy || !toUserId}>
          {busy ? "Reassigning…" : "Reassign"}
        </button>
      </div>
    </Modal>
  );
}
