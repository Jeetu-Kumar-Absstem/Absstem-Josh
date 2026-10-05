/**
 * Deterministic agentic drafts — zero LLM cost.
 * Build reviewable action cards; ConfirmDraftCard executes only after human click.
 */

function text(value, fallback = "") {
  const s = typeof value === "string" ? value.trim() : "";
  return s || fallback;
}

function num(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return digits > 0 ? (0).toFixed(digits) : "0";
  return digits > 0 ? n.toFixed(digits) : String(Math.trunc(n));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * @typedef {object} AiDraft
 * @property {string} id
 * @property {string} intent
 * @property {string} title
 * @property {string} rationale
 * @property {'high'|'medium'|'low'} confidence
 * @property {'deterministic'} source
 * @property {Array<{label:string,value:string}>} summary
 * @property {object} payload
 * @property {string} confirmLabel
 * @property {string} [cancelLabel]
 * @property {string} [confirmEndpoint]
 * @property {string} [confirmMethod]
 */

/** Lead → quote shell (optionally create/link customer via existing from-lead API). */
export function buildLeadToQuoteDraft({ lead, contacts = [] } = {}) {
  if (!lead?.id) return null;
  const primary =
    (contacts || []).find((c) => c.is_primary) ||
    (contacts || [])[0] ||
    null;
  const willCreateCustomer = !lead.customer_id;
  const companyName = text(lead.company_name, "Unknown company");

  return {
    id: `lead-quote-${lead.id}`,
    intent: "lead_to_quote",
    title: willCreateCustomer ? "Draft: create customer + quote shell" : "Draft: quote shell from lead",
    rationale: willCreateCustomer
      ? "Lead has no customer yet. Confirming will create/link the party master, then open a quote draft for review."
      : "Customer is already linked. Confirming opens a quote draft prefilled from this lead.",
    confidence: primary?.email || lead.customer_id ? "high" : "medium",
    source: "deterministic",
    summary: [
      { label: "Company", value: companyName },
      { label: "Lead", value: text(lead.lead_number, `#${lead.id}`) },
      { label: "Customer", value: willCreateCustomer ? "Will create / link from lead" : text(lead.customer_name, `Customer #${lead.customer_id}`) },
      { label: "Primary contact", value: primary ? [primary.full_name, primary.email, primary.phone].filter(Boolean).join(" · ") || "—" : "None on lead" },
      { label: "Attribution", value: text(lead.marketing_campaign_name || lead.marketing_exhibition_name || lead.lead_source_name, "Untagged") },
    ],
    payload: {
      lead_id: Number(lead.id),
      create_customer: willCreateCustomer,
    },
    confirmLabel: willCreateCustomer ? "Confirm customer + quote" : "Confirm quote shell",
    cancelLabel: "Keep editing lead",
    confirmEndpoint: `/quotes/from-lead/${lead.id}`,
    confirmMethod: "POST",
  };
}

/** Approved PR → PO draft for confirmation. */
export function buildPoFromPrDraft({
  requisition = null,
  vendor = null,
  currency = null,
} = {}) {
  if (!requisition?.id) return null;
  const vendorName = text(vendor?.company_name, vendor?.id ? `Vendor #${vendor.id}` : "");
  if (!vendor?.id) return null;

  return {
    id: `po-from-pr-${requisition.id}-${vendor.id}`,
    intent: "po_from_pr",
    title: "Draft: purchase order from requisition",
    rationale: "Lines and pending quantities come from the approved PR. Confirming creates a draft PO you can still edit before submit.",
    confidence: "high",
    source: "deterministic",
    summary: [
      { label: "Requisition", value: text(requisition.requisition_number, `#${requisition.id}`) },
      { label: "Department", value: text(requisition.department, "—") },
      { label: "Purpose", value: text(requisition.purpose, "—") },
      { label: "Pending qty", value: num(requisition.pending_qty, 2) },
      { label: "Vendor", value: vendorName },
      { label: "Currency", value: text(currency?.currency_code, currency?.id ? `Currency #${currency.id}` : "Company default") },
      { label: "Required by", value: requisition.required_by_date ? String(requisition.required_by_date).slice(0, 10) : "—" },
    ],
    payload: {
      requisition_id: Number(requisition.id),
      vendor_id: Number(vendor.id),
      order_currency_id: currency?.id ? Number(currency.id) : null,
    },
    confirmLabel: "Confirm create draft PO",
    cancelLabel: "Back to launch",
    confirmEndpoint: `/purchase-orders/from-requisition/${requisition.id}`,
    confirmMethod: "POST",
  };
}

/** AR collection action draft (call / promise / chase). */
export function buildArCollectionDraft({
  customer = null,
  mode = "follow_up",
  remarksOverride = null,
} = {}) {
  if (!customer?.customer_id && !customer?.id) return null;
  const customerId = Number(customer.customer_id || customer.id);
  const name = text(customer.customer_name, `Customer #${customerId}`);
  const outstanding = Number(customer.outstanding_amount || customer.promised_amount || 0);
  const ageing = Number(customer.max_ageing_days || customer.overdue_days || 0);
  const invoiceId = customer.last_action_invoice_id || customer.customer_invoice_id || null;

  if (mode === "promise_to_pay") {
    const expected = customer.next_followup_date || customer.expected_date
      ? String(customer.next_followup_date || customer.expected_date).slice(0, 10)
      : addDaysIso(7);
    const amountCandidate = Number(customer.promised_amount || customer.outstanding_amount || 0);
    const amount = amountCandidate > 0 ? amountCandidate : null;
    const remarks = text(
      remarksOverride,
      ageing >= 60
        ? `Promise requested — ${ageing}d ageing, outstanding ${num(outstanding, 2)}`
        : `Promise to pay — outstanding ${num(outstanding, 2)}`
    );
    return {
      id: `ar-promise-${customerId}-${Date.now()}`,
      intent: "ar_collection_action",
      title: "Draft: promise-to-pay follow-up",
      rationale: "Built from outstanding balance and next follow-up date. Confirming logs the promise on AR Desk — nothing is saved until you confirm.",
      confidence: amount ? "high" : "medium",
      source: "deterministic",
      summary: [
        { label: "Customer", value: name },
        { label: "Outstanding", value: num(outstanding, 2) },
        { label: "Ageing", value: `${ageing} day(s)` },
        { label: "Promised amount", value: amount != null ? num(amount, 2) : "Enter on confirm form" },
        { label: "Expected date", value: expected },
        { label: "Invoice link", value: invoiceId ? `#${invoiceId}` : "None" },
      ],
      payload: {
        customer_id: customerId,
        action_type: "promise_to_pay",
        expected_date: expected,
        promised_amount: amount,
        remarks,
        customer_invoice_id: invoiceId,
      },
      confirmLabel: "Confirm log promise",
      cancelLabel: "Dismiss draft",
      confirmEndpoint: `/collections-desk/customers/${customerId}/actions`,
      confirmMethod: "POST",
    };
  }

  const defaultRemarks =
    mode === "chase"
      ? Number(customer.overdue_days || 0) > 0
        ? `Broken promise chase — outstanding ${num(outstanding, 2)}.`
        : `Promise check-in — outstanding ${num(outstanding, 2)}.`
      : ageing >= 90
        ? `Called today — critical ageing ${ageing}d, outstanding ${num(outstanding, 2)}. Escalate if no commitment.`
        : ageing >= 45
          ? `Called today — ${ageing}d overdue, outstanding ${num(outstanding, 2)}. Asked for payment date.`
          : `Called today — outstanding ${num(outstanding, 2)}. Follow-up logged.`;
  const remarks = text(remarksOverride, defaultRemarks);

  return {
    id: `ar-call-${customerId}-${Date.now()}`,
    intent: "ar_collection_action",
    title: mode === "chase" ? "Draft: promise chase" : "Draft: log collection call",
    rationale: "Remark text is generated from ageing and outstanding. Confirming posts the follow-up action — edit remarks first if needed.",
    confidence: "high",
    source: "deterministic",
    summary: [
      { label: "Customer", value: name },
      { label: "Outstanding", value: num(outstanding, 2) },
      { label: "Ageing", value: `${ageing} day(s)` },
      { label: "Action", value: mode === "chase" ? "Promise chase" : "Follow-up / call" },
      { label: "Action date", value: todayIso() },
      { label: "Draft remarks", value: remarks },
    ],
    payload: {
      customer_id: customerId,
      action_type: "follow_up",
      expected_date: todayIso(),
      promised_amount: null,
      remarks,
      customer_invoice_id: invoiceId,
    },
    confirmLabel: mode === "chase" ? "Confirm log chase" : "Confirm log call",
    cancelLabel: "Dismiss draft",
    confirmEndpoint: `/collections-desk/customers/${customerId}/actions`,
    confirmMethod: "POST",
  };
}

function moneyLabel(value, currencyCode = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${currencyCode ? `${currencyCode} ` : ""}${n.toFixed(2)}`;
}

function ageingFromSubmitted(submittedAt) {
  if (!submittedAt) return 0;
  const d = new Date(submittedAt);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

function docTypeLabel(docType, docTypes = []) {
  return (docTypes || []).find((item) => item.key === docType)?.label || text(docType, "Document");
}

/** Procurement Approval Desk — draft remarks before approve / send-back / post. */
export function buildApprovalActionDraft({
  row = null,
  action = "approve",
  docTypes = [],
  existingRemarks = "",
} = {}) {
  if (!row?.doc_type || !row?.doc_id) return null;
  if (!["approve", "send_back", "post"].includes(action)) return null;

  const label = docTypeLabel(row.doc_type, docTypes);
  const amount = moneyLabel(row.total_amount, row.currency_code);
  const policy = text(row.policy_match_reason, "");
  const currentLevel = Number(row.current_approval_level || 0);
  const requiredLevel = Number(row.required_approval_level || 0);
  const nextLevel = Number(row.next_approval_level || 0);
  const ageing = Number(row.ageing_days);
  const ageDays = Number.isFinite(ageing) && ageing >= 0 ? ageing : ageingFromSubmitted(row.submitted_at);
  const party = text(row.vendor_name, "—");
  const seeded = text(existingRemarks);

  let remarks = seeded;
  if (!remarks) {
    if (action === "approve") {
      if (policy) {
        remarks = `Approved: ${policy}. Amount ${amount} is within the active approval routing.`;
      } else if (requiredLevel > 0) {
        remarks = `Approved at level ${currentLevel}/${requiredLevel}${nextLevel ? ` (next L${nextLevel})` : " (final)"}. Amount ${amount}.`;
      } else {
        remarks = `Approved. Amount ${amount}.`;
      }
      if (ageDays >= 2) remarks += ` Queue ageing ${ageDays}d.`;
    } else if (action === "send_back") {
      remarks = policy
        ? `Sent back: revise before resubmission. Policy note — ${policy}. Amount ${amount}.`
        : `Sent back: exceeds current approval readiness or needs correction. Amount ${amount}.`;
    } else {
      remarks = `Direct-posted. ${policy ? `Policy: ${policy}. ` : ""}Amount ${amount}.`;
    }
  }

  const actionTitle =
    action === "approve" ? "Approve" : action === "send_back" ? "Send back" : "Post direct";

  return {
    id: `approval-${action}-${row.doc_type}-${row.doc_id}`,
    intent: "approval_action",
    title: `Draft: ${actionTitle.toLowerCase()} ${label}`,
    rationale:
      "Remarks are built from policy band, approval level, amount, and queue age. Confirming stamps the decision — edit the remark first if needed.",
    confidence: policy || requiredLevel > 0 ? "high" : "medium",
    source: "deterministic",
    summary: [
      { label: "Document", value: `${label} ${text(row.doc_number, `#${row.doc_id}`)}` },
      { label: "Party", value: party },
      { label: "Amount", value: amount },
      { label: "Level", value: requiredLevel > 0 ? `${currentLevel} / ${requiredLevel}` : "One-step" },
      { label: "Next", value: text(row.next_approver, nextLevel ? `L${nextLevel}` : "Final") },
      { label: "Policy", value: policy || "Screen approver" },
      { label: "Ageing", value: `${ageDays}d` },
    ],
    payload: {
      doc_type: row.doc_type,
      doc_id: Number(row.doc_id),
      action,
      remarks,
    },
    confirmLabel: action === "approve" ? "Confirm approve" : action === "send_back" ? "Confirm send back" : "Confirm post",
    cancelLabel: "Keep reviewing",
    confirmEndpoint: "/approval-desk/action",
    confirmMethod: "POST",
  };
}

/** Sales Desk quote approve / reject — discount & authority aware remarks. */
export function buildQuoteApprovalDraft({
  quoteRow = null,
  approval = null,
  action = "approve",
  existingRemarks = "",
} = {}) {
  const quoteId = Number(quoteRow?.record_id || quoteRow?.id || 0);
  if (!Number.isFinite(quoteId) || quoteId <= 0) return null;
  if (!["approve", "reject"].includes(action)) return null;

  const maxDisc = Number(approval?.max_discount_pct);
  const autoDisc = Number(approval?.autonomous_discount_pct);
  const hasDisc = Number.isFinite(maxDisc) && Number.isFinite(autoDisc);
  const withinLimit = hasDisc && maxDisc <= autoDisc + 0.0001;
  const amount = moneyLabel(quoteRow?.amount || quoteRow?.total_amount);
  const customer = text(quoteRow?.customer_name, "—");
  const quoteNo = text(quoteRow?.record_number || quoteRow?.quote_number, `#${quoteId}`);
  const seeded = text(existingRemarks);

  let remarks = seeded;
  if (!remarks) {
    if (action === "approve") {
      remarks = hasDisc
        ? withinLimit
          ? `Approved: Discount ${maxDisc.toFixed(1)}% is within standard ${autoDisc.toFixed(1)}% autonomous limit.`
          : `Approved: Discount ${maxDisc.toFixed(1)}% exceeds autonomous ${autoDisc.toFixed(1)}% — manager override recorded.`
        : `Approved quote ${quoteNo}. Commercial review completed.`;
    } else {
      remarks = hasDisc
        ? `Rejected: Discount ${maxDisc.toFixed(1)}% exceeds financial authority ceiling of ${autoDisc.toFixed(1)}% (or commercials need revision).`
        : `Rejected: Quote ${quoteNo} needs commercial revision before resubmission.`;
    }
  }

  return {
    id: `quote-${action}-${quoteId}`,
    intent: "quote_approval_action",
    title: action === "approve" ? "Draft: approve quote" : "Draft: reject quote",
    rationale: hasDisc
      ? "Remark uses max line discount vs the requester’s autonomous discount ceiling. Confirming records the decision — edit first if needed."
      : "Built from quote queue state. Confirming records the decision — edit the remark first if needed.",
    confidence: hasDisc ? "high" : "medium",
    source: "deterministic",
    summary: [
      { label: "Quote", value: quoteNo },
      { label: "Customer", value: customer },
      { label: "Amount", value: amount },
      { label: "Max discount", value: hasDisc ? `${maxDisc.toFixed(1)}%` : "—" },
      { label: "Authority ceiling", value: hasDisc ? `${autoDisc.toFixed(1)}%` : "—" },
      { label: "Band", value: hasDisc ? (withinLimit ? "Within autonomous limit" : "Above autonomous limit") : "Review manually" },
    ],
    payload: {
      quote_id: quoteId,
      action,
      remarks,
    },
    confirmLabel: action === "approve" ? "Confirm approve quote" : "Confirm reject quote",
    cancelLabel: "Keep reviewing",
    confirmEndpoint: action === "approve" ? `/quotes/${quoteId}/approve` : `/quotes/${quoteId}/reject`,
    confirmMethod: "POST",
  };
}

/**
 * Aftermarket Desk triage — local confirm opens quote builder / AMC / service (no silent DB write).
 * triage: amc_renewal_quote | engineer_dispatch | service_follow_up | service_quote
 */
export function buildAftermarketTriageDraft({
  row = null,
  bucket = "",
  triage = null,
} = {}) {
  if (!row) return null;
  const stage = text(row.stage);
  const bucketKey = text(bucket);
  const recordId = Number(row.record_id || 0);
  const contractId = Number(row.amc_contract_id || (stage === "amc_contract" ? recordId : 0));
  const customerId = Number(row.customer_id || 0);
  const customerName = text(row.customer_name, "—");
  const recordNumber = text(row.record_number, recordId ? `#${recordId}` : "—");
  const due = row.due_date ? String(row.due_date).slice(0, 10) : "—";
  const ageing = Number(row.ageing_days || 0);

  let resolved =
    triage ||
    (bucketKey.startsWith("amc_expiring") || stage === "amc_contract"
      ? "amc_renewal_quote"
      : stage === "amc_visit"
        ? "engineer_dispatch"
        : stage === "service_case"
          ? Number(row.qty_pending_replacement || 0) > 0
            ? "service_quote"
            : "service_follow_up"
          : null);
  if (!resolved) return null;

  if (resolved === "amc_renewal_quote") {
    if (!Number.isFinite(contractId) || contractId <= 0) return null;
    const daysLeft = Number.isFinite(ageing) ? ageing : null;
    return {
      id: `afm-renewal-${contractId}`,
      intent: "aftermarket_triage",
      confirmMode: "local",
      title: "Draft: AMC renewal quote",
      rationale:
        "Contract end date is within the renewal window. Confirming opens the aftermarket quote builder prefilled from this AMC — the quote is not saved until you create it.",
      confidence: "high",
      source: "deterministic",
      summary: [
        { label: "Contract", value: recordNumber },
        { label: "Customer", value: customerName },
        { label: "Ends", value: due },
        { label: "Days left", value: daysLeft != null ? String(daysLeft) : "—" },
        { label: "Action", value: "Open renewal quote shell" },
      ],
      payload: {
        triage: "amc_renewal_quote",
        remarks: `AMC renewal follow-up for ${recordNumber} (ends ${due}).`,
        navigate: {
          kind: "aftermarket_quote",
          launch: {
            mode: "aftermarket_service",
            amc_contract_id: contractId,
            customer_id: Number.isFinite(customerId) && customerId > 0 ? customerId : null,
            customer_name: customerName !== "—" ? customerName : "",
            quote_origin: "amc_renewal",
            source_label: "AMC Renewal Quote",
            source_note: `Renewal draft for ${recordNumber}${due !== "—" ? ` ending ${due}` : ""}.`,
          },
        },
      },
      confirmLabel: "Confirm open renewal quote",
      cancelLabel: "Dismiss draft",
    };
  }

  if (resolved === "engineer_dispatch") {
    if (!Number.isFinite(contractId) || contractId <= 0) return null;
    return {
      id: `afm-dispatch-${row.record_id || contractId}`,
      intent: "aftermarket_triage",
      confirmMode: "local",
      title: "Draft: engineer dispatch",
      rationale:
        "Visit is due or overdue. Confirming opens the AMC contract so you can assign / complete the preventive visit — nothing is auto-posted.",
      confidence: "high",
      source: "deterministic",
      summary: [
        { label: "Contract", value: recordNumber },
        { label: "Customer", value: customerName },
        { label: "Visit", value: row.visit_no != null ? String(row.visit_no) : "—" },
        { label: "Due", value: due },
        { label: "Ageing", value: `${ageing}d` },
        { label: "Action", value: "Open AMC for engineer dispatch" },
      ],
      payload: {
        triage: "engineer_dispatch",
        remarks: ageing > 0
          ? `Overdue AMC visit chase — visit due ${due}, ageing ${ageing}d.`
          : `Schedule engineer for AMC visit due ${due}.`,
        navigate: {
          kind: "amc_contract",
          amc_contract_id: contractId,
        },
      },
      confirmLabel: "Confirm open AMC visit",
      cancelLabel: "Dismiss draft",
    };
  }

  if (resolved === "service_quote") {
    if (!Number.isFinite(recordId) || recordId <= 0) return null;
    return {
      id: `afm-svc-quote-${recordId}`,
      intent: "aftermarket_triage",
      confirmMode: "local",
      title: "Draft: aftermarket service quote",
      rationale:
        "Service case still has pending replacement qty. Confirming opens the aftermarket quote builder linked to this case — quote is not saved until you create it.",
      confidence: "high",
      source: "deterministic",
      summary: [
        { label: "Case", value: recordNumber },
        { label: "Customer", value: customerName },
        { label: "Pending replacement", value: num(row.qty_pending_replacement, 4) },
        { label: "Pending field return", value: num(row.qty_pending_field_return, 4) },
        { label: "Ageing", value: `${ageing}d` },
      ],
      payload: {
        triage: "service_quote",
        remarks: `Aftermarket quote for ${recordNumber} — pending replacement ${num(row.qty_pending_replacement, 4)}.`,
        navigate: {
          kind: "aftermarket_quote",
          launch: {
            mode: "aftermarket_service",
            service_warranty_case_id: recordId,
            customer_id: Number.isFinite(customerId) && customerId > 0 ? customerId : null,
            customer_name: customerName !== "—" ? customerName : "",
            quote_origin: "service_warranty",
            source_label: "Service Aftermarket Quote",
            source_note: `Create an aftermarket quote for ${recordNumber}.`,
          },
        },
      },
      confirmLabel: "Confirm open service quote",
      cancelLabel: "Dismiss draft",
    };
  }

  // service_follow_up
  if (!Number.isFinite(recordId) || recordId <= 0) return null;
  return {
    id: `afm-svc-follow-${recordId}`,
    intent: "aftermarket_triage",
    confirmMode: "local",
    title: "Draft: service case follow-up",
    rationale:
      "Case is open with pending field work. Confirming opens the service warranty case for triage — no status change until you act on the case.",
    confidence: "high",
    source: "deterministic",
    summary: [
      { label: "Case", value: recordNumber },
      { label: "Customer", value: customerName },
      { label: "Pending field return", value: num(row.qty_pending_field_return, 4) },
      { label: "Pending replacement", value: num(row.qty_pending_replacement, 4) },
      { label: "Ageing", value: `${ageing}d` },
      { label: "Dispatch", value: text(row.dispatch_number, "—") },
    ],
    payload: {
      triage: "service_follow_up",
      remarks:
        ageing >= 7
          ? `Stale service follow-up — ${recordNumber} open ${ageing}d with pending field work.`
          : `Service follow-up for ${recordNumber}.`,
      navigate: {
        kind: "service_case",
        service_case_id: recordId,
      },
    },
    confirmLabel: "Confirm open service case",
    cancelLabel: "Dismiss draft",
  };
}

/** Service Tickets — draft engineer assign before POST. */
export function buildServiceTicketAssignDraft({
  ticket = null,
  engineerUserId = null,
  engineerName = "",
} = {}) {
  const ticketId = Number(ticket?.id || 0);
  const engineerId = Number(engineerUserId);
  if (!Number.isFinite(ticketId) || ticketId <= 0) return null;
  if (!Number.isFinite(engineerId) || engineerId <= 0) return null;

  const ticketNo = text(ticket.ticket_number, `#${ticketId}`);
  const customer = text(ticket.customer_name, "—");
  const engName = text(engineerName, `Engineer #${engineerId}`);
  const remarks = `Assign ${engName} to ${ticketNo} for site response.`;

  return {
    id: `svc-assign-${ticketId}-${engineerId}`,
    intent: "service_ticket_assign",
    title: "Draft: engineer dispatch (assign)",
    rationale: "Built from the selected ticket and engineer. Confirming assigns the engineer — nothing is saved until you confirm.",
    confidence: "high",
    source: "deterministic",
    summary: [
      { label: "Ticket", value: ticketNo },
      { label: "Customer", value: customer },
      { label: "Status", value: text(ticket.ticket_status, "—") },
      { label: "Engineer", value: engName },
      { label: "Job asset", value: ticket.job_asset_id ? `#${ticket.job_asset_id}` : "Not linked" },
    ],
    payload: {
      ticket_id: ticketId,
      assigned_to_user_id: engineerId,
      remarks,
    },
    confirmLabel: "Confirm assign engineer",
    cancelLabel: "Dismiss draft",
    confirmEndpoint: `/service-tickets/${ticketId}/assign`,
    confirmMethod: "POST",
  };
}

/** Extraction: vendor quote PDF → receive (+ optional PO draft). */
export function buildVendorQuoteExtractDraft({
  extraction = null,
  context = {},
  vendorLabel = "",
} = {}) {
  if (!extraction?.fields) return null;
  const fields = extraction.fields;
  const lines = Array.isArray(fields.lines) ? fields.lines : [];
  const requisitionId = Number(context.purchase_requisition_id || 0);
  if (!Number.isFinite(requisitionId) || requisitionId <= 0) return null;

  const createPoAfter = context.create_po_after !== false;
  const linePreview = lines.length
    ? lines
        .slice(0, 3)
        .map((l) => `${l.item_code || l.item_name || "Line"} @ ${Number(l.unit_price || 0).toFixed(2)}`)
        .join("; ")
    : "No priced lines yet";

  return {
    id: `extract-vq-${requisitionId}-${Date.now()}`,
    intent: "vendor_quote_extract",
    title: createPoAfter ? "Draft: vendor quote → PO" : "Draft: vendor quote receive",
    rationale: extraction.used_slm
      ? "Heuristics left gaps, so the mock SLM filled commercials. Review/edit before confirm — nothing is saved until you confirm."
      : "Parsed with deterministic PDF/text heuristics. Review/edit before confirm — nothing is saved until you confirm.",
    confidence: extraction.confidence_label || (Number(extraction.confidence) >= 0.85 ? "high" : Number(extraction.confidence) >= 0.7 ? "medium" : "low"),
    source: extraction.source || "heuristic",
    sourceLabel: extraction.used_slm ? "heuristic+mock SLM" : "heuristic",
    summary: [
      { label: "Source", value: extraction.source || "heuristic" },
      { label: "Confidence", value: `${Math.round(Number(extraction.confidence || 0) * 100)}%` },
      { label: "Vendor", value: text(vendorLabel, "Selected on form") },
      { label: "Payment", value: text(fields.payment_terms, "—") },
      { label: "Credit / delivery", value: `${fields.credit_days ?? "—"}d / ${fields.delivery_days ?? "—"}d` },
      { label: "Quote ref", value: text(fields.quote_ref, "—") },
      { label: "Lines", value: `${lines.length} · ${linePreview}` },
      { label: "After confirm", value: createPoAfter ? "Receive quote, then create draft PO" : "Receive quote only" },
    ],
    editableFields: [
      { key: "payment_terms", label: "Payment terms", type: "text" },
      { key: "credit_days", label: "Credit days", type: "number" },
      { key: "delivery_days", label: "Delivery days", type: "number" },
      { key: "compliance_notes", label: "Compliance notes", type: "text" },
      { key: "remarks", label: "Remarks", type: "textarea", rows: 2 },
    ],
    payload: {
      purchase_requisition_id: requisitionId,
      purchase_rfq_vendor_id: context.purchase_rfq_vendor_id ? Number(context.purchase_rfq_vendor_id) : null,
      vendor_id: context.vendor_id ? Number(context.vendor_id) : null,
      payment_terms: fields.payment_terms || "",
      credit_days: fields.credit_days,
      delivery_days: fields.delivery_days,
      compliance_ok: fields.compliance_ok !== false,
      compliance_notes: fields.compliance_notes || "",
      remarks: fields.remarks || "Received via PDF extract.",
      lines: lines.map((l) => ({
        purchase_requisition_line_id: Number(l.purchase_requisition_line_id),
        qty: Number(l.qty || 0),
        unit_price: Number(l.unit_price || 0),
        freight_per_unit: Number(l.freight_per_unit || 0),
        gst_pct: Number(l.gst_pct || 0),
      })),
      create_po_after: createPoAfter,
    },
    confirmLabel: createPoAfter ? "Confirm receive + draft PO" : "Confirm receive quote",
    cancelLabel: "Discard extract",
    confirmEndpoint: "/vendor-quotes/receive",
    confirmMethod: "POST",
  };
}

/** Extraction: inbound email → lead convert draft. */
export function buildInboundLeadExtractDraft({
  extraction = null,
  inboundEmailId = null,
  item = null,
} = {}) {
  const fields = extraction?.fields || {};
  const id = Number(inboundEmailId || item?.id || 0);
  if (!Number.isFinite(id) || id <= 0) return null;

  const company = text(fields.company_name, text(item?.parse_company_name));
  const contact = text(fields.contact_name, text(item?.parse_contact_name, text(item?.from_name)));
  const email = text(fields.email, text(item?.from_email));
  const phone = text(fields.phone, text(item?.parse_phone));
  const need = text(fields.need_summary, text(item?.subject));

  return {
    id: `extract-lead-${id}-${Date.now()}`,
    intent: "inbound_lead_extract",
    title: "Draft: create lead from inbound email",
    rationale: extraction?.used_slm
      ? "Heuristics were incomplete; mock SLM filled gaps. Edit fields, then confirm to create the lead."
      : "Parsed with deterministic email heuristics. Edit fields, then confirm to create the lead.",
    confidence:
      extraction?.confidence_label ||
      (Number(extraction?.confidence) >= 0.85 ? "high" : Number(extraction?.confidence) >= 0.7 ? "medium" : "low"),
    source: extraction?.source || "heuristic",
    sourceLabel: extraction?.used_slm ? "heuristic+mock SLM" : "heuristic",
    summary: [
      { label: "Subject", value: text(item?.subject, text(fields.subject, "—")) },
      { label: "From", value: `${text(item?.from_name, "—")} <${email || "—"}>` },
      { label: "Source", value: extraction?.source || "heuristic" },
      { label: "Confidence", value: `${Math.round(Number(extraction?.confidence || 0) * 100)}%` },
      { label: "Need", value: need || "—" },
    ],
    editableFields: [
      { key: "company_name", label: "Company", type: "text" },
      { key: "contact_name", label: "Contact name", type: "text" },
      { key: "email", label: "Email", type: "text" },
      { key: "phone", label: "Phone", type: "text" },
      { key: "need_summary", label: "Need / enquiry", type: "textarea", rows: 2 },
    ],
    payload: {
      inbound_email_id: id,
      company_name: company,
      contact_name: contact,
      email,
      phone,
      need_summary: need,
    },
    confirmLabel: "Confirm create lead",
    cancelLabel: "Keep in queue",
    confirmEndpoint: `/inbound-lead-review/${id}/convert`,
    confirmMethod: "POST",
  };
}

export function draftBodyForConfirm(draft) {
  if (!draft?.payload) return "{}";
  if (draft.intent === "lead_to_quote") {
    return JSON.stringify({ create_customer: Boolean(draft.payload.create_customer) });
  }
  if (draft.intent === "po_from_pr") {
    const body = { vendor_id: Number(draft.payload.vendor_id) };
    if (Number.isFinite(Number(draft.payload.order_currency_id)) && Number(draft.payload.order_currency_id) > 0) {
      body.order_currency_id = Number(draft.payload.order_currency_id);
    }
    return JSON.stringify(body);
  }
  if (draft.intent === "ar_collection_action") {
    return JSON.stringify({
      action_type: draft.payload.action_type,
      expected_date: draft.payload.expected_date || null,
      promised_amount:
        draft.payload.action_type === "promise_to_pay" ? Number(draft.payload.promised_amount || 0) : null,
      customer_invoice_id: draft.payload.customer_invoice_id || null,
      remarks: draft.payload.remarks || "",
    });
  }
  if (draft.intent === "approval_action") {
    return JSON.stringify({
      doc_type: draft.payload.doc_type,
      doc_id: Number(draft.payload.doc_id),
      action: draft.payload.action,
      remarks: draft.payload.remarks || null,
    });
  }
  if (draft.intent === "quote_approval_action") {
    return JSON.stringify({ remarks: draft.payload.remarks || "" });
  }
  if (draft.intent === "aftermarket_triage") {
    return JSON.stringify({
      triage: draft.payload.triage,
      remarks: draft.payload.remarks || "",
      navigate: draft.payload.navigate || null,
    });
  }
  if (draft.intent === "service_ticket_assign") {
    return JSON.stringify({
      assigned_to_user_id: Number(draft.payload.assigned_to_user_id),
    });
  }
  if (draft.intent === "vendor_quote_extract") {
    const body = {
      payment_terms: draft.payload.payment_terms || null,
      credit_days: draft.payload.credit_days,
      delivery_days: draft.payload.delivery_days,
      compliance_ok: draft.payload.compliance_ok !== false,
      compliance_notes: draft.payload.compliance_notes || null,
      remarks: draft.payload.remarks || null,
      lines: Array.isArray(draft.payload.lines) ? draft.payload.lines : [],
    };
    if (draft.payload.purchase_rfq_vendor_id) {
      body.purchase_rfq_vendor_id = Number(draft.payload.purchase_rfq_vendor_id);
    } else {
      body.purchase_requisition_id = Number(draft.payload.purchase_requisition_id);
      body.vendor_id = Number(draft.payload.vendor_id);
    }
    return JSON.stringify(body);
  }
  if (draft.intent === "inbound_lead_extract") {
    return JSON.stringify({
      company_name: draft.payload.company_name || null,
      contact_name: draft.payload.contact_name || null,
      email: draft.payload.email || null,
      phone: draft.payload.phone || null,
      need_summary: draft.payload.need_summary || null,
    });
  }
  if (draft.intent === "inbound_lead_paste") {
    const contacts = [];
    if (draft.payload.contact_name || draft.payload.email || draft.payload.phone) {
      contacts.push({
        full_name: draft.payload.contact_name || "Inbound contact",
        email: draft.payload.email || null,
        phone: draft.payload.phone || null,
        is_primary: true,
      });
    }
    return JSON.stringify({
      company_name: draft.payload.company_name || "Inbound lead",
      status: "new",
      priority: "medium",
      contacts,
    });
  }
  return JSON.stringify(draft.payload);
}
