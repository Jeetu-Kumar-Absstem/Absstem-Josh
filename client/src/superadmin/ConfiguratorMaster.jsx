import { useEffect, useMemo, useState } from "react";

function parseJsonSafe(raw) {
  try {
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function errorMessage(e, fallback) {
  const apiErr = e?.data?.error;
  if (apiErr) return apiErr;
  if (e?.status) return `${fallback} (HTTP ${e.status})`;
  return fallback;
}

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const raw = await res.text().catch(() => "");
  const data = parseJsonSafe(raw);
  if (!res.ok) {
    const err = new Error("Request failed");
    err.status = res.status;
    err.data = data;
    err.raw = raw;
    throw err;
  }
  return data;
}

async function apiFetchForm(path, formData, options) {
  const res = await fetch(path, {
    credentials: "include",
    body: formData,
    ...options,
  });
  const raw = await res.text().catch(() => "");
  const data = parseJsonSafe(raw);
  if (!res.ok) {
    const err = new Error("Request failed");
    err.status = res.status;
    err.data = data;
    err.raw = raw;
    throw err;
  }
  return data;
}

const DATASETS = [
  { key: "nitrogen", title: "Nitrogen PSA", detail: "Purity/flow matrix and model mapping." },
  { key: "oxygen", title: "Oxygen PSA", detail: "Purity/flow matrix and model mapping." },
  { key: "compressor", title: "Air Compressor", detail: "Compressor power and airflow lookup." },
];

function Badge({ label }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        border: "1px solid #e5e5e5",
        fontSize: 12,
        opacity: 0.76,
        background: "#fff",
      }}
    >
      {label}
    </span>
  );
}

