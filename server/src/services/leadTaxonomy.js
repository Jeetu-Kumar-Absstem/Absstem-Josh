const LIFECYCLE = {
  NEW_LEAD: "new_lead",
  MQL: "mql",
  SQL: "sql",
  NEGOTIATION: "negotiation",
  WON: "won",
  LOST: "lost",
  SHELVED: "shelved",
  CANCELLED: "cancelled",
};

const SALES_ACTIVITY = {
  UNCONTACTED: "uncontacted",
  CONTACTED: "contacted",
  FOLLOW_UP: "follow_up",
  QUOTE_SENT: "quote_sent",
  NEGOTIATION: "negotiation",
  ORDER_CLOSED: "order_closed",
  LOST_ORDER: "lost_order",
};

const TEMPERATURES = ["hot", "warm", "cold"];

const CONTACT_OUTCOMES = [
  "connected",
  "no_answer",
  "busy",
  "wrong_number",
  "callback_requested",
  "not_interested",
  "qualified_mql",
  "meeting_booked",
  "quotation_requested",
];

const CHANNELS = [
  "website",
  "google_lead_form",
  "meta_lead_form",
  "linkedin_lead_form",
  "whatsapp",
  "telephony_tollfree",
  "qr_form",
  "exhibition_form",
  "email_inbound",
  "manual",
];

const LEGACY_TO_LIFECYCLE = {
  new: LIFECYCLE.NEW_LEAD,
  qualified: LIFECYCLE.MQL,
  follow_up: LIFECYCLE.SQL,
  quoted: LIFECYCLE.NEGOTIATION,
  order_won: LIFECYCLE.WON,
  lost: LIFECYCLE.LOST,
  closed: LIFECYCLE.SHELVED,
  closed_no_action: LIFECYCLE.SHELVED,
  cancelled: LIFECYCLE.CANCELLED,
};

const LIFECYCLE_TO_LEGACY = {
  [LIFECYCLE.NEW_LEAD]: "new",
  [LIFECYCLE.MQL]: "qualified",
  [LIFECYCLE.SQL]: "follow_up",
  [LIFECYCLE.NEGOTIATION]: "quoted",
  [LIFECYCLE.WON]: "order_won",
  [LIFECYCLE.LOST]: "lost",
  [LIFECYCLE.SHELVED]: "closed",
  [LIFECYCLE.CANCELLED]: "cancelled",
};

const LEGACY_TO_ACTIVITY = {
  new: SALES_ACTIVITY.UNCONTACTED,
  qualified: SALES_ACTIVITY.CONTACTED,
  follow_up: SALES_ACTIVITY.FOLLOW_UP,
  quoted: SALES_ACTIVITY.QUOTE_SENT,
  order_won: SALES_ACTIVITY.ORDER_CLOSED,
  lost: SALES_ACTIVITY.LOST_ORDER,
  closed: SALES_ACTIVITY.FOLLOW_UP,
  closed_no_action: SALES_ACTIVITY.FOLLOW_UP,
  cancelled: SALES_ACTIVITY.LOST_ORDER,
};

const ACTIVITY_TO_LEGACY = {
  [SALES_ACTIVITY.UNCONTACTED]: "new",
  [SALES_ACTIVITY.CONTACTED]: "qualified",
  [SALES_ACTIVITY.FOLLOW_UP]: "follow_up",
  [SALES_ACTIVITY.QUOTE_SENT]: "quoted",
  [SALES_ACTIVITY.NEGOTIATION]: "quoted",
  [SALES_ACTIVITY.ORDER_CLOSED]: "order_won",
  [SALES_ACTIVITY.LOST_ORDER]: "lost",
};

function normalizeLifecycle(value, fallback = LIFECYCLE.NEW_LEAD) {
  const raw = String(value || "").trim().toLowerCase();
  if (Object.values(LIFECYCLE).includes(raw)) return raw;
  if (LEGACY_TO_LIFECYCLE[raw]) return LEGACY_TO_LIFECYCLE[raw];
  return fallback;
}

function normalizeSalesActivity(value, fallback = SALES_ACTIVITY.UNCONTACTED) {
  const raw = String(value || "").trim().toLowerCase();
  if (Object.values(SALES_ACTIVITY).includes(raw)) return raw;
  if (LEGACY_TO_ACTIVITY[raw]) return LEGACY_TO_ACTIVITY[raw];
  return fallback;
}

