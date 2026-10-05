const express = require("express");
const session = require("express-session");
const passport = require("passport");
const { pool } = require("./db/pool");
const { loadUserContextById } = require("./auth/userContext");

const pgSession = require("connect-pg-simple")(session);

const { registerGoogleStrategy } = require("./auth/googleStrategy");
const { registerGoogleMailStrategy } = require("./auth/googleMailStrategy");
const authRoutes = require("./routes/auth");
const mailAccountsRoutes = require("./routes/mailAccounts");
const leadsRoutes = require("./routes/leads");
const leadsIngestRoutes = require("./routes/leadsIngest");
const geoRoutes = require("./routes/geo");
const customersRoutes = require("./routes/customers");
const quotesRoutes = require("./routes/quotes");
const salesOrdersRoutes = require("./routes/salesOrders");
const dispatchesRoutes = require("./routes/dispatches");
const proformaInvoicesRoutes = require("./routes/proformaInvoices");
const invoicesRoutes = require("./routes/invoices");
const salesDeskRoutes = require("./routes/salesDesk");
const inboundLeadReviewRoutes = require("./routes/inboundLeadReview");
const extractionRoutes = require("./routes/extraction");
const collectionsDeskRoutes = require("./routes/collectionsDesk");
const collectionsAnalyticsRoutes = require("./routes/collectionsAnalytics");
const creditControlRoutes = require("./routes/creditControl");
const reconciliationDeskRoutes = require("./routes/reconciliationDesk");
const receiptsRoutes = require("./routes/receipts");
const glDeskRoutes = require("./routes/glDesk");
const financeLandedCostRoutes = require("./routes/financeLandedCost");
const tallyExportRoutes = require("./routes/tallyExport");
const purchaseOrdersRoutes = require("./routes/purchaseOrders");
const purchaseRequisitionsRoutes = require("./routes/purchaseRequisitions");
const vendorQuotesRoutes = require("./routes/vendorQuotes");
const vendorPortalRoutes = require("./routes/vendorPortal");
const vendorPortalExecutiveRoutes = vendorPortalRoutes.executiveRouter;
const shopFloorRoutes = require("./routes/shopFloor");
const salesCommercialRoutes = require("./routes/sales");
const financeAccountingRoutes = require("./routes/finance");
const serviceMaintenanceRoutes = require("./routes/service");
const executiveAnalyticsRoutes = require("./routes/executive");
const mrpPlanningRoutes = require("./routes/mrp");
const adminGovernanceRoutes = require("./routes/admin");
const dataOpsRoutes = require("./routes/dataOps");
const entitySearchRoutes = require("./routes/entitySearch");
const purchaseInvoicesRoutes = require("./routes/purchaseInvoices");
const goodsReceiptsRoutes = require("./routes/goodsReceipts");
const purchaseReturnsRoutes = require("./routes/purchaseReturns");
const qualityControlsRoutes = require("./routes/qualityControls");
const supplierClaimsRoutes = require("./routes/supplierClaims");
const subcontractingRoutes = require("./routes/subcontracting");
const serviceWarrantyRoutes = require("./routes/serviceWarranty");
const serviceTicketsRoutes = require("./routes/serviceTickets");
const aftermarketDeskRoutes = require("./routes/aftermarketDesk");
const reverseLogisticsRoutes = require("./routes/reverseLogistics");
const returnReworkRoutes = require("./routes/returnRework");
const stockAdjustmentsRoutes = require("./routes/stockAdjustments");
const jobCardsRoutes = require("./routes/jobCards");
const manufacturingBomsRoutes = require("./routes/manufacturingBoms");
const inventorySpecsRoutes = require("./routes/inventorySpecs");
const engineeringDeskRoutes = require("./routes/engineeringDesk");
const stockTransfersRoutes = require("./routes/stockTransfers");
const amcContractsRoutes = require("./routes/amcContracts");
const salesReturnsRoutes = require("./routes/salesReturns");
const stockLedgerRoutes = require("./routes/stockLedger");
const threeWayMatchRoutes = require("./routes/threeWayMatch");
const vendorPaymentsRoutes = require("./routes/vendorPayments");
const vendorStatementRoutes = require("./routes/vendorStatement");
const approvalDeskRoutes = require("./routes/approvalDesk");
const approvalPoliciesRoutes = require("./routes/approvalPolicies");
const approvalHistoryRoutes = require("./routes/approvalHistory");
const bankBookRoutes = require("./routes/bankBook");
const tdsRoutes = require("./routes/tds");
const hrRoutes = require("./routes/hr");
const hrAdminRoutes = require("./routes/hrAdmin");
const marketingRoutes = require("./routes/marketing");
const marketingPhase3Routes = require("./routes/marketingPhase3");
const managementRoutes = require("./routes/management");
const officeAdminRoutes = require("./routes/officeAdmin");
const productsRoutes = require("./routes/products");
const jobAssetsAdminRoutes = require("./routes/jobAssetsAdmin");
const templatesRoutes = require("./routes/templates");
const usersRoutes = require("./routes/users");
const permissionsRoutes = require("./routes/permissions");
const adminMastersRoutes = require("./routes/adminMasters");
const intercompanyPartnersRoutes = require("./routes/intercompanyPartners");
const intercompanyStatusRoutes = require("./routes/intercompanyStatus");
const pilotFeedbackRoutes = require("./routes/pilotFeedback");
const notificationsRoutes = require("./routes/notifications");
const driveRoutes = require("./routes/drive");
const fieldServiceRoutes = require("./routes/fieldService");
const tallyRoutes = require("./routes/tally");
const timelineRoutes = require("./routes/timeline");

