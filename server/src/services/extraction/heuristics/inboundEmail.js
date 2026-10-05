function text(value, fallback = "") {
  const s = typeof value === "string" ? value.trim() : "";
  return s || fallback;
}

function titleCaseWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function deriveCompanyFromEmail(email) {
  const domain = String(email || "").split("@")[1] || "";
  const bare = domain.replace(/\.(com|in|co\.in|net|org|biz|co)$/i, "");
  const root = bare.split(".").slice(-1)[0] || "";
  if (!root || ["gmail", "outlook", "hotmail", "yahoo", "icloud", "rediffmail"].includes(root.toLowerCase())) {
    return "";
  }
  return titleCaseWords(root.replace(/[-_]+/g, " "));
}

function parsePhone(blob) {
  const matches = String(blob || "").match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  for (const raw of matches) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15) return digits.slice(-10);
  }
  return "";
}

function parseEmailAddress(blob) {
  const m = String(blob || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : "";
}

/**
 * Heuristic inbound email → lead fields.
 */
function extractInboundEmailHeuristic({
  subject = "",
  fromName = "",
  fromEmail = "",
  bodyText = "",
  bodyPreview = "",
} = {}) {
  const blob = [subject, fromName, fromEmail, bodyText || bodyPreview].filter(Boolean).join("\n");
  const lines = String(bodyText || bodyPreview || "").split(/\r?\n/);

  let companyName = "";
  let contactName = "";
  let needSummary = "";

  for (const line of lines) {
    const companyMatch = line.match(/(?:company|organisation|organization|firm)\s*[:\-]\s*(.+)$/i);
    if (!companyName && companyMatch?.[1]) companyName = companyMatch[1].trim().slice(0, 200);
    const contactMatch = line.match(/(?:name|contact person|contact)\s*[:\-]\s*(.+)$/i);
    if (!contactName && contactMatch?.[1]) contactName = contactMatch[1].trim().slice(0, 160);
    const needMatch = line.match(/(?:looking for|need|requirement|enquiry|inquiry|interested in)\s*[:\-]?\s*(.+)$/i);
    if (!needSummary && needMatch?.[1]) needSummary = needMatch[1].trim().slice(0, 240);
  }

  if (!companyName) companyName = deriveCompanyFromEmail(fromEmail);
  if (!contactName) contactName = text(fromName).slice(0, 160);
  const phone = parsePhone(blob);
  const email = text(fromEmail).toLowerCase() || parseEmailAddress(blob);

  let score = 0.2;
  const missing = [];
  if (email) score += 0.25;
  else missing.push("email");
  if (companyName) score += 0.2;
  else missing.push("company_name");
  if (phone) score += 0.2;
  else missing.push("phone");
  if (contactName) score += 0.1;
  else missing.push("contact_name");
  if (text(subject)) score += 0.05;
  if (String(bodyText || bodyPreview || "").trim().length >= 40) score += 0.1;
  if (!needSummary) missing.push("need_summary");

  return {
    source: "heuristic",
    confidence: Math.min(score, 0.99),
    fields: {
      company_name: companyName || null,
      contact_name: contactName || null,
      email: email || null,
      phone: phone || null,
      need_summary: needSummary || text(subject).slice(0, 240) || null,
      subject: text(subject) || null,
    },
    missing_required: missing.filter((k) => ["company_name", "contact_name", "email"].includes(k)),
  };
}

module.exports = {
  extractInboundEmailHeuristic,
};
