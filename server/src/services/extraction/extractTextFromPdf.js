const zlib = require("zlib");

function unescapePdfString(raw) {
  let s = String(raw || "");
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1);
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function collectPrintable(buf) {
  const latin = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf || "");
  const chunks = [];
  const re = /\((?:\\.|[^\\)]){2,}\)/g;
  let match;
  while ((match = re.exec(latin))) {
    const value = unescapePdfString(match[0]).replace(/\0/g, " ").trim();
    if (value.length >= 2) chunks.push(value);
  }
  return chunks.join(" ");
}

/**
 * Deterministic PDF text scrape — no external OCR/LLM.
 * Works for many text-based vendor PDFs; scanned images will yield little text (then SLM mock fills gaps).
 */
function extractTextFromPdfBuffer(buffer) {
  if (!buffer || !buffer.length) return { text: "", method: "empty" };
  const latin = buffer.toString("latin1");
  if (!latin.includes("%PDF")) {
    const asUtf = buffer.toString("utf8").trim();
    return { text: asUtf, method: "plain_text" };
  }

  const parts = [];
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(latin))) {
    let data = Buffer.from(m[1].replace(/^\r?\n/, "").replace(/\r?\n$/, ""), "latin1");
    try {
      data = zlib.inflateSync(data);
    } catch {
      try {
        data = zlib.unzipSync(data);
      } catch {
        // keep raw stream bytes
      }
    }
    const scraped = collectPrintable(data);
    if (scraped) parts.push(scraped);
  }

  // Fallback: scrape string literals from the whole file.
  if (!parts.length) {
    const scraped = collectPrintable(buffer);
    if (scraped) parts.push(scraped);
  }

  // Last resort: printable run extraction
  if (!parts.length) {
    const runs = latin.match(/[\x20-\x7E\n\r\t]{6,}/g) || [];
    parts.push(runs.join("\n"));
  }

  const text = parts
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, method: "pdf_stream_heuristic" };
}

module.exports = {
  extractTextFromPdfBuffer,
};
