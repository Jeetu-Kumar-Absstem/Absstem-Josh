import { canAccessPage } from "./roleAccess";

function n(value, digits = 0) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return digits > 0 ? (0).toFixed(digits) : "0";
  return digits > 0 ? num.toFixed(digits) : String(Math.trunc(num));
}

function push(items, item) {
  if (!item?.title || !item?.action) return;
  if (item.page && item.me && !canAccessPage(item.me, item.page)) return;
  items.push({
    id: item.id || `${item.kind || "task"}-${items.length}-${item.title}`,
    kind: item.kind || "task",
    title: item.title,
    body: item.body || "",
    action: item.action,
    onClick: item.onClick,
    page: item.page,
    priority: item.priority ?? 50,
  });
}

function readExpenseDraft() {
  try {
    const raw = window.sessionStorage.getItem("josh-my-expense-draft-meta-v1");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Global HR layer (all departments): duty + expenses.
 * When role blockers exist, these demote below desk work so My Day reflects the job first.
 */
function buildGlobalHrItems(me, data, onNavigate, { demote = false } = {}) {
  if (!canAccessPage(me, "my_duty_expenses")) return [];
  const items = [];
  const duty = data.fieldDuty;
  const openClaims = (data.fieldClaims || []).filter(
    (c) => c.status === "manager_pending" || c.status === "accounts_pending"
  ).length;
  const expenseDraft = readExpenseDraft();
  const dutyPriority = demote ? 55 : 1;
  const expensePriority = demote ? 56 : 2;

  if (!duty || !duty.in_time) {
    push(items, {
      me,
      kind: "field",
      priority: dutyPriority,
      page: "my_duty_expenses",
      title: "Check in to start your duty day",
      body: "Mark attendance so your day is on the record.",
      action: "Check in now",
      onClick: () => onNavigate("my_duty_expenses", { resetQuote: true }),
    });
  } else if (!duty.out_time) {
    push(items, {
      me,
      kind: "field",
      priority: dutyPriority,
      page: "my_duty_expenses",
      title: `Check out — duty open since ${duty.in_time}`,
      body: "Close attendance when your work day ends.",
      action: "Check out now",
      onClick: () => onNavigate("my_duty_expenses", { resetQuote: true }),
    });
  }

  if (expenseDraft || openClaims > 0) {
    push(items, {
      me,
      kind: "field",
      priority: expensePriority,
      page: "my_duty_expenses",
      title: expenseDraft
        ? "Finish your unsubmitted expense draft"
        : `Track ${n(openClaims)} expense claim${openClaims === 1 ? "" : "s"} in flight`,
      body: expenseDraft
        ? "Complete the receipt photo claim you started on this device."
        : "Follow manager / accounts pending claims from My Duty & Expenses.",
      action: expenseDraft ? "Finish expense draft" : "Open expenses",
      onClick: () => onNavigate("my_duty_expenses", { resetQuote: true }),
    });
  }

  return items;
}

function isZeroCountTitle(title) {
  // Verb-led titles put the count mid-sentence ("Review 3 pending…"). Treat first number as the signal.
  const match = String(title || "").match(/\b(\d+(?:\.\d+)?)\b/);
  return match ? Number(match[1]) === 0 : false;
}

function buildFamilyBlockers(me, family, data, onNavigate) {
  const items = [];

  if (family === "finance") {
    push(items, {
      me,
      page: "ar_desk",
      title: `Chase ${n(data.collections?.followups?.overdue_count)} overdue AR follow-ups`,
      body: "Log the next collection call or promise before the day fills up.",
      action: "Work overdue follow-ups",
      onClick: () => onNavigate("ar_desk", { resetQuote: true, arDeskLaunch: { panel: "followups", bucket: "overdue" } }),
    });
    push(items, {
      me,
      page: "ar_desk",
      title: `Re-promise ${n(data.collectionsAnalytics?.broken_promises)} broken payment promises`,
      body: "Customers missed committed receipt dates — chase or reset the promise.",
      action: "Open broken promises",
      onClick: () => onNavigate("ar_desk", { resetQuote: true, arDeskLaunch: { panel: "promises", bucket: "overdue" } }),
    });
    push(items, {
      me,
      page: "gl_desk",
      title: `Clear ${n(data.gl?.draft_journals)} draft journals · TB Δ ${n(data.gl?.trial_balance_diff_this_month, 2)}`,
      body: "Close readiness: post drafts and resolve trial-balance difference.",
      action: "Open GL close",
      onClick: () => onNavigate("gl_desk", { resetQuote: true, glDeskLaunch: { panel: "trial_balance" } }),
    });
    push(items, {
      me,
      page: "ar_desk",
      title: `Send ${n(data.collections?.followups?.dunning_overdue_count)} overdue dunning reminders`,
      body: "Invoice ladder dates slipped — fire the next reminder from AR Desk.",
      action: "Open dunning overdue",
      onClick: () => onNavigate("ar_desk", { resetQuote: true, arDeskLaunch: { panel: "followups", bucket: "dunning_overdue" } }),
    });
    push(items, {
      me,
      page: "bank_book",
      title: `Book ${n(data.bankBook?.unbooked_receipts_count)} receipts to the bank ledger`,
      body: "Posted receipts still missing a finance book link.",
      action: "Open bank reconciliation",
      onClick: () => onNavigate("bank_book", { resetQuote: true, bankBookLaunch: { bucket: "unbooked_receipts" } }),
    });
  } else if (family === "procurement") {
    push(items, {
      me,
      page: "vendor_quotes",
      title: `Run RFQ on ${n(data.vendorQuotes?.pending_rfq_pr_count)} ready purchase requisitions`,
      body: "Send RFQs, compare replies, and hand winners into PO.",
      action: "Open vendor quotes",
      onClick: () => onNavigate("vendor_quotes", { resetQuote: true, vendorQuotesLaunch: { mode: "rfq" } }),
    });
    push(items, {
      me,
      page: "goods_receipts",
      title: `Receive ${n(data.receiving?.pending_receipt_count)} pending goods receipts`,
      body: "GRNs waiting to land stock and close vendor risk.",
      action: "Open pending receipts",
      onClick: () => onNavigate("goods_receipts", { resetQuote: true, goodsReceiptsLaunch: { receiving_bucket: "pending_receipt" } }),
    });
    push(items, {
      me,
      page: "approval_desk",
      title: `Approve ${n(data.procurementExceptions?.pr_submitted_count)} submitted purchase requisitions`,
      body: "Requisitions still need an approval stamp before buy.",
      action: "Review PR approvals",
      onClick: () =>
        onNavigate("approval_desk", {
          resetQuote: true,
          approvalDeskLaunch: { doc_type: "purchase_requisition" },
        }),
    });
    push(items, {
      me,
      page: "approval_desk",
      title: `Approve ${n(data.procurementExceptions?.po_submitted_count)} submitted purchase orders`,
      body: "Purchase orders waiting for the next approval stamp.",
      action: "Review PO approvals",
      onClick: () =>
        onNavigate("approval_desk", {
          resetQuote: true,
          approvalDeskLaunch: { doc_type: "purchase_order" },
        }),
    });
    push(items, {
      me,
      page: "purchase_invoices",
      title: `Unblock ${n(data.purchaseInvoices?.match_blocked_count)} match-blocked purchase invoices`,
      body: "Posted PIs stuck on 3-way quantity mismatch.",
      action: "Open match-blocked PIs",
      onClick: () => onNavigate("purchase_invoices", { resetQuote: true, purchaseInvoicesLaunch: { control_bucket: "match_blocked" } }),
    });
    push(items, {
      me,
      page: "purchase_orders",
      title: `Chase ${n(data.procurementExceptions?.po_promise_overdue_count)} POs past promised date`,
      body: "Vendor delivery promises slipped — chase or re-promise.",
      action: "Open promise overdue",
      onClick: () => onNavigate("purchase_orders", { resetQuote: true, purchaseOrdersLaunch: { procurement_bucket: "po_promise_overdue" } }),
    });
    push(items, {
      me,
      page: "vendor_payments",
      title: `Clear ${n(data.payables?.overdue_groups)} overdue payable groups`,
      body: "Vendor payment pressure is building — clear overdue first.",
      action: "Pay overdue groups",
      onClick: () => onNavigate("vendor_payments", { resetQuote: true, vendorPaymentsLaunch: { command_bucket: "overdue" } }),
    });
    push(items, {
      me,
      page: "vendor_payments",
      title: `Resolve ${n(data.payables?.blocked_match_groups)} payables blocked by 3-way match`,
      body: "AP movement is stuck on receipt or invoice matching.",
      action: "Open blocked match",
      onClick: () => onNavigate("vendor_payments", { resetQuote: true, vendorPaymentsLaunch: { command_bucket: "blocked_match" } }),
    });
  } else if (family === "operations") {
    push(items, {
      me,
      page: "engineering_desk",
      title: `Answer ${n(data.engineering?.waiting_input_requests || data.engineering?.open_requests)} open engineering requests`,
      body: `${n(data.engineering?.quote_linked_open)} quote-linked — return datasheets so Sales can move.`,
      action: "Open engineering desk",
      onClick: () => onNavigate("engineering_desk", { resetQuote: true }),
    });
    push(items, {
      me,
      page: "dispatches",
      title: `Complete docs on ${n(data.shipment?.docs_pending)} live dispatches`,
      body: "Transporter, LR, vehicle, or eWay still missing on shipments.",
      action: "Clear docs gaps",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "docs_pending" } }),
    });
    push(items, {
      me,
      page: "dispatches",
      title: `Fix ${n(data.shipment?.eway_warning)} e-way gaps ≥ ₹50k`,
      body: "Structured Part A/B incomplete on consignments at or above the soft threshold.",
      action: "Open e-way warnings",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "eway_warning" } }),
    });
    push(items, {
      me,
      page: "dispatches",
      title: `Renew ${n(data.shipment?.eway_expired)} expired e-way bills in transit`,
      body: "Validity lapsed while shipment is still dispatched — renew or update Part B.",
      action: "Open expired e-ways",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "eway_expired", status: "dispatched" } }),
    });
    push(items, {
      me,
      page: "job_cards",
      title: `Clear ${n(data.materialReadiness?.shortageNotRaised || data.materialReadiness?.blockedSupply)} material / shortage blockers`,
      body: "Stores or RM gaps are holding jobs and dispatch readiness.",
      action: "Open material desk",
      onClick: () => onNavigate("job_cards", { resetQuote: true, jobCardsLaunch: { panel: "stores", material_bucket: "shortage_not_raised" } }),
    });
    push(items, {
      me,
      page: "job_cards",
      title: `Rebalance ${n(data.planningCapacity?.overdueJobs)} overdue capacity jobs`,
      body: "Planned job dates have slipped — fix the release queue.",
      action: "Open capacity overdue",
      onClick: () => onNavigate("job_cards", { resetQuote: true, jobCardsLaunch: { panel: "audit", capacity_bucket: "capacity_overdue" } }),
    });
    push(items, {
      me,
      page: "job_cards",
      title: `Unstick ${n(data.productionExecution?.stalledWip)} stalled WIP jobs`,
      body: "Open jobs with no movements — chase production or close.",
      action: "Open stalled WIP",
      onClick: () => onNavigate("job_cards", { resetQuote: true, jobCardsLaunch: { panel: "audit", execution_bucket: "stalled_wip" } }),
    });
  } else if (family === "dispatch") {
    push(items, {
      me,
      page: "dispatches",
      title: `Ship ${n(data.salesDesk?.dispatches?.ready)} dispatches ready to go`,
      body: "Packed and cleared — assign vehicle, print gatepass, and dispatch.",
      action: "Open ready dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { status: "ready" } }),
    });
    push(items, {
      me,
      page: "dispatches",
      title: `Complete docs on ${n(data.shipment?.docs_pending)} live dispatches`,
      body: "Transporter, LR, vehicle, or eWay still missing on shipments.",
      action: "Clear docs gaps",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "docs_pending" } }),
    });
    push(items, {
      me,
      page: "dispatches",
      title: `Fix ${n(data.shipment?.eway_warning)} e-way gaps ≥ ₹50k`,
      body: "Structured Part A/B incomplete on consignments at or above the soft threshold.",
      action: "Open e-way warnings",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "eway_warning" } }),
    });
    push(items, {
      me,
      page: "dispatches",
      title: `Renew ${n(data.shipment?.eway_expired)} expired e-way bills in transit`,
      body: "Validity lapsed while shipment is still dispatched — renew or update Part B.",
      action: "Open expired e-ways",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "eway_expired", status: "dispatched" } }),
    });
    push(items, {
      me,
      page: "dispatches",
      title: `Hand ${n(data.salesDesk?.dispatches?.dispatched_not_invoiced)} shipped dispatches to billing`,
      body: "Goods left the gate without a tax invoice.",
      action: "Open invoice lag",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "dispatched_not_invoiced" } }),
    });
  } else if (family === "executive") {
    push(items, {
      me,
      page: "sales_desk",
      title: `Review ${n(data.salesDesk?.quotes?.submitted)} quotes waiting for approval`,
      body: "Commercial approvals holding customer offers.",
      action: "Open approval inbox",
      onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_submitted" } }),
    });
    push(items, {
      me,
      page: "ar_desk",
      title: `Watch ${n(data.collections?.followups?.overdue_count)} overdue collection follow-ups`,
      body: "Cash is late — see who owes and who is chasing.",
      action: "Open AR Desk",
      onClick: () => onNavigate("ar_desk", { resetQuote: true, arDeskLaunch: { panel: "followups", bucket: "overdue" } }),
    });
    push(items, {
      me,
      page: "dispatches",
      title: `Bill ${n(data.salesDesk?.dispatches?.dispatched_not_invoiced)} dispatches shipped but not invoiced`,
      body: "Revenue left the gate without an invoice.",
      action: "Open invoice lag",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "dispatched_not_invoiced" } }),
    });
    push(items, {
      me,
      page: "job_cards",
      title: `Check ${n(data.productionExecution?.stalledWip)} stalled WIP jobs`,
      body: "Open jobs with no movement on the floor.",
      action: "Open stalled WIP",
      onClick: () => onNavigate("job_cards", { resetQuote: true, jobCardsLaunch: { panel: "audit", execution_bucket: "stalled_wip" } }),
    });
    push(items, {
      me,
      page: "service_tickets",
      title: `Follow ${n(data.serviceTickets?.overdue_count)} overdue service tickets`,
      body: "Customer breakdowns past their target date.",
      action: "Open service tickets",
      onClick: () => onNavigate("service_tickets", { resetQuote: true }),
    });
  } else if (family === "stores") {
    push(items, {
      me,
      page: "goods_receipts",
      title: `Receive ${n(data.receiving?.pending_receipt_count)} expected goods receipts`,
      body: "PO lines waiting to land in stores today.",
      action: "Open pending receipt",
      onClick: () => onNavigate("goods_receipts", { resetQuote: true, goodsReceiptsLaunch: { receiving_bucket: "pending_receipt" } }),
    });
    push(items, {
      me,
      page: "goods_receipts",
      title: `Post ${n(data.receiving?.grn_in_progress_count)} open GRNs`,
      body: "Draft or submitted receipts need posting.",
      action: "Open GRN in progress",
      onClick: () => onNavigate("goods_receipts", { resetQuote: true, goodsReceiptsLaunch: { receiving_bucket: "grn_in_progress" } }),
    });
    push(items, {
      me,
      page: "goods_receipts",
      title: `Start QC on ${n(data.receiving?.awaiting_qc_count)} posted GRNs`,
      body: "Stock is in — inspection has not started.",
      action: "Open awaiting QC",
      onClick: () => onNavigate("goods_receipts", { resetQuote: true, goodsReceiptsLaunch: { receiving_bucket: "awaiting_qc" } }),
    });
    push(items, {
      me,
      page: "goods_receipts",
      title: `Dispose ${n(data.receiving?.qc_hold_count)} QC holds`,
      body: "Held qty needs RTV, rework, or replacement disposition.",
      action: "Open QC hold",
      onClick: () => onNavigate("goods_receipts", { resetQuote: true, goodsReceiptsLaunch: { receiving_bucket: "qc_hold" } }),
    });
    push(items, {
      me,
      page: "job_cards",
      title: `Re-issue ${n(data.storesShortage?.readyForReissue)} ready pick lists`,
      body: "Shortage lines are received — issue RM to the floor.",
      action: "Open ready for reissue",
      onClick: () => onNavigate("job_cards", { resetQuote: true, jobCardsLaunch: { panel: "stores", material_bucket: "ready_reissue" } }),
    });
    push(items, {
      me,
      page: "stock_ledger",
      title: `Reconcile ${n(data.stockExceptions?.negative_count)} negative stock balances`,
      body: "Ledger shows below-zero qty — fix before more issues.",
      action: "Open stock exceptions",
      onClick: () => onNavigate("stock_ledger", { resetQuote: true, stockLedgerLaunch: { bucket: "negative" } }),
    });
  } else if (family === "aftermarket") {
    push(items, {
      me,
      page: "service_tickets",
      title: `Assign ${n(data.serviceTickets?.unassigned_count || data.serviceTickets?.open_count)} service tickets needing attention`,
      body: `${n(data.serviceTickets?.overdue_count)} overdue — schedule engineers and visits.`,
      action: "Open service tickets",
      onClick: () => onNavigate("service_tickets", { resetQuote: true, serviceTicketsLaunch: { filter: "unassigned" } }),
    });
    push(items, {
      me,
      page: "service_warranty",
      title: `Close ${n(data.serviceFailure?.actionOverdue)} overdue service actions`,
      body: "Field corrective actions are slipping — open the failure desk.",
      action: "Open failure desk",
      onClick: () => onNavigate("service_warranty", { resetQuote: true, serviceWarrantyLaunch: { failure_bucket: "action_overdue" } }),
    });
    push(items, {
      me,
      page: "aftermarket_desk",
      title: `Process ${n(data.aftermarket?.service?.pending_field_return?.case_count)} pending field returns`,
      body: "Customer-return flow is waiting on the aftermarket queue.",
      action: "Open aftermarket desk",
      onClick: () => onNavigate("aftermarket_desk", { resetQuote: true, aftermarketDeskLaunch: { bucket: "service_pending_field_return" } }),
    });
    push(items, {
      me,
      page: "aftermarket_desk",
      title: `Renew ${n(data.aftermarket?.amc?.expiring_7d || data.aftermarket?.amc?.expiring_30d)} AMC contracts before lapse`,
      body: "Coverage window is closing — start with the 7-day bucket.",
      action: "Open AMC renewals",
      onClick: () => onNavigate("aftermarket_desk", { resetQuote: true, aftermarketDeskLaunch: { bucket: "amc_expiring_7d" } }),
    });
  } else if (family === "marketing") {
    const topExhibition = data.marketingExhibitionAlerts?.[0];
    push(items, {
      me,
      page: topExhibition ? "leads" : "exhibitions",
      title: `Follow up ${n(data.marketingExhibitionAlerts?.length)} exhibition lead exceptions`,
      body: topExhibition ? `${topExhibition.title}: ${topExhibition.issue}` : "No open exhibition exceptions — keep attributed leads moving.",
      action: "Open exhibition work",
      onClick: () => {
        if (topExhibition) {
          onNavigate("leads", {
            resetQuote: true,
            leadsLaunch: { exhibitionId: String(topExhibition.id), assignedTo: "unassigned", campaignId: "" },
          });
          return;
        }
        onNavigate("exhibitions", { resetQuote: true });
      },
    });
    push(items, {
      me,
      page: "leads",
      title: `Chase ${n(data.myWork?.salesQueue?.summary?.overdue || data.myWork?.staleLeads?.length)} overdue / stale leads`,
      body: "Attributed demand waiting on fair follow-up.",
      action: "Open lead queue",
      onClick: () => onNavigate("leads", { resetQuote: true, leadsLaunch: { queue: "overdue" } }),
    });
  } else if (family === "sales" || family === "distributor") {
    if (family === "sales") {
      push(items, {
        me,
        page: "sales_desk",
        title: `Review ${n(data.salesDesk?.quotes?.submitted || data.myWork?.approvals?.length)} pending quote approvals`,
        body: "Approve or reject from Sales Desk without opening each quote first.",
        action: "Open approval inbox",
        onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_submitted" } }),
      });
      push(items, {
        me,
        page: "engineering_desk",
        title: `Unblock ${n(data.engineering?.waiting_input_requests || data.engineering?.quote_linked_open)} engineering waits on Sales`,
        body: `${n(data.engineering?.quote_linked_open)} quote-linked — clear datasheet / input gaps so Engineering can finish.`,
        action: "Clear engineering waits",
        onClick: () => onNavigate("engineering_desk", { resetQuote: true, engineeringDeskLaunch: { bucket: "waiting_input" } }),
      });
    }
    push(items, {
      me,
      page: "leads",
      title: `Chase ${n(data.myWork?.staleLeads?.length || data.myWork?.salesQueue?.summary?.overdue)} stale / overdue leads`,
      body: "Clear aging follow-ups in your personal queue.",
      action: "Open my lead queue",
      onClick: () => onNavigate("leads", { resetQuote: true, leadsLaunch: { queue: "overdue", assignedTo: "me" } }),
    });
    push(items, {
      me,
      page: "leads",
      title: `Complete ${n(data.myWork?.salesQueue?.summary?.due_today)} lead follow-ups due today`,
      body: "Dated next actions on your assigned leads.",
      action: "Open due today",
      onClick: () => onNavigate("leads", { resetQuote: true, leadsLaunch: { queue: "due_today", assignedTo: "me" } }),
    });
    push(items, {
      me,
      page: "leads",
      title: `Respond to ${n(data.myWork?.salesQueue?.summary?.sla_breached)} assign SLA breaches`,
      body: "Leads waiting for first response after handoff.",
      action: "Open SLA queue",
      onClick: () => onNavigate("leads", { resetQuote: true, leadsLaunch: { queue: "sla_breached", assignedTo: "me" } }),
    });
    push(items, {
      me,
      page: "quotes",
      title: `Convert ${n(data.salesDesk?.quotes?.approved_unconverted)} approved quotes to orders`,
      body: "Quotes ready for the next commercial step.",
      action: "Open unconverted quotes",
      onClick: () => onNavigate("quotes", { resetQuote: true, quotesLaunch: { bucket: "unconverted" } }),
    });
    push(items, {
      me,
      page: "quotes",
      title: `Chase ${n(data.salesDesk?.quotes?.expiring_7d)} quotes expiring in 7 days`,
      body: "Protect validity before the offer lapses.",
      action: "Open expiring quotes",
      onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_expiring" } }),
    });
    push(items, {
      me,
      page: "quotes",
      title: `Email ${n(data.salesDesk?.quotes?.issued_not_sent)} issued quotes still unsent`,
      body: "Commercial lock is done — the customer still needs the PDF.",
      action: "Open issued not sent",
      onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_issued_not_sent" } }),
    });
    push(items, {
      me,
      page: "quotes",
      title: `Revive or close ${n(data.salesDesk?.quotes?.lapsed)} lapsed quotes`,
      body: "Validity expired — set a new date or close the opportunity.",
      action: "Open lapsed quotes",
      onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_lapsed" } }),
    });
    push(items, {
      me,
      page: "dispatches",
      title: `Invoice ${n(data.salesDesk?.dispatches?.dispatched_not_invoiced)} dispatches still unbilled`,
      body: "Dispatch-to-billing handoff is lagging.",
      action: "Open invoice lag",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "dispatched_not_invoiced" } }),
    });
  } else if (family === "superadmin") {
    push(items, {
      me,
      page: "admin_masters",
      title: "Review admin masters and access controls",
      body: "Confirm company setup, masters, and rights before operators hit blockers.",
      action: "Open Admin Masters",
      onClick: () => onNavigate("admin_masters", { resetQuote: true }),
    });
    push(items, {
      me,
      page: "pilot_feedback",
      title: `Triage ${n(data.pilotFeedback?.open_count)} open pilot feedback notes`,
      body: "Clear confusing / blocked notes from the floor.",
      action: "Open pilot feedback",
      onClick: () => onNavigate("pilot_feedback", { resetQuote: true }),
    });
    push(items, {
      me,
      page: "intercompany_dashboard",
      title: `Review ${n(data.intercompany?.mismatch_count || data.intercompany?.rows?.length)} intercompany link rows`,
      body: "PO ↔ SO ↔ stock ↔ invoice links across companies.",
      action: "Open intercompany",
      onClick: () => onNavigate("intercompany_dashboard", { resetQuote: true }),
    });
    push(items, {
      me,
      page: "admin_masters",
      title: data.einvoiceSettings?.credential_env_configured === false || data.einvoiceSettings?.is_enabled === false
        ? "Complete e-invoice / GSP setup"
        : "Confirm e-invoice GSP settings",
      body: "Verify MasterGST credentials and environment before IRN / e-way ops.",
      action: "Open GSP settings",
      onClick: () => onNavigate("admin_masters", { resetQuote: true, adminMastersLaunch: { section: "einvoice_gsp" } }),
    });
  } else if (family === "hr") {
    push(items, {
      me,
      page: "expenses",
      title: `Approve ${n((data.hrDesk?.expense_alerts || []).length)} pending expense claims`,
      body: "Manager or accounts still needs to clear claims.",
      action: "Open expenses",
      onClick: () => onNavigate("expenses", { resetQuote: true }),
    });
    push(items, {
      me,
      page: "leave",
      title: `Decide ${n(data.hrDesk?.leave_alerts?.length)} pending leave requests`,
      body: "Approve or reject time-off before the day starts.",
      action: "Open leave",
      onClick: () => onNavigate("leave", { resetQuote: true }),
    });
    push(items, {
      me,
      page: "attendance",
      title: `Resolve ${n(data.hrDesk?.attendance_alerts?.length)} attendance exceptions`,
      body: "Late marks, missing punches, and regularizations waiting.",
      action: "Open attendance",
      onClick: () => onNavigate("attendance", { resetQuote: true }),
    });
    push(items, {
      me,
      page: "salary_slips",
      title: `Mark paid ${n(data.hrDesk?.salary_slip_alerts?.length)} unpaid salary slips`,
      body: "Payroll slips still not marked paid.",
      action: "Open salary slips",
      onClick: () => onNavigate("salary_slips", { resetQuote: true }),
    });
  }

  return items;
}

