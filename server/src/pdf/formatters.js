/**
 * Shared PDF / financial-document formatters (Indian numbering + amount-in-words).
 */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || "";
}

function fmtMoney(value) {
  return num(value).toFixed(2);
}

function fmtMoneyWithSymbol(value, currencySymbol, currencyCode) {
  const amount = fmtMoney(value);
  const symbol = cleanText(currencySymbol);
  if (symbol) return `${symbol} ${amount}`;
  const code = cleanText(currencyCode);
  return code ? `${code} ${amount}` : amount;
}

function fmtQty(value) {
  const n = num(value);
  if (Math.abs(n - Math.round(n)) < 0.0001) return String(Math.round(n));
  return n.toFixed(3).replace(/\.?0+$/, "");
}

function fmtDate(value) {
  const dt = value ? new Date(value) : null;
  if (!dt || Number.isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function deriveStateCode(value) {
  const text = cleanText(value);
  if (!text) return "";
  const match = text.match(/^(\d{2})/);
  return match ? match[1] : "";
}

function normalizeStateName(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z]/g, "");
}

function joinAddressLines(parts) {
  return (Array.isArray(parts) ? parts : []).map(cleanText).filter(Boolean);
}

function numberToWordsIndian(value) {
  const n = Math.floor(Math.abs(num(value)));
  if (n === 0) return "Zero";

  const units = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function belowThousand(input) {
    const x = Math.floor(input);
    const parts = [];
    const hundreds = Math.floor(x / 100);
    const remainder = x % 100;
    if (hundreds) parts.push(`${units[hundreds]} Hundred`);
    if (remainder < 20) {
      if (remainder) parts.push(units[remainder]);
    } else {
      const ten = Math.floor(remainder / 10);
      const unit = remainder % 10;
      parts.push(`${tens[ten]}${unit ? ` ${units[unit]}` : ""}`);
    }
    return parts.join(" ").trim();
  }

  const groups = [
    { value: 10000000, label: "Crore" },
    { value: 100000, label: "Lakh" },
    { value: 1000, label: "Thousand" },
  ];

  let remainder = n;
  const out = [];
  for (const group of groups) {
    if (remainder >= group.value) {
      const quotient = Math.floor(remainder / group.value);
      remainder %= group.value;
      out.push(`${belowThousand(quotient)} ${group.label}`);
    }
  }
  if (remainder) out.push(belowThousand(remainder));
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function amountToWords(amount, currencyCode) {
  const totalPaise = Math.round(num(amount) * 100);
  const integerPart = Math.floor(totalPaise / 100);
  const paisePart = totalPaise % 100;
  const currency = cleanText(currencyCode || "INR").toUpperCase() || "INR";
  const major = numberToWordsIndian(integerPart);
  const minor = paisePart ? numberToWordsIndian(paisePart) : "";
  if (!minor) return `${currency} ${major} Only`;
  return `${currency} ${major} and Paise ${minor} Only`;
}

module.exports = {
  escapeHtml,
  num,
  cleanText,
  fmtMoney,
  fmtMoneyWithSymbol,
  fmtQty,
  fmtDate,
  deriveStateCode,
  normalizeStateName,
  joinAddressLines,
  numberToWordsIndian,
  amountToWords,
};
