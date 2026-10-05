import { useCallback, useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero } from "../shared/joshUi";

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

function errMsg(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

function personLabel(u) {
  if (!u) return "";
  const name = u.full_name || u.email || `User ${u.id}`;
  return u.user_code ? `${name} (${u.user_code})` : name;
}

function fmtWhen(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16);
  return d.toLocaleString();
}

const ASSET_CATEGORIES = ["Laptop", "Phone", "Keys", "Monitor", "Peripheral", "Access_Card", "Other"];
const ASSET_STATUSES = ["Available", "Assigned", "Under_Repair", "Retired"];

const STATUS_TONE = {
  Available: { tone: "#effcf3", color: "#0b7d45" },
  Assigned: { tone: "#eef4ff", color: "#234a8f" },
  Under_Repair: { tone: "#fff6e8", color: "#8b5a00" },
  Retired: { tone: "#f3f4f6", color: "#4b5563" },
  Active: { tone: "#eef4ff", color: "#234a8f" },
  Completed: { tone: "#effcf3", color: "#0b7d45" },
};

const tabBtn = (active) => ({
  border: active ? "1px solid #96b5ff" : "1px solid #dfe5ef",
  background: active ? "#eef4ff" : "#fff",
  color: active ? "#1e3a8a" : "#334155",
  fontWeight: active ? 800 : 600,
  borderRadius: 999,
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 13,
});