function normalizeErrorDetail(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 500) : null;
}

function inferHttpStatus(err) {
  const explicit = Number(err?.status || err?.statusCode);
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;

  const code = String(err?.code || "").trim();
  if (!code) return 500;
  if (code === "23505" || code === "23503") return 409;
  if (code === "23514" || /^22/.test(code) || /^23/.test(code)) return 400;
  return 500;
}

function buildErrorPayload(err) {
  const status = inferHttpStatus(err);
  const detail = normalizeErrorDetail(err?.detail || err?.message);
  const errorCode =
    typeof err?.code === "string" && /^[A-Z0-9_]+$/i.test(err.code)
      ? String(err.code).toUpperCase()
      : status >= 500
        ? "SERVER_ERROR"
        : "REQUEST_FAILED";

  return {
    status,
    body: {
      ok: false,
      error: errorCode,
      detail,
      pg_code: typeof err?.code === "string" && /^\d+$/.test(err.code) ? err.code : null,
    },
  };
}

function createApp() {
  const app = express();

  app.set("trust proxy", 1);

  app.use(express.json({ limit: "1mb" }));

  app.use(
    session({
      store: new pgSession({
        pool,
        tableName: "user_sessions",
        createTableIfMissing: true,
      }),
      name: "josh.sid",
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        domain:
          process.env.NODE_ENV === "production" &&
          typeof process.env.SESSION_COOKIE_DOMAIN === "string" &&
          process.env.SESSION_COOKIE_DOMAIN.length
            ? process.env.SESSION_COOKIE_DOMAIN
            : undefined,
      },
    })
  );

  app.use(passport.initialize());
  app.use(passport.session());

  app.use(async (req, _res, next) => {
    try {
      if (req.user) return next();
      const localUserId =
        req.session && Number.isFinite(Number(req.session.localUserId))
          ? Number(req.session.localUserId)
          : null;
      if (!localUserId) return next();
      req.user = await loadUserContextById(pool, localUserId);
      return next();
    } catch (err) {
      return next(err);
    }
  });

  app.use((req, _res, next) => {
    try {
      if (!req.user) {
        req.ctx = { company_id: null };
        return next();
      }

      const companies = Array.isArray(req.user.companies) ? req.user.companies : [];
      const isSuper = req.user.group_name === "SuperAdmin";

      const rawSessionCompanyId =
        req.session && Number.isFinite(Number(req.session.activeCompanyId)) ? Number(req.session.activeCompanyId) : null;
      const sessionCompanyId =
        rawSessionCompanyId && rawSessionCompanyId > 0 ? rawSessionCompanyId : null;

      const sessionAllowed =
        sessionCompanyId && (isSuper || companies.some((c) => Number(c.company_id) === sessionCompanyId));

      const primaryCompanyId =
        Number.isFinite(Number(req.user.primary_company_id)) && Number(req.user.primary_company_id) > 0
          ? Number(req.user.primary_company_id)
          : null;

      const primaryAllowed =
        primaryCompanyId && (isSuper || companies.some((c) => Number(c.company_id) === primaryCompanyId));

      const fallbackCompanyId =
        companies.length && Number.isFinite(Number(companies[0]?.company_id)) ? Number(companies[0].company_id) : null;

      const activeCompanyId =
        (sessionAllowed && sessionCompanyId) ||
        (primaryAllowed && primaryCompanyId) ||
        (fallbackCompanyId && (isSuper || companies.some((c) => Number(c.company_id) === fallbackCompanyId)) ? fallbackCompanyId : null);

      if (activeCompanyId && req.session) {
        req.session.activeCompanyId = activeCompanyId;
      }

      req.ctx = { company_id: activeCompanyId || null };
      return next();
    } catch (err) {
      return next(err);
    }
  });

  registerGoogleStrategy(passport);
  registerGoogleMailStrategy(passport);

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/integrations/google-chat", require("./routes/googleChatEvents"));
  app.use("/api/timeline", timelineRoutes);

  app.use("/auth", authRoutes);
  app.use("/mail-accounts", mailAccountsRoutes);
  app.use("/leads/ingest", leadsIngestRoutes);
  app.use("/leads", leadsRoutes);
  app.use("/geo", geoRoutes);
  app.use("/customers", customersRoutes);
  app.use("/quotes/family-content", require("./routes/quoteFamilyContent"));
  app.use("/quotes", quotesRoutes);
  app.use("/sales-orders", salesOrdersRoutes);
  app.use("/dispatches", dispatchesRoutes);
  app.use("/proforma-invoices", proformaInvoicesRoutes);
  app.use("/invoices", invoicesRoutes);
  app.use("/sales-desk", salesDeskRoutes);
  app.use("/inbound-lead-review", inboundLeadReviewRoutes);
  app.use("/extraction", extractionRoutes);
  app.use("/collections-desk", collectionsDeskRoutes);
  app.use("/collections-analytics", collectionsAnalyticsRoutes);
  app.use("/credit-control", creditControlRoutes);
  app.use("/reconciliation-desk", reconciliationDeskRoutes);
  app.use("/receipts", receiptsRoutes);
  app.use("/gl-desk", glDeskRoutes);
  app.use("/finance-landed-cost", financeLandedCostRoutes);
  app.use("/tally-export", tallyExportRoutes);
  app.use("/api/tally", tallyRoutes);
  app.use("/tally", tallyRoutes);
  app.use("/purchase-orders", purchaseOrdersRoutes);
  app.use("/purchase-requisitions", purchaseRequisitionsRoutes);
  app.use("/vendor-quotes", vendorQuotesRoutes);
  app.use("/api/vendor-portal", vendorPortalRoutes);
  app.use("/api/vendors", vendorPortalExecutiveRoutes);
  app.use("/api/shop-floor", shopFloorRoutes);
  app.use("/shop-floor", shopFloorRoutes);
  app.use("/api/sales", salesCommercialRoutes);
  app.use("/sales-commercial", salesCommercialRoutes);
  app.use("/api/finance", financeAccountingRoutes);
  app.use("/finance-accounting", financeAccountingRoutes);
  app.use("/api/service", serviceMaintenanceRoutes);
  app.use("/service-maintenance", serviceMaintenanceRoutes);
  app.use("/api/executive", executiveAnalyticsRoutes);
  app.use("/executive-analytics", executiveAnalyticsRoutes);
  app.use("/api/mrp", mrpPlanningRoutes);
  app.use("/mrp-planning", mrpPlanningRoutes);
  app.use("/api/admin", adminGovernanceRoutes);
  app.use("/admin-governance", adminGovernanceRoutes);
  app.use("/api/data-ops", dataOpsRoutes);
  app.use("/data-ops", dataOpsRoutes);
  app.use("/api/search", entitySearchRoutes);
  app.use("/search", entitySearchRoutes);
  app.use("/purchase-invoices", purchaseInvoicesRoutes);
  app.use("/goods-receipts", goodsReceiptsRoutes);
  app.use("/purchase-returns", purchaseReturnsRoutes);
  app.use("/quality-controls", qualityControlsRoutes);
