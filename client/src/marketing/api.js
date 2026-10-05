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
  if (error?.data?.error === "FORBIDDEN") return "You do not have permission to complete that Marketing action.";
  if (error?.data?.error === "UNAUTHORIZED") return "Your session expired. Sign in again and retry.";
  if (error?.data?.error === "MISSING_FIELDS") return "Please complete the required Marketing fields and try again.";
  if (error?.data?.error === "LEAD_ATTRIBUTION_CONFLICT") return "Select either a campaign or an exhibition for the lead, not both.";
  if (error?.data?.error === "LEAD_ALREADY_ATTRIBUTED") {
    return "This lead is already attributed to another trade show campaign.";
  }
  if (error?.data?.error === "LEAD_NOT_ATTRIBUTED") {
    return "This lead is not attributed to that trade show campaign.";
  }
  if (error?.data?.error === "CAMPAIGN_AND_LEAD_REQUIRED") return "Select a lead and campaign before linking.";
  if (error?.data?.error === "CAMPAIGN_NOT_FOUND") return "That trade show campaign was not found.";
  if (error?.data?.error === "LEAD_NOT_FOUND") return "That lead was not found.";
  if (error?.data?.error === "AUDIENCE_NOT_SELECTED") return "Select an audience before sending the mailer.";
  if (error?.data?.error === "DISTRIBUTOR_REQUIRED") return "Select a distributor before sending to a distributor audience.";
  if (error?.data?.error === "NO_RECIPIENT") return "No email recipients were found for that audience.";
  if (error?.data?.error === "ALL_RECIPIENTS_OPTED_OUT") return "All recipients are unsubscribed from marketing emails.";
  if (error?.data?.error === "BREVO_NOT_CONFIGURED") return "Brevo is not configured. Set BREVO_API_KEY to sync the dormant newsletter list.";
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}