export default function OfficeAdminDesk() {
  const [tab, setTab] = useState("assets");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [people, setPeople] = useState([]);

  const [assets, setAssets] = useState([]);
  const [assetFilter, setAssetFilter] = useState("");
  const [showAssetModal, setShowAssetModal] = useState(false);
  const [assetForm, setAssetForm] = useState({
    asset_tag: "",
    category: "Laptop",
    status: "Available",
    assigned_user_id: "",
    purchase_date: "",
    notes: "",
  });
  const [savingAsset, setSavingAsset] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState(null);

  const [visitors, setVisitors] = useState([]);
  const [visitorView, setVisitorView] = useState("active");
  const [showVisitorForm, setShowVisitorForm] = useState(false);
  const [visitorForm, setVisitorForm] = useState({
    visitor_name: "",
    representing_company: "",
    purpose: "",
    host_user_id: "",
  });
  const [savingVisitor, setSavingVisitor] = useState(false);
  const [checkoutBusyId, setCheckoutBusyId] = useState(null);

  const loadPeople = useCallback(async () => {
    try {
      const data = await apiFetch("/office-admin/people");
      setPeople(Array.isArray(data?.people) ? data.people : []);
    } catch {
      setPeople([]);
    }
  }, []);

  const loadAssets = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (assetFilter) params.set("status", assetFilter);
      const qs = params.toString();
      const data = await apiFetch(`/office-admin/assets${qs ? `?${qs}` : ""}`);
      setAssets(Array.isArray(data?.assets) ? data.assets : []);
    } catch (err) {
      setError(errMsg(err, "Could not load office assets."));
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [assetFilter]);

  const loadVisitors = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/office-admin/visitors");
      setVisitors(Array.isArray(data?.visitors) ? data.visitors : []);
    } catch (err) {
      setError(errMsg(err, "Could not load visitor logs."));
      setVisitors([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPeople().catch(() => {});
  }, [loadPeople]);

  useEffect(() => {
    if (tab === "assets") loadAssets().catch(() => {});
    else loadVisitors().catch(() => {});
  }, [tab, loadAssets, loadVisitors]);

  const stats = useMemo(() => {
    const assigned = assets.filter((a) => a.status === "Assigned").length;
    const repair = assets.filter((a) => a.status === "Under_Repair").length;
    const activeVisitors = visitors.filter((v) => v.status === "Active").length;
    return [
      { label: "Assets tracked", value: String(assets.length), tone: "#234a8f" },
      { label: "Assigned", value: String(assigned), tone: "#0b7d45" },
      { label: "Under repair", value: String(repair), tone: "#8b5a00" },
      { label: "On site now", value: String(activeVisitors), tone: "#9f2042" },
    ];
  }, [assets, visitors]);

  const activeVisitors = useMemo(() => visitors.filter((v) => v.status === "Active"), [visitors]);
  const completedVisitors = useMemo(() => visitors.filter((v) => v.status === "Completed"), [visitors]);

  async function createAsset() {
    if (!assetForm.asset_tag.trim()) {
      setError("Asset tag is required.");
      return;
    }
    setSavingAsset(true);
    setError("");
    setNotice("");
    try {
      const body = {
        asset_tag: assetForm.asset_tag.trim(),
        category: assetForm.category,
        status: assetForm.status,
        purchase_date: assetForm.purchase_date || null,
        notes: assetForm.notes || null,
      };
      if (assetForm.status === "Assigned" && assetForm.assigned_user_id) {
        body.assigned_user_id = Number(assetForm.assigned_user_id);
      }
      await apiFetch("/office-admin/assets", { method: "POST", body: JSON.stringify(body) });
      setShowAssetModal(false);
      setAssetForm({
        asset_tag: "",
        category: "Laptop",
        status: "Available",
        assigned_user_id: "",
        purchase_date: "",
        notes: "",
      });
      setNotice("Asset added.");
      await loadAssets();
    } catch (err) {
      setError(errMsg(err, "Could not create asset."));
    } finally {
      setSavingAsset(false);
    }
  }

  async function updateAssetStatus(asset, nextStatus) {
    if (!nextStatus || nextStatus === asset.status) return;
    setStatusBusyId(asset.id);
    setError("");
    setNotice("");
    try {
      const body = { status: nextStatus };
      if (nextStatus === "Assigned") {
        if (!asset.assigned_user_id) {
          setError("Assign a user before marking Assigned (edit via re-add or set Assigned with a person).");
          setStatusBusyId(null);
          return;
        }
        body.assigned_user_id = asset.assigned_user_id;
      }
      await apiFetch(`/office-admin/assets/${asset.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setNotice(`${asset.asset_tag} → ${nextStatus.replace(/_/g, " ")}`);
      await loadAssets();
    } catch (err) {
      setError(errMsg(err, "Could not update asset status."));
    } finally {
      setStatusBusyId(null);
    }
  }

  async function assignAndSet(asset, userId) {
    if (!userId) return;
    setStatusBusyId(asset.id);
    setError("");
    try {
      await apiFetch(`/office-admin/assets/${asset.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "Assigned", assigned_user_id: Number(userId) }),
      });
      setNotice(`${asset.asset_tag} assigned.`);
      await loadAssets();
    } catch (err) {
      setError(errMsg(err, "Could not assign asset."));
    } finally {
      setStatusBusyId(null);
    }
  }

  async function checkInVisitor() {
    if (!visitorForm.visitor_name.trim()) {
      setError("Visitor name is required.");
      return;
    }
    setSavingVisitor(true);
    setError("");
    setNotice("");
    try {
      await apiFetch("/office-admin/visitors", {
        method: "POST",
        body: JSON.stringify({
          visitor_name: visitorForm.visitor_name.trim(),
          representing_company: visitorForm.representing_company || null,
          purpose: visitorForm.purpose || null,
          host_user_id: visitorForm.host_user_id ? Number(visitorForm.host_user_id) : undefined,
        }),
      });
      setVisitorForm({ visitor_name: "", representing_company: "", purpose: "", host_user_id: "" });
      setShowVisitorForm(false);
      setNotice("Visitor checked in.");
      setVisitorView("active");
      await loadVisitors();
    } catch (err) {
      setError(errMsg(err, "Could not check in visitor."));
    } finally {
      setSavingVisitor(false);
    }
  }

  async function checkoutVisitor(visitor) {
    setCheckoutBusyId(visitor.id);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/office-admin/visitors/${visitor.id}/checkout`, { method: "POST", body: "{}" });
      setNotice(`${visitor.visitor_name} checked out.`);
      await loadVisitors();
    } catch (err) {
      setError(errMsg(err, "Could not check out visitor."));
    } finally {
      setCheckoutBusyId(null);
    }
  }

  const listForVisitorView = visitorView === "active" ? activeVisitors : completedVisitors;

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Corporate office"
        title="Office Admin"
        description="Track IT hardware and plant visitor check-ins from one operational surface."
        stats={stats}
      />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, marginBottom: 8 }}>
        <button type="button" style={tabBtn(tab === "assets")} onClick={() => setTab("assets")}>
          IT &amp; Assets
        </button>
        <button type="button" style={tabBtn(tab === "visitors")} onClick={() => setTab("visitors")}>
          Visitor Logs
        </button>
      </div>

      {error ? <NoticeBanner tone="error" message={error} /> : null}
      {notice ? <NoticeBanner tone="success" message={notice} /> : null}

      {tab === "assets" ? (
        <DeskCard
          title="IT & hardware assets"
          subtitle="Laptops, phones, keys, and access cards"
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)} style={{ minHeight: 34 }}>
                <option value="">All statuses</option>
                {ASSET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => loadAssets()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </button>
              <button type="button" onClick={() => setShowAssetModal(true)}>
                Add Asset
              </button>
            </div>
          }
        >
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e6ebf2" }}>
                  <th style={{ padding: "10px 8px", textAlign: "left", width: 140 }}>Tag</th>
                  <th style={{ padding: "10px 8px", textAlign: "left" }}>Category</th>
                  <th style={{ padding: "10px 8px", textAlign: "center", width: 120 }}>Status</th>
                  <th style={{ padding: "10px 8px", textAlign: "left" }}>Assigned to</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", width: 120 }}>Purchase</th>
                  <th style={{ padding: "10px 8px", textAlign: "center", width: 180 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => {
                  const tone = STATUS_TONE[asset.status] || STATUS_TONE.Available;
                  const busy = statusBusyId === asset.id;
                  return (
                    <tr key={asset.id} style={{ borderBottom: "1px solid #f0f3f8" }}>
                      <td style={{ padding: "10px 8px", fontWeight: 700 }}>{asset.asset_tag}</td>
                      <td style={{ padding: "10px 8px" }}>{asset.category}</td>
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <DeskChip label={String(asset.status).replace(/_/g, " ")} tone={tone.tone} color={tone.color} />
                      </td>
                      <td style={{ padding: "10px 8px" }}>{asset.assigned_user_name || asset.assigned_user_email || "—"}</td>
                      <td style={{ padding: "10px 8px" }}>{asset.purchase_date ? String(asset.purchase_date).slice(0, 10) : "—"}</td>
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", justifyContent: "center" }}>
                          <select
                            disabled={busy}
                            defaultValue=""
                            onChange={(e) => {
                              const v = e.target.value;
                              e.target.value = "";
                              if (v === "__assign__") return;
                              if (v.startsWith("assign:")) {
                                assignAndSet(asset, v.slice(7)).catch(() => {});
                                return;
                              }
                              updateAssetStatus(asset, v).catch(() => {});
                            }}
                            style={{ minHeight: 32, maxWidth: 180 }}
                          >
                            <option value="">Update status…</option>
                            {ASSET_STATUSES.filter((s) => s !== asset.status && s !== "Assigned").map((s) => (
                              <option key={s} value={s}>
                                Mark {s.replace(/_/g, " ")}
                              </option>
                            ))}
                            {asset.status !== "Assigned" ? (
                              <optgroup label="Assign to">
                                {people.map((p) => (
                                  <option key={p.id} value={`assign:${p.id}`}>
                                    {personLabel(p)}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null}
                          </select>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && !assets.length ? (
              <div style={{ padding: 16, fontSize: 13, opacity: 0.66 }}>No assets yet. Add the first laptop, phone, or key set.</div>
            ) : null}
          </div>
        </DeskCard>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard
            title="Plant visitor check-in"
            subtitle="Live floor presence and historical visits"
            actions={
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" style={tabBtn(visitorView === "active")} onClick={() => setVisitorView("active")}>
                  Active ({activeVisitors.length})
                </button>
                <button type="button" style={tabBtn(visitorView === "history")} onClick={() => setVisitorView("history")}>
                  History ({completedVisitors.length})
                </button>
                <button type="button" onClick={() => setShowVisitorForm((v) => !v)}>
                  {showVisitorForm ? "Cancel" : "Check in visitor"}
                </button>
                <button type="button" onClick={() => loadVisitors()} disabled={loading}>
                  Refresh
                </button>
              </div>
            }
          >
            {showVisitorForm ? (
              <div
                style={{
                  marginBottom: 16,
                  padding: 14,
                  borderRadius: 16,
                  border: "1px solid #dfe5ef",
                  background: "#f8fafc",
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                }}
              >
                <input
                  placeholder="Visitor name *"
                  value={visitorForm.visitor_name}
                  onChange={(e) => setVisitorForm((c) => ({ ...c, visitor_name: e.target.value }))}
                />
                <input
                  placeholder="Company"
                  value={visitorForm.representing_company}
                  onChange={(e) => setVisitorForm((c) => ({ ...c, representing_company: e.target.value }))}
                />
                <input
                  placeholder="Purpose"
                  value={visitorForm.purpose}
                  onChange={(e) => setVisitorForm((c) => ({ ...c, purpose: e.target.value }))}
                />
                <select
                  value={visitorForm.host_user_id}
                  onChange={(e) => setVisitorForm((c) => ({ ...c, host_user_id: e.target.value }))}
                >
                  <option value="">Host (default: you)</option>
                  {people.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {personLabel(p)}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={checkInVisitor} disabled={savingVisitor}>
                  {savingVisitor ? "Saving…" : "Confirm check-in"}
                </button>
              </div>
            ) : null}

            <div style={{ display: "grid", gap: 10 }}>
              {listForVisitorView.map((v) => {
                const tone = STATUS_TONE[v.status] || STATUS_TONE.Active;
                return (
                  <div
                    key={v.id}
                    style={{
                      border: "1px solid #e6ebf2",
                      borderRadius: 16,
                      padding: 14,
                      background: "#fff",
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 800 }}>{v.visitor_name}</div>
                      <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4 }}>
                        {[v.representing_company, v.purpose, v.host_user_name ? `Host: ${v.host_user_name}` : null]
                          .filter(Boolean)
                          .join(" • ") || "No company / purpose"}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
                        In {fmtWhen(v.check_in_time)}
                        {v.check_out_time ? ` · Out ${fmtWhen(v.check_out_time)}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <DeskChip label={v.status} tone={tone.tone} color={tone.color} />
                      {v.status === "Active" ? (
                        <button type="button" onClick={() => checkoutVisitor(v)} disabled={checkoutBusyId === v.id}>
                          {checkoutBusyId === v.id ? "…" : "Check-Out"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {!loading && !listForVisitorView.length ? (
                <div style={{ fontSize: 13, opacity: 0.66 }}>
                  {visitorView === "active" ? "No visitors currently on site." : "No completed visits yet."}
                </div>
              ) : null}
            </div>
          </DeskCard>
        </div>
      )}

      {showAssetModal ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            zIndex: 80,
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={() => !savingAsset && setShowAssetModal(false)}
        >
          <div
            style={{
              width: "min(480px, 100%)",
              borderRadius: 18,
              background: "#fff",
              border: "1px solid #dde5f1",
              padding: 20,
              display: "grid",
              gap: 12,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 900, fontSize: 18 }}>Add office asset</div>
            <input
              placeholder="Asset tag *"
              value={assetForm.asset_tag}
              onChange={(e) => setAssetForm((c) => ({ ...c, asset_tag: e.target.value }))}
            />
            <select value={assetForm.category} onChange={(e) => setAssetForm((c) => ({ ...c, category: e.target.value }))}>
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <select
              value={assetForm.status}
              onChange={(e) => setAssetForm((c) => ({ ...c, status: e.target.value }))}
            >
              {ASSET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            {assetForm.status === "Assigned" ? (
              <select
                value={assetForm.assigned_user_id}
                onChange={(e) => setAssetForm((c) => ({ ...c, assigned_user_id: e.target.value }))}
              >
                <option value="">Assign to…</option>
                {people.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {personLabel(p)}
                  </option>
                ))}
              </select>
            ) : null}
            <input
              type="date"
              value={assetForm.purchase_date}
              onChange={(e) => setAssetForm((c) => ({ ...c, purchase_date: e.target.value }))}
            />
            <textarea
              rows={3}
              placeholder="Notes"
              value={assetForm.notes}
              onChange={(e) => setAssetForm((c) => ({ ...c, notes: e.target.value }))}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="button-ghost" onClick={() => setShowAssetModal(false)} disabled={savingAsset}>
                Cancel
              </button>
              <button type="button" onClick={createAsset} disabled={savingAsset}>
                {savingAsset ? "Saving…" : "Save asset"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
