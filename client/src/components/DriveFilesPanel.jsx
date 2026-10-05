import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DRIVE_CATEGORY_LABELS,
  canUploadDrive,
  canViewDrive,
  driveViewUrl,
} from "../shared/driveAccess";

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

async function apiFetchForm(path, formData, options) {
  const res = await fetch(path, {
    credentials: "include",
    body: formData,
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

function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUploadedAt(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * ERP-gated Drive file panel. Never stores or renders raw Google Drive URLs.
 */
export default function DriveFilesPanel({
  me,
  category,
  companyId = null,
  productId = null,
  ownerRef = null,
  title = null,
  subtitle = null,
  accept = ".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.mp4,.mov",
}) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fileKey, setFileKey] = useState(0);

  const canView = canViewDrive(me, category);
  const canUpload = canUploadDrive(me, category);
  const label = title || DRIVE_CATEGORY_LABELS[category] || category;

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set("category", category);
    if (companyId) params.set("company_id", String(companyId));
    if (productId) params.set("product_id", String(productId));
    return params.toString();
  }, [category, companyId, productId]);

  const refresh = useCallback(async () => {
    if (!canView) {
      setFiles([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/drive/files?${query}`);
      setFiles(Array.isArray(data?.files) ? data.files : []);
    } catch (err) {
      const code = err?.data?.error || err?.data?.code;
      const detail = err?.data?.detail || err?.data?.message || err?.message;
      setError([code || "Failed to load files", detail && detail !== code ? detail : null].filter(Boolean).join(": "));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [canView, query]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  async function onUpload(file) {
    if (!file || !canUpload) return;
    setUploading(true);
    setError("");
    setNotice("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (companyId) fd.append("company_id", String(companyId));
      if (productId) fd.append("product_id", String(productId));
      if (ownerRef) fd.append("owner_ref", String(ownerRef));
      await apiFetchForm(`/drive/upload/${encodeURIComponent(category)}`, fd, { method: "POST" });
      setNotice("Uploaded.");
      setFileKey((k) => k + 1);
      await refresh();
    } catch (err) {
      const code = err?.data?.error || err?.data?.code;
      const detail = err?.data?.detail || err?.data?.message || err?.message;
      setError([code || "Upload failed", detail && detail !== code ? detail : null].filter(Boolean).join(": "));
    } finally {
      setUploading(false);
    }
  }

  if (!canView) return null;

  return (
    <div
      style={{
        border: "1px solid #dfe5ef",
        borderRadius: 18,
        padding: 14,
        background: "#fff",
        boxShadow: "0 12px 28px rgba(15, 23, 42, 0.06)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>{label}</div>
          {subtitle ? <div style={{ fontSize: 13, opacity: 0.74, lineHeight: 1.5, marginTop: 6 }}>{subtitle}</div> : null}
        </div>
        <button type="button" onClick={() => refresh().catch(() => {})} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <div style={{ color: "#9f1428", marginBottom: 10, fontSize: 13 }}>{error}</div>
      ) : null}
      {notice ? (
        <div style={{ color: "#0d6b33", marginBottom: 10, fontSize: 13 }}>{notice}</div>
      ) : null}

      {canUpload ? (
        <div style={{ marginBottom: 12, border: "1px dashed #c5d0e0", borderRadius: 12, padding: 12, background: "#fbfcff" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Upload</div>
          <input
            key={fileKey}
            type="file"
            accept={accept}
            disabled={uploading}
            onChange={(e) => {
              const next = e.target.files && e.target.files[0];
              if (next) onUpload(next).catch(() => {});
            }}
          />
          {uploading ? <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>Uploading…</div> : null}
        </div>
      ) : (
        <div style={{ fontSize: 12, opacity: 0.68, marginBottom: 10 }}>View / attach only — uploads are restricted for your role.</div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        {files.length === 0 && !loading ? (
          <div style={{ fontSize: 13, opacity: 0.7 }}>No files yet.</div>
        ) : null}
        {files.map((file) => {
          const viewHref = driveViewUrl(file.drive_file_id);
          const downloadHref = driveViewUrl(file.drive_file_id, { download: true });
          const uploadedLabel = formatUploadedAt(file.created_at);
          return (
            <div
              key={file.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
                border: "1px solid #edf1f7",
                borderRadius: 12,
                padding: "10px 12px",
                background: "#fbfcff",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, wordBreak: "break-word" }}>{file.file_name}</div>
                <div style={{ fontSize: 12, opacity: 0.65 }}>
                  {file.mime_type || "file"} · {formatBytes(file.file_size_bytes)}
                  {uploadedLabel ? ` · Uploaded ${uploadedLabel}` : null}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <a href={viewHref} target="_blank" rel="noreferrer">
                  Preview
                </a>
                <a href={downloadHref} target="_blank" rel="noreferrer">
                  Download
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
