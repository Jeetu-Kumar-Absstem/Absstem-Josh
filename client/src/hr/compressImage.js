function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("IMAGE_DECODE_FAILED"));
    };
    img.src = url;
  });
}

async function maybeConvertHeic(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  const looksHeic =
    type.includes("heic") ||
    type.includes("heif") ||
    name.endsWith(".heic") ||
    name.endsWith(".heif");
  if (!looksHeic) return file;

  try {
    const mod = await import("heic2any");
    const heic2any = mod.default || mod;
    const converted = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.9,
    });
    const blob = Array.isArray(converted) ? converted[0] : converted;
    return new File([blob], name.replace(/\.heic$/i, ".jpg").replace(/\.heif$/i, ".jpg") || "receipt.jpg", {
      type: "image/jpeg",
    });
  } catch {
    throw new Error("HEIC_UNSUPPORTED");
  }
}

function canvasToJpegBlob(img, maxEdge = 1280, quality = 0.72) {
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error("IMAGE_DECODE_FAILED");

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("COMPRESS_FAILED"));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

/**
 * Compress a receipt photo for mobile upload.
 * Returns { file, originalBytes, compressedBytes, previewUrl }.
 */
export async function compressReceiptImage(inputFile, options = {}) {
  const maxEdge = options.maxEdge || 1280;
  const quality = options.quality ?? 0.72;
  const maxBytes = options.maxBytes || 1.5 * 1024 * 1024;

  if (!inputFile) throw new Error("NO_FILE");

  let working = inputFile;
  try {
    working = await maybeConvertHeic(inputFile);
  } catch (err) {
    if (String(err?.message) === "HEIC_UNSUPPORTED") {
      const e = new Error("HEIC_UNSUPPORTED");
      e.code = "HEIC_UNSUPPORTED";
      throw e;
    }
    throw err;
  }

  let img;
  try {
    img = await loadImageElement(working);
  } catch {
    const e = new Error("IMAGE_DECODE_FAILED");
    e.code = "IMAGE_DECODE_FAILED";
    throw e;
  }

  const originalBytes = working.size || inputFile.size || 0;
  let blob = await canvasToJpegBlob(img, maxEdge, quality);

  // If still large, re-encode a bit smaller
  if (blob.size > maxBytes) {
    blob = await canvasToJpegBlob(img, Math.min(maxEdge, 1024), 0.6);
  }
  if (blob.size > maxBytes) {
    blob = await canvasToJpegBlob(img, 900, 0.5);
  }
  if (blob.size > maxBytes) {
    const e = new Error("STILL_TOO_LARGE");
    e.code = "STILL_TOO_LARGE";
    throw e;
  }

  const file = new File([blob], "receipt.jpg", { type: "image/jpeg" });
  const previewUrl = URL.createObjectURL(blob);
  return {
    file,
    originalBytes,
    compressedBytes: blob.size,
    previewUrl,
    label: `${formatBytes(originalBytes)} → ${formatBytes(blob.size)}`,
  };
}

export { formatBytes };