export default function ConfiguratorMaster() {
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [datasets, setDatasets] = useState([]);
  const [selectedKey, setSelectedKey] = useState("nitrogen");
  const [fileMap, setFileMap] = useState({});
  const [preview, setPreview] = useState(null);

  const selectedMeta = useMemo(() => DATASETS.find((x) => x.key === selectedKey) || DATASETS[0], [selectedKey]);
  const selectedStatus = useMemo(
    () => datasets.find((d) => String(d.dataset_key) === String(selectedKey)) || null,
    [datasets, selectedKey]
  );

  useEffect(() => {
    loadBootstrap().catch(() => {});
  }, []);

  async function loadBootstrap() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/configurator/admin/bootstrap");
      setDatasets(Array.isArray(data?.datasets) ? data.datasets : []);
    } catch (e) {
      setError(errorMessage(e, "Failed to load configurator datasets."));
    } finally {
      setLoading(false);
    }
  }

  function setFile(key, file) {
    setFileMap((prev) => ({ ...prev, [key]: file }));
  }

  async function previewFromFiles() {
    setWorking(true);
    setError("");
    setNotice("");
    setPreview(null);
    try {
      const data = await apiFetch(`/configurator/admin/${selectedKey}/preview-from-files`);
      setPreview(data);
    } catch (e) {
      setError(errorMessage(e, "Failed to preview dataset from server files."));
    } finally {
      setWorking(false);
    }
  }

  async function applyFromFiles() {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/configurator/admin/${selectedKey}/apply-from-files`, { method: "POST" });
      setNotice(`Dataset published: ${selectedMeta.title} v${data?.applied?.version_no || "?"}`);
      setPreview(null);
      await loadBootstrap();
    } catch (e) {
      setError(errorMessage(e, "Failed to apply dataset from server files."));
    } finally {
      setWorking(false);
    }
  }

  async function previewUpload() {
    const file = fileMap[selectedKey] || null;
    if (!file) return;
    setWorking(true);
    setError("");
    setNotice("");
    setPreview(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const data = await apiFetchForm(`/configurator/admin/${selectedKey}/upload/preview`, fd, { method: "POST" });
      setPreview(data);
    } catch (e) {
      setError(errorMessage(e, "Failed to preview upload."));
    } finally {
      setWorking(false);
    }
  }

  async function applyUpload() {
    const file = fileMap[selectedKey] || null;
    if (!file) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const data = await apiFetchForm(`/configurator/admin/${selectedKey}/upload/apply`, fd, { method: "POST" });
      setNotice(`Dataset published: ${selectedMeta.title} v${data?.applied?.version_no || "?"}`);
      setPreview(null);
      setFile(selectedKey, null);
      await loadBootstrap();
    } catch (e) {
      const validation = e?.data?.validation;
      if (validation?.issues?.length) {
        setError(`Invalid dataset. Missing: ${validation.issues.join(", ")}`);
      } else {
        setError(errorMessage(e, "Failed to publish upload."));
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <div style={{ maxWidth: 1280, width: "100%" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ margin: 0 }}>Configurator Master</h2>
          <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4 }}>
            Publish and version Nitrogen, Oxygen, and Compressor datasets so the model selection stays updateable from UI.
          </div>
        </div>
        <button onClick={() => loadBootstrap().catch(() => {})} disabled={loading}>
          Refresh
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginBottom: 10 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginBottom: 10 }}>{notice}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 0.8fr) minmax(0, 1.2fr)", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #e5e5e5", fontWeight: 800 }}>Datasets</div>
          {DATASETS.map((item) => {
            const active = item.key === selectedKey;
            const status = datasets.find((d) => d.dataset_key === item.key) || null;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setSelectedKey(item.key);
                  setPreview(null);
                  setError("");
                  setNotice("");
                }}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  display: "block",
                  padding: 12,
                  borderBottom: "1px solid #f2f2f2",
                  background: active ? "#f7fbff" : "#fff",
                }}
              >
                <div style={{ fontWeight: 800 }}>{item.title}</div>
                <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>{item.detail}</div>
                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Badge label={`Current v${status?.current_version_no || 0}`} />
                  <Badge label={`${status?.current_row_count || 0} rows`} />
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ minWidth: 240 }}>
                <div style={{ fontWeight: 800 }}>{selectedMeta.title}</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  Current version: v{selectedStatus?.current_version_no || 0} • Rows: {selectedStatus?.current_row_count || 0}
                </div>
                {selectedStatus?.current_file_name ? (
                  <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>Source: {selectedStatus.current_file_name}</div>
                ) : null}
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <button type="button" onClick={previewFromFiles} disabled={working}>
                  Preview Server File
                </button>
                <button type="button" onClick={applyFromFiles} disabled={working}>
                  Publish From Server File
                </button>
              </div>
            </div>

            <div style={{ marginTop: 16, borderTop: "1px solid #edf1f6", paddingTop: 14 }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>Upload New JSON</div>
              <input type="file" accept=".json,application/json" onChange={(e) => setFile(selectedKey, e.target.files?.[0] || null)} />
              <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                <button type="button" onClick={previewUpload} disabled={working || !fileMap[selectedKey]}>
                  Preview Upload
                </button>
                <button type="button" onClick={applyUpload} disabled={working || !fileMap[selectedKey]}>
                  Publish Upload
                </button>
              </div>
            </div>
          </div>

          {preview ? (
            <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div style={{ fontWeight: 800 }}>Preview</div>
                <Badge label={`${preview?.preview?.row_count || 0} rows`} />
              </div>
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72 }}>
                File: {preview.file_name || "unknown"} • Required fields: {(preview?.validation?.required_fields || []).join(", ")}
              </div>
              {preview?.validation?.issues?.length ? (
                <div style={{ marginTop: 10, color: "#b00020", fontSize: 12 }}>
                  Issues: {preview.validation.issues.join(", ")}
                </div>
              ) : (
                <div style={{ marginTop: 10, color: "#0a7a35", fontSize: 12 }}>Validation OK</div>
              )}

              <div style={{ marginTop: 14, fontWeight: 700 }}>Sample Columns</div>
              <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(preview?.preview?.sample_columns || []).map((col) => (
                  <Badge key={col} label={col} />
                ))}
              </div>

              <div style={{ marginTop: 14, fontWeight: 700 }}>Sample Rows</div>
              <pre
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: "#0f172a",
                  color: "#e2e8f0",
                  borderRadius: 12,
                  fontSize: 12,
                  overflowX: "auto",
                }}
              >
                {JSON.stringify(preview?.preview?.sample_rows || [], null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
