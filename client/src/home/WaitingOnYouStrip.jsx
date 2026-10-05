/** Event types that mean the user must act (not FYI-only). */
export const WAITING_ON_YOU_EVENTS = new Set([
  "quote_approval_needed",
  "lead_assigned",
  "lead_follow_up_due",
  "expense_approval_needed",
  "leave_approval_needed",
  "engineering_request_assigned",
  "service_ticket_assigned",
  "service_visit_completed",
  "service_signed_report_uploaded",
]);

export function isWaitingOnYouItem(note) {
  if (!note || note.read_at) return false;
  const eventType = String(note.event_type || "").trim();
  if (WAITING_ON_YOU_EVENTS.has(eventType)) return true;
  // Fallback: any unread with a deep link is actionable
  return Boolean(note.deep_link_page);
}

export function waitingOnYouActionLabel(note) {
  const eventType = String(note?.event_type || "");
  if (eventType === "quote_approval_needed") return "Review & approve";
  if (eventType === "lead_assigned") return "Open lead";
  if (eventType === "lead_follow_up_due") return "Follow up";
  if (eventType === "expense_approval_needed" || eventType === "leave_approval_needed") return "Approve";
  if (eventType === "engineering_request_assigned") return "Open engineering";
  if (eventType === "service_ticket_assigned") return "Open ticket";
  if (eventType.startsWith("service_")) return "Open service";
  if (note?.deep_link_page === "quotes") return "Open quote";
  if (note?.deep_link_page === "leads") return "Open lead";
  if (note?.deep_link_page === "approval_desk") return "Open approval desk";
  return "Open";
}

export function waitingOnYouKicker(note) {
  const eventType = String(note?.event_type || "");
  if (eventType.includes("approval")) return "Approval needed";
  if (eventType === "lead_follow_up_due") return "Follow-up due";
  if (eventType.includes("assigned")) return "Assigned to you";
  if (eventType.startsWith("service_")) return "Service update";
  return "Action needed";
}

/**
 * High-visibility strip of For you items that need the signed-in user's action.
 */
export default function WaitingOnYouStrip({
  forYou = [],
  onOpenNotification = null,
  onEnablePush = null,
  pushEnabled = false,
  limit = 8,
}) {
  const items = (Array.isArray(forYou) ? forYou : []).filter(isWaitingOnYouItem).slice(0, limit);

  if (!items.length) {
    return (
      <section className="waiting-on-you waiting-on-you-empty" aria-label="Waiting on you">
        <div className="waiting-on-you-head">
          <div>
            <div className="panel-kicker">Inbox zero</div>
            <h3 className="waiting-on-you-title">Waiting on you</h3>
          </div>
          <div className="waiting-on-you-head-actions">
            <p className="waiting-on-you-copy">Nothing in your action queue. New approvals and assignments land here — not in email.</p>
            {typeof onEnablePush === "function" && !pushEnabled ? (
              <button type="button" className="button-ghost compact-button" onClick={onEnablePush}>
                Enable desktop alerts
              </button>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="waiting-on-you" aria-label="Waiting on you">
      <div className="waiting-on-you-head">
        <div>
          <div className="panel-kicker">Your next actions</div>
          <h3 className="waiting-on-you-title">
            Waiting on you <span className="waiting-on-you-count">{items.length}</span>
          </h3>
        </div>
        <div className="waiting-on-you-head-actions">
          <p className="waiting-on-you-copy">Clear these from Josh. Click a card to open the desk.</p>
          {typeof onEnablePush === "function" && !pushEnabled ? (
            <button type="button" className="button-ghost compact-button" onClick={onEnablePush}>
              Enable desktop alerts
            </button>
          ) : null}
        </div>
      </div>

      <div className="waiting-on-you-rail">
        {items.map((note) => (
          <button
            key={note.id}
            type="button"
            className="waiting-on-you-card"
            onClick={() => onOpenNotification?.(note)}
          >
            <span className="waiting-on-you-card-kicker">{waitingOnYouKicker(note)}</span>
            <strong className="waiting-on-you-card-title">{note.title || "Action needed"}</strong>
            {note.body ? <span className="waiting-on-you-card-body">{note.body}</span> : null}
            {Array.isArray(note.payload?.triggering_lines) && note.payload.triggering_lines.length ? (
              <span className="waiting-on-you-card-chips">
                {note.payload.triggering_lines.slice(0, 3).map((line) => (
                  <span key={line.line_id || `${line.line_no}-${line.item_name}`} className="waiting-on-you-chip">
                    #{line.line_no} {line.item_name} · {Number(line.discount_pct || 0).toFixed(1)}%
                  </span>
                ))}
              </span>
            ) : null}
            <span className="waiting-on-you-card-action">{waitingOnYouActionLabel(note)} →</span>
          </button>
        ))}
      </div>
    </section>
  );
}
