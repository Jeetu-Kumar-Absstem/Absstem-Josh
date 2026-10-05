const QRCode = require("qrcode");

/**
 * Convert NIC signed QR payload string into a PNG data URL for Chromium PDF HTML.
 * Returns null on empty/invalid input — never throws (PDF must still download).
 */
async function signedQrToDataUrl(signedQrCode) {
  const payload = String(signedQrCode ?? "").trim();
  if (!payload) return null;
  try {
    return await QRCode.toDataURL(payload, {
      errorCorrectionLevel: "L",
      margin: 0,
      width: 320,
      type: "image/png",
    });
  } catch {
    return null;
  }
}

module.exports = { signedQrToDataUrl };