app.use("/supplier-claims", supplierClaimsRoutes);
  app.use("/subcontracting", subcontractingRoutes);
app.use("/service-warranty", serviceWarrantyRoutes);
app.use("/service-tickets", serviceTicketsRoutes);
app.use("/aftermarket-desk", aftermarketDeskRoutes);
app.use("/reverse-logistics", reverseLogisticsRoutes);
app.use("/return-rework", returnReworkRoutes);
app.use("/stock-adjustments", stockAdjustmentsRoutes);
  app.use("/job-cards", jobCardsRoutes);
  app.use("/manufacturing-boms", manufacturingBomsRoutes);
  app.use("/inventory/bom", manufacturingBomsRoutes);
  app.use("/inventory/specs", inventorySpecsRoutes);
  app.use("/engineering-desk", engineeringDeskRoutes);
  app.use("/stock-transfers", stockTransfersRoutes);
  app.use("/amc-contracts", amcContractsRoutes);
  app.use("/sales-returns", salesReturnsRoutes);
  app.use("/stock-ledger", stockLedgerRoutes);
  app.use("/three-way-match", threeWayMatchRoutes);
  app.use("/vendor-payments", vendorPaymentsRoutes);
  app.use("/vendor-statement", vendorStatementRoutes);
  app.use("/approval-desk", approvalDeskRoutes);
  app.use("/approval-policies", approvalPoliciesRoutes);
  app.use("/approval-history", approvalHistoryRoutes);
  app.use("/bank-book", bankBookRoutes);
  app.use("/tds", tdsRoutes);
  app.use("/hr", hrAdminRoutes);
  app.use("/hr", hrRoutes);
  app.use("/hr/self", require("./routes/selfService"));
  app.use("/office-admin", officeAdminRoutes);
  app.use("/marketing", marketingPhase3Routes);
  app.use("/marketing", marketingRoutes);
  app.use("/management", managementRoutes);
  app.use("/products", productsRoutes);
  app.use("/job-assets-admin", jobAssetsAdminRoutes);
  app.use("/templates", templatesRoutes);
  app.use("/users", usersRoutes);
  app.use("/permissions/access", require("./routes/access"));
  app.use("/permissions", permissionsRoutes);
  app.use("/admin-masters", adminMastersRoutes);
  app.use("/intercompany-partners", intercompanyPartnersRoutes);
  app.use("/intercompany-status", intercompanyStatusRoutes);
  app.use("/pilot-feedback", pilotFeedbackRoutes);
  app.use("/hr/pilot-feedback", pilotFeedbackRoutes);
  app.use("/notifications", notificationsRoutes);
  app.use("/drive", driveRoutes);
  app.use("/field-service", fieldServiceRoutes);

  app.get("/me", (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false });
    return res.json({ ok: true, user: req.user });
  });

  app.use((err, _req, res, _next) => {
    process.stderr.write(`${err?.stack || err}\n`);
    const payload = buildErrorPayload(err);
    res.status(payload.status).json(payload.body);
  });

  return app;
}

module.exports = { createApp };

