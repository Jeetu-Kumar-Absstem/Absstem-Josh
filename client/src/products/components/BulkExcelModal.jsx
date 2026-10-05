import React, { useEffect, useState } from "react";
import TypedConfirmModal from "../../components/TypedConfirmModal";

export default function BulkExcelModal({ isOpen, onClose, onImportSuccess }) {
  const [activeTab, setActiveTab] = useState("upload"); // 'upload' | 'export'
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [applying, setApplying] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setFile(null);
      setPreviewData(null);
      setImportSummary(null);
      setError(null);
      setActiveTab("upload");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleFileChange = async (e) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    setFile(selectedFile);
    setPreviewData(null);
    setImportSummary(null);
    setError(null);

    // Auto preview
    const formData = new FormData();
    formData.append("file", selectedFile);
    setPreviewing(true);
    try {
      const res = await fetch("/products/excel/preview", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const data = await res.json();
      if (data.ok && data.preview) {
        setPreviewData(data.preview);
      } else {
        setError(data.error || "Could not parse Excel workbook structure.");
      }
    } catch (err) {
      setError(err.message || "Network error previewing file.");
    } finally {
      setPreviewing(false);
    }
  };

  const handleApplyImport = async (confirmPhrase) => {
    if (!file) return;
    setApplying(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("confirm_phrase", String(confirmPhrase || ""));
      formData.append("file", file);
      const res = await fetch("/products/excel/apply", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const data = await res.json();
      if (data.ok && data.summary) {
        setImportSummary(data.summary);
        if (onImportSuccess) onImportSuccess(data.summary);
      } else {
        setError(data.detail || data.error || data.message || "Failed to apply workbook import.");
      }
    } catch (err) {
      setError(err.message || "Network error applying import.");
    } finally {
      setApplying(false);
      setApplyConfirmOpen(false);
    }
  };

  return (
    <div className="pd-modal-overlay">
      <div className="pd-modal-card" style={{ maxWidth: "780px" }}>
        {/* Modal Header */}
        <div className="pd-modal-header">
          <div>
            <h2 style={{ fontSize: "1.125rem", fontWeight: 700, margin: 0, color: "#0f172a" }}>
              Bulk Excel Operations & Workbook Suite
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "0.75rem", color: "#64748b" }}>
              Export current catalog or bulk upload new SKUs, company policies, and technical specifications
            </p>
          </div>
          <button type="button" className="pd-btn-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Modal Navigation Tabs */}
        <div className="pd-modal-tabs">
          <button
            type="button"
            className={`pd-modal-tab ${activeTab === "upload" ? "active" : ""}`}
            onClick={() => setActiveTab("upload")}
          >
            📥 Upload & Import Workbook
          </button>
          <button
            type="button"
            className={`pd-modal-tab ${activeTab === "export" ? "active" : ""}`}
            onClick={() => setActiveTab("export")}
          >
            📤 Download Templates & Current Catalog
          </button>
        </div>

        {/* Modal Body */}
        <div className="pd-modal-body">
          {error && (
            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#991b1b",
                padding: "8px 12px",
                borderRadius: "6px",
                fontSize: "0.8125rem",
                marginBottom: "12px",
              }}
            >
              ⚠️ {error}
            </div>
          )}

          {activeTab === "upload" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div
                style={{
                  border: "2px dashed #cbd5e1",
                  borderRadius: "8px",
                  padding: "24px",
                  textAlign: "center",
                  background: "#f8fafc",
                  cursor: "pointer",
                }}
              >
                <input
                  type="file"
                  id="bulk-excel-input"
                  accept=".xlsx,.xls"
                  onChange={handleFileChange}
                  style={{ display: "none" }}
                />
                <label htmlFor="bulk-excel-input" style={{ cursor: "pointer", display: "block" }}>
                  <div style={{ fontSize: "2rem", marginBottom: 6 }}>📊</div>
                  <strong style={{ fontSize: "0.875rem", color: "#0f172a" }}>
                    {file ? file.name : "Click to select Product Master Excel Workbook (.xlsx)"}
                  </strong>
                  <p style={{ margin: "4px 0 0", fontSize: "0.75rem", color: "#64748b" }}>
                    Supports multi-sheet workbooks: Product Catalog + Company Policies
                  </p>
                </label>
              </div>

              {previewing && (
                <div style={{ textAlign: "center", padding: "12px 0", color: "#0284c7", fontSize: "0.8125rem" }}>
                  Validating workbook structure and inspecting product rows...
                </div>
              )}

              {previewData && !importSummary && (
                <div
                  style={{
                    background: "#f0fdf4",
                    border: "1px solid #bbf7d0",
                    borderRadius: "8px",
                    padding: "12px 16px",
                  }}
                >
                  <h3 style={{ margin: "0 0 8px", fontSize: "0.875rem", color: "#065f46" }}>
                    Workbook Validation Analysis
                  </h3>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, fontSize: "0.8125rem" }}>
                    <div>
                      Total Rows: <strong>{previewData.total_rows || 0}</strong>
                    </div>
                    <div>
                      New SKUs to Create: <strong style={{ color: "#16a34a" }}>{previewData.creates || 0}</strong>
                    </div>
                    <div>
                      Existing SKUs to Update: <strong style={{ color: "#0284c7" }}>{previewData.updates || 0}</strong>
                    </div>
                    <div>
                      Skipped / Blank: <strong>{previewData.skipped || 0}</strong>
                    </div>
                  </div>

                  {Array.isArray(previewData.sample_rows) && previewData.sample_rows.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#475569" }}>Sample Rows:</span>
                      <div style={{ maxHeight: 120, overflowY: "auto", marginTop: 4 }}>
                        <table style={{ width: "100%", fontSize: "0.75rem", borderCollapse: "collapse" }}>
                          <thead>
                            <tr style={{ background: "#e2e8f0" }}>
                              <th style={{ padding: "3px 6px", textAlign: "left" }}>Code</th>
                              <th style={{ padding: "3px 6px", textAlign: "left" }}>Name</th>
                              <th style={{ padding: "3px 6px", textAlign: "left" }}>Category</th>
                              <th style={{ padding: "3px 6px", textAlign: "center" }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {previewData.sample_rows.slice(0, 5).map((r, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid #e2e8f0" }}>
                                <td style={{ padding: "3px 6px", fontWeight: 600 }}>{r.item_code}</td>
                                <td style={{ padding: "3px 6px" }}>{r.item_name}</td>
                                <td style={{ padding: "3px 6px" }}>{r.category_name}</td>
                                <td style={{ padding: "3px 6px", textAlign: "center" }}>
                                  <span style={{ color: r.action === "create" ? "#16a34a" : "#0284c7", fontWeight: 700 }}>
                                    {r.action.toUpperCase()}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {importSummary && (
                <div
                  style={{
                    background: "#ecfdf5",
                    border: "1px solid #a7f3d0",
                    borderRadius: "8px",
                    padding: "14px 18px",
                  }}
                >
                  <strong style={{ color: "#065f46", fontSize: "0.9375rem" }}>
                    ✓ Workbook Import Completed Successfully!
                  </strong>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 8, fontSize: "0.8125rem" }}>
                    <div>
                      Created Products: <strong>{importSummary.created_products || 0}</strong>
                    </div>
                    <div>
                      Updated Products: <strong>{importSummary.updated_products || 0}</strong>
                    </div>
                    <div>
                      Policies Configured: <strong>{importSummary.applied_company_policies || 0}</strong>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "export" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "14px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <strong style={{ fontSize: "0.875rem", color: "#0f172a" }}>Download Current Product Master</strong>
                  <p style={{ margin: "2px 0 0", fontSize: "0.75rem", color: "#64748b" }}>
                    Full export of all 300+ items with current pricing, technical specs, and multi-company sourcing policies
                  </p>
                </div>
                <a
                  href="/products/excel/current-workbook"
                  download
                  className="pd-btn pd-btn-primary"
                  style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  📥 Download Current XLSX
                </a>
              </div>

              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "14px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <strong style={{ fontSize: "0.875rem", color: "#0f172a" }}>Download Blank Guided Template</strong>
                  <p style={{ margin: "2px 0 0", fontSize: "0.75rem", color: "#64748b" }}>
                    Standard template with sample columns for adding new SKUs and multi-company policies
                  </p>
                </div>
                <a
                  href="/products/excel/template"
                  download
                  className="pd-btn pd-btn-secondary"
                  style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  📄 Download Blank Template
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="pd-modal-footer">
          <button type="button" className="pd-btn pd-btn-secondary" onClick={onClose}>
            Close
          </button>
          {activeTab === "upload" && previewData && !importSummary && (
            <button
              type="button"
              className="pd-btn pd-btn-primary"
              disabled={applying}
              onClick={() => setApplyConfirmOpen(true)}
            >
              {applying ? "Applying Workbook..." : "✓ Apply & Save to Catalog"}
            </button>
          )}
        </div>
      </div>
      <TypedConfirmModal
        open={applyConfirmOpen}
        title="Apply Product Master upload"
        message="This writes/updates live product rows from the workbook. Type APPLY UPLOAD to continue."
        confirmPhrase="APPLY UPLOAD"
        confirmLabel="Apply upload"
        busy={applying}
        onCancel={() => setApplyConfirmOpen(false)}
        onConfirm={handleApplyImport}
      />
    </div>
  );
}
