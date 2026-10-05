const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PASSWORD_OPTIONS = { N: 16384, r: 8, p: 1 };
const JWT_TTL_SECONDS = 8 * 60 * 60;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const DOCUMENT_TYPES = new Set([
  "GST",
  "GST_CERTIFICATE",
  "PAN",
  "PAN_CARD",
  "MSME",
  "ISO",
  "ISO_CERTIFICATE",
  "BANK_PROOF",
  "OTHER",
]);
const FILE_TYPES = new Map([
  [".pdf", new Set(["application/pdf"])],
  [".png", new Set(["image/png"])],
  [".jpg", new Set(["image/jpeg"])],
  [".jpeg", new Set(["image/jpeg"])],
]);

function cleanText(value, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeEmail(value) {
  const email = cleanText(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function validatePassword(password) {
  const value = typeof password === "string" ? password : "";
  if (value.length < 12 || value.length > 128) return false;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);
}

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, PASSWORD_OPTIONS, (error, derivedKey) => {
      if (error) return reject(error);
      return resolve(derivedKey.toString("base64"));
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64");
  return { salt, hash: await scryptHash(password, salt) };
}

async function verifyPassword(password, salt, expectedHash) {
  const actualHash = await scryptHash(password, salt);
  const actual = Buffer.from(actualHash);
  const expected = Buffer.from(String(expectedHash || ""));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function portalJwtSecret() {
  return String(process.env.VENDOR_PORTAL_JWT_SECRET || process.env.SESSION_SECRET || "").trim();
}

function signVendorJwt(payload) {
  const secret = portalJwtSecret();
  if (!secret) {
    const error = new Error("VENDOR_PORTAL_JWT_SECRET_MISSING");
    error.status = 503;
    error.code = "VENDOR_PORTAL_JWT_SECRET_MISSING";
    throw error;
  }
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify({
    ...payload,
    typ: "vendor_portal",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS,
  }));
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verifyVendorJwt(token) {
  const secret = portalJwtSecret();
  const parts = String(token || "").trim().split(".");
  if (!secret || parts.length !== 3) return null;
  const expected = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  const actual = Buffer.from(parts[2]);
  const signed = Buffer.from(expected);
  if (actual.length !== signed.length || !crypto.timingSafeEqual(actual, signed)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload.typ !== "vendor_portal" || Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function hashGuestToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createGuestToken() {
  return crypto.randomBytes(32).toString("hex");
}

function normalizeDocumentType(value) {
  const type = cleanText(value, 40).toUpperCase().replaceAll(" ", "_");
  return DOCUMENT_TYPES.has(type) ? type : "";
}

const googleDrive = require("./googleDrive");

function validateDocumentFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) return { ok: false, error: "FILE_REQUIRED" };
  if (file.size > MAX_FILE_SIZE) return { ok: false, error: "FILE_TOO_LARGE" };
  const extension = path.extname(file.originalname || "").toLowerCase();
  const mimeTypes = FILE_TYPES.get(extension);
  if (!mimeTypes || !mimeTypes.has(String(file.mimetype || "").toLowerCase())) {
    return { ok: false, error: "INVALID_FILE_TYPE" };
  }
  return { ok: true, extension };
}

function sanitizeFileNameComponent(value, fallback = "UNKNOWN") {
  if (!value) return fallback;
  const clean = String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean || fallback;
}

function buildStructuredDocumentName({ vendorName, vendorId, documentType, expiryDate }) {
  const safeVendor = sanitizeFileNameComponent(vendorName, "Vendor");
  const safeId = vendorId ? String(vendorId) : "GUEST";
  const safeType = sanitizeFileNameComponent(documentType, "DOCUMENT").toUpperCase();
  const safeExpiry = expiryDate ? String(expiryDate).slice(0, 10) : "NOEXPIRY";
  return `${safeVendor}_VEND-${safeId}-${safeType}-${safeExpiry}.pdf`;
}

async function saveVendorDocumentFile(file, { vendorId = null, tokenId = null, vendorName = null, documentType = "STATUTORY", expiryDate = null } = {}) {
  const validation = validateDocumentFile(file);
  if (!validation.ok) {
    const error = new Error(validation.error);
    error.status = 400;
    error.code = validation.error;
    throw error;
  }

  // Generate standardized file name: {VendorName}_VEND-{VendorId}-{DocumentType}-{ExpiryDate}.pdf
  const standardFileName = buildStructuredDocumentName({
    vendorName,
    vendorId,
    documentType,
    expiryDate,
  });

  // Check if Google Drive storage is configured
  if (googleDrive.isDriveConfigured()) {
    try {
      const driveUpload = await googleDrive.uploadFile({
        category: "statutory",
        fileName: standardFileName,
        mimeType: String(file.mimetype || "application/pdf").toLowerCase(),
        buffer: file.buffer,
      });

      return {
        filePath: `gdrive:${driveUpload.drive_file_id}`,
        driveFileId: driveUpload.drive_file_id,
        fileName: driveUpload.file_name || standardFileName,
        mimeType: driveUpload.mime_type || "application/pdf",
        fileSizeBytes: driveUpload.file_size_bytes || file.size || file.buffer.length,
        storageProvider: "gdrive",
      };
    } catch (driveErr) {
      console.warn("Google Drive upload failed, falling back to local storage:", driveErr?.message || driveErr);
    }
  }

  // Fallback to local storage if Google Drive is not configured or fails
  const owner = Number(vendorId) > 0 ? String(Number(vendorId)) : `guest-${Number(tokenId) || "unassigned"}`;
  const directory = path.resolve(__dirname, "../../storage/vendor-portal", owner);
  await fs.promises.mkdir(directory, { recursive: true });
  const storedName = `${Date.now()}-${standardFileName}`;
  const absolutePath = path.join(directory, storedName);
  await fs.promises.writeFile(absolutePath, file.buffer, { flag: "wx" });
  return {
    filePath: path.relative(path.resolve(__dirname, "../.."), absolutePath).replaceAll(path.sep, "/"),
    fileName: standardFileName,
    mimeType: String(file.mimetype || "application/octet-stream").toLowerCase(),
    fileSizeBytes: file.size || file.buffer.length,
    storageProvider: "local",
  };
}

async function getVendorComplianceStatus(client, vendorId) {
  const id = Number(vendorId);
  if (!Number.isFinite(id) || id <= 0) return { locked: false, expired: [], non_compliant: [] };
  await client.query(
    `
      update vendor_documents
      set verification_status = 'expired', updated_at = now()
      where vendor_id = $1
        and expiry_date < current_date
        and verification_status <> 'expired'
    `,
    [id]
  );
  const result = await client.query(
    `
      select id, document_type, expiry_date, verification_status, is_mandatory
      from vendor_documents
      where vendor_id = $1
        and (
          is_mandatory = true
          or upper(document_type) in ('GST', 'GST_CERTIFICATE', 'PAN', 'PAN_CARD', 'MSME')
        )
      order by expiry_date asc, document_type asc
    `,
    [id]
  );

  const nonCompliant = result.rows.filter(
    (row) =>
      (row.expiry_date && new Date(row.expiry_date) < new Date()) ||
      row.verification_status !== "approved"
  );

  const expired = result.rows.filter(
    (row) => row.expiry_date && new Date(row.expiry_date) < new Date()
  );

  return {
    locked: nonCompliant.length > 0,
    non_compliant: nonCompliant.map((row) => ({
      document_type: row.document_type,
      expiry_date: row.expiry_date,
      verification_status: row.verification_status,
      reason:
        row.expiry_date && new Date(row.expiry_date) < new Date()
          ? "Expired document"
          : `Unverified document (${row.verification_status})`,
    })),
    expired: expired.map((row) => ({
      document_type: row.document_type,
      expiry_date: row.expiry_date,
      verification_status: row.verification_status,
    })),
  };
}

function complianceLockError(nonCompliant = []) {
  const error = new Error("VENDOR_COMPLIANCE_LOCKED");
  error.status = 400;
  error.code = "VENDOR_COMPLIANCE_LOCKED";
  error.error = "VENDOR_COMPLIANCE_LOCKED";
  error.message = "Purchase order blocked. Vendor statutory compliance documents are expired or unverified.";
  error.detail = `Vendor has expired or unverified mandatory statutory documents: ${nonCompliant
    .map((row) => `${row.document_type} (${row.reason || row.verification_status})`)
    .join(", ")}.`;
  error.non_compliant_documents = nonCompliant;
  return error;
}

async function assertVendorCompliance(client, vendorId) {
  const status = await getVendorComplianceStatus(client, vendorId);
  if (status.locked) throw complianceLockError(status.non_compliant);
  return status;
}

module.exports = {
  MAX_FILE_SIZE,
  DOCUMENT_TYPES,
  cleanText,
  normalizeEmail,
  normalizeDocumentType,
  validatePassword,
  hashPassword,
  verifyPassword,
  signVendorJwt,
  verifyVendorJwt,
  hashGuestToken,
  createGuestToken,
  buildStructuredDocumentName,
  sanitizeFileNameComponent,
  validateDocumentFile,
  saveVendorDocumentFile,
  getVendorComplianceStatus,
  complianceLockError,
  assertVendorCompliance,
};
