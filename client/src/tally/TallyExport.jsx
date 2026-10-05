import { useCallback, useEffect, useState } from "react";
import { DeskCard, DeskChip, DeskStat, EmptyState, toast, useSubmitLock } from "../shared/joshUi";

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

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return num(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

function inputStyle(extra) {
  return { padding: "8px 10px", borderRadius: 12, border: "1px solid #e3e8f1", ...extra };
}

const EXPORT_TYPES = [
  { value: "sales", label: "Sales Vouchers" },
  { value: "receipts", label: "Receipt Vouchers" },
];

const MAP_SCOPES = [
  ["sales", "Sales Account"],
  ["output_cgst", "Output CGST"],
  ["output_sgst", "Output SGST"],
  ["output_igst", "Output IGST"],
  ["round_off", "Round Off"],
  ["bank", "Bank Account"],
  ["cash", "Cash"],
  ["freight", "Freight Outward"],
  ["packing_forwarding", "Packing & Forwarding"],
  ["party", "Party (Customer)"],
];

function emptyMapRow(scope = "sales") {
  return { map_scope: scope, match_key: "", tally_ledger_name: "", tally_parent_group: "", is_active: true };
}

export default function TallyExport({ launch, onConsumeLaunch }) {
  const { isBusy, runLocked } = useSubmitLock();
  const [exportType, setExportType] = useState("sales");
  const [dateFrom, setDateFrom] = useState(monthStartIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [mappings, setMappings] = useState([]);
  const [defaults, setDefaults] = useState([]);
  const [draftRows, setDraftRows] = useState([]);
  const [loadingMap, setLoadingMap] = useState(false);
  const [mapError, setMapError] = useState("");
  const downloading = isBusy("download");
  const savingMap = isBusy("save-map");

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    if (launch.export_type === "sales" || launch.export_type === "receipts") setExportType(launch.export_type);
    if (launch.from) setDateFrom(String(launch.from).slice(0, 10));
    if (launch.to) setDateTo(String(launch.to).slice(0, 10));
    onConsumeLaunch?.();
  }, [launch, onConsumeLaunch]);

  const loadPreview = useCallback(async () => {
    setLoadingPreview(true);
    setPreviewError("");
    try {
      const qs = new URLSearchParams({ type: exportType, from: dateFrom, to: dateTo });
      const data = await apiFetch(`/tally-export/preview?${qs.toString()}`);
      setPreview(data);
    } catch (e) {
      setPreview(null);
      setPreviewError(getApiErrorMessage(e, "Failed to load export preview."));
    } finally {
      setLoadingPreview(false);
    }
  }, [exportType, dateFrom, dateTo]);

  const loadLedgerMap = useCallback(async () => {
    setLoadingMap(true);
    setMapError("");
    try {
      const data = await apiFetch("/tally-export/ledger-map");
      const rows = Array.isArray(data?.mappings) ? data.mappings : [];
      const effectiveDefaults = Array.isArray(data?.defaults) ? data.defaults : [];
      setMappings(rows);
      setDefaults(effectiveDefaults);
      const source = rows.length ? rows : effectiveDefaults;
      setDraftRows(
        source.map((row) => ({
          map_scope: row.map_scope,
          match_key: row.match_key || "",
          tally_ledger_name: row.tally_ledger_name || "",
          tally_parent_group: row.tally_parent_group || "",
          is_active: row.is_active !== false,
        }))
      );
    } catch (e) {
      setMapError(getApiErrorMessage(e, "Failed to load ledger map."));
    } finally {
      setLoadingMap(false);
    }
  }, []);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  useEffect(() => {
    loadLedgerMap();
  }, [loadLedgerMap]);

  async function handleDownload() {
    await runLocked("download", async () => {
      try {
        const qs = new URLSearchParams({ type: exportType, from: dateFrom, to: dateTo });
        const res = await fetch(`/tally-export/xml?${qs.toString()}`, { credentials: "include" });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          const err = new Error("Download failed");
          err.data = data;
          throw err;
        }
        const blob = await res.blob();
        const disposition = res.headers.get("Content-Disposition") || "";
        const match = disposition.match(/filename="([^"]+)"/i);
        const filename = match?.[1] || `TALLY_${exportType.toUpperCase()}_${dateFrom}_${dateTo}.xml`;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        toast("Tally XML downloaded.", "success");
      } catch (e) {
        toast(getApiErrorMessage(e, "Could not download XML."), "error");
      }
    });
  }

  function updateDraftRow(index, patch) {
    setDraftRows((rows) => rows.map((row, idx) => (idx === index ? { ...row, ...patch } : row)));
  }

  function addDraftRow() {
    setDraftRows((rows) => [...rows, emptyMapRow()]);
  }

  function removeDraftRow(index) {
    setDraftRows((rows) => rows.filter((_, idx) => idx !== index));
  }

  async function handleSaveMap() {
    await runLocked("save-map", async () => {
      try {
        const payload = draftRows
          .filter((row) => String(row.tally_ledger_name || "").trim())
          .map((row) => ({
            map_scope: row.map_scope,
            match_key: String(row.match_key || "").trim() || null,
            tally_ledger_name: String(row.tally_ledger_name || "").trim(),
            tally_parent_group: String(row.tally_parent_group || "").trim() || null,
            is_active: row.is_active !== false,
          }));
        if (!payload.length) {
          toast("Add at least one ledger name before saving.", "warning");
          return;
        }
        await apiFetch("/tally-export/ledger-map", { method: "PUT", body: JSON.stringify({ mappings: payload }) });
        toast("Ledger map saved.", "success");
        await loadLedgerMap();
        await loadPreview();
      } catch (e) {
        toast(getApiErrorMessage(e, "Could not save ledger map."), "error");
      }
    });
  }

  const unmapped = Array.isArray(preview?.unmapped_ledgers) ? preview.unmapped_ledgers : [];
  const imbalancedCount = num(preview?.imbalanced_vouchers);
  const heldVouchers = Array.isArray(preview?.held_vouchers) ? preview.held_vouchers : [];

  return (
    <div style={{ maxWidth: 1360 }}>
      <div
        style={{
          border: "1px solid #dde5f1",
          borderRadius: 24,
          padding: 20,
          background: "linear-gradient(135deg, #f7fafc 0%, #ffffff 42%, #eef4ff 100%)",
          boxShadow: "0 20px 45px rgba(28, 45, 74, 0.08)",
        }}
      >
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.56, marginBottom: 8 }}>
              Desktop Accounting Bridge
            </div>
            <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.08 }}>Tally Export</h2>
            <div style={{ fontSize: 14, opacity: 0.72, marginTop: 10, maxWidth: 720, lineHeight: 1.7 }}>
              Preview unmapped ledgers, then download Sales and Receipt voucher XML for Tally import. Accounting
              entries only — no inventory vouchers, no automated push into Tally.
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <select value={exportType} onChange={(e) => setExportType(e.target.value)} style={inputStyle()}>
              {EXPORT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputStyle()} />
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputStyle()} />
            <button type="button" onClick={() => loadPreview()} disabled={loadingPreview}>
              {loadingPreview ? "Refreshing…" : "Preview"}
            </button>
            <button type="button" onClick={handleDownload} disabled={downloading}>
              {downloading ? "Downloading…" : "Download XML"}
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 12, marginTop: 18 }}>
          <DeskStat label="Vouchers In Range" value={preview?.voucher_count ?? 0} tone="#143d7a" />
          <DeskStat label="Total Amount" value={money(preview?.total_amount)} tone="#234a8f" />
          <DeskStat label="Unmapped Ledgers" value={unmapped.length} tone={unmapped.length ? "#8b5a00" : "#0a7a35"} />
          <DeskStat label="Imbalanced Vouchers" value={imbalancedCount} tone={imbalancedCount ? "#b00020" : "#0a7a35"} />
        </div>
      </div>

      {previewError ? (
        <div style={{ color: "#b00020", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#fff3f3", border: "1px solid #ffd8d8" }}>
          {previewError}
        </div>
      ) : null}

      {heldVouchers.length ? (
        <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#fff7ea", border: "1px solid #fde68a", color: "#7c4a03" }}>
          <div style={{ fontWeight: 700 }}>
            {heldVouchers.length} invoice{heldVouchers.length === 1 ? "" : "s"} held back from the XML — header total does not match lines + GST
          </div>
          <div style={{ fontSize: 12, marginTop: 4, opacity: 0.85 }}>
            Round-off only absorbs differences under ₹1. Fix these invoices, then export again.
          </div>
          <div style={{ display: "grid", gap: 4, marginTop: 8, fontSize: 13 }}>
            {heldVouchers.slice(0, 20).map((row) => (
              <div key={row.invoice_id}>
                <strong>{row.invoice_number}</strong> · invoice {money(row.invoice_total)} · lines + GST {money(row.computed_from_lines)} · difference{" "}
                {money(row.difference)}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16, marginTop: 16, alignItems: "start" }}>
        <DeskCard
          title="Export preview"
          subtitle={`${exportType === "receipts" ? "Posted receipts" : "Issued / paid invoices"} between ${dateFrom} and ${dateTo}`}
        >
          {loadingPreview && !preview ? (
            <div>Loading preview…</div>
          ) : preview?.sample_voucher ? (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <DeskChip label={preview.sample_voucher.voucher_type} tone="#eef4ff" color="#234a8f" />
                <DeskChip label={preview.sample_voucher.voucher_number} tone="#f6f7fb" color="#58627a" />
                <DeskChip label={String(preview.sample_voucher.voucher_date || "").slice(0, 10)} tone="#f6f7fb" color="#58627a" />
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                <strong>Party ledger:</strong> {preview.sample_voucher.party_ledger}
                {preview.sample_voucher.payment_ledger ? (
                  <>
                    {" · "}
                    <strong>Payment ledger:</strong> {preview.sample_voucher.payment_ledger}
                  </>
                ) : null}
                {preview.sample_voucher.tax_mode ? (
                  <>
                    {" · "}
                    <strong>Tax mode:</strong> {preview.sample_voucher.tax_mode === "intra" ? "CGST + SGST" : "IGST"}
                  </>
                ) : null}
              </div>
              <div style={{ fontSize: 13, opacity: 0.68 }}>
                Sample shown for the first voucher in range — the downloaded file includes all {preview.voucher_count} voucher(s).
              </div>
            </div>
          ) : (
            <EmptyState title="No vouchers in this range" body="Adjust the date range or voucher type, then preview again." />
          )}
        </DeskCard>

        <DeskCard title="Unmapped ledger warnings" subtitle="Resolve these before importing into Tally">
          {unmapped.length ? (
            <div style={{ display: "grid", gap: 8, maxHeight: 260, overflowY: "auto" }}>
              {unmapped.map((row, idx) => (
                <div
                  key={`${row.map_scope}-${row.match_key || idx}`}
                  style={{ border: "1px solid #f2dfb0", background: "#fff9ec", borderRadius: 12, padding: 10 }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{row.label || row.map_scope}</div>
                  <div style={{ fontSize: 12, opacity: 0.72, marginTop: 2 }}>
                    {row.reason} — scope: {row.map_scope}
                    {row.match_key ? ` (${row.match_key})` : ""}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No unmapped ledgers" body="Every ledger reference resolves to a mapped or default Tally ledger name." />
          )}
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard
          title="Ledger map"
          subtitle="Map Josh accounting concepts to Tally ledger names. Leave a row blank to fall back to the built-in default."
          actions={
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={addDraftRow}>
                Add Row
              </button>
              <button type="button" onClick={handleSaveMap} disabled={savingMap || loadingMap}>
                {savingMap ? "Saving…" : "Save Map"}
              </button>
            </div>
          }
        >
          {mapError ? <div style={{ color: "#b00020", marginBottom: 12 }}>{mapError}</div> : null}
          {loadingMap ? (
            <div>Loading ledger map…</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e6ebf2" }}>Scope</th>
                    <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e6ebf2" }}>Match Key</th>
                    <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e6ebf2" }}>Tally Ledger Name</th>
                    <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e6ebf2" }}>Parent Group</th>
                    <th style={{ padding: 8, borderBottom: "1px solid #e6ebf2" }} />
                  </tr>
                </thead>
                <tbody>
                  {draftRows.map((row, idx) => (
                    <tr key={`map-row-${idx}`}>
                      <td style={{ padding: 8, borderBottom: "1px solid #f1f3f8" }}>
                        <select value={row.map_scope} onChange={(e) => updateDraftRow(idx, { map_scope: e.target.value })} style={inputStyle()}>
                          {MAP_SCOPES.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: 8, borderBottom: "1px solid #f1f3f8" }}>
                        <input
                          value={row.match_key}
                          onChange={(e) => updateDraftRow(idx, { match_key: e.target.value })}
                          placeholder={row.map_scope === "party" ? "Customer ID" : "Optional"}
                          style={inputStyle({ width: 140 })}
                        />
                      </td>
                      <td style={{ padding: 8, borderBottom: "1px solid #f1f3f8" }}>
                        <input
                          value={row.tally_ledger_name}
                          onChange={(e) => updateDraftRow(idx, { tally_ledger_name: e.target.value })}
                          placeholder="Ledger name in Tally"
                          style={inputStyle({ width: 220 })}
                        />
                      </td>
                      <td style={{ padding: 8, borderBottom: "1px solid #f1f3f8" }}>
                        <input
                          value={row.tally_parent_group}
                          onChange={(e) => updateDraftRow(idx, { tally_parent_group: e.target.value })}
                          placeholder="Parent group"
                          style={inputStyle({ width: 180 })}
                        />
                      </td>
                      <td style={{ padding: 8, borderBottom: "1px solid #f1f3f8", textAlign: "center" }}>
                        <button
                          type="button"
                          onClick={() => removeDraftRow(idx)}
                          style={{ all: "unset", cursor: "pointer", color: "#b00020", fontSize: 12, fontWeight: 700 }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!draftRows.length ? <EmptyState title="No mappings yet" body="Defaults apply until you add and save custom rows." /> : null}
            </div>
          )}
          {defaults.length ? (
            <div style={{ fontSize: 12, opacity: 0.62, marginTop: 12, lineHeight: 1.7 }}>
              Built-in fallbacks: {defaults.map((row) => `${row.map_scope} → ${row.tally_ledger_name}`).join(" · ")}
            </div>
          ) : null}
          {mappings.length ? (
            <div style={{ fontSize: 12, opacity: 0.62, marginTop: 4 }}>{mappings.length} active mapping row(s) stored for this company.</div>
          ) : null}
        </DeskCard>
      </div>
    </div>
  );
}
