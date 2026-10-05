import React, { useEffect, useState } from "react";
import "./admin.css";
import TypedConfirmModal from "../components/TypedConfirmModal";

function formatCurrency(val) {
  const num = Number(val) || 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(num);
}

export default function TallyImportDesk({ onNavigate, activeCompanyId: propActiveCompanyId }) {
  const [companies, setCompanies] = useState([]);
  const [companiesStatus, setCompaniesStatus] = useState("loading"); // 'loading' | 'ready' | 'error'
  const [companiesError, setCompaniesError] = useState(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [activeTab, setActiveTab] = useState("runs"); // 'runs' | 'staging' | 'reconciliations' | 'mappings' | 'upload'

  // Data states
  const [logs, setLogs] = useState([]);
  const [reconciliations, setReconciliations] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Staging Review states
  const [activeBatchId, setActiveBatchId] = useState(null);
  const [stagingData, setStagingData] = useState({ batch: null, stats: {}, records: [] });
  const [stagingLoading, setStagingLoading] = useState(false);
  const [stagingFilterStatus, setStagingFilterStatus] = useState("");
  const [stagingRecordType, setStagingRecordType] = useState("");
  const [stagingSearch, setStagingSearch] = useState("");
  const [committingStaging, setCommittingStaging] = useState(false);
  const [commitConfirmOpen, setCommitConfirmOpen] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkApproving, setBulkApproving] = useState(false);

  // Upload states
  const [uploadFile, setUploadFile] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [stagingInProgress, setStagingInProgress] = useState(false);
  const [stagingResult, setStagingResult] = useState(null);

  // Filter states
  const [filterStatus, setFilterStatus] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  async function loadCompanies() {
    setCompaniesStatus("loading");
    setCompaniesError(null);
    try {
      const res = await fetch("/api/tally/companies", { credentials: "include" });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok && Array.isArray(data.companies) && data.companies.length) {
        setCompanies(data.companies);
        setCompaniesStatus("ready");
        setSelectedCompanyId((prev) => {
          if (propActiveCompanyId && data.companies.some((c) => String(c.id) === String(propActiveCompanyId))) {
            return String(propActiveCompanyId);
          }
          if (prev && data.companies.some((c) => String(c.id) === String(prev))) {
            return prev;
          }
          return String(data.companies[0].id);
        });
        return;
      }
      setCompanies([]);
      setSelectedCompanyId("");
      setCompaniesStatus("error");
      setLoading(false);
      setCompaniesError(
        data?.ok && Array.isArray(data.companies)
          ? "No legal entities are configured for Tally import. Ask an administrator to set up company profiles before staging files."
          : "Legal entities could not be loaded. Staging is disabled until the company list loads — use Retry or contact your administrator."
      );
    } catch (err) {
      console.error("Error loading companies:", err);
      setCompanies([]);
      setSelectedCompanyId("");
      setCompaniesStatus("error");
      setLoading(false);
      setCompaniesError("Legal entities could not be loaded. Staging is disabled until the company list loads — use Retry or contact your administrator.");
    }
  }

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const compParam = selectedCompanyId ? `?company_id=${selectedCompanyId}` : "";
      const recParams = new URLSearchParams();
      if (selectedCompanyId) recParams.append("company_id", selectedCompanyId);
      if (filterStatus) recParams.append("status", filterStatus);
      if (searchQuery) recParams.append("q", searchQuery);

      const [logsRes, recsRes, mapsRes] = await Promise.all([
        fetch(`/api/tally/import-logs${compParam}`, { credentials: "include" }).then((r) => r.json()),
        fetch(`/api/tally/reconciliations?${recParams.toString()}`, { credentials: "include" }).then((r) => r.json()),
        fetch(`/api/tally/master-mappings?${recParams.toString()}`, { credentials: "include" }).then((r) => r.json()),
      ]);

      if (logsRes.ok) setLogs(logsRes.logs || []);
      if (recsRes.ok) setReconciliations(recsRes.reconciliations || []);
      if (mapsRes.ok) setMappings(mapsRes.mappings || []);
    } catch (err) {
      setError(err.message || "Failed to load Tally reconciliation data");
    } finally {
      setLoading(false);
    }
  }

  async function loadStagingBatch(batchId) {
    if (!batchId) return;
    setActiveBatchId(batchId);
    setStagingLoading(true);
    try {
      const params = new URLSearchParams();
      if (stagingFilterStatus) params.append("status", stagingFilterStatus);
      if (stagingRecordType) params.append("record_type", stagingRecordType);
      if (stagingSearch) params.append("q", stagingSearch);

      const res = await fetch(`/api/tally/staging/${batchId}?${params.toString()}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        setStagingData(data);
      } else {
        alert("Could not load staging batch: " + (data.error || "Error"));
      }
    } catch (err) {
      console.error("Error loading staging batch:", err);
    } finally {
      setStagingLoading(false);
    }
  }

  useEffect(() => {
    loadCompanies();
  }, []);

  useEffect(() => {
    if (selectedCompanyId) {
      loadData();
    }
  }, [selectedCompanyId, filterStatus]);

  useEffect(() => {
    if (activeBatchId && activeTab === "staging") {
      loadStagingBatch(activeBatchId);
    }
  }, [activeBatchId, activeTab, stagingFilterStatus, stagingRecordType]);

  async function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (companiesStatus !== "ready" || !selectedCompanyId) {
      alert("Legal entities have not loaded yet. Select a target company before choosing a file.");
      e.target.value = "";
      return;
    }
    setUploadFile(file);
    setPreviewData(null);
    setStagingResult(null);

    // Fetch quick preview with target company context for mismatch detection
    const formData = new FormData();
    formData.append("file", file);
    if (selectedCompanyId) {
      formData.append("company_id", selectedCompanyId);
    }
    setPreviewing(true);
    try {
      const res = await fetch("/api/tally/preview", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_jsonErr) {
        throw new Error(`The server could not analyse this file (HTTP ${res.status}). Please try again in a moment; if it keeps failing, contact your system administrator.`);
      }
      if (res.ok && data.ok) {
        setPreviewData(data);
      } else {
        alert("Preview error: " + (data.error || data.message || `HTTP ${res.status}`));
      }
    } catch (err) {
      alert("Error previewing file: " + err.message);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleStageAndMatchSubmit(e) {
    e.preventDefault();
    if (!uploadFile) {
      alert("Please select a Tally XML or JSON export file first.");
      return;
    }
    if (!selectedCompanyId || !companies.some((c) => String(c.id) === String(selectedCompanyId))) {
      alert("Please select a target company from the loaded list before staging.");
      return;
    }

    setStagingInProgress(true);
    setStagingResult(null);
    try {
      const formData = new FormData();
      formData.append("file", uploadFile);
      formData.append("company_id", selectedCompanyId);

      const res = await fetch("/api/tally/stage-and-match", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_jsonErr) {
        throw new Error(`The server returned an unexpected response (HTTP ${res.status}). Nothing was staged. Please try again; if it keeps failing, contact your system administrator.`);
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.message || data.error || "Staging & Auto-matching failed");
      }

      setStagingResult(data);
      setUploadFile(null);
      setPreviewData(null);
      setActiveBatchId(data.batch_id);
      loadStagingBatch(data.batch_id);
      setActiveTab("staging");
      loadData();
    } catch (err) {
      alert("Staging Pipeline Error: " + err.message);
    } finally {
      setStagingInProgress(false);
    }
  }

  async function handleStagingAction(stagingId, action) {
    try {
      const res = await fetch(`/api/tally/staging/${stagingId}/action`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_jsonErr) {
        throw new Error("Server returned an invalid response.");
      }
      if (data.ok) {
        loadStagingBatch(activeBatchId);
      } else {
        alert("Action failed: " + (data.error || "Unknown"));
      }
    } catch (err) {
      alert("Error updating staging record: " + err.message);
    }
  }

  async function handleBulkApprove(confirmPhrase) {
    if (!activeBatchId) return;
    setBulkApproving(true);
    try {
      const res = await fetch(`/api/tally/staging/${activeBatchId}/bulk-approve`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_phrase: confirmPhrase }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_jsonErr) {
        throw new Error("Server returned an invalid response.");
      }
      if (data.ok) {
        alert(
          `Approved ${data.approved_count} auto-matched record(s).` +
            (data.needs_review_remaining
              ? `\n${data.needs_review_remaining} record(s) still need review (variance or fuzzy match) — approve or override them one by one.`
              : "")
        );
        setBulkConfirmOpen(false);
        loadStagingBatch(activeBatchId);
      } else {
        alert("Bulk approval failed: " + (data.detail || data.error || "Error"));
      }
    } catch (err) {
      alert("Error in bulk approve: " + err.message);
    } finally {
      setBulkApproving(false);
    }
  }

  async function handleCommitToLive(confirmPhrase) {
    if (!activeBatchId) return;

    setCommittingStaging(true);
    try {
      const res = await fetch(`/api/tally/staging/${activeBatchId}/commit`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_phrase: confirmPhrase }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_jsonErr) {
        throw new Error("Server returned an invalid response.");
      }
      if (data.ok) {
        alert(
          `Successfully committed staging batch to live Josh ERP!\n` +
            `Ledgers: ${data.ledgers_committed}\n` +
            `Stock Items: ${data.stock_items_committed}\n` +
            `Vouchers Reconciled: ${data.vouchers_committed}\n` +
            `Invoices Created from Tally: ${data.invoices_created || 0}\n` +
            `Receipts Created from Tally: ${data.receipts_created || 0}` +
            (data.needs_review_skipped ? `\nNot committed (still need review): ${data.needs_review_skipped}` : "")
        );
        setCommitConfirmOpen(false);
        setActiveTab("runs");
        loadData();
      } else {
        alert("Commit failed: " + (data.detail || data.error || data.message || "Error"));
      }
    } catch (err) {
      alert("Commit Error: " + err.message);
    } finally {
      setCommittingStaging(false);
    }
  }

  const selectedCompany = companies.find((c) => String(c.id) === String(selectedCompanyId));

  // Compute Macro Metrics
  const totalLogsCount = logs.length;
  const totalReconciledVouchers = reconciliations.length;
  const varianceCount = reconciliations.filter((r) => r.reconciliation_status === "variance_detected").length;
  const totalVarianceAmt = reconciliations
    .filter((r) => r.reconciliation_status === "variance_detected")
    .reduce((acc, r) => acc + (parseFloat(r.variance) || 0), 0);

  return (
    <div className="admin-desk">
      {/* Command Bar */}
      <header className="admin-command-bar">
        <div className="admin-title-group">
          <h1>AI-Assisted Tally ERP Staging & Smart Ingestion</h1>
          <p>
            Deterministic (GSTIN/PAN) & Fuzzy String Auto-Matching Pipeline with Exception Review & Live Commit.
            Sales vouchers from Tally are auto-created as Josh AR invoices and receipt vouchers as posted receipts for parallel operation.
          </p>
        </div>

        <div className="admin-actions-group">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#475569" }}>TARGET ENTITY:</span>
            <select
              className="admin-select"
              style={{ fontWeight: 700, borderColor: "var(--absstem-primary, #0ea5e9)", background: "#ffffff", minWidth: 200, minHeight: 34 }}
              value={selectedCompanyId}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
              disabled={companiesStatus !== "ready"}
            >
              {companies.length === 0 && (
                <option value="">{companiesStatus === "loading" ? "Loading legal entities..." : "No legal entities available"}</option>
              )}
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  [{c.company_code}] {c.display_name || c.legal_name}
                </option>
              ))}
            </select>
          </div>

          <button type="button" className="admin-btn secondary" onClick={loadData}>
            ↻ Refresh
          </button>
          <button
            type="button"
            className="admin-btn primary"
            onClick={() => setActiveTab("upload")}
            disabled={companiesStatus !== "ready"}
          >
            + Stage Tally Export
          </button>
        </div>
      </header>

      {companiesStatus === "error" && (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "10px 14px",
            borderRadius: 8,
            fontSize: "0.8125rem",
            fontWeight: 600,
            margin: "0 0 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{companiesError}</span>
          <button type="button" className="admin-btn secondary" onClick={loadCompanies}>
            Retry
          </button>
        </div>
      )}

      {/* 4-Column KPI Summary Grid */}
      <div className="admin-kpi-grid">
        <div className="admin-kpi-card">
          <span className="label">Active Entity Scope</span>
          <span className="value" style={{ color: "var(--absstem-primary, #0ea5e9)" }}>
            {selectedCompany ? selectedCompany.company_code : "—"}
          </span>
          <span className="subtext">{selectedCompany?.display_name || "Enterprise Partition"}</span>
        </div>

        <div className="admin-kpi-card">
          <span className="label">Total Ingestion Runs</span>
          <span className="value">{totalLogsCount}</span>
          <span className="subtext">Completed synchronizations & staging runs</span>
        </div>

        <div className="admin-kpi-card">
          <span className="label">Reconciled Vouchers</span>
          <span className="value">{totalReconciledVouchers}</span>
          <span className="subtext">{mappings.length} master mappings mapped</span>
        </div>

        <div className="admin-kpi-card">
          <span className="label">Reconciliation Variances</span>
          <span className="value" style={{ color: varianceCount > 0 ? "#dc2626" : "#16a34a" }}>
            {varianceCount > 0 ? formatCurrency(totalVarianceAmt) : "₹0 (Balanced)"}
          </span>
          <span className="subtext">{varianceCount} transactions flagged with discrepancy</span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="admin-tabs" style={{ marginTop: 12 }}>
        <button
          type="button"
          className={`admin-tab ${activeTab === "runs" ? "active" : ""}`}
          onClick={() => setActiveTab("runs")}
        >
          🗂 Import Runs & Batches ({logs.length})
        </button>

        {activeBatchId && (
          <button
            type="button"
            className={`admin-tab ${activeTab === "staging" ? "active" : ""}`}
            onClick={() => setActiveTab("staging")}
          >
            ⚡ AI Staging & Match Review
          </button>
        )}

        <button
          type="button"
          className={`admin-tab ${activeTab === "reconciliations" ? "active" : ""}`}
          onClick={() => setActiveTab("reconciliations")}
        >
          ⚖ Voucher Reconciliations ({reconciliations.length})
        </button>

        <button
          type="button"
          className={`admin-tab ${activeTab === "mappings" ? "active" : ""}`}
          onClick={() => setActiveTab("mappings")}
        >
          📖 Master Mappings Dictionary ({mappings.length})
        </button>

        <button
          type="button"
          className={`admin-tab ${activeTab === "upload" ? "active" : ""}`}
          onClick={() => setActiveTab("upload")}
        >
          📤 Upload & Ingest Portal
        </button>
      </div>

      {/* TAB 1: RUNS */}
      {activeTab === "runs" && (
        <section className="admin-panel" style={{ marginTop: 12 }}>
          <div className="admin-panel-header">
            <h2>Multi-Company Ingestion Run History</h2>
            <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
              Filtered for Entity: <strong>{selectedCompany?.company_code || "ALL"}</strong>
            </span>
          </div>

          <div className="admin-table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Batch Code</th>
                  <th style={{ width: 70, textAlign: "center" }}>Entity</th>
                  <th>File Name</th>
                  <th style={{ width: 80, textAlign: "right" }}>Masters</th>
                  <th style={{ width: 80, textAlign: "right" }}>Vouchers</th>
                  <th style={{ width: 120, textAlign: "center" }}>Ledgers / Stock</th>
                  <th style={{ width: 100, textAlign: "center" }}>Status</th>
                  <th style={{ width: 110, textAlign: "center" }}>Match Rate</th>
                  <th style={{ width: 140 }}>Executed At</th>
                  <th style={{ width: 120, textAlign: "center" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ textAlign: "center", padding: "28px 0", color: "#94a3b8" }}>
                      No Tally ingestion runs recorded for this company yet. Click "+ Stage Tally Export" to upload.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => {
                    const sum = log.reconciliation_summary || {};
                    const matchRate = sum.match_rate_pct !== undefined ? `${sum.match_rate_pct}%` : "100%";
                    return (
                      <tr key={log.id}>
                        <td>
                          <strong style={{ color: "#0284c7" }}>{log.import_batch_code}</strong>
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <span
                            className="admin-badge"
                            style={{
                              background: log.entity_code === "AI" ? "#dbeafe" : "#fef3c7",
                              color: log.entity_code === "AI" ? "#1e40af" : "#92400e",
                              fontWeight: 700,
                            }}
                          >
                            {log.entity_code}
                          </span>
                        </td>
                        <td style={{ fontSize: "0.75rem" }}>{log.file_name}</td>
                        <td style={{ textAlign: "right", fontFamily: "monospace" }}>{log.masters_count}</td>
                        <td style={{ textAlign: "right", fontFamily: "monospace" }}>{log.vouchers_count}</td>
                        <td style={{ textAlign: "center", fontFamily: "monospace" }}>
                          {log.ledgers_imported} / {log.stock_items_imported}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <span
                            className={`admin-badge ${
                              log.status === "completed" ? "active" : log.status === "staged" ? "pending" : "danger"
                            }`}
                          >
                            {log.status.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <span style={{ fontWeight: 700, color: "#059669" }}>{matchRate}</span>
                        </td>
                        <td style={{ fontSize: "0.75rem", color: "#64748b" }}>
                          {log.created_at ? new Date(log.created_at).toLocaleString("en-IN") : "—"}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                            <button
                              type="button"
                              className="admin-btn-action"
                              style={{ color: "#0284c7", borderColor: "#bae6fd" }}
                              onClick={() => {
                                setActiveBatchId(log.id);
                                setActiveTab("staging");
                              }}
                            >
                              Inspect Staging
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 2: AI STAGING & AUTO-MATCH REVIEW */}
      {activeTab === "staging" && (
        <section className="admin-panel" style={{ marginTop: 12 }}>
          {/* Staging Header & KPI Banner */}
          <div
            style={{
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: 8,
              padding: "14px 18px",
              marginBottom: 14,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    background: "#059669",
                    color: "#ffffff",
                    fontSize: "0.6875rem",
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 4,
                  }}
                >
                  AI STAGING ENGINE
                </span>
                <h2 style={{ margin: 0, fontSize: "1.0625rem", color: "#065f46" }}>
                  Staging Batch: {stagingData.batch?.import_batch_code || `Batch #${activeBatchId}`}
                </h2>
              </div>
              <p style={{ margin: "4px 0 0", fontSize: "0.8125rem", color: "#047857" }}>
                Auto-Matched: <strong>{stagingData.stats?.auto_matched_count || 0}</strong> • Exceptions Requiring Review:{" "}
                <strong style={{ color: "#d97706" }}>{stagingData.stats?.exceptions_count || 0}</strong> • Total Staged:{" "}
                <strong>{stagingData.stats?.total_records || 0}</strong>
              </p>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="admin-btn secondary"
                disabled={bulkApproving}
                onClick={() => setBulkConfirmOpen(true)}
                style={{ background: "#ffffff", borderColor: "#cbd5e1" }}
              >
                {bulkApproving ? "Approving..." : "⚡ 1-Click Approve Suggestions"}
              </button>

              <button
                type="button"
                className="admin-btn primary"
                disabled={committingStaging}
                onClick={() => setCommitConfirmOpen(true)}
                style={{ background: "#059669", borderColor: "#047857" }}
              >
                {committingStaging ? "Committing..." : "✓ Commit to Live ERP"}
              </button>
            </div>
          </div>

          {/* Staging Filters */}
          <div className="admin-filter-bar" style={{ marginBottom: 12 }}>
            <div className="admin-filter-group">
              <label>Resolution Status:</label>
              <select
                className="admin-filter-select"
                value={stagingFilterStatus}
                onChange={(e) => setStagingFilterStatus(e.target.value)}
              >
                <option value="">All Statuses</option>
                <option value="NEEDS_REVIEW">Needs Review / Exception</option>
                <option value="AUTO_MATCHED">Auto-Matched</option>
                <option value="APPROVED">Approved</option>
                <option value="COMMITTED">Committed</option>
              </select>
            </div>

            <div className="admin-filter-group">
              <label>Record Type:</label>
              <select
                className="admin-filter-select"
                value={stagingRecordType}
                onChange={(e) => setStagingRecordType(e.target.value)}
              >
                <option value="">All Types</option>
                <option value="ledger">Ledgers (Customers/Vendors/COA)</option>
                <option value="stock_item">Stock Items / SKUs</option>
                <option value="voucher">Vouchers (Sales/Receipts)</option>
              </select>
            </div>

            <div className="admin-filter-group" style={{ flex: 1 }}>
              <label>Search Identifier:</label>
              <input
                type="text"
                className="admin-filter-input"
                placeholder="Search ledger name, stock item or voucher number..."
                value={stagingSearch}
                onChange={(e) => setStagingSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadStagingBatch(activeBatchId);
                }}
              />
            </div>

            <button
              type="button"
              className="admin-btn secondary"
              style={{ alignSelf: "flex-end" }}
              onClick={() => loadStagingBatch(activeBatchId)}
            >
              Filter
            </button>
          </div>

          {/* Staged Record AI Recommendation Cards / List */}
          {stagingLoading ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#64748b" }}>
              Evaluating staging records and AI confidence scores...
            </div>
          ) : stagingData.records?.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>
              No staged records found matching the active filter.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {stagingData.records.map((rec) => {
                const recAI = rec.ai_recommendation || {};
                const isException = rec.resolution_status === "NEEDS_REVIEW";
                const isAutoMatched = rec.resolution_status === "AUTO_MATCHED";

                return (
                  <div
                    key={rec.id}
                    className={`ai-recommendation-card ${isException ? "needs-review" : isAutoMatched ? "auto-matched" : ""}`}
                  >
                    <div className="ai-card-info">
                      <div className="ai-card-badge-row">
                        <span
                          className={`ai-badge ${
                            rec.match_strategy.includes("gstin")
                              ? "gstin"
                              : rec.match_strategy.includes("pan")
                              ? "pan"
                              : rec.match_strategy.includes("fuzzy")
                              ? "fuzzy"
                              : "new"
                          }`}
                        >
                          {recAI.badge || rec.match_strategy}
                        </span>

                        <span style={{ fontSize: "0.6875rem", fontWeight: 700, color: "#64748b" }}>
                          Confidence: {rec.match_confidence_pct}%
                        </span>

                        <span
                          className={`admin-badge ${
                            rec.resolution_status === "NEEDS_REVIEW"
                              ? "danger"
                              : rec.resolution_status === "AUTO_MATCHED"
                              ? "active"
                              : "pending"
                          }`}
                          style={{ fontSize: "0.625rem", padding: "1px 5px" }}
                        >
                          {rec.resolution_status}
                        </span>
                      </div>

                      <div className="ai-card-title">
                        {rec.source_identifier}
                        <span style={{ fontWeight: 400, color: "#64748b", marginLeft: 8 }}>
                          → Target: <strong>{rec.suggested_target_display}</strong>
                        </span>
                      </div>

                      <div className="ai-card-desc">
                        <strong>AI Analysis:</strong> {recAI.reason || "Auto-resolved via deterministic algorithm."}
                      </div>
                    </div>

                    <div className="ai-card-actions">
                      {rec.resolution_status !== "COMMITTED" && (
                        <>
                          <button
                            type="button"
                            className="admin-btn secondary"
                            style={{ fontSize: "0.71875rem", padding: "4px 8px" }}
                            onClick={() => handleStagingAction(rec.id, "APPROVE")}
                          >
                            ✓ Accept
                          </button>
                          <button
                            type="button"
                            className="admin-btn secondary"
                            style={{ fontSize: "0.71875rem", padding: "4px 8px", color: "#dc2626" }}
                            onClick={() => handleStagingAction(rec.id, "DISCARD")}
                          >
                            Discard
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* TAB 3: RECONCILIATIONS */}
      {activeTab === "reconciliations" && (
        <section className="admin-panel" style={{ marginTop: 12 }}>
          <div className="admin-panel-header">
            <h2>Voucher Reconciliations & Discrepancy Inspector</h2>
          </div>

          <div className="admin-filter-bar">
            <div className="admin-filter-group">
              <label>Reconciliation Status:</label>
              <select
                className="admin-filter-select"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                <option value="">All Statuses</option>
                <option value="reconciled">Reconciled / Balanced</option>
                <option value="variance_detected">Variance Detected</option>
                <option value="missing_in_josh">Tally Only / Missing</option>
              </select>
            </div>

            <div className="admin-filter-group" style={{ flex: 1 }}>
              <label>Search Party / Voucher:</label>
              <input
                type="text"
                className="admin-filter-input"
                placeholder="Search voucher number or party name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="admin-table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Voucher No</th>
                  <th style={{ width: 100 }}>Date</th>
                  <th style={{ width: 100, textAlign: "center" }}>Type</th>
                  <th>Party Name</th>
                  <th style={{ width: 120, textAlign: "right" }}>Tally Amount</th>
                  <th style={{ width: 120, textAlign: "right" }}>Josh Amount</th>
                  <th style={{ width: 120, textAlign: "right" }}>Variance</th>
                  <th style={{ width: 110, textAlign: "center" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {reconciliations.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", padding: "28px 0", color: "#94a3b8" }}>
                      No voucher reconciliations match the current filters.
                    </td>
                  </tr>
                ) : (
                  reconciliations.map((rec) => (
                    <tr key={rec.id}>
                      <td>
                        <strong>{rec.voucher_number}</strong>
                      </td>
                      <td>{rec.voucher_date}</td>
                      <td style={{ textAlign: "center" }}>
                        <span className="admin-badge pending">{rec.voucher_type}</span>
                      </td>
                      <td>{rec.party_name || "—"}</td>
                      <td style={{ textAlign: "right", fontFamily: "monospace" }}>{formatCurrency(rec.tally_amount)}</td>
                      <td style={{ textAlign: "right", fontFamily: "monospace" }}>{formatCurrency(rec.josh_amount)}</td>
                      <td
                        style={{
                          textAlign: "right",
                          fontFamily: "monospace",
                          fontWeight: 700,
                          color: Math.abs(parseFloat(rec.variance || 0)) > 0 ? "#dc2626" : "#16a34a",
                        }}
                      >
                        {formatCurrency(rec.variance)}
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <span
                          className={`admin-badge ${
                            rec.reconciliation_status === "reconciled" ? "active" : "danger"
                          }`}
                        >
                          {rec.reconciliation_status.replace(/_/g, " ").toUpperCase()}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 4: MASTER MAPPINGS */}
      {activeTab === "mappings" && (
        <section className="admin-panel" style={{ marginTop: 12 }}>
          <div className="admin-panel-header">
            <h2>Master Mappings & Entity Partitioning Dictionary</h2>
          </div>

          <div className="admin-table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 120 }}>Master Type</th>
                  <th>Tally Name</th>
                  <th style={{ width: 140 }}>Tally Parent Group</th>
                  <th style={{ width: 150 }}>Target ERP Entity</th>
                  <th style={{ width: 130, textAlign: "right" }}>Opening Balance</th>
                  <th style={{ width: 110, textAlign: "center" }}>Match Status</th>
                  <th style={{ width: 110 }}>Updated At</th>
                </tr>
              </thead>
              <tbody>
                {mappings.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", padding: "28px 0", color: "#94a3b8" }}>
                      No master mappings registered for this entity yet.
                    </td>
                  </tr>
                ) : (
                  mappings.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <span className="admin-badge pending">{m.master_type.replace(/_/g, " ").toUpperCase()}</span>
                      </td>
                      <td>
                        <strong>{m.tally_name}</strong>
                      </td>
                      <td style={{ color: "#64748b" }}>{m.tally_parent_group || "—"}</td>
                      <td>
                        <span style={{ color: "#0284c7", fontWeight: 600 }}>{m.target_table}</span> (ID:{" "}
                        {m.target_id || "Auto"})
                      </td>
                      <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                        {formatCurrency(m.opening_balance)} ({m.opening_balance_type})
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <span className="admin-badge active">{m.match_status.toUpperCase()}</span>
                      </td>
                      <td style={{ fontSize: "0.75rem", color: "#64748b" }}>
                        {m.updated_at ? new Date(m.updated_at).toLocaleDateString("en-IN") : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 5: UPLOAD & INGEST PORTAL */}
      {activeTab === "upload" && (
        <section className="admin-panel" style={{ marginTop: 12, maxWidth: 860, marginInline: "auto" }}>
          <div className="admin-panel-header">
            <h2>Stage Tally XML / JSON Export File</h2>
          </div>

          <div
            style={{
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 12,
              fontSize: "0.8125rem",
              color: "#1e40af",
            }}
          >
            <strong>Parallel Operation Mode:</strong> Import <code>Master.xml</code> first, then <code>Transactions.xml</code>.
            On commit, Tally sales vouchers auto-create Josh AR invoices (status: issued) and receipt vouchers as posted receipts so both systems run together.
            Once fully on ERP, use <strong>Tally Export</strong> only to push data from Josh → Tally.
          </div>

          <form onSubmit={handleStageAndMatchSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="admin-form-group">
              <label>1. Select Target Enterprise Entity Partition:</label>
              <select
                className="admin-select"
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                style={{ fontWeight: 700, padding: 8, background: "#ffffff", minHeight: "38px" }}
                required
                disabled={companiesStatus !== "ready"}
              >
                {companies.length === 0 && (
                  <option value="">{companiesStatus === "loading" ? "Loading legal entities..." : "No legal entities available"}</option>
                )}
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    [{c.company_code}] {c.display_name || c.legal_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="admin-form-group">
              <label>2. Choose Tally Export File (.XML or .JSON):</label>
              <input
                type="file"
                accept=".xml,.json,text/xml,application/json"
                onChange={handleFileSelect}
                style={{
                  padding: "16px",
                  border: "2px dashed #cbd5e1",
                  borderRadius: 8,
                  background: "#f8fafc",
                  cursor: "pointer",
                }}
                required
              />
            </div>

            {/* Preview Card */}
            {previewing && (
              <div style={{ color: "#0284c7", fontSize: "0.8125rem" }}>Analyzing file structure...</div>
            )}

            {previewData && (
              <div
                style={{
                  background: previewData.mismatch_warning ? "#fffbeb" : "#f8fafc",
                  border: previewData.mismatch_warning ? "1px solid #fde68a" : "1px solid #e2e8f0",
                  borderRadius: 8,
                  padding: "12px 16px",
                }}
              >
                {previewData.mismatch_warning && (
                  <div
                    style={{
                      background: "#fef2f2",
                      border: "1px solid #fecaca",
                      color: "#991b1b",
                      padding: "8px 12px",
                      borderRadius: 6,
                      fontSize: "0.8125rem",
                      fontWeight: 600,
                      marginBottom: 10,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span>⚠️</span>
                    <span>{previewData.mismatch_warning}</span>
                  </div>
                )}

                <h3 style={{ margin: "0 0 8px", fontSize: "0.875rem", color: "#0f172a" }}>
                  File Structure Analysis: {previewData.file_name}
                  {previewData.tally_gstin && (
                    <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "#0284c7", marginLeft: 8 }}>
                      [Detected Tally GSTIN: {previewData.tally_gstin}]
                    </span>
                  )}
                </h3>
                <div style={{ display: "flex", gap: 16, fontSize: "0.8125rem", color: "#475569" }}>
                  <div>
                    Total Masters: <strong>{previewData.masters_count}</strong>
                  </div>
                  <div>
                    Ledgers: <strong>{previewData.ledgers_count}</strong>
                  </div>
                  <div>
                    Stock Items: <strong>{previewData.stock_items_count}</strong>
                  </div>
                  <div>
                    Vouchers: <strong>{previewData.vouchers_count}</strong>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="admin-btn secondary"
                onClick={() => {
                  setUploadFile(null);
                  setPreviewData(null);
                  setActiveTab("runs");
                }}
              >
                Cancel
              </button>

              <button
                type="submit"
                className="admin-btn primary"
                disabled={!uploadFile || stagingInProgress || companiesStatus !== "ready" || !selectedCompanyId}
                style={{ minWidth: 200 }}
              >
                {stagingInProgress ? "Executing AI Staging..." : "⚡ Stage & Auto-Match"}
              </button>
            </div>
          </form>
        </section>
      )}

      <TypedConfirmModal
        open={bulkConfirmOpen}
        title="Bulk-approve Tally suggestions"
        message="Approves every auto-matched record in this batch. Records that need review (amount variance or fuzzy match) are left for one-by-one review. Type BULK APPROVE to continue."
        confirmPhrase="BULK APPROVE"
        confirmLabel="Approve suggestions"
        busy={bulkApproving}
        onCancel={() => setBulkConfirmOpen(false)}
        onConfirm={handleBulkApprove}
      />
      <TypedConfirmModal
        open={commitConfirmOpen}
        title="Commit staging to live ERP"
        message="Writes approved and auto-matched staging rows into live masters, AR invoices, and receipts. Rows still marked Needs Review are not committed. Type COMMIT LIVE to continue."
        confirmPhrase="COMMIT LIVE"
        confirmLabel="Commit to live"
        busy={committingStaging}
        onCancel={() => setCommitConfirmOpen(false)}
        onConfirm={handleCommitToLive}
      />
    </div>
  );
}
