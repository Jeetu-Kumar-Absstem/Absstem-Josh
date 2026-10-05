const path = require("path");
const fs = require("fs");
const { PDFDocument } = require("pdf-lib");

const TARGET_MAX_BYTES = 500 * 1024; // < 500 KB

function resolveStorageDirectory() {
  const custom = process.env.VENDOR_DOCS_STORAGE_DIR;
  if (custom && custom.trim()) return custom.trim();
  // Production /opt/josh path or fallback to workspace storage
  if (fs.existsSync("/opt/josh/storage")) {
    return "/opt/josh/storage/vendor_docs";
  }
  return path.resolve(__dirname, "../../storage/vendor_docs");
}

function detectFileSignature(buffer) {
  if (!buffer || buffer.length < 4) return null;
  // PDF: %PDF- (0x25 0x50 0x44 0x46)
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return "pdf";
  }
  // JPEG: 0xFF 0xD8 0xFF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  // PNG: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }
  return null;
}

function safeFileStem(value) {
  const clean = String(value || "document")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return clean || "document";
}

async function compressAndNormalizeFile(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer)) {
    const error = new Error("FILE_BUFFER_REQUIRED");
    error.status = 400;
    error.code = "FILE_BUFFER_REQUIRED";
    throw error;
  }

  // 1. Validate file signature (magic numbers)
  const signature = detectFileSignature(file.buffer);
  if (!signature) {
    const error = new Error("INVALID_FILE_SIGNATURE");
    error.status = 400;
    error.code = "INVALID_FILE_SIGNATURE";
    error.detail = "Only valid PDF, JPEG, and PNG files are accepted. Corrupted or invalid headers detected.";
    throw error;
  }

  const originalName = String(file.originalname || "vendor-document");
  const originalExt = path.extname(originalName).toLowerCase();
  const baseStem = safeFileStem(path.basename(originalName, originalExt));

  // 2 & 3. Convert raster images to PDF or compress existing PDF
  const pdfDoc = await PDFDocument.create();

  if (signature === "pdf") {
    const sourcePdf = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
    const pageIndices = sourcePdf.getPageIndices();
    const copiedPages = await pdfDoc.copyPages(sourcePdf, pageIndices);
    copiedPages.forEach((page) => pdfDoc.addPage(page));
  } else if (signature === "jpeg") {
    const embeddedImg = await pdfDoc.embedJpg(file.buffer);
    const scale = Math.min(1, 540 / embeddedImg.width, 760 / embeddedImg.height);
    const page = pdfDoc.addPage([595, 842]);
    page.drawImage(embeddedImg, {
      x: (595 - embeddedImg.width * scale) / 2,
      y: (842 - embeddedImg.height * scale) / 2,
      width: embeddedImg.width * scale,
      height: embeddedImg.height * scale,
    });
  } else if (signature === "png") {
    const embeddedImg = await pdfDoc.embedPng(file.buffer);
    const scale = Math.min(1, 540 / embeddedImg.width, 760 / embeddedImg.height);
    const page = pdfDoc.addPage([595, 842]);
    page.drawImage(embeddedImg, {
      x: (595 - embeddedImg.width * scale) / 2,
      y: (842 - embeddedImg.height * scale) / 2,
      width: embeddedImg.width * scale,
      height: embeddedImg.height * scale,
    });
  }

  if (pdfDoc.getPageCount() === 0) {
    pdfDoc.addPage([595, 842]);
  }

  // Optimize and compress PDF by stripping unused objects and enabling object streams
  const compressedBytes = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });

  const finalBuffer = Buffer.from(compressedBytes);

  // 4. Force output size to target < 500 KB
  if (finalBuffer.length > TARGET_MAX_BYTES) {
    const error = new Error("NORMALIZED_DOCUMENT_TOO_LARGE");
    error.status = 400;
    error.code = "NORMALIZED_DOCUMENT_TOO_LARGE";
    error.detail = `Document '${originalName}' normalized size is ${Math.round(finalBuffer.length / 1024)} KB, which exceeds the 500 KB limit.`;
    throw error;
  }

  return {
    ...file,
    buffer: finalBuffer,
    size: finalBuffer.length,
    file_size_kb: Math.round(finalBuffer.length / 1024),
    originalname: `${baseStem}.pdf`,
    mimetype: "application/pdf",
    isNormalizedPdf: true,
  };
}

function documentCompressor() {
  return async function documentCompressorMiddleware(req, res, next) {
    try {
      if (req.file) {
        req.file = await compressAndNormalizeFile(req.file);
      }
      if (Array.isArray(req.files) && req.files.length > 0) {
        const processed = [];
        for (const file of req.files) {
          processed.push(await compressAndNormalizeFile(file));
        }
        req.files = processed;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  TARGET_MAX_BYTES,
  resolveStorageDirectory,
  detectFileSignature,
  compressAndNormalizeFile,
  documentCompressor,
};
