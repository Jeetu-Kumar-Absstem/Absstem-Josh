import { useEffect, useState } from "react";
import { canAccessPage } from "./roleAccess";

async function fetchJson(path) {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

const EMPTY = {
  loading: true,
  salesDesk: null,
  shipment: null,
  collections: null,
  collectionsAnalytics: null,
  gl: null,
  credit: null,
  reconciliation: null,
  payables: null,
  receiving: null,
  vendorQuotes: null,
  procurementExceptions: null,
  externalProcessing: null,
  purchaseInvoices: null,
  materialReadiness: null,
  storesShortage: null,
  planningCapacity: null,
  productionExecution: null,
  bankBook: null,
  hrDesk: null,
  pilotFeedback: null,
  intercompany: null,
  einvoiceSettings: null,
  stockExceptions: null,
  engineering: null,
  serviceTickets: null,
  aftermarket: null,
  reverseLogistics: null,
  returnRework: null,
  serviceFailure: null,
  marketing: null,
  marketingCampaignAlerts: [],
  marketingExhibitionAlerts: [],
  myWork: { approvals: [], drafts: [], staleLeads: [], salesQueue: null },
  fieldDuty: null,
  fieldClaims: [],
};

/**
 * Mounts ONLY summary/bootstrap fetchers for the resolved HomeRoleFamily.
 * Cross-family APIs are never called (no UI tourism data).
 */
export function useHomeFamilyData(me, family) {
  const [data, setData] = useState(EMPTY);

  useEffect(() => {
    if (!me || !family) return undefined;
    let cancelled = false;

    setData((current) => ({ ...EMPTY, loading: true, myWork: current.myWork }));

    async function load() {
      const next = { ...EMPTY, loading: false };

      const tasks = [];

      const run = (key, promise, map) => {
        tasks.push(
          promise
            .then((raw) => {
              if (cancelled) return;
              map(next, raw);
            })
            .catch(() => {})
        );
      };

      if (family === "sales" || family === "operations" || family === "dispatch" || family === "executive" || family === "distributor") {
        if (canAccessPage(me, "quotes") || canAccessPage(me, "sales_orders") || canAccessPage(me, "dispatches") || canAccessPage(me, "invoices") || canAccessPage(me, "sales_desk")) {
          run("sales", fetchJson("/sales-desk/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.salesDesk = raw.summary || null;
          });
        }
        if (canAccessPage(me, "dispatches")) {
          run("ship", fetchJson("/dispatches/shipment-control-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.shipment = raw.summary || null;
          });
        }
      }

      if (family === "sales" || family === "distributor") {
        if (canAccessPage(me, "quotes")) {
          run("quotes", fetchJson("/quotes?limit=40"), (bucket, raw) => {
            const rows = Array.isArray(raw?.quotes) ? raw.quotes : Array.isArray(raw?.items) ? raw.items : [];
            const userId = Number(me.user_id || me.id);
            bucket.myWork.approvals = rows
              .filter((row) => String(row.status || row.revision_status || "").toLowerCase().includes("pending_approval"))
              .slice(0, 5);
            bucket.myWork.drafts = rows
              .filter((row) => {
                const status = String(row.status || row.revision_status || "").toLowerCase();
                const ownerId = Number(row.owner_user_id || row.created_by || row.owner_id);
                return status === "draft" && (!Number.isFinite(userId) || !Number.isFinite(ownerId) || ownerId === userId);
              })
              .slice(0, 5);
          });
        }
        if (canAccessPage(me, "leads")) {
          run("leads", fetchJson("/leads/my-queue?stale_days=7"), (bucket, raw) => {
            if (!raw?.ok) return;
            bucket.myWork.staleLeads = Array.isArray(raw.overdue) ? raw.overdue.slice(0, 5) : [];
            bucket.myWork.salesQueue = {
              summary: raw.summary || {},
              assigned: Array.isArray(raw.assigned) ? raw.assigned.slice(0, 5) : [],
              overdue: Array.isArray(raw.overdue) ? raw.overdue.slice(0, 5) : [],
              quoted_not_ordered: Array.isArray(raw.quoted_not_ordered) ? raw.quoted_not_ordered.slice(0, 5) : [],
              quotes_unconverted: Array.isArray(raw.quotes_unconverted) ? raw.quotes_unconverted.slice(0, 5) : [],
            };
          });
        }
        if (family === "sales" && canAccessPage(me, "engineering_desk")) {
          run("eng", fetchJson("/engineering-desk/bootstrap"), (bucket, raw) => {
            if (raw?.ok) bucket.engineering = raw.summary || raw || null;
          });
        }
      }

      if (family === "finance") {
        if (canAccessPage(me, "invoices") || canAccessPage(me, "receipts") || canAccessPage(me, "ar_desk")) {
          run("collections", fetchJson("/collections-desk/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.collections = raw.summary || null;
          });
          run("analytics", fetchJson("/collections-analytics/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.collectionsAnalytics = raw.summary || null;
          });
        }
        if (canAccessPage(me, "gl_desk")) {
          run("gl", fetchJson("/gl-desk/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.gl = raw.summary || null;
          });
        }
        if (canAccessPage(me, "receipts") || canAccessPage(me, "invoices") || canAccessPage(me, "customers")) {
          run("credit", fetchJson("/credit-control/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.credit = raw.summary || null;
          });
        }
        if (canAccessPage(me, "receipts") || canAccessPage(me, "invoices")) {
          run("recon", fetchJson("/reconciliation-desk/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.reconciliation = raw.summary || null;
          });
        }
        if (canAccessPage(me, "bank_book")) {
          run("bank", fetchJson("/bank-book/reconciliation-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.bankBook = raw.summary || null;
          });
        }
      }

      if (family === "executive") {
        if (canAccessPage(me, "ar_desk") || canAccessPage(me, "receipts") || canAccessPage(me, "invoices")) {
          run("collections", fetchJson("/collections-desk/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.collections = raw.summary || null;
          });
        }
        if (canAccessPage(me, "job_cards")) {
          run("execution", fetchJson("/job-cards/production-execution-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.productionExecution = raw.summary || null;
          });
        }
        if (canAccessPage(me, "service_tickets")) {
          run("tickets", fetchJson("/service-tickets/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.serviceTickets = raw.summary || null;
          });
        }
      }

      if (family === "procurement") {
        if (canAccessPage(me, "vendor_payments")) {
          run("payables", fetchJson("/vendor-payments/command-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.payables = raw.summary || null;
          });
        }
        if (canAccessPage(me, "goods_receipts")) {
          run("receiving", fetchJson("/goods-receipts/exceptions-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.receiving = raw.summary || null;
          });
        }
        if (canAccessPage(me, "vendor_quotes")) {
          run("vq", fetchJson("/vendor-quotes/bootstrap"), (bucket, raw) => {
            if (!raw?.ok) return;
            const requisitions = Array.isArray(raw.requisitions) ? raw.requisitions : [];
            bucket.vendorQuotes = {
              pending_rfq_pr_count: requisitions.length,
              pending_rfq_lines: requisitions.reduce((sum, row) => sum + Number(row.pending_lines || 0), 0),
              mail_configured: Boolean(raw.mail_configured),
            };
          });
        }
        if (canAccessPage(me, "purchase_orders") || canAccessPage(me, "purchase_requisitions")) {
          run("poex", fetchJson("/purchase-orders/exceptions-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.procurementExceptions = raw.summary || null;
          });
          run("ext", fetchJson("/purchase-orders/external-processing-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.externalProcessing = raw.summary || null;
          });
        }
        if (canAccessPage(me, "purchase_invoices")) {
          run("pi", fetchJson("/purchase-invoices/control-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.purchaseInvoices = raw.summary || null;
          });
        }
      }

      if (family === "operations") {
        if (canAccessPage(me, "job_cards")) {
          run("material", fetchJson("/job-cards/material-readiness-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.materialReadiness = raw.summary || null;
          });
          run("capacity", fetchJson("/job-cards/planning-capacity-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.planningCapacity = raw.summary || null;
          });
          run("execution", fetchJson("/job-cards/production-execution-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.productionExecution = raw.summary || null;
          });
        }
        if (canAccessPage(me, "engineering_desk")) {
          run("eng", fetchJson("/engineering-desk/bootstrap"), (bucket, raw) => {
            if (raw?.ok) bucket.engineering = raw.summary || raw || null;
          });
        }
      }

      if (family === "stores") {
        if (canAccessPage(me, "goods_receipts")) {
          run("receiving", fetchJson("/goods-receipts/exceptions-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.receiving = raw.summary || null;
          });
        }
        if (canAccessPage(me, "job_cards")) {
          run("shortage", fetchJson("/job-cards/stores-shortage-dashboard"), (bucket, raw) => {
            if (raw?.ok) bucket.storesShortage = raw.summary || null;
          });
        }
        if (canAccessPage(me, "stock_ledger")) {
          run("stockex", fetchJson("/stock-ledger/exceptions-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.stockExceptions = raw.summary || null;
          });
        }
      }

      // Global HR layer — any employee with My Duty & Expenses, every department.
      if (canAccessPage(me, "my_duty_expenses")) {
        run("duty", fetchJson("/hr/self/bootstrap"), (bucket, raw) => {
          if (raw?.ok) {
            bucket.fieldDuty = raw.duty || null;
            bucket.fieldClaims = Array.isArray(raw.claims) ? raw.claims : [];
          }
        });
      }

      if (family === "aftermarket") {
        if (canAccessPage(me, "service_tickets")) {
          run("tickets", fetchJson("/service-tickets/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.serviceTickets = raw.summary || null;
          });
        }
        if (canAccessPage(me, "aftermarket_desk")) {
          run("afm", fetchJson("/aftermarket-desk/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.aftermarket = raw.summary || null;
          });
        }
        if (canAccessPage(me, "service_warranty")) {
          run("fail", fetchJson("/service-warranty/failure-summary"), (bucket, raw) => {
            if (raw?.ok) bucket.serviceFailure = raw.summary || null;
          });
        }
        if (canAccessPage(me, "reverse_logistics")) {
          run("rev", fetchJson("/reverse-logistics/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.reverseLogistics = raw.summary || null;
          });
        }
        if (canAccessPage(me, "return_rework")) {
          run("rwk", fetchJson("/return-rework/summary"), (bucket, raw) => {
            if (raw?.ok) bucket.returnRework = raw.summary || null;
          });
        }
      }

      if (family === "marketing") {
        if (
          canAccessPage(me, "marketing_desk") ||
          canAccessPage(me, "campaigns") ||
          canAccessPage(me, "exhibitions")
        ) {
          run("mkt", fetchJson("/marketing/desk"), (bucket, raw) => {
            if (!raw?.ok) return;
            bucket.marketing = raw.summary || null;
            bucket.marketingCampaignAlerts = Array.isArray(raw.campaign_alerts) ? raw.campaign_alerts : [];
            bucket.marketingExhibitionAlerts = Array.isArray(raw.exhibition_alerts) ? raw.exhibition_alerts : [];
          });
        }
        if (canAccessPage(me, "leads")) {
          run("leads", fetchJson("/leads/my-queue?stale_days=7"), (bucket, raw) => {
            if (!raw?.ok) return;
            bucket.myWork.staleLeads = Array.isArray(raw.overdue) ? raw.overdue.slice(0, 5) : [];
            bucket.myWork.salesQueue = { summary: raw.summary || {} };
          });
        }
      }

      if (family === "hr") {
        if (canAccessPage(me, "hr_desk") || canAccessPage(me, "expenses") || canAccessPage(me, "leave") || canAccessPage(me, "attendance")) {
          run("hrdesk", fetchJson("/hr/desk"), (bucket, raw) => {
            if (!raw?.ok) return;
            bucket.hrDesk = {
              attendance_alerts: Array.isArray(raw.attendance_alerts) ? raw.attendance_alerts : [],
              expense_alerts: Array.isArray(raw.expense_alerts) ? raw.expense_alerts : [],
              leave_alerts: Array.isArray(raw.leave_alerts) ? raw.leave_alerts : [],
              salary_slip_alerts: Array.isArray(raw.salary_slip_alerts) ? raw.salary_slip_alerts : [],
              planner_alerts: Array.isArray(raw.planner_alerts) ? raw.planner_alerts : [],
              event_alerts: Array.isArray(raw.event_alerts) ? raw.event_alerts : [],
            };
          });
        }
      }

      if (family === "superadmin") {
        run("pilot", fetchJson("/hr/pilot-feedback/summary"), (bucket, raw) => {
          if (raw?.ok) bucket.pilotFeedback = raw.summary || raw || null;
        });
        run("ic", fetchJson("/intercompany-status"), (bucket, raw) => {
          if (!raw?.ok) return;
          const rows = Array.isArray(raw.rows) ? raw.rows : [];
          bucket.intercompany = {
            rows,
            mismatch_count: rows.filter((row) => {
              const statuses = [row.po_status, row.order_status, row.dispatch_status, row.grn_status, row.invoice_status, row.purchase_invoice_status]
                .map((v) => String(v || "").toLowerCase())
                .filter(Boolean);
              return statuses.some((s) => s.includes("draft") || s.includes("mismatch") || s.includes("pending") || s.includes("blocked"));
            }).length,
          };
        });
        run("einvoice", fetchJson("/admin-masters/einvoice-settings"), (bucket, raw) => {
          if (raw?.ok) bucket.einvoiceSettings = raw.settings || raw || null;
        });
      }

      // SuperAdmin operational summaries are loaded above when family matches.
      await Promise.all(tasks);
      if (!cancelled) setData(next);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [me, family]);

  return data;
}