/**
 * Zone B ranking (department-first desks):
 * 1) Role blockers + approvals when the desk has real work
 * 2) For you notifications (optional; Home prefers Waiting on You strip)
 * 3) Duty check-in/out + expenses — demoted when role blockers exist
 */
export function buildMyDayItems({ me, family, data, forYou = [], onNavigate, onOpenNotification }) {
  const items = [];

  const familyBlockers = buildFamilyBlockers(me, family, data, onNavigate)
    .filter((item) => !isZeroCountTitle(item.title))
    .map((item) => ({ ...item, priority: item.priority ?? 15 }));
  const hasRoleBlockers = familyBlockers.length > 0;

  for (const item of buildGlobalHrItems(me, data, onNavigate, { demote: hasRoleBlockers })) {
    items.push(item);
  }

  for (const note of (forYou || []).slice(0, 3)) {
    push(items, {
      me,
      kind: "for_you",
      priority: 10,
      id: `fy-${note.id}`,
      title: note.title || "Assigned work",
      body: note.body || "Open your assigned item.",
      action: "Open assigned work",
      onClick: () => (typeof onOpenNotification === "function" ? onOpenNotification(note) : onNavigate(note.deep_link_page || "home", { resetQuote: true })),
    });
  }

  if (family === "sales" || family === "distributor") {
    for (const row of (data.myWork?.approvals || []).slice(0, 2)) {
      const id = row.id || row.quote_id;
      push(items, {
        me,
        kind: "approval",
        priority: 12,
        page: "sales_desk",
        id: `ap-${id}`,
        title: `Review approval for ${row.quote_number || `Quote #${id}`}`,
        body: "Waiting on your stamp — clear it on Sales Desk.",
        action: "Open approval inbox",
        onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_submitted" } }),
      });
    }
  }

  for (const item of familyBlockers) items.push(item);

  return items
    .sort((a, b) => (a.priority || 50) - (b.priority || 50))
    .slice(0, 7);
}

