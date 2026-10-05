export async function fetchNotificationSummary() {
  const res = await fetch("/notifications/summary", { credentials: "include" });
  if (!res.ok) return { unread_count: 0 };
  const data = await res.json().catch(() => null);
  return { unread_count: Number(data?.unread_count || 0) };
}

export async function fetchNotifications({ unreadOnly = false, limit = 20 } = {}) {
  const params = new URLSearchParams();
  if (unreadOnly) params.set("unread", "1");
  params.set("limit", String(limit));
  const res = await fetch(`/notifications?${params}`, { credentials: "include" });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return Array.isArray(data?.notifications) ? data.notifications : [];
}

export async function markNotificationRead(id) {
  await fetch(`/notifications/${id}/read`, { method: "POST", credentials: "include" });
}

export async function markAllNotificationsRead() {
  await fetch("/notifications/read-all", { method: "POST", credentials: "include" });
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export async function enableDesktopPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("PUSH_UNSUPPORTED");
  }
  const keyRes = await fetch("/notifications/push/vapid-public-key", { credentials: "include" });
  if (!keyRes.ok) throw new Error("PUSH_NOT_CONFIGURED");
  const keyData = await keyRes.json();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("PUSH_DENIED");

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
  });
  const json = sub.toJSON();
  const saveRes = await fetch("/notifications/push/subscribe", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(json),
  });
  if (!saveRes.ok) throw new Error("PUSH_SAVE_FAILED");
  return true;
}

/**
 * Real browser state instead of a remembered flag: "unsupported" | "denied" | "enabled" | "available".
 * An existing subscription is re-saved so a wiped server row heals itself.
 */
export async function getPushState() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "available";
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return "available";
    await fetch("/notifications/push/subscribe", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    }).catch(() => {});
    return "enabled";
  } catch {
    return "available";
  }
}

export async function fetchNotificationChannels() {
  const res = await fetch("/notifications/channels", { credentials: "include" });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export async function sendTestAlert() {
  const res = await fetch("/notifications/test", { method: "POST", credentials: "include" });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP_${res.status}`);
  return data.channels || {};
}
