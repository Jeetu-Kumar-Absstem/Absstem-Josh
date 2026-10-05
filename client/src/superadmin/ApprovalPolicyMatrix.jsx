import { useEffect, useMemo, useState } from "react";

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

function emptyForm() {
  return {
    id: null,
    doc_type: "purchase_order",
    level_no: "1",
    role_id: "",
    group_id: "",
    user_id: "",
    user_label: "",
    vendor_id: "",
    min_amount: "0",
    max_amount: "",
    remarks: "",
    is_active: true,
  };
}

function fmtMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function userScopeLabel(row) {
  if (!row?.user_id) return "";
  return row.user_full_name || row.user_name || `User #${row.user_id}`;
}

function scopeLabel(row) {
  const parts = [];
  const userLabel = userScopeLabel(row);
  if (userLabel) parts.push(`User: ${userLabel}`);
  if (row.group_name) parts.push(row.group_name);
  if (row.role_name) parts.push(row.role_name);
  return parts.length ? parts.join(" / ") : "—";
}

function amountNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function amountCeiling(value) {
  if (value === null || value === undefined || value === "") return Number.POSITIVE_INFINITY;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function buildOverlapWarnings(policies) {
  const buckets = new Map();
  policies
    .filter((row) => row?.is_active !== false)
    .forEach((row) => {
      const key = [
        row.doc_type || "",
        String(row.level_no || 1),
        String(row.vendor_id || ""),
        String(row.user_id || ""),
        String(row.group_id || ""),
        String(row.role_id || ""),
      ].join("::");
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    });

  const warnings = [];
  buckets.forEach((items) => {
    const sorted = [...items].sort((a, b) => amountNumber(a.min_amount) - amountNumber(b.min_amount));
    for (let index = 1; index < sorted.length; index += 1) {
      const prev = sorted[index - 1];
      const current = sorted[index];
      if (amountNumber(current.min_amount) <= amountCeiling(prev.max_amount)) {
        warnings.push({
          key: `${prev.id}-${current.id}`,
          doc_type: current.doc_type,
          ids: [prev.id, current.id],
          detail: `${scopeLabel(current)} overlaps between ${fmtMoney(prev.min_amount)}-${prev.max_amount === null ? "No limit" : fmtMoney(
            prev.max_amount
          )} and ${fmtMoney(current.min_amount)}-${current.max_amount === null ? "No limit" : fmtMoney(current.max_amount)}.`,
        });
      }
    }
  });
  return warnings;
}

function SurfaceCard({ title, subtitle, actions, children }) {
  return (
    <div
      style={{
        border: "1px solid #dfe5ef",
        borderRadius: 22,
        padding: 18,
        background: "#fff",
        boxShadow: "0 16px 38px rgba(25, 37, 61, 0.07)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 13, opacity: 0.74, lineHeight: 1.6, marginTop: 6 }}>{subtitle}</div> : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, value, note, accent }) {
  return (
    <div
      style={{
        border: "1px solid #dfe5ef",
        borderRadius: 18,
        padding: 14,
        background: "#fff",
        boxShadow: "0 12px 28px rgba(15, 23, 42, 0.06)",
        borderTop: `4px solid ${accent}`,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>{note}</div>
    </div>
  );
}

function HeaderChip({ label, tone = "#5f6f86", background = "rgba(0, 80, 158, 0.08)" }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 28,
        padding: "4px 10px",
        borderRadius: 999,
        background,
        color: tone,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

function DocTypeButton({ active, label, count, note, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        borderRadius: 18,
        padding: "14px 16px",
        border: active ? "1px solid #96b5ff" : "1px solid #dfe5ef",
        background: active ? "linear-gradient(180deg, #eef4ff 0%, #f8fbff 100%)" : "#fff",
        boxShadow: active ? "0 12px 28px rgba(31, 94, 255, 0.12)" : "0 10px 22px rgba(15, 23, 42, 0.05)",
        display: "grid",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 14 }}>{label}</strong>
      <span style={{ fontSize: 12, opacity: 0.72 }}>{count} rules</span>
      <span style={{ fontSize: 12, opacity: 0.68 }}>{note}</span>
    </button>
  );
}

function FocusActionCard({ title, note, tone, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        borderRadius: 18,
        padding: 14,
        border: active ? `1px solid ${tone}` : "1px solid #dfe5ef",
        background: active ? "rgba(31, 94, 255, 0.06)" : "#fff",
        boxShadow: active ? "0 12px 28px rgba(31, 94, 255, 0.12)" : "0 10px 22px rgba(15, 23, 42, 0.05)",
        display: "grid",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 14, color: tone }}>{title}</strong>
      <span style={{ fontSize: 12, opacity: 0.74, lineHeight: 1.5 }}>{note}</span>
    </button>
  );
}

function PolicyBadge({ label, tone, background }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        color: tone,
        background,
      }}
    >
      {label}
    </span>
  );
}