export function buildPulseChips({ me, family, data, onNavigate }) {
  const chips = [];
  const add = (chip) => {
    if (!chip?.label) return;
    if (chip.page && !canAccessPage(me, chip.page)) return;
    chips.push(chip);
  };

  if (canAccessPage(me, "my_duty_expenses")) {
    add({
      label: "Duty today",
      value: data.fieldDuty?.in_time ? (data.fieldDuty.out_time ? "Closed" : "On duty") : "Not in",
      page: "my_duty_expenses",
      onClick: () => onNavigate("my_duty_expenses", { resetQuote: true }),
    });
  }

  if (family === "finance") {
    add({
      label: "Overdue follow-ups",
      value: n(data.collections?.followups?.overdue_count),
      page: "ar_desk",
      onClick: () => onNavigate("ar_desk", { resetQuote: true, arDeskLaunch: { panel: "followups", bucket: "overdue" } }),
    });
    add({
      label: "Broken promises",
      value: n(data.collectionsAnalytics?.broken_promises),
      page: "ar_desk",
      onClick: () => onNavigate("ar_desk", { resetQuote: true, arDeskLaunch: { panel: "promises", bucket: "overdue" } }),
    });
    add({
      label: "Draft journals",
      value: n(data.gl?.draft_journals),
      page: "gl_desk",
      onClick: () => onNavigate("gl_desk", { resetQuote: true }),
    });
    add({
      label: "Over-limit customers",
      value: n(data.credit?.over_limit_count),
      page: "ar_desk",
      onClick: () => onNavigate("ar_desk", { resetQuote: true, arDeskLaunch: { panel: "credit_control", bucket: "over_limit" } }),
    });
    add({
      label: "Dunning overdue",
      value: n(data.collections?.followups?.dunning_overdue_count),
      page: "ar_desk",
      onClick: () => onNavigate("ar_desk", { resetQuote: true, arDeskLaunch: { panel: "followups", bucket: "dunning_overdue" } }),
    });
    add({
      label: "Unbooked receipts",
      value: n(data.bankBook?.unbooked_receipts_count),
      page: "bank_book",
      onClick: () => onNavigate("bank_book", { resetQuote: true, bankBookLaunch: { bucket: "unbooked_receipts" } }),
    });
  } else if (family === "procurement") {
    add({
      label: "RFQ backlog PRs",
      value: n(data.vendorQuotes?.pending_rfq_pr_count),
      page: "vendor_quotes",
      onClick: () => onNavigate("vendor_quotes", { resetQuote: true, vendorQuotesLaunch: { mode: "rfq" } }),
    });
    add({
      label: "Pending receipt",
      value: n(data.receiving?.pending_receipt_count),
      page: "goods_receipts",
      onClick: () => onNavigate("goods_receipts", { resetQuote: true, goodsReceiptsLaunch: { receiving_bucket: "pending_receipt" } }),
    });
    add({
      label: "Overdue AP groups",
      value: n(data.payables?.overdue_groups),
      page: "vendor_payments",
      onClick: () => onNavigate("vendor_payments", { resetQuote: true, vendorPaymentsLaunch: { command_bucket: "overdue" } }),
    });
    add({
      label: "PO awaiting approval",
      value: n(data.procurementExceptions?.po_submitted_count),
      page: "approval_desk",
      onClick: () =>
        onNavigate("approval_desk", {
          resetQuote: true,
          approvalDeskLaunch: { doc_type: "purchase_order" },
        }),
    });
    add({
      label: "PR submitted",
      value: n(data.procurementExceptions?.pr_submitted_count),
      page: "approval_desk",
      onClick: () =>
        onNavigate("approval_desk", {
          resetQuote: true,
          approvalDeskLaunch: { doc_type: "purchase_requisition" },
        }),
    });
    add({
      label: "PI match blocked",
      value: n(data.purchaseInvoices?.match_blocked_count),
      page: "purchase_invoices",
      onClick: () => onNavigate("purchase_invoices", { resetQuote: true, purchaseInvoicesLaunch: { control_bucket: "match_blocked" } }),
    });
    add({
      label: "QC hold",
      value: n(data.externalProcessing?.qc_hold_count),
      page: "purchase_orders",
      onClick: () => onNavigate("purchase_orders", { resetQuote: true, purchaseOrdersLaunch: { external_bucket: "qc_hold" } }),
    });
    add({
      label: "Replacement pending",
      value: n(data.externalProcessing?.replacement_pending_count),
      page: "purchase_orders",
      onClick: () => onNavigate("purchase_orders", { resetQuote: true, purchaseOrdersLaunch: { external_bucket: "replacement_pending" } }),
    });
  } else if (family === "operations") {
    add({
      label: "Eng waiting input",
      value: n(data.engineering?.waiting_input_requests || data.engineering?.overdue_open),
      page: "engineering_desk",
      onClick: () => onNavigate("engineering_desk", { resetQuote: true }),
    });
    add({
      label: "Docs pending",
      value: n(data.shipment?.docs_pending),
      page: "dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "docs_pending" } }),
    });
    add({
      label: "E-way warning",
      value: n(data.shipment?.eway_warning),
      page: "dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "eway_warning" } }),
    });
    add({
      label: "E-way expired",
      value: n(data.shipment?.eway_expired),
      page: "dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "eway_expired", status: "dispatched" } }),
    });
    add({
      label: "Shortage not raised",
      value: n(data.materialReadiness?.shortageNotRaised),
      page: "job_cards",
      onClick: () => onNavigate("job_cards", { resetQuote: true, jobCardsLaunch: { panel: "stores", material_bucket: "shortage_not_raised" } }),
    });
    add({
      label: "Capacity overdue",
      value: n(data.planningCapacity?.overdueJobs),
      page: "job_cards",
      onClick: () => onNavigate("job_cards", { resetQuote: true, jobCardsLaunch: { panel: "audit", capacity_bucket: "capacity_overdue" } }),
    });
    add({
      label: "Stalled WIP",
      value: n(data.productionExecution?.stalledWip),
      page: "job_cards",
      onClick: () => onNavigate("job_cards", { resetQuote: true, jobCardsLaunch: { panel: "audit", execution_bucket: "stalled_wip" } }),
    });
    if (canAccessPage(me, "sales_orders") || canAccessPage(me, "dispatches")) {
      add({
        label: "Dispatch not invoiced",
        value: n(data.salesDesk?.dispatches?.dispatched_not_invoiced),
        page: "dispatches",
        onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "dispatched_not_invoiced" } }),
      });
    }
  } else if (family === "dispatch") {
    add({
      label: "Dispatch ready",
      value: n(data.salesDesk?.dispatches?.ready),
      page: "dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { status: "ready" } }),
    });
    add({
      label: "Docs pending",
      value: n(data.shipment?.docs_pending),
      page: "dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "docs_pending" } }),
    });
    add({
      label: "E-way warning",
      value: n(data.shipment?.eway_warning),
      page: "dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "eway_warning" } }),
    });
    add({
      label: "E-way expired",
      value: n(data.shipment?.eway_expired),
      page: "dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "eway_expired", status: "dispatched" } }),
    });
    add({
      label: "Dispatch not invoiced",
      value: n(data.salesDesk?.dispatches?.dispatched_not_invoiced),
      page: "dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "dispatched_not_invoiced" } }),
    });
  } else if (family === "executive") {
    add({
      label: "Quotes pending approval",
      value: n(data.salesDesk?.quotes?.submitted),
      page: "sales_desk",
      onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_submitted" } }),
    });
    add({
      label: "Overdue AR follow-ups",
      value: n(data.collections?.followups?.overdue_count),
      page: "ar_desk",
      onClick: () => onNavigate("ar_desk", { resetQuote: true, arDeskLaunch: { panel: "followups", bucket: "overdue" } }),
    });
    add({
      label: "Dispatch not invoiced",
      value: n(data.salesDesk?.dispatches?.dispatched_not_invoiced),
      page: "dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { bucket: "dispatched_not_invoiced" } }),
    });
    add({
      label: "Stalled WIP",
      value: n(data.productionExecution?.stalledWip),
      page: "job_cards",
      onClick: () => onNavigate("job_cards", { resetQuote: true, jobCardsLaunch: { panel: "audit", execution_bucket: "stalled_wip" } }),
    });
    add({
      label: "Tickets open",
      value: n(data.serviceTickets?.open_count),
      page: "service_tickets",
      onClick: () => onNavigate("service_tickets", { resetQuote: true }),
    });
  } else if (family === "stores") {
    add({
      label: "Pending receipt",
      value: n(data.receiving?.pending_receipt_count),
      page: "goods_receipts",
      onClick: () => onNavigate("goods_receipts", { resetQuote: true, goodsReceiptsLaunch: { receiving_bucket: "pending_receipt" } }),
    });
    add({
      label: "GRN in progress",
      value: n(data.receiving?.grn_in_progress_count),
      page: "goods_receipts",
      onClick: () => onNavigate("goods_receipts", { resetQuote: true, goodsReceiptsLaunch: { receiving_bucket: "grn_in_progress" } }),
    });
    add({
      label: "Awaiting QC",
      value: n(data.receiving?.awaiting_qc_count),
      page: "goods_receipts",
      onClick: () => onNavigate("goods_receipts", { resetQuote: true, goodsReceiptsLaunch: { receiving_bucket: "awaiting_qc" } }),
    });
    add({
      label: "QC hold",
      value: n(data.receiving?.qc_hold_count),
      page: "goods_receipts",
      onClick: () => onNavigate("goods_receipts", { resetQuote: true, goodsReceiptsLaunch: { receiving_bucket: "qc_hold" } }),
    });
    add({
      label: "Ready to reissue",
      value: n(data.storesShortage?.readyForReissue),
      page: "job_cards",
      onClick: () => onNavigate("job_cards", { resetQuote: true, jobCardsLaunch: { panel: "stores", material_bucket: "ready_reissue" } }),
    });
    add({
      label: "Negative stock",
      value: n(data.stockExceptions?.negative_count),
      page: "stock_ledger",
      onClick: () => onNavigate("stock_ledger", { resetQuote: true, stockLedgerLaunch: { bucket: "negative" } }),
    });
  } else if (family === "aftermarket") {
    add({
      label: "Tickets open",
      value: n(data.serviceTickets?.open_count),
      page: "service_tickets",
      onClick: () => onNavigate("service_tickets", { resetQuote: true }),
    });
    add({
      label: "AMC overdue",
      value: n(data.aftermarket?.amc?.overdue_visits),
      page: "aftermarket_desk",
      onClick: () => onNavigate("aftermarket_desk", { resetQuote: true, aftermarketDeskLaunch: { bucket: "amc_overdue_visits" } }),
    });
    add({
      label: "AMC expiring 7d",
      value: n(data.aftermarket?.amc?.expiring_7d),
      page: "aftermarket_desk",
      onClick: () => onNavigate("aftermarket_desk", { resetQuote: true, aftermarketDeskLaunch: { bucket: "amc_expiring_7d" } }),
    });
    add({
      label: "Reverse stale 7d+",
      value: n(data.reverseLogistics?.stale_7d_lines),
      page: "reverse_logistics",
      onClick: () => onNavigate("reverse_logistics", { resetQuote: true, reverseLogisticsLaunch: { bucket: "stale_7d" } }),
    });
  } else if (family === "marketing") {
    add({
      label: "Exhibition alerts",
      value: n(data.marketingExhibitionAlerts?.length),
      page: "exhibitions",
      onClick: () => onNavigate("exhibitions", { resetQuote: true }),
    });
    add({
      label: "Campaign alerts",
      value: n(data.marketingCampaignAlerts?.length),
      page: "campaigns",
      onClick: () => onNavigate("campaigns", { resetQuote: true }),
    });
    add({
      label: "Overdue leads",
      value: n(data.myWork?.salesQueue?.summary?.overdue),
      page: "leads",
      onClick: () => onNavigate("leads", { resetQuote: true, leadsLaunch: { queue: "overdue" } }),
    });
  } else if (family === "sales" || family === "distributor") {
    add({
      label: "Pending approval",
      value: n(data.salesDesk?.quotes?.submitted),
      page: "sales_desk",
      onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_submitted" } }),
    });
    if (family === "sales") {
      add({
        label: "Eng waiting on Sales",
        value: n(data.engineering?.waiting_input_requests || data.engineering?.quote_linked_open),
        page: "engineering_desk",
        onClick: () => onNavigate("engineering_desk", { resetQuote: true, engineeringDeskLaunch: { bucket: "waiting_input" } }),
      });
    }
    add({
      label: "Approved not SO",
      value: n(data.salesDesk?.quotes?.approved_unconverted),
      page: "quotes",
      onClick: () => onNavigate("quotes", { resetQuote: true, quotesLaunch: { bucket: "unconverted" } }),
    });
    add({
      label: "Expiring 7d",
      value: n(data.salesDesk?.quotes?.expiring_7d),
      page: "sales_desk",
      onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_expiring" } }),
    });
    add({
      label: "Quote follow-ups",
      value: n(data.salesDesk?.quotes?.follow_up_due),
      page: "sales_desk",
      onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_follow_up_due" } }),
    });
    add({
      label: "Not emailed",
      value: n(data.salesDesk?.quotes?.issued_not_sent),
      page: "sales_desk",
      onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_issued_not_sent" } }),
    });
    add({
      label: "Lapsed quotes",
      value: n(data.salesDesk?.quotes?.lapsed),
      page: "sales_desk",
      onClick: () => onNavigate("sales_desk", { resetQuote: true, salesDeskLaunch: { bucket: "quotes_lapsed" } }),
    });
    add({
      label: "Dispatch ready",
      value: n(data.salesDesk?.dispatches?.ready),
      page: "dispatches",
      onClick: () => onNavigate("dispatches", { resetQuote: true, dispatchesLaunch: { status: "ready" } }),
    });
    add({
      label: "My overdue leads",
      value: n(data.myWork?.salesQueue?.summary?.overdue),
      page: "leads",
      onClick: () => onNavigate("leads", { resetQuote: true, leadsLaunch: { queue: "overdue", assignedTo: "me" } }),
    });
    add({
      label: "Due today",
      value: n(data.myWork?.salesQueue?.summary?.due_today),
      page: "leads",
      onClick: () => onNavigate("leads", { resetQuote: true, leadsLaunch: { queue: "due_today", assignedTo: "me" } }),
    });
    add({
      label: "SLA breached",
      value: n(data.myWork?.salesQueue?.summary?.sla_breached),
      page: "leads",
      onClick: () => onNavigate("leads", { resetQuote: true, leadsLaunch: { queue: "sla_breached", assignedTo: "me" } }),
    });
  } else if (family === "hr") {
    add({
      label: "Expense pending",
      value: n((data.hrDesk?.expense_alerts || []).length),
      page: "expenses",
      onClick: () => onNavigate("expenses", { resetQuote: true }),
    });
    add({
      label: "Leave pending",
      value: n((data.hrDesk?.leave_alerts || []).length),
      page: "leave",
      onClick: () => onNavigate("leave", { resetQuote: true }),
    });
    add({
      label: "Attendance alerts",
      value: n((data.hrDesk?.attendance_alerts || []).length),
      page: "attendance",
      onClick: () => onNavigate("attendance", { resetQuote: true }),
    });
    add({
      label: "Unpaid slips",
      value: n((data.hrDesk?.salary_slip_alerts || []).length),
      page: "salary_slips",
      onClick: () => onNavigate("salary_slips", { resetQuote: true }),
    });
  } else if (family === "superadmin") {
    add({
      label: "Pilot open",
      value: n(data.pilotFeedback?.open_count),
      page: "pilot_feedback",
      onClick: () => onNavigate("pilot_feedback", { resetQuote: true }),
    });
    add({
      label: "Intercompany",
      value: n(data.intercompany?.mismatch_count),
      page: "intercompany_dashboard",
      onClick: () => onNavigate("intercompany_dashboard", { resetQuote: true }),
    });
  }

  return chips.slice(0, 8);
}
