const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");
const { google } = require("googleapis");
const { normalizeCategory } = require("../auth/driveAccess");

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];

function envBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function readServiceAccountCredentials() {
  const clientEmail = String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL || "").trim();
  const rawKey = String(process.env.GOOGLE_DRIVE_PRIVATE_KEY || "").trim();
  if (clientEmail && rawKey) {
    const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
    return {
      client_email: clientEmail,
      private_key: privateKey,
    };
  }

  const rawJson = String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || "").trim();
  if (rawJson) {
    try {
      return JSON.parse(rawJson);
    } catch {
      throw new Error("INVALID_GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON");
    }
  }

  const filePath = String(
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS || ""
  ).trim();
  if (!filePath) return null;
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) throw new Error("GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE_MISSING");
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function folderIdForCategory(category) {
  const cat = normalizeCategory(category);
  const map = {
    statutory: process.env.GOOGLE_DRIVE_VENDOR_DOCS_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_STATUTORY,
    model_asset: process.env.GOOGLE_DRIVE_FOLDER_MODEL_ASSET,
    marketing_collateral: process.env.GOOGLE_DRIVE_FOLDER_MARKETING,
    service_amc: process.env.GOOGLE_DRIVE_FOLDER_SERVICE_AMC,
  };
  const folderId = String(
    map[cat] ||
    process.env.GOOGLE_DRIVE_VENDOR_DOCS_FOLDER_ID ||
    process.env.GOOGLE_DRIVE_FOLDER_ROOT ||
    ""
  ).trim();
  return folderId || null;
}

function isDriveConfigured() {
  if (!envBool(process.env.GOOGLE_DRIVE_ENABLED, true)) return false;
  try {
    return Boolean(readServiceAccountCredentials());
  } catch {
    return false;
  }
}

let driveClientPromise = null;

async function getDriveClient() {
  if (!driveClientPromise) {
    driveClientPromise = (async () => {
      const credentials = readServiceAccountCredentials();
      if (!credentials) throw Object.assign(new Error("DRIVE_NOT_CONFIGURED"), { status: 503 });

      const subject = String(process.env.GOOGLE_DRIVE_IMPERSONATE_USER || "").trim();
      const auth = new GoogleAuth({
        credentials,
        scopes: DRIVE_SCOPES,
        clientOptions: subject ? { subject } : undefined,
      });
      const authClient = await auth.getClient();
      return google.drive({ version: "v3", auth: authClient });
    })().catch((err) => {
      driveClientPromise = null;
      throw err;
    });
  }
  return driveClientPromise;
}

async function uploadFile({ category, fileName, mimeType, buffer }) {
  const drive = await getDriveClient();
  const folderId = folderIdForCategory(category);
  const requestBody = {
    name: String(fileName || "upload").slice(0, 240),
    parents: folderId ? [folderId] : undefined,
  };
  const media = {
    mimeType: mimeType || "application/octet-stream",
    body: require("stream").Readable.from(buffer),
  };

  const created = await drive.files.create({
    requestBody,
    media,
    fields: "id,name,mimeType,size",
    supportsAllDrives: true,
  });

  const data = created.data || {};
  if (!data.id) throw Object.assign(new Error("DRIVE_UPLOAD_FAILED"), { status: 502 });

  return {
    drive_file_id: data.id,
    file_name: data.name || fileName,
    mime_type: data.mimeType || mimeType || null,
    file_size_bytes: data.size != null ? Number(data.size) : buffer?.length || null,
  };
}

async function getFileMetadata(driveFileId) {
  const drive = await getDriveClient();
  const res = await drive.files.get({
    fileId: String(driveFileId),
    fields: "id,name,mimeType,size",
    supportsAllDrives: true,
  });
  return res.data;
}

async function downloadFileStream(driveFileId) {
  const drive = await getDriveClient();
  const res = await drive.files.get(
    {
      fileId: String(driveFileId),
      alt: "media",
      supportsAllDrives: true,
    },
    { responseType: "stream" }
  );
  return res.data;
}

module.exports = {
  isDriveConfigured,
  folderIdForCategory,
  uploadFile,
  getFileMetadata,
  downloadFileStream,
};