function normalizeTemperature(value, fallback = "warm") {
  const raw = String(value || "").trim().toLowerCase();
  return TEMPERATURES.includes(raw) ? raw : fallback;
}

function dualWriteFromLegacy(status) {
  return {
    status,
    lifecycle_status: LEGACY_TO_LIFECYCLE[status] || LIFECYCLE.NEW_LEAD,
    sales_activity_status: LEGACY_TO_ACTIVITY[status] || SALES_ACTIVITY.UNCONTACTED,
  };
}

function dualWriteFromLifecycle(lifecycleStatus) {
  const lifecycle_status = normalizeLifecycle(lifecycleStatus);
  return {
    lifecycle_status,
    status: LIFECYCLE_TO_LEGACY[lifecycle_status] || "new",
  };
}

function dualWriteFromActivity(salesActivityStatus) {
  const sales_activity_status = normalizeSalesActivity(salesActivityStatus);
  return {
    sales_activity_status,
    status: ACTIVITY_TO_LEGACY[sales_activity_status] || "new",
  };
}

function taxonomyPayload() {
  return {
    lifecycle: [
      { code: LIFECYCLE.NEW_LEAD, label: "New Lead" },
      { code: LIFECYCLE.MQL, label: "MQL" },
      { code: LIFECYCLE.SQL, label: "SQL" },
      { code: LIFECYCLE.NEGOTIATION, label: "Negotiation" },
      { code: LIFECYCLE.WON, label: "Won" },
      { code: LIFECYCLE.LOST, label: "Lost" },
      { code: LIFECYCLE.SHELVED, label: "Shelved" },
      { code: LIFECYCLE.CANCELLED, label: "Cancelled" },
    ],
    sales_activity: [
      { code: SALES_ACTIVITY.UNCONTACTED, label: "Uncontacted" },
      { code: SALES_ACTIVITY.CONTACTED, label: "Contacted" },
      { code: SALES_ACTIVITY.FOLLOW_UP, label: "Follow-up" },
      { code: SALES_ACTIVITY.QUOTE_SENT, label: "Quote Sent" },
      { code: SALES_ACTIVITY.NEGOTIATION, label: "Negotiation" },
      { code: SALES_ACTIVITY.ORDER_CLOSED, label: "Order Closed" },
      { code: SALES_ACTIVITY.LOST_ORDER, label: "Lost Order" },
    ],
    temperatures: TEMPERATURES.map((code) => ({ code, label: code[0].toUpperCase() + code.slice(1) })),
    contact_outcomes: CONTACT_OUTCOMES,
    channels: CHANNELS,
  };
}

async function applyLeadCommercialProgress(client, leadId, { quoted = false, won = false, lost = false } = {}) {
  const id = Number(leadId);
  if (!Number.isFinite(id) || id <= 0) return;
  if (quoted) {
    await client.query(
      `
        update leads
        set
          status = case when status = 'order_won' then status else 'quoted' end,
          lifecycle_status = case when lifecycle_status in ('won', 'lost', 'cancelled') then lifecycle_status else 'negotiation' end,
          sales_activity_status = case
            when sales_activity_status in ('order_closed', 'lost_order') then sales_activity_status
            else 'quote_sent'
          end,
          last_sales_engagement_at = now(),
          updated_at = now()
        where id = $1
      `,
      [id]
    );
  }
  if (won) {
    await client.query(
      `
        update leads
        set
          status = 'order_won',
          lifecycle_status = 'won',
          sales_activity_status = 'order_closed',
          last_sales_engagement_at = now(),
          newsletter_segment = null,
          dormant_since = null,
          updated_at = now()
        where id = $1
      `,
      [id]
    );
  }
  if (lost) {
    await client.query(
      `
        update leads
        set
          status = 'lost',
          lifecycle_status = 'lost',
          sales_activity_status = 'lost_order',
          last_sales_engagement_at = now(),
          updated_at = now()
        where id = $1
      `,
      [id]
    );
  }
}

module.exports = {
  LIFECYCLE,
  SALES_ACTIVITY,
  TEMPERATURES,
  CONTACT_OUTCOMES,
  CHANNELS,
  LEGACY_TO_LIFECYCLE,
  LIFECYCLE_TO_LEGACY,
  normalizeLifecycle,
  normalizeSalesActivity,
  normalizeTemperature,
  dualWriteFromLegacy,
  dualWriteFromLifecycle,
  dualWriteFromActivity,
  taxonomyPayload,
  applyLeadCommercialProgress,
};
