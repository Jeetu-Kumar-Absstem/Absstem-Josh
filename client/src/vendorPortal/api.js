export const VENDOR_TOKEN_KEY = "josh_vendor_portal_token";

export function getVendorToken() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(VENDOR_TOKEN_KEY) || "";
}

export function setVendorToken(token) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(VENDOR_TOKEN_KEY, token);
  else window.localStorage.removeItem(VENDOR_TOKEN_KEY);
}

function readPayload(response) {
  return response
    .json()
    .catch(() => ({}))
    .then((payload) => {
      if (!response.ok) {
        const message = payload?.detail || payload?.message || payload?.error || `Request failed (${response.status})`;
        const error = new Error(message);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    });
}

export async function vendorRequest(path, options = {}) {
  const { registered = false, body, ...rest } = options;
  const headers = new Headers(rest.headers || {});
  const token = registered ? getVendorToken() : "";
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body && !(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const requestPath = path.startsWith("/vendor-portal") ? `/api${path}` : path;
  const response = await fetch(requestPath, {
    ...rest,
    headers,
    body: body && !(body instanceof FormData) ? JSON.stringify(body) : body,
  });
  return readPayload(response);
}

export function asList(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

export function formatDate(value, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export function daysUntil(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.ceil((time - Date.now()) / 86400000);
}

export function statusTone(status = "") {
  const value = String(status).toLowerCase();
  if (/(expired|blocked|rejected|failed|declined|overdue)/.test(value)) return "danger";
  if (/(pending|review|warning|due|draft)/.test(value)) return "warning";
  if (/(approved|submitted|active|verified|complete|accepted)/.test(value)) return "success";
  return "info";
}