export default function ApprovalPolicyMatrix({ launch, onConsumeLaunch }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeDocType, setActiveDocType] = useState("all");
  const [policyQuery, setPolicyQuery] = useState("");
  const [focusMode, setFocusMode] = useState("all");
  const [bootstrap, setBootstrap] = useState({
    roles: [],
    groups: [],
    vendors: [],
    doc_types: [],
  });
  const [policies, setPolicies] = useState([]);
  const [form, setForm] = useState(emptyForm());

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/approval-policies/bootstrap");
      setBootstrap({
        roles: Array.isArray(data?.roles) ? data.roles : [],
        groups: Array.isArray(data?.groups) ? data.groups : [],
        vendors: Array.isArray(data?.vendors) ? data.vendors : [],
        doc_types: Array.isArray(data?.doc_types) ? data.doc_types : [],
      });
      setPolicies(Array.isArray(data?.approval_policies) ? data.approval_policies : []);
    } catch (e) {
      setError(e?.data?.error || "Failed to load Approval Policy Matrix.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData().catch(() => {});
  }, []);

  useEffect(() => {
    if (!launch) return;
    if (launch.docType) {
      setActiveDocType(String(launch.docType));
    }
    if (launch.query) {
      setPolicyQuery(String(launch.query));
    }
    onConsumeLaunch?.();
  }, [launch, onConsumeLaunch]);

  const groupedPolicies = useMemo(() => {
    return bootstrap.doc_types.map((docType) => ({
      ...docType,
      items: policies.filter((row) => row.doc_type === docType.key),
      activeCount: policies.filter((row) => row.doc_type === docType.key && row.is_active).length,
      inactiveCount: policies.filter((row) => row.doc_type === docType.key && !row.is_active).length,
      openEndedCount: policies.filter((row) => row.doc_type === docType.key && (row.max_amount === null || row.max_amount === "")).length,
    }));
  }, [bootstrap.doc_types, policies]);

  const overlapWarnings = useMemo(() => buildOverlapWarnings(policies), [policies]);
  const overlapPolicyIds = useMemo(
    () => new Set(overlapWarnings.flatMap((item) => item.ids.map((id) => String(id)))),
    [overlapWarnings]
  );
  const inactivePolicies = useMemo(() => policies.filter((row) => !row.is_active), [policies]);
  const openEndedPolicies = useMemo(
    () => policies.filter((row) => row.max_amount === null || row.max_amount === ""),
    [policies]
  );
  const vendorScopedPolicies = useMemo(() => policies.filter((row) => row.vendor_id), [policies]);

  const filteredPolicies = useMemo(() => {
    const q = policyQuery.trim().toLowerCase();
    return policies.filter((row) => {
      if (activeDocType !== "all" && row.doc_type !== activeDocType) return false;
      if (focusMode === "inactive" && row.is_active) return false;
      if (focusMode === "open_ended" && !(row.max_amount === null || row.max_amount === "")) return false;
      if (focusMode === "vendor_scoped" && !row.vendor_id) return false;
      if (focusMode === "overlap" && !overlapPolicyIds.has(String(row.id))) return false;
      if (!q) return true;
      return [row.vendor_name, row.group_name, row.role_name, row.remarks, row.doc_type]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [policies, activeDocType, focusMode, overlapPolicyIds, policyQuery]);

  const filteredGroupedPolicies = useMemo(() => {
    return bootstrap.doc_types
      .map((docType) => ({
        ...docType,
        items: filteredPolicies.filter((row) => row.doc_type === docType.key),
      }))
      .filter((group) => activeDocType === "all" || group.key === activeDocType);
  }, [bootstrap.doc_types, filteredPolicies, activeDocType]);
  const uncoveredDocTypes = useMemo(() => {
    const covered = new Set(policies.filter((item) => item?.is_active !== false).map((item) => String(item.doc_type || "")));
    return bootstrap.doc_types.filter((item) => !covered.has(String(item.key)));
  }, [bootstrap.doc_types, policies]);
  const headerChips = [
    uncoveredDocTypes.length
      ? { label: `${uncoveredDocTypes.length} doc types uncovered`, tone: "#b45309", background: "rgba(217, 119, 6, 0.12)" }
      : { label: "All doc types covered", tone: "#14804a", background: "rgba(20, 128, 74, 0.1)" },
    activeDocType !== "all"
      ? { label: `Focused on ${bootstrap.doc_types.find((item) => item.key === activeDocType)?.label || activeDocType}`, tone: "#1f5eff", background: "rgba(31, 94, 255, 0.1)" }
      : null,
    uncoveredDocTypes[0]
      ? { label: `Next missing: ${uncoveredDocTypes[0].label}`, tone: "#7c3aed", background: "rgba(124, 58, 237, 0.1)" }
      : null,
    focusMode !== "all"
      ? {
          label: `Reviewing ${focusMode.replace("_", " ")}`,
          tone: "#9f2042",
          background: "rgba(159, 32, 66, 0.1)",
        }
      : null,
  ].filter(Boolean);

  const stats = useMemo(() => {
    return [
      { label: "Policies", value: policies.length, note: "total approval rules", accent: "#1f5eff" },
      { label: "Uncovered", value: uncoveredDocTypes.length, note: "document types with no active rule", accent: uncoveredDocTypes.length ? "#d97706" : "#14804a" },
      { label: "Inactive", value: inactivePolicies.length, note: "rules that can likely be retired", accent: inactivePolicies.length ? "#8b5cf6" : "#14804a" },
      { label: "Overlap alerts", value: overlapWarnings.length, note: "active bands that may conflict", accent: overlapWarnings.length ? "#b00020" : "#14804a" },
    ];
  }, [inactivePolicies.length, overlapWarnings.length, policies.length, uncoveredDocTypes.length]);

  const editorGuidance = useMemo(() => {
    if (!form.role_id && !form.group_id && !form.user_id) {
      return {
        tone: "#8b5a00",
        background: "#fff9ec",
        border: "#f2dfb0",
        message: "Pick at least a role or a group so the approval lane is explicit before you save.",
      };
    }
    if (form.max_amount !== "" && amountNumber(form.max_amount, -1) < amountNumber(form.min_amount, 0)) {
      return {
        tone: "#b00020",
        background: "#fff3f3",
        border: "#ffd8d8",
        message: "The amount band is inverted. Max amount must stay greater than or equal to min amount.",
      };
    }
    if (!form.vendor_id && form.max_amount === "") {
      return {
        tone: "#234a8f",
        background: "#eef4ff",
        border: "#d9e6ff",
        message: "This becomes a broad fallback band for all vendors with no ceiling. Use it only when narrower bands are already defined.",
      };
    }
    if (form.vendor_id) {
      return {
        tone: "#234a8f",
        background: "#eef4ff",
        border: "#d9e6ff",
        message: "Vendor-specific routing is active, so this rule only applies to the selected supplier.",
      };
    }
    return {
      tone: "#234a8f",
      background: "#eef4ff",
      border: "#d9e6ff",
      message: "Keep levels and amount bands sequential to avoid conflicting approver routes in the same scope.",
    };
  }, [form.group_id, form.max_amount, form.min_amount, form.role_id, form.user_id, form.vendor_id]);

  const focusActions = [
    {
      key: "missing",
      title: "Cover missing doc types",
      note: uncoveredDocTypes.length
        ? `${uncoveredDocTypes.length} document types still have no active routing. Start with ${uncoveredDocTypes[0]?.label || "the next missing lane"}.`
        : "Every document type already has an active routing baseline.",
      tone: uncoveredDocTypes.length ? "#d97706" : "#14804a",
      active: false,
      onClick: () => {
        const next = uncoveredDocTypes[0];
        setFocusMode("all");
        if (next) {
          setActiveDocType(next.key);
          setField("doc_type", next.key);
        }
      },
    },
    {
      key: "inactive",
      title: "Retire inactive rules",
      note: inactivePolicies.length
        ? `${inactivePolicies.length} inactive rows are still cluttering review. Filter them and decide what should be deleted or reactivated.`
        : "No inactive rows are diluting the review queue right now.",
      tone: inactivePolicies.length ? "#8b5cf6" : "#14804a",
      active: focusMode === "inactive",
      onClick: () => setFocusMode((prev) => (prev === "inactive" ? "all" : "inactive")),
    },
    {
      key: "open-ended",
      title: "Review open-ended bands",
      note: openEndedPolicies.length
        ? `${openEndedPolicies.length} rules have no upper limit. Confirm they are intended as the final fallback band.`
        : "No open-ended amount bands need review.",
      tone: openEndedPolicies.length ? "#234a8f" : "#14804a",
      active: focusMode === "open_ended",
      onClick: () => setFocusMode((prev) => (prev === "open_ended" ? "all" : "open_ended")),
    },
    {
      key: "overlap",
      title: "Investigate overlaps",
      note: overlapWarnings.length
        ? `${overlapWarnings.length} active band conflicts need cleanup before approval traffic increases.`
        : "No active overlaps detected in matching approval scopes.",
      tone: overlapWarnings.length ? "#b00020" : "#14804a",
      active: focusMode === "overlap",
      onClick: () => setFocusMode((prev) => (prev === "overlap" ? "all" : "overlap")),
    },
  ];

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function editPolicy(row) {
    setForm({
      id: row.id,
      doc_type: row.doc_type || "purchase_order",
      level_no: String(row.level_no || 1),
      role_id: row.role_id ? String(row.role_id) : "",
      group_id: row.group_id ? String(row.group_id) : "",
      user_id: row.user_id ? String(row.user_id) : "",
      user_label: userScopeLabel(row),
      vendor_id: row.vendor_id ? String(row.vendor_id) : "",
      min_amount: String(row.min_amount ?? 0),
      max_amount: row.max_amount === null || row.max_amount === undefined ? "" : String(row.max_amount),
      remarks: row.remarks || "",
      is_active: Boolean(row.is_active),
    });
    setActiveDocType(row.doc_type || "all");
    setNotice("");
    setError("");
  }

  function resetForm() {
    setForm(emptyForm());
    setNotice("");
    setError("");
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        doc_type: form.doc_type,
        level_no: Number(form.level_no || 0),
        role_id: form.role_id ? Number(form.role_id) : null,
        group_id: form.group_id ? Number(form.group_id) : null,
        user_id: form.user_id ? Number(form.user_id) : null,
        vendor_id: form.vendor_id ? Number(form.vendor_id) : null,
        min_amount: Number(form.min_amount || 0),
        max_amount: form.max_amount === "" ? null : Number(form.max_amount),
        remarks: form.remarks,
        is_active: form.is_active,
      };
      const path = form.id ? `/approval-policies/${form.id}` : "/approval-policies";
      const method = form.id ? "PUT" : "POST";
      const data = await apiFetch(path, {
        method,
        body: JSON.stringify(payload),
      });
      const saved = data?.approval_policy || null;
      await loadData();
      setNotice(`Approval policy ${form.id ? "updated" : "created"}${saved?.id ? ` (#${saved.id})` : ""}.`);
      resetForm();
    } catch (e) {
      const code = e?.data?.error;
      if (code === "APPROVER_SCOPE_REQUIRED") setError("Select at least a role or a group.");
      else if (code === "INVALID_RANGE") setError("Max amount must be greater than or equal to min amount.");
      else if (code === "INVALID_LEVEL") setError("Approval level must be 1 or more.");
      else if (code === "DUPLICATE_USER_BAND") setError(e?.data?.detail || "This user already has an active band for this level.");
      else if (code === "APPROVER_USER_INACTIVE") setError("The user on this row is inactive. Reactivate them or change the scope to a role or group.");
      else if (code === "APPROVER_USER_NOT_FOUND") setError("The user on this row no longer exists.");
      else setError(code || "Failed to save approval policy.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 1320, width: "100%", display: "grid", gap: 16 }}>
      <section
        style={{
          border: "1px solid #dfe5ef",
          borderRadius: 24,
          padding: 22,
          background: "linear-gradient(135deg, #f7fbff 0%, #ffffff 58%, #f9fbff 100%)",
          boxShadow: "0 18px 42px rgba(25, 37, 61, 0.08)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Emergency purchase-band editor</div>
            <h2 style={{ margin: "8px 0 0", fontSize: 32, lineHeight: 1.15 }}>Purchase approval bands — emergency matrix.</h2>
            <p style={{ margin: "12px 0 0", fontSize: 14, opacity: 0.76, maxWidth: 760, lineHeight: 1.7 }}>
              Use this desk when purchase document coverage or amount-band overlaps need a direct fix. Day-to-day per-user approval ceilings live in{" "}
              <strong>Org &amp; access → Financial Authority</strong>. These bands route purchase-side documents only (PO and related purchase lanes) — not sales quotes, orders, or invoices.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              {headerChips.map((chip) => (
                <HeaderChip key={chip.label} {...chip} />
              ))}
            </div>
          </div>
          <button type="button" onClick={() => loadData().catch(() => {})} disabled={loading}>
            Refresh
          </button>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14 }}>
        {stats.map((item) => (
          <StatCard key={item.label} {...item} />
        ))}
      </section>

      {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35" }}>{notice}</div> : null}

      <section style={{ display: "grid", gridTemplateColumns: "1.25fr 0.9fr", gap: 16, alignItems: "start" }}>
        <SurfaceCard title="Fix now" subtitle="Use these review lanes to move straight to the rules most likely to cause approval confusion.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {focusActions.map((item) => (
              <FocusActionCard key={item.key} {...item} />
            ))}
          </div>
        </SurfaceCard>

        <SurfaceCard title="Review rail" subtitle="Priority checks before you create or edit another band.">
          <div style={{ display: "grid", gap: 10 }}>
            {uncoveredDocTypes.length ? (
              <div style={{ border: "1px solid #f2dfb0", background: "#fff9ec", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#8b5a00", fontSize: 13 }}>Coverage gap</strong>
                <div style={{ fontSize: 12, opacity: 0.78, marginTop: 4 }}>
                  {uncoveredDocTypes.map((item) => item.label).join(", ")} still has no active approval path.
                </div>
              </div>
            ) : null}
            {overlapWarnings.slice(0, 2).map((warning) => (
              <div key={warning.key} style={{ border: "1px solid #ffd8d8", background: "#fff3f3", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#b00020", fontSize: 13 }}>Overlap alert</strong>
                <div style={{ fontSize: 12, opacity: 0.82, marginTop: 4 }}>{warning.detail}</div>
              </div>
            ))}
            {!uncoveredDocTypes.length && !overlapWarnings.length ? (
              <div style={{ border: "1px solid #d6f4df", background: "#f2fff6", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#0a7a35", fontSize: 13 }}>Governance baseline is clean</strong>
                <div style={{ fontSize: 12, opacity: 0.78, marginTop: 4 }}>
                  Coverage and band overlap checks look healthy. This is a good time to tune sequence and exception rules.
                </div>
              </div>
            ) : null}
            <div style={{ fontSize: 12, opacity: 0.72 }}>
              Vendor-scoped rules: {vendorScopedPolicies.length} • Open-ended bands: {openEndedPolicies.length}
            </div>
          </div>
        </SurfaceCard>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
        <DocTypeButton
          active={activeDocType === "all"}
          label="All Documents"
          count={policies.length}
          note={focusMode === "all" ? "See every rule in one view." : `Focused on ${focusMode.replace("_", " ")} rules.`}
          onClick={() => {
            setActiveDocType("all");
          }}
        />
        {groupedPolicies.map((group) => (
          <DocTypeButton
            key={group.key}
            active={activeDocType === group.key}
            label={group.label}
            count={group.items.length}
            note={
              group.items.length
                ? `${group.activeCount} active${group.inactiveCount ? ` • ${group.inactiveCount} inactive` : ""}`
                : "No approval rules yet."
            }
            onClick={() => {
              setActiveDocType(group.key);
              setField("doc_type", group.key);
            }}
          />
        ))}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 16, alignItems: "start" }}>
        <SurfaceCard
          title={form.id ? `Edit Policy #${form.id}` : "Create Purchase Approval Policy"}
          subtitle="Define the purchase document lane, amount band, approver scope, and optional vendor lock before saving."
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={resetForm} disabled={saving}>
                Reset
              </button>
              <button type="button" onClick={save} disabled={saving}>
                {saving ? "Saving..." : form.id ? "Update Policy" : "Create Policy"}
              </button>
            </div>
          }
        >
          <div
            style={{
              color: editorGuidance.tone,
              marginBottom: 12,
              padding: "12px 14px",
              borderRadius: 14,
              background: editorGuidance.background,
              border: `1px solid ${editorGuidance.border}`,
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {editorGuidance.message}
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Document Type
            <select value={form.doc_type} onChange={(e) => setField("doc_type", e.target.value)} style={{ height: 36 }}>
              {bootstrap.doc_types.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12, marginTop: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Level
              <input value={form.level_no} onChange={(e) => setField("level_no", e.target.value)} style={{ height: 34, padding: "0 10px" }} />
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginTop: 22 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setField("is_active", e.target.checked)} />
              Active
            </label>
          </div>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            {form.user_id ? (
              <div style={{ fontSize: 12, padding: "8px 10px", borderRadius: 10, background: "#f3efff", color: "#5b21b6" }}>
                User-specific row: <strong>{form.user_label || `User #${form.user_id}`}</strong>. Saving keeps this user; clear it only if the band should apply by role or group.{" "}
                <button type="button" onClick={() => setForm((prev) => ({ ...prev, user_id: "", user_label: "" }))} style={{ marginLeft: 6 }}>
                  Clear user
                </button>
              </div>
            ) : null}
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Role
              <select value={form.role_id} onChange={(e) => setField("role_id", e.target.value)} style={{ height: 36 }}>
                <option value="">Any role in scope</option>
                {bootstrap.roles.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.role_name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Group
              <select value={form.group_id} onChange={(e) => setField("group_id", e.target.value)} style={{ height: 36 }}>
                <option value="">Any group in scope</option>
                {bootstrap.groups.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.group_name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Vendor
              <select value={form.vendor_id} onChange={(e) => setField("vendor_id", e.target.value)} style={{ height: 36 }}>
                <option value="">All vendors</option>
                {bootstrap.vendors.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.company_name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Min Amount
              <input value={form.min_amount} onChange={(e) => setField("min_amount", e.target.value)} style={{ height: 34, padding: "0 10px" }} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Max Amount
              <input value={form.max_amount} onChange={(e) => setField("max_amount", e.target.value)} placeholder="Blank = no limit" style={{ height: 34, padding: "0 10px" }} />
            </label>
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Remarks
            <textarea value={form.remarks} onChange={(e) => setField("remarks", e.target.value)} rows={4} style={{ padding: 10 }} />
          </label>
        </SurfaceCard>

        <SurfaceCard
          title="Policy directory"
          subtitle="Filter by document type and search by vendor, role, or group to review routing quickly."
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                value={policyQuery}
                onChange={(e) => setPolicyQuery(e.target.value)}
                placeholder="Search role, group, vendor, remarks"
                style={{ minWidth: 240 }}
              />
              {focusMode !== "all" ? (
                <button type="button" onClick={() => setFocusMode("all")}>
                  Clear focus
                </button>
              ) : null}
            </div>
          }
        >
          <div style={{ display: "grid", gap: 16 }}>
            {filteredGroupedPolicies.map((group) => (
              <div key={group.key} style={{ border: "1px solid #e3e8f2", borderRadius: 18, padding: 14, background: "#fbfcff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 12 }}>
                  <div>
                    <strong>{group.label}</strong>
                    <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>
                      {group.items.length} rules in view • {group.activeCount} active • {group.openEndedCount} open-ended
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveDocType(group.key);
                      setField("doc_type", group.key);
                    }}
                  >
                    New Rule Here
                  </button>
                </div>

                {group.items.length ? (
                  <div style={{ display: "grid", gap: 10 }}>
                    {group.items.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => editPolicy(row)}
                        style={{
                          all: "unset",
                          cursor: "pointer",
                          border: "1px solid #dfe5ef",
                          borderRadius: 14,
                          padding: 14,
                          background: String(form.id) === String(row.id) ? "#eef4ff" : "#fff",
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                          <strong>L{row.level_no} • {scopeLabel(row)}</strong>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                            <PolicyBadge
                              label={row.is_active ? "Active" : "Inactive"}
                              tone={row.is_active ? "#0b7d45" : "#5d6782"}
                              background={row.is_active ? "#effcf3" : "#f5f6fa"}
                            />
                            <PolicyBadge
                              label={row.vendor_name ? "Vendor scoped" : "All vendors"}
                              tone={row.vendor_name ? "#8b5a00" : "#234a8f"}
                              background={row.vendor_name ? "#fff6e8" : "#eef4ff"}
                            />
                            <PolicyBadge
                              label={row.max_amount === null ? "No limit" : "Banded"}
                              tone={overlapPolicyIds.has(String(row.id)) ? "#b00020" : "#7c3aed"}
                              background={overlapPolicyIds.has(String(row.id)) ? "#fff3f3" : "#f3efff"}
                            />
                          </div>
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.74 }}>
                          Vendor: {row.vendor_name || "All vendors"} • Min: {fmtMoney(row.min_amount)} • Max: {row.max_amount === null ? "No limit" : fmtMoney(row.max_amount)}
                        </div>
                        {overlapPolicyIds.has(String(row.id)) ? (
                          <div style={{ fontSize: 12, color: "#b00020" }}>Potential overlap detected in this approval scope.</div>
                        ) : null}
                        {row.remarks ? <div style={{ fontSize: 12, opacity: 0.72 }}>{row.remarks}</div> : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                    {activeDocType === "all" && focusMode !== "all"
                      ? "No policies in this document type match the current review focus."
                      : "No policies for this document type yet."}
                  </div>
                )}
              </div>
            ))}
          </div>
        </SurfaceCard>
      </div>
    </div>
  );
}
