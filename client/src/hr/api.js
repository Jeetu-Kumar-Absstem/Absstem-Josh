export async function apiFetch(path, options) {
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

export function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (error?.data?.error === "FORBIDDEN") return "You do not have permission to complete that HR action.";
  if (error?.data?.error === "UNAUTHORIZED") return "Your session expired. Sign in again and retry.";
  if (error?.data?.error === "MISSING_FIELDS") return "Please complete the required HR fields and try again.";
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}
