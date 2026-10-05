import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import HomePanel, { canAccessPage, canScreenAction, SUPERADMIN_PAGES } from "./home";
import { EmptyState, ToastHost, clearLastDeskFix, loadLastDeskFix, toast } from "./shared/joshUi";
import PilotFeedbackModal from "./shared/PilotFeedbackModal";
import {
  enableDesktopPush,
  fetchNotificationChannels,
  fetchNotificationSummary,
  fetchNotifications,
  getPushState,
  markAllNotificationsRead,
  markNotificationRead,
  sendTestAlert,
} from "./shared/notificationsApi";
import CommandPalette from "./components/CommandPalette";
import VendorPortalApp from "./vendorPortal/VendorPortalApp";
import Login from "./auth/Login";
import { GlobalTimelineProvider } from "./timeline/GlobalTimelineContext";
import GlobalTimelineBar from "./timeline/GlobalTimelineBar";

const Leads = lazy(() => import("./leads/Leads"));
const Customers = lazy(() => import("./customers/Customers"));
const Quotes = lazy(() => import("./quotes/Quotes"));
const SalesOrders = lazy(() => import("./salesOrders/SalesOrders"));
const Dispatches = lazy(() => import("./dispatches/Dispatches"));
const CommissioningDesk = lazy(() => import("./fieldService/CommissioningDesk"));
const Invoices = lazy(() => import("./invoices/Invoices"));
const ProformaInvoices = lazy(() => import("./proforma/ProformaInvoices"));
const TallyExport = lazy(() => import("./tally/TallyExport"));
const Receipts = lazy(() => import("./receipts/Receipts"));
const ArDesk = lazy(() => import("./arDesk/ArDesk"));
const GlDesk = lazy(() => import("./glDesk/GlDesk"));
const FinanceLandedCostDesk = lazy(() => import("./financeLandedCost/FinanceLandedCostDesk"));
const PurchaseOrders = lazy(() => import("./purchaseOrders/PurchaseOrders"));
const Subcontracting = lazy(() => import("./subcontracting/Subcontracting"));
const PurchaseRequisitions = lazy(() => import("./purchaseRequisitions/PurchaseRequisitions"));
const VendorQuotes = lazy(() => import("./vendorQuotes/VendorQuotes"));
const PurchaseInvoices = lazy(() => import("./purchaseInvoices/PurchaseInvoices"));
const GoodsReceipts = lazy(() => import("./goodsReceipts/GoodsReceipts"));
const QualityControls = lazy(() => import("./qualityControls/QualityControls"));
const SupplierClaims = lazy(() => import("./supplierClaims/SupplierClaims"));
const PurchaseReturns = lazy(() => import("./purchaseReturns/PurchaseReturns"));
const ServiceWarranty = lazy(() => import("./serviceWarranty/ServiceWarranty"));
const ServiceTickets = lazy(() => import("./serviceTickets/ServiceTickets"));
const AftermarketDesk = lazy(() => import("./aftermarketDesk/AftermarketDesk"));
const JobCards = lazy(() => import("./jobCards/JobCards"));
const ShopFloorDesk = lazy(() => import("./shopFloor/ShopFloorDesk"));
const ManufacturingBoms = lazy(() => import("./inventory/BomManagerDesk"));
const EngineeringDesk = lazy(() => import("./engineering/EngineeringDesk"));
const AmcContracts = lazy(() => import("./amcContracts/AmcContracts"));
const StockLedger = lazy(() => import("./stockLedger/StockLedger"));
const StockAdjustments = lazy(() => import("./stockAdjustments/StockAdjustments"));
const StockTransfers = lazy(() => import("./stockTransfers/StockTransfers"));
const ThreeWayMatch = lazy(() => import("./threeWayMatch/ThreeWayMatch"));
const ApprovalDesk = lazy(() => import("./approvalDesk/ApprovalDesk"));
const VendorPayments = lazy(() => import("./vendorPayments/VendorPayments"));
const VendorStatement = lazy(() => import("./vendorStatement/VendorStatement"));
const BankBook = lazy(() => import("./bankBook/BankBook"));
const Tds = lazy(() => import("./tds/Tds"));
const SalesReturns = lazy(() => import("./salesReturns/SalesReturns"));
const ReverseLogistics = lazy(() => import("./reverseLogistics/ReverseLogistics"));
const ReturnRework = lazy(() => import("./returnRework/ReturnRework"));
const HrDesk = lazy(() => import("./hr/HrDesk"));
const HRAdminDesk = lazy(() => import("./hr/HRAdminDesk"));
const Attendance = lazy(() => import("./hr/Attendance"));
const Expenses = lazy(() => import("./hr/Expenses"));
const ActivityPlanner = lazy(() => import("./hr/ActivityPlanner"));
const Events = lazy(() => import("./hr/Events"));
const Leave = lazy(() => import("./hr/Leave"));
const Holidays = lazy(() => import("./hr/Holidays"));
const Salary = lazy(() => import("./hr/Salary"));
const SalarySlips = lazy(() => import("./hr/SalarySlips"));
const MyDutyExpenses = lazy(() => import("./hr/MyDutyExpenses"));
const OfficeAdminDesk = lazy(() => import("./officeAdmin/OfficeAdminDesk"));
const MarketingDesk = lazy(() => import("./marketing/MarketingDesk"));
const MarketingRoiDesk = lazy(() => import("./marketing/MarketingRoiDesk"));
const Campaigns = lazy(() => import("./marketing/Campaigns"));
const Exhibitions = lazy(() => import("./marketing/Exhibitions"));
const SourcePerformance = lazy(() => import("./marketing/SourcePerformance"));
const MarketingMailers = lazy(() => import("./marketing/MarketingMailers"));
const ExecutiveBoardDesk = lazy(() => import("./management/ExecutiveBoardDesk"));
const ExecutiveCommandCenter = lazy(() => import("./executive/ExecutiveCommandCenter"));
const CommercialDesk = lazy(() => import("./sales/CommercialDesk"));
const FinanceDesk = lazy(() => import("./finance/FinanceDesk"));
const ServiceDesk = lazy(() => import("./service/ServiceDesk"));
const MrpPlanningDesk = lazy(() => import("./mrp/MrpPlanningDesk"));
const ProductMasterDesk = lazy(() => import("./products/ProductMasterDesk"));
const AdminDesk = lazy(() => import("./admin/AdminDesk"));
const TallyImportDesk = lazy(() => import("./admin/TallyImportDesk"));
const SalesDesk = lazy(() => import("./salesDesk/SalesDesk"));
const InboundLeadReview = lazy(() => import("./inboundLeadReview/InboundLeadReview"));
const Templates = lazy(() => import("./superadmin/Templates"));
const UserMaster = lazy(() => import("./superadmin/UserMaster"));
const RightsMatrix = lazy(() => import("./superadmin/RightsMatrix"));
const UserAccessPreview = lazy(() => import("./superadmin/UserAccessPreview"));
const AdminMasters = lazy(() => import("./superadmin/AdminMasters"));
const JobAssetsAdmin = lazy(() => import("./superadmin/JobAssetsAdmin"));
const OnboardingWizard = lazy(() => import("./superadmin/OnboardingWizard"));
const ProductMaster = lazy(() => import("./superadmin/ProductMaster"));
const DataOpsDesk = lazy(() => import("./superadmin/DataOpsDesk"));
const LeadIngestionAdmin = lazy(() => import("./superadmin/LeadIngestionAdmin"));
const ApprovalPolicyMatrix = lazy(() => import("./superadmin/ApprovalPolicyMatrix"));
const IntercompanyPartners = lazy(() => import("./superadmin/IntercompanyPartners"));
const SuperAdminHome = lazy(() => import("./superadmin/SuperAdminHome"));
const PilotFeedbackNotes = lazy(() => import("./superadmin/PilotFeedbackNotes"));
const ChatReadiness = lazy(() => import("./superadmin/ChatReadiness"));
const AccessProfiles = lazy(() => import("./superadmin/AccessProfiles"));
const IntercompanyDashboard = lazy(() => import("./intercompany/IntercompanyDashboard"));

const NARROW_VIEWPORT_QUERY = "(max-width: 920px)";

const NAV_ITEMS = [
  // 1. Overview & Executive
  { key: "home", label: "Home", detail: "My Day start", accent: "Core", group: "Overview & Executive" },
  { key: "executive_command", label: "Executive Command", detail: "Real-time BI, Working Capital & Ops Pulse", accent: "BI", group: "Overview & Executive" },
  { key: "my_duty_expenses", label: "My Duty & Expenses", detail: "Duty mark and claims with receipt photo", accent: "Self", group: "Overview & Executive" },
  { key: "management", label: "Executive Board", detail: "Monthly board packs and governance manuscript", accent: "EXE", group: "Overview & Executive" },

  // 2. Commercial & Sales — primary: Sales Desk + Leads + Customers; docs nested as secondary
  { key: "sales_desk", label: "Sales Desk", detail: "Quote → SO → Dispatch → Invoice bridge", accent: "Desk", group: "Commercial & Sales" },
  { key: "leads", label: "Leads", detail: "Pipeline intake & review", accent: "Queue", group: "Commercial & Sales" },
  { key: "customers", label: "Customers", detail: "Account & customer registry", accent: "CRM", group: "Commercial & Sales" },
  { key: "quotes", label: "Quotes", detail: "Open from Sales Desk buckets", accent: "PDF", group: "Commercial & Sales", secondary: true },
  { key: "sales_orders", label: "Sales Orders", detail: "Open from Sales Desk buckets", accent: "SO", group: "Commercial & Sales", secondary: true },
  { key: "commercial_desk", label: "Commercial Desk", detail: "Legacy CRM console", accent: "CRM", group: "Commercial & Sales", secondary: true },

  // 3. Manufacturing & Engineering
  { key: "product_master_desk", label: "Product Master & SKU Catalog", detail: "SKU catalog, tech specs, industrial costs & safety thresholds", accent: "SKU", group: "Manufacturing & Engineering" },
  { key: "manufacturing_boms", label: "Manufacturing BOMs", detail: "FG recipe & component builder", accent: "BOM", group: "Manufacturing & Engineering" },
  { key: "shop_floor", label: "Shop Floor & Kitting", detail: "Assembly pick list, BOM explosion, issuance & scrap", accent: "SF", group: "Manufacturing & Engineering" },
  { key: "job_cards", label: "Job Cards", detail: "Issue and consumption desk", accent: "JOB", group: "Manufacturing & Engineering" },
  { key: "engineering_desk", label: "Engineering Desk", detail: "Datasheets, NPD, drawings, and release control", accent: "ENG", group: "Manufacturing & Engineering" },

  // 4. Inventory & Logistics
  { key: "stock_ledger", label: "Stock Ledger", detail: "Real-time inventory valuation & balance", accent: "STK", group: "Inventory & Logistics" },
  { key: "goods_receipts", label: "Goods Receipts (GRN)", detail: "Stores receiving & inspection", accent: "GRN", group: "Inventory & Logistics" },
  { key: "dispatches", label: "Dispatches", detail: "Order fulfillment & gatepass dispatch", accent: "DSP", group: "Inventory & Logistics" },
  { key: "stock_transfers", label: "Stock Transfers", detail: "Inter-location & bay moves", accent: "TRF", group: "Inventory & Logistics" },
  { key: "stock_adjustments", label: "Stock Adjustments", detail: "Physical stock audit & reconciliation", accent: "ADJ", group: "Inventory & Logistics" },

  // 5. Procurement & Supply Chain
  { key: "mrp_planning_desk", label: "MRP II & Procurement Planning", detail: "Predictive shortage reorder, auto-PRs & supplier lead times", accent: "MRP", group: "Procurement & Supply Chain" },
  { key: "purchase_orders", label: "Purchase Orders", detail: "Procurement & vendor orders", accent: "PO", group: "Procurement & Supply Chain" },
  { key: "purchase_requisitions", label: "Purchase Requisitions", detail: "Upstream demand & PR desk", accent: "PRQ", group: "Procurement & Supply Chain" },
  { key: "vendor_quotes", label: "Vendor Quotes / RFQ", detail: "RFQ compare & vendor portal", accent: "VQ", group: "Procurement & Supply Chain" },
  { key: "purchase_invoices", label: "Purchase Invoices", detail: "Vendor bill entry & match control", accent: "PI", group: "Procurement & Supply Chain" },
  { key: "quality_control", label: "Quality Control", detail: "Post-GRN inspection & quality signoff", accent: "QC", group: "Procurement & Supply Chain" },
  { key: "three_way_match", label: "3-Way Match", detail: "PO / GRN / invoice exception queue", accent: "3WM", group: "Procurement & Supply Chain" },
  { key: "vendor_payments", label: "Vendor Payments", detail: "AP pay-run & match-blocked queue", accent: "VP", group: "Procurement & Supply Chain" },
  { key: "approval_desk", label: "Approval Desk", detail: "Procurement & PO approval queue", accent: "APR", group: "Procurement & Supply Chain" },

  // 6. Field Service & Aftermarket
  { key: "service_desk", label: "Service & Maintenance Desk", detail: "Serialized assets, AMCs, breakdown calls & spare parts", accent: "SRV", group: "Field Service & Aftermarket" },
  { key: "aftermarket_desk", label: "Aftermarket Desk", detail: "AMC, warranty, RMA & recovery queues", accent: "AM", group: "Field Service & Aftermarket" },
  { key: "commissioning_desk", label: "Commissioning Desk", detail: "Site sign-off & warranty gate", accent: "COM", group: "Field Service & Aftermarket" },
  { key: "service_tickets", label: "Service Tickets", detail: "Complaints, visits & signed reports", accent: "TKT", group: "Field Service & Aftermarket" },
  { key: "amc_contracts", label: "AMC Contracts", detail: "Contract & SLA maintenance", accent: "AMC", group: "Field Service & Aftermarket" },
  { key: "sales_returns", label: "Sales Returns / RMA", detail: "Customer return & RMA desk", accent: "SRT", group: "Field Service & Aftermarket" },

  // 7. Finance & Accounts
  { key: "finance_desk", label: "Finance & Accounts Desk", detail: "Invoicing, 3-Way AP match, double-entry GL & GST reconciliation", accent: "FIN", group: "Finance & Accounts" },
  { key: "ar_desk", label: "AR Desk", detail: "Collections, credit, ageing & follow-ups", accent: "AR", group: "Finance & Accounts" },
  { key: "invoices", label: "Tax Invoices", detail: "Billing & commercial invoice desk", accent: "INV", group: "Finance & Accounts" },
  { key: "proforma_invoices", label: "Proforma Invoices", detail: "Advance / PI commercial docs", accent: "PI", group: "Finance & Accounts" },
  { key: "receipts", label: "Receipts & Collections", detail: "Collections & customer receipts", accent: "RCT", group: "Finance & Accounts" },
  { key: "tally_import_desk", label: "Tally Ingestion & Rec", detail: "Multi-company XML/JSON import & auto-matching", accent: "TLY", group: "Finance & Accounts" },
  { key: "bank_book", label: "Bank / Cash Book", detail: "Bank balances & cash register", accent: "BK", group: "Finance & Accounts" },
  { key: "gl_desk", label: "General Ledger", detail: "Chart of accounts & trial balance", accent: "GL", group: "Finance & Accounts" },

  // 8. Human Resources
  { key: "hr_desk", label: "HR Management Desk", detail: "Attendance, leave, payroll, planner, and events", accent: "HR", group: "Human Resources" },
  { key: "attendance", label: "Attendance", detail: "Punch, late marks, and regularization", accent: "ATT", group: "Human Resources" },
  { key: "leave", label: "Leave", detail: "Requests, approvals, and balances", accent: "LV", group: "Human Resources" },
  { key: "expenses", label: "Expenses", detail: "Employee claims and reimbursements", accent: "EXP", group: "Human Resources" },
  { key: "salary", label: "Salary & Payroll", detail: "Payroll setup and generation", accent: "PAY", group: "Human Resources" },
  { key: "hr_admin", label: "HR Admin", detail: "Skill matrix, rights delegation, and offboarding", accent: "HRA", group: "Human Resources" },
  { key: "office_admin", label: "Office Admin", detail: "IT assets and plant visitor logs", accent: "OFF", group: "Human Resources" },

  // 9. Marketing & Growth
  { key: "marketing_desk", label: "Marketing Desk", detail: "Campaigns, exhibitions, and source yield", accent: "MKT", group: "Marketing & Growth" },
  { key: "campaigns", label: "Campaigns", detail: "Social and digital demand control", accent: "CMP", group: "Marketing & Growth" },
  { key: "exhibitions", label: "Exhibitions", detail: "Event spend and lead yield", accent: "EXP", group: "Marketing & Growth" },
  { key: "source_performance", label: "Source Performance", detail: "Lead, quote, and order yield by source", accent: "SRC", group: "Marketing & Growth" },
  { key: "lead_ingestion", label: "Lead Ingestion", detail: "Channel API keys for web / ads / WhatsApp forms", accent: "ING", group: "Marketing & Growth" },

  // 10. System Administration
  { key: "admin_desk", label: "Admin & Security Governance", detail: "Audit trail, access audit & backup intent logs", accent: "SEC", group: "System Administration" },
  { key: "data_ops", label: "Data Ops", detail: "Dry-run repairs with typed confirm & audit", accent: "OPS", superAdminOnly: true, group: "System Administration" },
  { key: "superadmin_home", label: "SuperAdmin Home", detail: "System control desk", accent: "Desk", superAdminOnly: true, group: "System Administration" },
  { key: "users", label: "Org & Access", detail: "Org chart, identity, screens, authority", accent: "Org", superAdminOnly: true, group: "System Administration" },
  { key: "access_profiles", label: "Access Profiles", detail: "Module levels, who is affected, org baseline rules", accent: "New", superAdminOnly: true, group: "System Administration" },
  { key: "rights", label: "Rights Matrix", detail: "Role templates & screen rights", accent: "RBAC", superAdminOnly: true, group: "System Administration" },
  { key: "user_access_preview", label: "Access Preview", detail: "Diagnose what a user can see and do", accent: "View", superAdminOnly: true, group: "System Administration" },
  { key: "onboarding", label: "Onboarding", detail: "Employee & distributor guided setup", accent: "Join", superAdminOnly: true, group: "System Administration" },
  { key: "admin_masters", label: "Admin Masters", detail: "Business controls & system masters", accent: "Admin", group: "System Administration" },
  { key: "job_asset_admin", label: "Job Asset Admin", detail: "Deployed assets, BOM snapshots & spare maps", accent: "Asset", superAdminOnly: true, group: "System Administration" },
  { key: "product_master", label: "Product Master Admin", detail: "SKU import/update & item registry control", accent: "SKU", superAdminOnly: true, group: "System Administration" },
  { key: "intercompany_partners", label: "Intercompany Partners", detail: "AI ↔ AT company links and mappings", accent: "IC", superAdminOnly: true, group: "System Administration" },
  { key: "intercompany_dashboard", label: "Intercompany Dashboard", detail: "PO ↔ SO ↔ Stock ↔ Accounts", accent: "Link", group: "System Administration" },
  { key: "approval_policy_matrix", label: "Approval Policies", detail: "Approval thresholds & matrices", accent: "Rule", superAdminOnly: true, group: "System Administration" },
  { key: "templates", label: "Templates", detail: "Document & print control", accent: "Admin", group: "System Administration" },
  { key: "pilot_feedback", label: "Pilot Feedback", detail: "Blocked / confusing / suggestion triage", accent: "Note", superAdminOnly: true, group: "System Administration" },
  { key: "chat_readiness", label: "Chat Readiness", detail: "Who receives Josh alerts in Google Chat", accent: "Chat", superAdminOnly: true, group: "System Administration" },
];

const NAV_GROUP_ORDER = [
  "Overview & Executive",
  "Commercial & Sales",
  "Manufacturing & Engineering",
  "Inventory & Logistics",
  "Procurement & Supply Chain",
  "Field Service & Aftermarket",
  "Finance & Accounts",
  "Human Resources",
  "Marketing & Growth",
  "System Administration",
];


const PAGE_META = {
  home: {
    eyebrow: "Executive overview",
    title: "JOSH overview",
    description: "Review priorities, open the right desk, and move work forward quickly.",
    chip: "Today view",
    status: "Phase 1 live",
  },
  my_duty_expenses: {
    eyebrow: "Self service",
    title: "My Duty & Expenses",
    description: "Mark your duty day and submit expense claims with a compressed receipt photo from phone or desktop.",
    chip: "Mobile ready",
    status: "Own records",
  },
  leads: {
    eyebrow: "Pipeline review",
    title: "Lead desk and intake control",
    description: "Review fresh demand, prioritize follow-up, and open quote work from the same business-ready shell.",
    chip: "Queue live",
    status: "Priority routing active",
  },
  inbound_lead_review: {
    eyebrow: "Inbound intake",
    title: "Inbound Lead Review",
    description: "Convert, link, or ignore mailbox enquiries into the sales lead pipeline.",
    chip: "Mailbox",
    status: "Review desk",
  },
  customers: {
    eyebrow: "Account registry",
    title: "Customer context in one place",
    description: "Keep channel-partner-linked accounts, search, and customer details inside a compact shell designed for daily use.",
    chip: "Accounts synced",
    status: "Channel Partner linked",
  },
  quotes: {
    eyebrow: "Commercial desk",
    title: "Quote execution workspace",
    description: "Prepare revisions, confirm totals, issue PDFs, and send the next offer with confidence.",
    chip: "PDF ready",
    status: "Revision desk",
  },
  sales_desk: {
    eyebrow: "Sales command desk",
    title: "Sales Desk",
    description: "Work one bucketed queue across quotes, sales orders, dispatches, and invoices to keep the next operational gap visible.",
    chip: "Desk",
    status: "Queue live",
  },
  sales_orders: {
    eyebrow: "Order booking",
    title: "Sales order conversion desk",
    description: "Convert issued quotes into operational orders and keep the commercial snapshot visible from a dedicated order workspace.",
    chip: "Quote-linked",
    status: "Order desk",
  },
  dispatches: {
    eyebrow: "Order fulfilment",
    title: "Dispatch and fulfilment desk",
    description: "Create shipment records from confirmed orders, capture transporter details, and control dispatched quantities from UI.",
    chip: "Shipment-ready",
    status: "Fulfilment desk",
  },
  commissioning_desk: {
    eyebrow: "Field commissioning",
    title: "Commissioning gatekeeper desk",
    description: "Complete on-site commissioning with client sign-off to start warranty clocks and unlock commissioning milestones.",
    chip: "Sign-off",
    status: "Field desk",
  },
  executive_command: {
    eyebrow: "Executive Intelligence",
    title: "Executive Command Center & BI Dashboard",
    description: "Real-time unified pulse across working capital, shop floor manufacturing, commercial sales pipeline, and field service operations.",
    chip: "Executive",
    status: "Telemetry Live",
  },
  admin_desk: {
    eyebrow: "System Administration",
    title: "System Administration & Security Governance",
    description: "Enterprise audit trail inspector, RBAC role-permission matrix, and automated database snapshot governance.",
    chip: "Security",
    status: "Governance Live",
  },
  product_master_desk: {
    eyebrow: "Product Master",
    title: "Product Master & SKU Specifications Desk",
    description: "Industrial PSA plant models, sub-assemblies, raw materials, spare parts, and JSON technical specifications catalog.",
    chip: "SKU Master",
    status: "Catalog Live",
  },
  tally_import_desk: {
    eyebrow: "Tally ERP Ingestion",
    title: "Multi-Company Tally Data Ingestion & Reconciliation",
    description: "Multi-company XML/JSON backup ingestion for Absstem Industrial (AI) and AT with master dictionary mapping and AR/AP voucher reconciliation.",
    chip: "Tally Ingestion",
    status: "Reconciliation Live",
  },
  mrp_planning_desk: {
    eyebrow: "Procurement Planning",
    title: "MRP II & Automated Purchase Planning",
    description: "Net material shortage calculation, predictive reordering from Master BOM demand, and automated purchase requisition generation.",
    chip: "MRP II",
    status: "Planning Live",
  },
  finance_desk: {
    eyebrow: "Finance & Accounting",
    title: "Finance & Accounts Command Center",
    description: "Real-time General Ledger, automated tax invoicing from dispatches, 3-way vendor bill match, and GST reconciliation.",
    chip: "Finance",
    status: "Double-Entry Live",
  },
  service_desk: {
    eyebrow: "Service & Maintenance",
    title: "Service, AMC & Maintenance Command Center",
    description: "Serialized asset registry, active AMC contract tracking, field dispatch ticketing, and spare parts inventory deduction.",
    chip: "Service",
    status: "Field Ops Live",
  },
  invoices: {
    eyebrow: "Billing desk",
    title: "Customer invoice control",
    description: "Create invoices from confirmed orders, preserve the financial snapshot, and track draft to paid transitions from UI.",
    chip: "Invoice-ready",
    status: "Accounts desk",
  },
  proforma_invoices: {
    eyebrow: "Advance billing",
    title: "Proforma invoice desk",
    description: "Create milestone or percent proformas from sales orders without touching AR ageing, then convert to a tax invoice when ready.",
    chip: "PI",
    status: "Collection instrument",
  },
  receipts: {
    eyebrow: "Collections desk",
    title: "Receipts and ageing control",
    description: "Capture customer receipts, allocate them against invoices, and keep receivables ageing visible from one accounting surface.",
    chip: "Receipt-ready",
    status: "Collections live",
  },
  ar_desk: {
    eyebrow: "AR operations",
    title: "AR Desk",
    description: "Review follow-ups, disputes, credit holds, and reconciliation gaps from one working desk.",
    chip: "AR",
    status: "Ops live",
  },
  gl_desk: {
    eyebrow: "Financial close",
    title: "GL Desk",
    description: "Maintain the chart of accounts, post journals, and validate balances from one accounting desk.",
    chip: "GL",
    status: "Close control",
  },
  landed_cost: {
    eyebrow: "Finance control",
    title: "Landed cost and inventory valuation",
    description: "Review AVL-driven landed costs, configure variance alerts, and monitor weighted-average inventory value.",
    chip: "LC",
    status: "Valuation live",
  },
  tally_export: {
    eyebrow: "Desktop accounting bridge",
    title: "Tally export",
    description: "Preview unmapped ledgers and download Sales and Receipt voucher XML for Tally import.",
    chip: "TLY",
    status: "Export ready",
  },
  service_warranty: {
    eyebrow: "After-sales service",
    title: "Warranty, service replacement, and field return tracking",
    description: "Open service cases from dispatch history, record field returns and replacement issues, and keep after-sales stock movements traceable from one desk.",
    chip: "Service",
    status: "After-sales live",
  },
  service_tickets: {
    eyebrow: "Field service",
    title: "Service tickets and site visits",
    description: "Raise complaint tickets, assign engineers, schedule site visits, and capture signed reports without rebuilding warranty stock cases.",
    chip: "Tickets",
    status: "AT pilot live",
  },
  job_cards: {
    eyebrow: "Material issue",
    title: "Material issue, return, and consumption tracking",
    description: "Raise job cards for service or internal work, issue and return material against each job, and keep actual consumption visible against requested quantity.",
    chip: "Job card",
    status: "Consumption live",
  },
  engineering_desk: {
    eyebrow: "Engineering command center",
    title: "Engineering Desk",
    description: "Control client datasheet intake, NPD, drawing work, technical requests, and release blockers from one dense engineering surface.",
    chip: "Engineering",
    status: "Request control live",
  },
  amc_contracts: {
    eyebrow: "Preventive maintenance",
    title: "AMC contracts and planned service visits",
    description: "Create AMC coverage from dispatched material, schedule preventive visits, and convert visits into service cases whenever field action is required.",
    chip: "AMC",
    status: "Maintenance live",
  },
  aftermarket_desk: {
    eyebrow: "Aftermarket control",
    title: "Aftermarket Desk",
    description: "Run service cases and AMC visits from one queue so due, overdue, and stuck work stays visible.",
    chip: "Aftermarket",
    status: "Ops live",
  },
  sales_returns: {
    eyebrow: "Customer return",
    title: "Sales return and customer credit note control",
    description: "Create customer returns from invoices, capture returned quantity with serial validation where required, and reduce receivable outstanding through posted credit notes.",
    chip: "Credit note",
    status: "Returns live",
  },
  reverse_logistics: {
    eyebrow: "Customer RMA",
    title: "Reverse logistics control",
    description: "Control returned material disposition across sales returns and field returns: accept back into stock or scrap with traceable stock movements.",
    chip: "RMA",
    status: "Disposition live",
  },
  return_rework: {
    eyebrow: "Post-RMA execution",
    title: "Return rework / refurb desk",
    description: "Convert accepted returns into controlled refurbishment jobs using Job Cards so follow-up, parts issue, and closure remain visible.",
    chip: "Rework",
    status: "Job-led",
  },
  purchase_requisitions: {
    eyebrow: "Demand control",
    title: "Purchase requisition and indent",
    description: "Raise internal demand before procurement, route requisitions through approval, and track how much has already moved into purchase orders.",
    chip: "Indent",
    status: "Demand live",
  },
  vendor_quotes: {
    eyebrow: "Vendor compare",
    title: "RFQ and vendor quote desk",
    description: "Send RFQs from an approved PR, capture vendor replies, compare landed cost and commercial terms, then hand the winner into a purchase order.",
    chip: "RFQ",
    status: "Compare live",
  },
  purchase_orders: {
    eyebrow: "Procurement desk",
    title: "Purchase order control",
    description: "Create purchase orders against the Vendor Master, keep draft-to-confirmed status control, and maintain line items from a focused procurement surface.",
    chip: "PO desk",
    status: "Procurement live",
  },
  subcontracting: {
    eyebrow: "Outside processing ledger",
    title: "Subcontracting control",
    description: "Allocate subcontract orders, record send/receive movements, and keep overdue outside processing visible as a queue-first desk.",
    chip: "Subcontract",
    status: "Outside processing live",
  },
  purchase_invoices: {
    eyebrow: "Vendor billing",
    title: "Purchase invoice control",
    description: "Capture supplier invoices against purchase orders or as manual entries, control draft-to-posted status, and maintain invoice line items from a stable billing surface.",
    chip: "PINV desk",
    status: "Vendor billing live",
  },
  goods_receipts: {
    eyebrow: "Stores receipt",
    title: "Goods Receipts (GRN)",
    description: "Receive material against purchase orders or as standalone inward, capture serial numbers for serial-controlled products, and post receipts through a disciplined stores surface.",
    chip: "GRN desk",
    status: "Inward live",
  },
  quality_control: {
    eyebrow: "Inspection control",
    title: "Quality hold, replacement, rework, and RTV",
    description: "Inspect posted GRNs, split accepted, hold, and rejected quantities, then resolve held stock through replacement, rework, or final acceptance while rejected stock moves through RTV.",
    chip: "QC",
    status: "Post-GRN live",
  },
  supplier_claims: {
    eyebrow: "Supplier follow-up",
    title: "Supplier claims and replacement receipt tracking",
    description: "Convert QC supplier-replacement actions into claims, track pending replacement quantities, and record replacement receipts with traceability back to QC and GRN.",
    chip: "Claim",
    status: "Replacement live",
  },
  purchase_returns: {
    eyebrow: "Return control",
    title: "Purchase return and debit note",
    description: "Reverse inward quantities, capture vendor return details, and issue debit-note impact against supplier payables from one return desk.",
    chip: "Return",
    status: "Credit note live",
  },
  stock_ledger: {
    eyebrow: "Inventory balance",
    title: "Stock ledger and availability",
    description: "Track item-wise stock balances and movements from GRN posting and dispatch execution in a clean, audit-friendly ledger view.",
    chip: "Stock",
    status: "Ledger live",
  },
  stock_adjustments: {
    eyebrow: "Inventory reconciliation",
    title: "Stock adjustment and physical verification",
    description: "Count physical stock, compare it with current system balance, and post controlled stock adjustments through a dedicated verification document.",
    chip: "Adjust",
    status: "Reconciliation live",
  },
  stock_transfers: {
    eyebrow: "Stock movement",
    title: "Warehouse and location transfer control",
    description: "Maintain active stock locations, move material between warehouses, sites, vans, and service points, and keep transfer posting disciplined with serial control.",
    chip: "Transfer",
    status: "Movement live",
  },
  three_way_match: {
    eyebrow: "Match control",
    title: "3-way match (PO vs GRN vs Invoice)",
    description: "Work the PO / GRN / invoice exception queue: fix over-invoicing and over-receipt, short-close stalled balances, and chase aging exceptions.",
    chip: "3-way",
    status: "Match live",
  },
  approval_desk: {
    eyebrow: "Approval control",
    title: "Approval desk and action queue",
    description: "Review all submitted procurement documents from one desk, approve or send back quickly, and jump straight into the underlying document when deeper review is needed.",
    chip: "Approve",
    status: "Queue live",
  },
  vendor_payments: {
    eyebrow: "Vendor settlement",
    title: "Vendor payment allocations",
    description: "Record vendor payments, allocate them across purchase invoices, and keep vendor outstanding visible with disciplined draft-to-post control.",
    chip: "Payment",
    status: "Settlement live",
  },
  vendor_statement: {
    eyebrow: "Accounts payable",
    title: "Vendor statement and ageing",
    description: "Review vendor-wise AP ageing, drill into the full ledger, and export vendor statements as PDFs without leaving the procurement shell.",
    chip: "AP",
    status: "Statement live",
  },
  bank_book: {
    eyebrow: "Cash control",
    title: "Bank and cash books",
    description: "Manage bank/cash masters, track posted receipts and payments, and keep each book's running balance visible with manual vouchers.",
    chip: "Book",
    status: "Cash live",
  },
  tds: {
    eyebrow: "Withholding",
    title: "TDS deduction control",
    description: "Manage TDS sections, see deducted vendor payments, and keep withholding visibility tied to actual AP settlements.",
    chip: "TDS",
    status: "Withholding live",
  },
  hr_desk: {
    eyebrow: "People operations",
    title: "HR command desk",
    description: "Run attendance, leave, payroll, expense approvals, employee planning, and event actions from one guided people workspace.",
    chip: "HR desk",
    status: "People lane live",
  },
  hr_admin: {
    eyebrow: "People governance",
    title: "HR Admin — skills & transitions",
    description: "Maintain engineering skill matrices and run secure rights delegation and employee offboarding.",
    chip: "HR admin",
    status: "Governance live",
  },
  attendance: {
    eyebrow: "People time control",
    title: "Attendance review and regularization",
    description: "Review daily presence, late marks, missing punches, and regularization requests from one operational HR surface.",
    chip: "Attendance",
    status: "Daily queue live",
  },
  expenses: {
    eyebrow: "Employee claims",
    title: "Expense and reimbursement control",
    description: "Capture employee claims, route them through review, and keep reimbursement visibility disciplined for HR and Accounts.",
    chip: "Expenses",
    status: "Claim flow live",
  },
  activity_planner: {
    eyebrow: "Daily work planning",
    title: "Activity planner and follow-up board",
    description: "Plan daily work, assign internal tasks, and keep overdue follow-up visible through a compact action-driven planner.",
    chip: "Planner",
    status: "Task board live",
  },
  events: {
    eyebrow: "Company calendar",
    title: "Events, training, and activity calendar",
    description: "Manage company events, training sessions, employee activities, and itinerary broadcasts without leaving the HR lane.",
    chip: "Events",
    status: "Calendar live",
  },
  leave: {
    eyebrow: "Employee leave",
    title: "Leave requests and approvals",
    description: "Create employee leave, review approvals, and keep nearby holidays visible so attendance and people planning stay aligned.",
    chip: "Leave",
    status: "Leave live",
  },
  holidays: {
    eyebrow: "Holiday calendar",
    title: "Company holiday calendar",
    description: "Maintain company and festival holidays in one visible calendar so leave planning and attendance control stay coordinated.",
    chip: "Holidays",
    status: "Calendar ready",
  },
  salary: {
    eyebrow: "Payroll setup",
    title: "Salary structure and payroll generation",
    description: "Maintain employee salary profiles and trigger payroll generation so salary operations move from setup to payout cleanly.",
    chip: "Salary",
    status: "Payroll ready",
  },
  salary_slips: {
    eyebrow: "Payroll output",
    title: "Salary slips and payout status",
    description: "Review generated salary slips, filter them by month, and close payout visibility from one HR payroll surface.",
    chip: "Salary slips",
    status: "Slip queue live",
  },
  marketing_desk: {
    eyebrow: "Source to revenue",
    title: "Marketing command desk",
    description: "Track campaigns, exhibitions, and source-wise yield from one workspace so spend decisions stay tied to business outcomes.",
    chip: "Marketing desk",
    status: "Source yield live",
  },
  marketing: {
    eyebrow: "Market intelligence",
    title: "Trade show ROI & voice of market",
    description: "Measure exhibition cost-per-lead and closed-won yield, and capture Customer / Channel feedback for leadership.",
    chip: "ROI",
    status: "Intelligence live",
  },
  campaigns: {
    eyebrow: "Digital demand",
    title: "Campaign planning and performance",
    description: "Manage digital campaigns, track spend, and see which sources are turning into fruitful commercial movement.",
    chip: "Campaigns",
    status: "Demand control live",
  },
  exhibitions: {
    eyebrow: "Field demand",
    title: "Exhibition planning and yield",
    description: "Track exhibitions, follow-up pressure, and event-wise lead quality so each event can be judged by outcome.",
    chip: "Exhibitions",
    status: "Event yield live",
  },
  source_performance: {
    eyebrow: "Yield analysis",
    title: "Source performance and ROI view",
    description: "Compare campaigns and exhibitions by leads, fruitful movement, quote value, and order value before the next spend decision.",
    chip: "Source performance",
    status: "Yield view live",
  },
  marketing_mailers: {
    eyebrow: "Outbound awareness",
    title: "Newsletters and event mailers",
    description: "Send controlled newsletters and upcoming event awareness mails with tracking so engagement and yield stay measurable.",
    chip: "Mailers",
    status: "Mailer lane live",
  },
  management: {
    eyebrow: "Executive control",
    title: "Monthly board pack desk",
    description: "Generate manuscript-ready packs from commissioning, trade-show ROI, and Voice of Market for governance and newsletters.",
    chip: "Board pack",
    status: "Governance live",
  },
  superadmin_home: {
    eyebrow: "SuperAdmin control desk",
    title: "SuperAdmin setup and governance center",
    description: "Enter the right setup desk quickly, group admin work by function, and keep growing controls easier to find.",
    chip: "Control desk",
    status: "Admin lanes grouped",
  },
  admin_masters: {
    eyebrow: "Business controls",
    title: "Admin master governance",
    description: "Control distributor and commercial masters from UI so operational updates do not fall back to SQL or seed files.",
    chip: "SuperAdmin",
    status: "Master hub live",
  },
  office_admin: {
    eyebrow: "Corporate office",
    title: "Office Admin — assets & visitors",
    description: "Track IT hardware assignments and plant visitor check-in / check-out from one office surface.",
    chip: "Office",
    status: "Facility live",
  },
  job_asset_admin: {
    eyebrow: "Aftermarket governance",
    title: "Job assets and spare mapping control",
    description: "Maintain deployed assets, their installed BOM snapshots, and installed-to-replacement rules in one SuperAdmin desk.",
    chip: "SuperAdmin",
    status: "Asset linkage live",
  },
  product_master: {
    eyebrow: "Items and import",
    title: "Product master administration",
    description: "Maintain sellable items, categories, groups, and product import/update from UI instead of server-side scripts.",
    chip: "SuperAdmin",
    status: "Item control live",
  },
  onboarding: {
    eyebrow: "Guided setup",
    title: "Employee and distributor onboarding",
    description: "Create internal users, distributor org heads, and distributor employees through a guided flow with the right hierarchy from day one.",
    chip: "SuperAdmin",
    status: "Onboarding live",
  },
  users: {
    eyebrow: "Org and access",
    title: "Org & access",
    description: "Govern people from the org chart: identity, screen exceptions, and per-user financial authority in one place.",
    chip: "SuperAdmin",
    status: "Identity-centric",
  },
  approval_policy_matrix: {
    eyebrow: "Emergency band editor",
    title: "Purchase approval band matrix",
    description: "Emergency editor for purchase document amount bands and routing. Day-to-day per-user ceilings live in Org & access.",
    chip: "SuperAdmin",
    status: "Emergency band editor",
  },
  rights: {
    eyebrow: "Role templates",
    title: "Role templates (Rights Matrix)",
    description: "Edit role-level screen templates. Day-to-day user exceptions and authority stay in Org & access.",
    chip: "SuperAdmin",
    status: "Role templates",
  },
  user_access_preview: {
    eyebrow: "Access Preview",
    title: "Access Preview",
    description: "Diagnose what any user can see and do. Jump to Org & access to edit exceptions; use Role templates for baseline roles.",
    chip: "SuperAdmin",
    status: "Diagnose lane",
  },
  pilot_feedback: {
    eyebrow: "Pilot queue",
    title: "Live pilot feedback notes",
    description: "Review blocked, confusing, and suggestion notes from pilot users and triage them into action.",
    chip: "SuperAdmin",
    status: "Feedback live",
  },
  access_profiles: {
    eyebrow: "Access redesign",
    title: "Access Profiles",
    description: "Set each profile's level per module, see exactly who gains or loses access before saving, and map department + designation to a suggested profile.",
    chip: "SuperAdmin",
    status: "Shadow mode",
  },
  chat_readiness: {
    eyebrow: "Alerts",
    title: "Google Chat readiness",
    description: "See who actually receives Josh alerts in Google Chat, fix gaps, and send a test alert.",
    chip: "SuperAdmin",
    status: "Delivery check",
  },
  intercompany_dashboard: {
    eyebrow: "Group trading",
    title: "Intercompany dashboard",
    description: "Follow PO ↔ SO ↔ stock ↔ accounts links across Absstem companies.",
    chip: "Link",
    status: "Group live",
  },
  intercompany_partners: {
    eyebrow: "Company links",
    title: "Intercompany partners",
    description: "Maintain AI ↔ AT partner links and commercial mappings used by intercompany flows.",
    chip: "SuperAdmin",
    status: "Partner map",
  },
  templates: {
    eyebrow: "Document control",
    title: "Template administration",
    description: "Manage scope PDFs and letterheads in a disciplined admin surface while preserving the existing control flow.",
    chip: "SuperAdmin",
    status: "Asset vault secured",
  },
};

const PAGE_PULSE = {
  home: [
    { label: "Open revisions", value: "18", note: "quotes currently moving through review" },
    { label: "Response window", value: "7m", note: "average turnaround from lead to pricing action" },
    { label: "Template readiness", value: "92%", note: "document coverage prepared for issue" },
  ],
  my_duty_expenses: [
    { label: "Duty", value: "Self", note: "start and end your own day from phone" },
    { label: "Claims", value: "1 photo", note: "one receipt per expense head" },
    { label: "Upload", value: "Compressed", note: "JPEG shrink before send" },
  ],
  leads: [
    { label: "Priority leads", value: "8", note: "accounts waiting for qualification" },
    { label: "Route", value: "Direct", note: "handoff into quotes remains open" },
    { label: "Focus region", value: "South", note: "highest channel partner activity today" },
  ],
  customers: [
    { label: "Accounts", value: "43", note: "priority customers inside the shared shell" },
    { label: "Coverage", value: "Linked", note: "channel partner mapping remains intact" },
    { label: "Lookup state", value: "Ready", note: "search and account context stay persistent" },
  ],
  quotes: [
    { label: "Desk load", value: "19", note: "quote records currently in motion" },
    { label: "Output", value: "PDF", note: "issue and export controls available" },
    { label: "Default state", value: "Draft", note: "revision actions stay visible first" },
  ],
  sales_desk: [
    { label: "Scope", value: "Cross-stage", note: "quotes, sales orders, dispatches, and invoices in one queue" },
    { label: "Signals", value: "Buckets", note: "unconverted quotes, no-dispatch SOs, not-invoiced dispatches, outstanding invoices" },
    { label: "Action", value: "Open doc", note: "jump straight into the underlying record from the queue row" },
  ],
  sales_orders: [
    { label: "Source", value: "Issued quote", note: "orders are created only from locked customer-ready revisions" },
    { label: "Snapshot", value: "Frozen", note: "terms and commercial lines are copied into the order" },
    { label: "Control", value: "Status live", note: "draft, confirmed, closed, and cancelled remain user-controlled" },
  ],
  dispatches: [
    { label: "Source", value: "Confirmed SO", note: "dispatches begin from confirmed or closed orders" },
    { label: "Control", value: "Qty live", note: "dispatch quantity and shipment metadata remain editable" },
    { label: "Status", value: "Tracked", note: "draft, ready, dispatched, delivered, and cancelled stay visible" },
  ],
  invoices: [
    { label: "Source", value: "Confirmed SO", note: "invoice creation follows operational order confirmation" },
    { label: "Financials", value: "Frozen", note: "invoice lines mirror the sales order snapshot at creation time" },
    { label: "Status", value: "Tracked", note: "draft, issued, paid, and cancelled remain visible to accounts" },
  ],
  receipts: [
    { label: "Collections", value: "Allocatable", note: "receipts can be allocated across outstanding invoices" },
    { label: "Ageing", value: "Visible", note: "customer and invoice ageing stay visible from the same desk" },
    { label: "Posting", value: "Controlled", note: "only posted receipts reduce outstanding balances" },
  ],
  service_warranty: [
    { label: "Source", value: "Dispatch history", note: "service cases start from physically dispatched material" },
    { label: "Moves", value: "Return + Replace", note: "field returns add stock back while replacement issues reduce stock from service inventory" },
    { label: "Traceability", value: "Linked", note: "customer, sales order, dispatch, and invoice context stay visible on the case" },
  ],
  service_tickets: [
    { label: "Intake", value: "Complaint ticket", note: "field complaints start without requiring a dispatch-linked warranty case" },
    { label: "Visit", value: "Asset-gated", note: "job asset must be linked before a site visit can be scheduled" },
    { label: "Proof", value: "Signed report", note: "engineers upload compressed site photos; attendance stays in Field My Day" },
  ],
  job_cards: [
    { label: "Source", value: "Service or internal", note: "job cards can start from a service case or as a standalone internal issue" },
    { label: "Stock", value: "Issue + Return", note: "material issue reduces stock while material return brings unused quantity back" },
    { label: "Control", value: "Consumption", note: "consumed quantity is tracked separately from issued and returned quantity" },
  ],
  engineering_desk: [
    { label: "Datasheets", value: "Sales-ready", note: "client datasheets can be routed directly into the engineering queue" },
    { label: "Lanes", value: "NPD + Drawings", note: "request types stay separated so priorities do not collapse into one list" },
    { label: "Factory link", value: "Live", note: "material, release, and quality signals stay visible beside request intake" },
  ],
  amc_contracts: [
    { label: "Source", value: "Dispatch-linked", note: "AMC coverage begins from already dispatched customer material" },
    { label: "Visits", value: "Scheduled", note: "planned preventive visits are generated from contract start date and visit frequency" },
    { label: "Conversion", value: "Service case", note: "a visit can spawn a service case for field execution and traceability" },
  ],
  sales_returns: [
    { label: "Source", value: "Invoice-first", note: "sales returns start from customer invoices so pending return qty stays controlled" },
    { label: "Stock", value: "Reverse inward", note: "posted customer returns add stock back through the stock ledger" },
    { label: "AR", value: "Credit note", note: "posted return credit reduces outstanding invoice balance in receipts and invoicing views" },
  ],
  reverse_logistics: [
    { label: "Scope", value: "Cross-source", note: "sales returns and service field returns appear in the same disposition queue" },
    { label: "Control", value: "Accept vs scrap", note: "accepted qty stays in stock while scrapped qty posts stock movements with reference" },
    { label: "Signal", value: "Stale lines", note: "stale returns remain visible until disposition is completed" },
  ],
  return_rework: [
    { label: "Trigger", value: "Accepted qty", note: "rework starts only after returned quantity is accepted in reverse logistics" },
    { label: "Execution", value: "Job card", note: "each refurbishment job is tracked as a job card with consumption and closure" },
    { label: "Control", value: "Pending vs planned", note: "accepted qty minus planned rework stays visible as a queue" },
  ],
  purchase_requisitions: [
    { label: "Source", value: "Internal demand", note: "requisitions begin before vendor commitment and procurement execution" },
    { label: "Flow", value: "Approval-led", note: "draft, submitted, approved, and closed states stay visible" },
    { label: "Conversion", value: "PO linked", note: "pending requisition quantities can be converted into purchase orders" },
  ],
  vendor_quotes: [
    { label: "Send", value: "RFQ invite", note: "email vendors when SMTP is ready, or print the RFQ sheet" },
    { label: "Receive", value: "Manual capture", note: "purchaser enters quoted rates and commercial terms from vendor replies" },
    { label: "Decide", value: "Compare → PO", note: "pick a winner on landed cost, credit, delivery, and compliance" },
  ],
  purchase_orders: [
    { label: "Source", value: "Vendor master", note: "purchase orders are created against approved vendor records" },
    { label: "Control", value: "Draft to confirmed", note: "status stays user-driven for procurement control" },
    { label: "Lines", value: "Editable", note: "line items and totals remain editable while in draft" },
  ],
  purchase_invoices: [
    { label: "Source", value: "PO or manual", note: "purchase invoices can be created from purchase orders or entered manually" },
    { label: "Control", value: "Draft to posted", note: "post only after verification and matching" },
    { label: "Totals", value: "GST aware", note: "invoice totals are calculated from line values and GST%" },
  ],
  goods_receipts: [
    { label: "Source", value: "PO or standalone", note: "GRNs can be created from purchase orders or as standalone receipts" },
    { label: "Serial tracking", value: "Selective", note: "serial capture required only when Product Master marks serial numbers required" },
    { label: "Control", value: "Draft to posted", note: "post only after physical verification" },
  ],
  quality_control: [
    { label: "Source", value: "Posted GRN", note: "inspection starts after physical inward is posted into the system" },
    { label: "Split", value: "Accepted / Hold / Rejected", note: "each line is split into operational quality buckets" },
    { label: "Resolution", value: "Replacement / Rework / Accept", note: "held quantity can be resolved after QC close while rejected quantity can still move into RTV" },
  ],
  supplier_claims: [
    { label: "Source", value: "Closed QC", note: "claims start only from closed quality controls with supplier replacement actions" },
    { label: "Tracking", value: "Pending receipt", note: "claim lines track claimed, received, and pending replacement quantities" },
    { label: "Receipts", value: "Traceable", note: "replacement receipt rows stay linked back to claim line, QC, and GRN" },
  ],
  purchase_returns: [
    { label: "Source", value: "GRN or manual", note: "returns can start from GRN or be entered manually for debit note control" },
    { label: "Stock", value: "Reverse", note: "posted returns reduce stock and appear in the stock ledger" },
    { label: "AP", value: "Debit note", note: "linked purchase invoices reduce outstanding through posted debit notes" },
  ],
  stock_ledger: [
    { label: "Scope", value: "Qty only", note: "stock balance is tracked as quantity per item" },
    { label: "Sources", value: "GRN + Dispatch + Service + Adjustment", note: "posted inward, outward, service returns/replacements, and stock adjustments all flow into one ledger" },
    { label: "View", value: "Ledger", note: "movement list stays visible per item for audit" },
  ],
  stock_adjustments: [
    { label: "Mode", value: "Verify or adjust", note: "use physical verification or manual adjustment from the same document shell" },
    { label: "Math", value: "Count vs system", note: "system balance is compared with counted qty and the difference becomes the posted adjustment" },
    { label: "Control", value: "Draft to posted", note: "only posted adjustments affect stock ledger balances" },
  ],
  stock_transfers: [
    { label: "Mode", value: "Location to location", note: "move material between warehouses, sites, vans, and service points" },
    { label: "Serial tracking", value: "Selective", note: "serial-controlled items require exact serial capture on draft transfer lines" },
    { label: "Posting", value: "Controlled", note: "only posted transfers create paired out and in stock ledger movements" },
  ],
  three_way_match: [
    { label: "Mode", value: "Queue", note: "every open mismatch and short-close candidate for the company" },
    { label: "Act", value: "Fix / close", note: "post draft GRN, hold invoice, return excess, or short-close" },
    { label: "Aging", value: "Stalled days", note: "since the last posted GRN or invoice, banded 0–7 / 8–30 / 31+" },
  ],
  approval_desk: [
    { label: "Mode", value: "Central queue", note: "submitted procurement documents sit in one approval rail" },
    { label: "Actions", value: "Fast", note: "approve, send back, or direct-post without opening each desk first" },
    { label: "Traceability", value: "Linked", note: "jump from queue item into the exact source document" },
  ],
  vendor_payments: [
    { label: "Mode", value: "Allocate", note: "allocate a payment across one or more invoices" },
    { label: "Control", value: "Draft to posted", note: "only posted payments reduce outstanding" },
    { label: "Guardrails", value: "Validated", note: "allocations cannot exceed invoice outstanding or payment amount" },
  ],
  vendor_statement: [
    { label: "Mode", value: "Ledger", note: "vendor-wise statement shows invoices and posted payments" },
    { label: "Ageing", value: "Visible", note: "0-30 / 31-60 / 61-90 / 90+ buckets with overdue invoice list" },
    { label: "Output", value: "PDF", note: "export vendor statement PDFs directly from the desk" },
  ],
  bank_book: [
    { label: "Scope", value: "Book-wise", note: "separate running balance for each bank or cash book" },
    { label: "Sources", value: "Auto + manual", note: "posted receipts/payments plus manual book entries flow into the ledger" },
    { label: "Control", value: "Posted", note: "only posted entries affect the running balance" },
  ],
  tds: [
    { label: "Source", value: "Vendor payment", note: "TDS is captured at vendor-payment time against actual settlement amount" },
    { label: "Masters", value: "Sections", note: "default rates and thresholds stay manageable from UI" },
    { label: "View", value: "Summary", note: "vendor-wise and payment-wise deduction visibility stays live" },
  ],
  hr_desk: [
    { label: "Mode", value: "Guided queue", note: "attendance, expenses, activities, and events stay actionable from one entry surface" },
    { label: "People scope", value: "Daily", note: "run everyday employee operations from one compact lane" },
    { label: "Flow", value: "HR-first", note: "manager review and Accounts follow-through stay visible where needed" },
  ],
  hr_admin: [
    { label: "Skills", value: "Matrix", note: "engineering qualifications for commissioning assignment" },
    { label: "Handover", value: "Delegate", note: "transfer admin packs to a successor with audit trail" },
    { label: "Exit", value: "Offboard", note: "release assets and revoke ERP sessions in one action" },
  ],
  attendance: [
    { label: "Mode", value: "Exceptions first", note: "missing punches, late marks, and regularization stay in one queue" },
    { label: "Review", value: "Fast", note: "approve corrections quickly without leaving the desk" },
    { label: "Signal", value: "Daily", note: "present, leave, and pending attendance actions remain visible" },
  ],
  expenses: [
    { label: "Mode", value: "Claim flow", note: "create claims, review manager approval, and track reimbursement status" },
    { label: "Finance link", value: "Connected", note: "Accounts-pending claims remain visible before reimbursement" },
    { label: "Control", value: "Actionable", note: "return incomplete bills and clear ready claims quickly" },
  ],
  activity_planner: [
    { label: "Mode", value: "Board", note: "plan, execute, review, and close work from one task board" },
    { label: "Use", value: "Cross-team", note: "HR, Sales, Service, and Accounts plans can live together" },
    { label: "Signal", value: "Overdue visible", note: "today and delayed work stays visible without searching" },
  ],
  events: [
    { label: "Mode", value: "Calendar + actions", note: "company events, training, and activities stay in one lane" },
    { label: "Broadcast", value: "Ready", note: "registration reminders and itinerary actions stay visible" },
    { label: "Coverage", value: "Employee-led", note: "headcount, slot status, and publication progress stay live" },
  ],
  leave: [
    { label: "Mode", value: "Approval queue", note: "leave requests stay visible for review and action" },
    { label: "Calendar link", value: "Holiday aware", note: "nearby holidays stay visible while planning leave" },
    { label: "Use", value: "People planning", note: "leave and attendance remain coordinated in one HR lane" },
  ],
  holidays: [
    { label: "Mode", value: "Calendar", note: "company holidays stay visible as a working operational list" },
    { label: "Use", value: "Attendance + leave", note: "leave planning and attendance control can read one holiday source" },
    { label: "Control", value: "Editable", note: "festival, national, and shutdown holidays can be updated live" },
  ],
  salary: [
    { label: "Mode", value: "Profile + run", note: "salary setup and payroll generation stay in one workflow" },
    { label: "Coverage", value: "Employee-wise", note: "monthly CTC and breakup remain visible per employee" },
    { label: "Output", value: "Slip-ready", note: "generated payroll moves straight into the salary slip queue" },
  ],
  salary_slips: [
    { label: "Mode", value: "Payout queue", note: "generated slips stay visible until paid" },
    { label: "Filter", value: "Monthly", note: "review payout month by month without losing history" },
    { label: "Closure", value: "Mark paid", note: "slips can be closed with payout confirmation" },
  ],
  marketing: [
    { label: "Trade shows", value: "ROI", note: "CPL and closed-won revenue from attributed leads" },
    { label: "VoM", value: "Logged", note: "Customer and Channel notes feed the board pack" },
    { label: "Use", value: "Spend proof", note: "judge exhibitions by commercial outcome" },
  ],
  management: [
    { label: "Pack", value: "Monthly", note: "commissioning + ROI + VoM in one manuscript" },
    { label: "Status", value: "Draft → Published", note: "publish when ready for governance circulation" },
    { label: "Output", value: "Copy-ready", note: "newsletter and board submission text in one view" },
  ],
  superadmin_home: [
    { label: "Admin lanes", value: "Grouped", note: "setup, people, and document controls are easier to find" },
    { label: "Primary desk", value: "Users", note: "hierarchy and transfer work stay central" },
    { label: "Mode", value: "Control", note: "SuperAdmin navigation now starts from a dedicated hub" },
  ],
  admin_masters: [
    { label: "Master sources", value: "UI", note: "commercial setup moves out of seed-SQL dependence" },
    { label: "Distributor data", value: "Editable", note: "channel partner records can be maintained live" },
    { label: "Quote readiness", value: "Improved", note: "currencies, terms, and codes stay controllable" },
  ],
  office_admin: [
    { label: "Assets", value: "IT hardware", note: "laptops, phones, keys, and access cards with assignment status" },
    { label: "Visitors", value: "Plant floor", note: "active check-ins with one-click check-out" },
    { label: "Control", value: "Office desk", note: "facility presence stays visible without paper logs" },
  ],
  product_master: [
    { label: "Products", value: "UI-led", note: "manual create, edit, and maintenance from one screen" },
    { label: "Import", value: "CSV update", note: "existing item codes update, new ones create" },
    { label: "Specs", value: "Attribute rows", note: "technical captions and values remain editable with the item" },
  ],
  onboarding: [
    { label: "Flows", value: "3", note: "internal, distributor, and distributor employee onboarding" },
    { label: "Defaults", value: "Role-led", note: "rights inherit from the selected role and existing matrix" },
    { label: "Output", value: "Clean setup", note: "users, hierarchy, and company linkage are created in one pass" },
  ],
  users: [
    { label: "Hierarchy", value: "2-level", note: "primary and secondary reporting flow available" },
    { label: "Access", value: "Managed", note: "roles, groups, and passwords under SuperAdmin control" },
    { label: "Commercial", value: "Scoped", note: "user-level discount authority can be overridden" },
  ],
  approval_policy_matrix: [
    { label: "Rule base", value: "Policy-driven", note: "approval authority follows document, amount, vendor, role, and group rules" },
    { label: "Levels", value: "Multi-step", note: "documents move through configured levels before final approval" },
    { label: "Desk feed", value: "Connected", note: "Approval Desk shows the next eligible approver based on these rules" },
  ],
  rights: [
    { label: "Role model", value: "Active", note: "permissions are now driven by role matrices" },
    { label: "Scope flags", value: "Ready", note: "own-record and masking controls are configurable" },
    { label: "Shell gating", value: "Live", note: "page visibility can follow session permissions" },
  ],
  templates: [
    { label: "Managed assets", value: "6", note: "active document packs in control" },
    { label: "Access", value: "Scoped", note: "role-gated administration preserved" },
    { label: "Readiness", value: "Ready", note: "letterhead and scope handling intact" },
  ],
};

const PAGE_COMMANDS = {
  home: [
    { label: "Open My Duty & Expenses", page: "my_duty_expenses" },
    { label: "Open Quotes", page: "quotes" },
    { label: "Review Leads", page: "leads" },
    { label: "Check Customers", page: "customers" },
  ],
  leads: [
    { label: "Go Home", page: "home" },
    { label: "Open Quotes", page: "quotes" },
    { label: "Customer View", page: "customers" },
  ],
  customers: [
    { label: "Go Home", page: "home" },
    { label: "Open Leads", page: "leads" },
    { label: "Open Quotes", page: "quotes" },
  ],
  quotes: [
    { label: "Go Home", page: "home" },
    { label: "Open Leads", page: "leads" },
    { label: "View Customers", page: "customers" },
  ],
  sales_desk: [
    { label: "Go Home", page: "home" },
    { label: "Open Quotes", page: "quotes" },
    { label: "Open Sales Orders", page: "sales_orders" },
  ],
  sales_orders: [
    { label: "Go Home", page: "home" },
    { label: "Open Quotes", page: "quotes" },
    { label: "View Customers", page: "customers" },
  ],
  dispatches: [
    { label: "Go Home", page: "home" },
    { label: "Open Sales Orders", page: "sales_orders" },
    { label: "Open Invoices", page: "invoices" },
  ],
  commissioning_desk: [
    { label: "Go Home", page: "home" },
    { label: "Open Sales Orders", page: "sales_orders" },
    { label: "Service Tickets", page: "service_tickets" },
  ],
  invoices: [
    { label: "Go Home", page: "home" },
    { label: "Open Sales Orders", page: "sales_orders" },
    { label: "Open Dispatches", page: "dispatches" },
  ],
  receipts: [
    { label: "Go Home", page: "home" },
    { label: "Open Invoices", page: "invoices" },
    { label: "Open Sales Orders", page: "sales_orders" },
  ],
  service_warranty: [
    { label: "Go Home", page: "home" },
    { label: "Open Dispatches", page: "dispatches" },
    { label: "Open Invoices", page: "invoices" },
    { label: "Open Stock Ledger", page: "stock_ledger" },
  ],
  job_cards: [
    { label: "Go Home", page: "home" },
    { label: "Open Service Cases", page: "service_warranty" },
    { label: "Open Stock Ledger", page: "stock_ledger" },
  ],
  amc_contracts: [
    { label: "Go Home", page: "home" },
    { label: "Open Dispatches", page: "dispatches" },
    { label: "Open Service Cases", page: "service_warranty" },
  ],
  sales_returns: [
    { label: "Go Home", page: "home" },
    { label: "Open Invoices", page: "invoices" },
    { label: "Open Receipts", page: "receipts" },
  ],
  reverse_logistics: [
    { label: "Go Home", page: "home" },
    { label: "Open Sales Returns", page: "sales_returns" },
    { label: "Open Service Cases", page: "service_warranty" },
  ],
  return_rework: [
    { label: "Go Home", page: "home" },
    { label: "Open Reverse Logistics", page: "reverse_logistics" },
    { label: "Open Job Cards", page: "job_cards" },
  ],
  purchase_requisitions: [
    { label: "Go Home", page: "home" },
    { label: "Open Vendor Quotes / RFQ", page: "vendor_quotes" },
    { label: "Open Purchase Orders", page: "purchase_orders" },
    { label: "Open Approval Desk", page: "approval_desk" },
  ],
  vendor_quotes: [
    { label: "Go Home", page: "home" },
    { label: "Open Purchase Requisitions", page: "purchase_requisitions" },
    { label: "Open Purchase Orders", page: "purchase_orders" },
  ],
  purchase_orders: [
    { label: "Go Home", page: "home" },
    { label: "Open Purchase Requisitions", page: "purchase_requisitions" },
    { label: "Open Vendor Quotes / RFQ", page: "vendor_quotes" },
    { label: "Open Admin Masters", page: "admin_masters" },
    { label: "Open Product Master", page: "product_master" },
  ],
  purchase_invoices: [
    { label: "Go Home", page: "home" },
    { label: "Open Purchase Orders", page: "purchase_orders" },
    { label: "Open Admin Masters", page: "admin_masters" },
  ],
  goods_receipts: [
    { label: "Go Home", page: "home" },
    { label: "Open Quality Hold / RTV", page: "quality_control" },
    { label: "Open Purchase Orders", page: "purchase_orders" },
    { label: "Open Purchase Invoices", page: "purchase_invoices" },
  ],
  quality_control: [
    { label: "Go Home", page: "home" },
    { label: "Open Goods Receipts (GRN)", page: "goods_receipts" },
    { label: "Open Supplier Claims", page: "supplier_claims" },
    { label: "Open Purchase Returns", page: "purchase_returns" },
  ],
  supplier_claims: [
    { label: "Go Home", page: "home" },
    { label: "Open Quality Hold / RTV", page: "quality_control" },
    { label: "Open Goods Receipts (GRN)", page: "goods_receipts" },
  ],
  purchase_returns: [
    { label: "Go Home", page: "home" },
    { label: "Open Quality Hold / RTV", page: "quality_control" },
    { label: "Open Goods Receipts (GRN)", page: "goods_receipts" },
    { label: "Open Vendor Statement", page: "vendor_statement" },
  ],
  stock_ledger: [
    { label: "Go Home", page: "home" },
    { label: "Open Goods Receipts (GRN)", page: "goods_receipts" },
    { label: "Open Dispatches", page: "dispatches" },
  ],
  stock_adjustments: [
    { label: "Go Home", page: "home" },
    { label: "Open Stock Ledger", page: "stock_ledger" },
    { label: "Open Goods Receipts (GRN)", page: "goods_receipts" },
  ],
  stock_transfers: [
    { label: "Go Home", page: "home" },
    { label: "Open Stock Ledger", page: "stock_ledger" },
    { label: "Open Stock Adjustment", page: "stock_adjustments" },
  ],
  three_way_match: [
    { label: "Go Home", page: "home" },
    { label: "Open Approval Desk", page: "approval_desk" },
    { label: "Open Purchase Orders", page: "purchase_orders" },
  ],
  approval_desk: [
    { label: "Go Home", page: "home" },
    { label: "Open Purchase Orders", page: "purchase_orders" },
    { label: "Open Vendor Payments", page: "vendor_payments" },
  ],
  vendor_payments: [
    { label: "Go Home", page: "home" },
    { label: "Open Approval Desk", page: "approval_desk" },
    { label: "Open 3-way Match", page: "three_way_match" },
  ],
  vendor_statement: [
    { label: "Go Home", page: "home" },
    { label: "Open Vendor Payments", page: "vendor_payments" },
    { label: "Open Purchase Invoices", page: "purchase_invoices" },
  ],
  bank_book: [
    { label: "Go Home", page: "home" },
    { label: "Open Receipts", page: "receipts" },
    { label: "Open Vendor Payments", page: "vendor_payments" },
  ],
  tds: [
    { label: "Go Home", page: "home" },
    { label: "Open Vendor Payments", page: "vendor_payments" },
    { label: "Open Admin Masters", page: "admin_masters" },
  ],
  hr_desk: [
    { label: "Go Home", page: "home" },
    { label: "Open HR Admin", page: "hr_admin" },
    { label: "Open My Duty & Expenses", page: "my_duty_expenses" },
    { label: "Open Attendance", page: "attendance" },
    { label: "Open Expenses", page: "expenses" },
    { label: "Open Events", page: "events" },
  ],
  hr_admin: [
    { label: "Go Home", page: "home" },
    { label: "Open HR Desk", page: "hr_desk" },
    { label: "Open Office Admin", page: "office_admin" },
    { label: "Open Org & access", page: "users" },
  ],
  my_duty_expenses: [
    { label: "Go Home", page: "home" },
    { label: "Open Expenses queue", page: "expenses" },
    { label: "Open Attendance", page: "attendance" },
  ],
  attendance: [
    { label: "Go Home", page: "home" },
    { label: "Open My Duty & Expenses", page: "my_duty_expenses" },
    { label: "Open HR Desk", page: "hr_desk" },
    { label: "Open Expenses", page: "expenses" },
    { label: "Open Planner", page: "activity_planner" },
  ],
  expenses: [
    { label: "Go Home", page: "home" },
    { label: "Open My Duty & Expenses", page: "my_duty_expenses" },
    { label: "Open HR Desk", page: "hr_desk" },
    { label: "Open Attendance", page: "attendance" },
    { label: "Open Events", page: "events" },
  ],
  activity_planner: [
    { label: "Go Home", page: "home" },
    { label: "Open HR Desk", page: "hr_desk" },
    { label: "Open Attendance", page: "attendance" },
    { label: "Open Events", page: "events" },
  ],
  events: [
    { label: "Go Home", page: "home" },
    { label: "Open HR Desk", page: "hr_desk" },
    { label: "Open Attendance", page: "attendance" },
    { label: "Open Planner", page: "activity_planner" },
  ],
  leave: [
    { label: "Go Home", page: "home" },
    { label: "Open Holidays", page: "holidays" },
    { label: "Open HR Desk", page: "hr_desk" },
    { label: "Open Attendance", page: "attendance" },
  ],
  holidays: [
    { label: "Go Home", page: "home" },
    { label: "Open Leave", page: "leave" },
    { label: "Open HR Desk", page: "hr_desk" },
    { label: "Open Events", page: "events" },
  ],
  salary: [
    { label: "Go Home", page: "home" },
    { label: "Open Salary Slips", page: "salary_slips" },
    { label: "Open HR Desk", page: "hr_desk" },
    { label: "Open Expenses", page: "expenses" },
  ],
  salary_slips: [
    { label: "Go Home", page: "home" },
    { label: "Open Salary", page: "salary" },
    { label: "Open HR Desk", page: "hr_desk" },
    { label: "Open Expenses", page: "expenses" },
  ],
  superadmin_home: [
    { label: "Open Org & access", page: "users" },
    { label: "Open Access Preview", page: "user_access_preview" },
    { label: "Open Admin Masters", page: "admin_masters" },
    { label: "Open Product Master", page: "product_master" },
  ],
  user_access_preview: [
    { label: "Open Org & access", page: "users" },
    { label: "Open SuperAdmin Home", page: "superadmin_home" },
    { label: "Open Role templates", page: "rights" },
  ],
  admin_masters: [
    { label: "Open SuperAdmin Home", page: "superadmin_home" },
    { label: "Open Office Admin", page: "office_admin" },
    { label: "Open Job Assets", page: "job_asset_admin" },
    { label: "Open Org & access", page: "users" },
    { label: "Open Templates", page: "templates" },
  ],
  office_admin: [
    { label: "Go Home", page: "home" },
    { label: "Open HR Desk", page: "hr_desk" },
    { label: "Open HR Admin", page: "hr_admin" },
  ],
  marketing: [
    { label: "Go Home", page: "home" },
    { label: "Open Marketing Desk", page: "marketing_desk" },
    { label: "Open Exhibitions", page: "exhibitions" },
    { label: "Open Executive Board", page: "management" },
  ],
  management: [
    { label: "Go Home", page: "home" },
    { label: "Open Market Intelligence", page: "marketing" },
    { label: "Open Marketing Desk", page: "marketing_desk" },
    { label: "Open Sales Desk", page: "sales_desk" },
  ],
  job_asset_admin: [
    { label: "Open SuperAdmin Home", page: "superadmin_home" },
    { label: "Open Admin Masters", page: "admin_masters" },
    { label: "Open Product Master", page: "product_master" },
  ],
  product_master: [
    { label: "Open SuperAdmin Home", page: "superadmin_home" },
    { label: "Open Job Assets", page: "job_asset_admin" },
    { label: "Open Admin Masters", page: "admin_masters" },
    { label: "Open Quotes", page: "quotes" },
  ],
  onboarding: [
    { label: "Open SuperAdmin Home", page: "superadmin_home" },
    { label: "Open Org & access", page: "users" },
    { label: "Open Admin Masters", page: "admin_masters" },
  ],
  users: [
    { label: "Open SuperAdmin Home", page: "superadmin_home" },
    { label: "Open User Access Preview", page: "user_access_preview" },
    { label: "Open Quotes", page: "quotes" },
    { label: "Open Templates", page: "templates" },
  ],
  approval_policy_matrix: [
    { label: "Open SuperAdmin Home", page: "superadmin_home" },
    { label: "Open Org & access", page: "users" },
    { label: "Open Approval Desk", page: "approval_desk" },
  ],
  rights: [
    { label: "Open SuperAdmin Home", page: "superadmin_home" },
    { label: "Open Org & access", page: "users" },
    { label: "Open Templates", page: "templates" },
  ],
  templates: [
    { label: "Open SuperAdmin Home", page: "superadmin_home" },
    { label: "Open Quotes", page: "quotes" },
    { label: "View Customers", page: "customers" },
  ],
};

const PAGE_SCENE = {
  home: {
    title: "Today's focus",
    body: "Review priorities, open the next desk, and keep key actions visible.",
    tags: ["Priority view", "Pinned desks", "Next actions"],
  },
  leads: {
    title: "Lead intake control rail",
    body: "Qualification, routing, and quote handoff stay visible without unnecessary narrative layers.",
    tags: ["Lead routing", "Fast qualification", "Quote handoff"],
  },
  customers: {
    title: "Account context rail",
    body: "Lookup, relationship context, and channel partner visibility stay consistent across account work.",
    tags: ["Linked accounts", "Channel Partner view", "Shared shell"],
  },
  quotes: {
    title: "Revision-first workbench",
    body: "Review changes, confirm totals, issue PDFs, and move the quote ahead.",
    tags: ["Revision desk", "PDF issue", "Commercial actions"],
  },
  sales_desk: {
    title: "Sales command rail",
    body: "Track quotes, orders, dispatches, and invoices in one queue so the next gap is easy to spot.",
    tags: ["Sales desk", "Cross-stage queue", "Operational control"],
  },
  sales_orders: {
    title: "Order conversion rail",
    body: "Move from issued quote to booked order inside the shell, with status control and commercial traceability kept visible.",
    tags: ["Quote conversion", "Order desk", "Snapshot control"],
  },
  dispatches: {
    title: "Shipment control rail",
    body: "Capture fulfilment details, quantities, and transporter movement without leaving the shell.",
    tags: ["Dispatch desk", "Qty fulfilment", "Transport tracking"],
  },
  invoices: {
    title: "Invoice control rail",
    body: "Translate confirmed orders into customer invoices and keep commercial totals visible through payment state changes.",
    tags: ["Invoice desk", "Accounts flow", "Financial snapshot"],
  },
  receipts: {
    title: "Collections control rail",
    body: "Track receipts, allocations, and ageing in one place so billing and collections stay connected.",
    tags: ["Receipt desk", "Ageing view", "Outstanding control"],
  },
  service_warranty: {
    title: "After-sales service rail",
    body: "Open warranty and service cases from dispatch history, log field returns and replacement issues, and keep stock impact visible through the central ledger.",
    tags: ["Field return", "Replacement issue", "Customer traceability"],
  },
  service_tickets: {
    title: "Field ticket rail",
    body: "Raise complaint tickets, assign engineers, schedule site visits against installed packages, and capture signed reports on mobile.",
    tags: ["Complaint intake", "Site visit", "Signed report"],
  },
  job_cards: {
    title: "Material issue and consumption rail",
    body: "Issue material against service or internal jobs, log returns, and keep requested vs issued vs consumed quantity visible at the job-card line level.",
    tags: ["Material issue", "Material return", "Consumption tracking"],
  },
  engineering_desk: {
    title: "Engineering command rail",
    body: "Keep client datasheet intake, NPD, drawing work, and release blockers visible in one dense command-center desk.",
    tags: ["Datasheet intake", "Drawing control", "Release blockers"],
  },
  amc_contracts: {
    title: "Preventive maintenance rail",
    body: "Convert dispatched material into AMC coverage, plan future visits, and create field service cases directly from a preventive schedule when action is needed.",
    tags: ["AMC coverage", "Preventive visits", "Service conversion"],
  },
  sales_returns: {
    title: "Customer credit rail",
    body: "Capture customer-side returns from the source invoice, validate serial-controlled quantities, and post credit notes that reduce receivable outstanding cleanly.",
    tags: ["Sales return", "Credit note", "AR reduction"],
  },
  reverse_logistics: {
    title: "Reverse logistics rail",
    body: "Dispose returned items across sources, accept back into stock, or scrap with ledger traceability and clear accountability.",
    tags: ["Disposition", "RMA", "Reverse logistics"],
  },
  return_rework: {
    title: "Return rework rail",
    body: "Convert accepted returns into refurbishment jobs through job cards so consumption, follow-up, and closure remain disciplined.",
    tags: ["Refurb", "Rework", "Job card linkage"],
  },
  purchase_requisitions: {
    title: "Demand planning rail",
    body: "Capture internal need before vendor commitment, move it through approvals, and preserve pending-vs-ordered visibility until procurement takes over.",
    tags: ["Indent desk", "Approval-led", "PO conversion"],
  },
  vendor_quotes: {
    title: "RFQ and compare rail",
    body: "Invite vendors from an approved PR, capture replies, compare a few commercial fields, and create the PO from the selected quote.",
    tags: ["RFQ send", "Manual receive", "Compare → PO"],
  },
  purchase_orders: {
    title: "Procurement control rail",
    body: "Create and control purchase orders from a stable procurement surface linked to the Vendor Master and Product Master.",
    tags: ["Vendor-linked", "Draft control", "Line editing"],
  },
  purchase_invoices: {
    title: "Vendor billing control rail",
    body: "Capture supplier invoices from purchase orders or manual entry, keep status control disciplined, and prepare clean data for Accounts integration.",
    tags: ["PO linked", "Draft to posted", "GST totals"],
  },
  goods_receipts: {
    title: "Stores inward control rail",
    body: "Receive material against purchase orders or as standalone receipts, keep serial control disciplined for serial-tracked items, and post inward with clean traceability.",
    tags: ["PO-linked", "Standalone allowed", "Serial control"],
  },
  quality_control: {
    title: "Post-GRN inspection rail",
    body: "Inspect inward after posting, keep accepted, hold, and rejected quantities visible, resolve held stock through replacement, rework, or final acceptance, and create RTV drafts for rejected quantity.",
    tags: ["Quality hold", "Hold resolution", "RTV draft"],
  },
  supplier_claims: {
    title: "Supplier replacement rail",
    body: "Convert QC replacement actions into supplier claims, monitor pending replacement quantity, and log replacement receipts with serial traceability where needed.",
    tags: ["Supplier claims", "Replacement receipt", "QC traceability"],
  },
  purchase_returns: {
    title: "Return and credit rail",
    body: "Reverse inward stock, link debit notes to vendor invoices, and keep return control inside the purchase flow.",
    tags: ["Return desk", "Stock reversal", "Debit note"],
  },
  stock_ledger: {
    title: "Inventory balance rail",
    body: "Track item-wise balances and movement history, keeping stock visibility connected to GRN posting and dispatch execution.",
    tags: ["Qty ledger", "GRN posting", "Dispatch consumption"],
  },
  stock_adjustments: {
    title: "Inventory reconciliation rail",
    body: "Count stock physically, compare against current ledger balance, and post the verified difference through a controlled adjustment document.",
    tags: ["Physical count", "System vs actual", "Adjustment posting"],
  },
  stock_transfers: {
    title: "Inter-location stock rail",
    body: "Maintain live stock locations, draft transfer documents, and post paired outward and inward movement across warehouses and service points.",
    tags: ["Warehouse transfer", "Location master", "Stock movement"],
  },
  three_way_match: {
    title: "Match control rail",
    body: "Compare PO vs GRN vs Purchase Invoice quantities and keep mismatches visible before approvals, posting, and payments.",
    tags: ["PO match", "GRN match", "Invoice match"],
  },
  approval_desk: {
    title: "Approval command rail",
    body: "Review submitted procurement documents from one queue, take the decision quickly, and jump into the underlying desk only when detailed review is needed.",
    tags: ["Submitted queue", "Fast approval", "Cross-document jump"],
  },
  vendor_payments: {
    title: "Vendor settlement rail",
    body: "Allocate vendor payments across purchase invoices with draft-to-post control so outstanding and 3-way match discipline stay intact.",
    tags: ["Vendor payments", "Invoice allocation", "Outstanding control"],
  },
  vendor_statement: {
    title: "Accounts payable rail",
    body: "Review AP ageing, drill into vendor ledgers, and export vendor statements without leaving the procurement shell.",
    tags: ["Vendor statement", "AP ageing", "Ledger export"],
  },
  bank_book: {
    title: "Cash movement rail",
    body: "Track bank and cash balances from posted inflows, outflows, and manual vouchers in one running book view.",
    tags: ["Book balance", "Receipt flow", "Payment flow"],
  },
  tds: {
    title: "Withholding control rail",
    body: "Keep TDS sections, deducted vendor payments, and withholding visibility aligned with the AP settlement flow.",
    tags: ["TDS sections", "Vendor deduction", "Settlement-linked"],
  },
  hr_desk: {
    title: "People operations rail",
    body: "Run attendance exceptions, expense approvals, employee plans, and event follow-through from one compact people workspace.",
    tags: ["Attendance", "Expenses", "Planner"],
  },
  hr_admin: {
    title: "People governance rail",
    body: "Keep skill qualifications current and run secure admin handovers before access is revoked.",
    tags: ["Skill matrix", "Delegation", "Offboarding"],
  },
  attendance: {
    title: "Attendance action rail",
    body: "Review daily presence, clear late marks, and approve regularization quickly so operational attendance stays current.",
    tags: ["Missing punch", "Late mark", "Regularization"],
  },
  expenses: {
    title: "Claim control rail",
    body: "Capture employee expenses, move them through manager and Accounts review, and keep reimbursement progress visible.",
    tags: ["Claims", "Approval", "Reimbursement"],
  },
  my_duty_expenses: {
    title: "Self-service rail",
    body: "Mark your own duty day and submit one receipt photo per expense head from phone or desktop.",
    tags: ["Duty mark", "Compressed receipt", "Own claims"],
  },
  activity_planner: {
    title: "Planner action rail",
    body: "Convert work into visible planned, in-progress, review, and done lanes so daily follow-up stays disciplined.",
    tags: ["Daily plan", "Task board", "Follow-up"],
  },
  events: {
    title: "Calendar action rail",
    body: "Manage employee activities, event publication, and itinerary broadcasts from one guided company calendar lane.",
    tags: ["Events", "Training", "Broadcast"],
  },
  leave: {
    title: "Leave control rail",
    body: "Review employee leave, approve or reject requests, and keep the holiday context visible while managing people availability.",
    tags: ["Leave queue", "Approval", "Holiday link"],
  },
  holidays: {
    title: "Holiday calendar rail",
    body: "Maintain the company holiday list so leave, attendance, and HR communication work from one visible calendar source.",
    tags: ["Holiday calendar", "Festival list", "Shutdown planning"],
  },
  salary: {
    title: "Payroll setup rail",
    body: "Maintain salary breakups and trigger payroll generation from one compact HR payroll setup desk.",
    tags: ["Salary setup", "Payroll run", "Employee payroll"],
  },
  salary_slips: {
    title: "Payout visibility rail",
    body: "Track generated salary slips and close the month only after payout status is marked clearly for each employee.",
    tags: ["Salary slips", "Payout", "Payroll closure"],
  },
  superadmin_home: {
    title: "SuperAdmin control rail",
    body: "Group setup, people, product, and governance work into clearer admin lanes before drilling into the detailed screens.",
    tags: ["Control desk", "Grouped setup", "Fast admin access"],
  },
  admin_masters: {
    title: "Master control rail",
    body: "Bring commercial and distributor controls into the product so core setup stays operationally editable.",
    tags: ["Distributor master", "Commercial masters", "UI-first admin"],
  },
  office_admin: {
    title: "Office facility rail",
    body: "Track hardware custody and plant visitor presence without leaving the ERP shell.",
    tags: ["IT assets", "Visitor check-in", "Check-out"],
  },
  marketing: {
    title: "Market intelligence rail",
    body: "Connect exhibition spend to lead cost and closed-won revenue, and surface Voice of Market for leadership.",
    tags: ["Trade show ROI", "CPL", "Voice of market"],
  },
  management: {
    title: "Executive manuscript rail",
    body: "Generate and publish monthly board packs from commissioning, marketing ROI, and market feedback.",
    tags: ["Board pack", "Publish", "Governance"],
  },
  job_asset_admin: {
    title: "Aftermarket control rail",
    body: "Keep deployed machine identity, installed BOM snapshots, and replacement mapping governance in one focused admin lane.",
    tags: ["Job assets", "Asset BOM", "Spare mapping"],
  },
  product_master: {
    title: "Item control rail",
    body: "Bring item creation and CSV-based master maintenance into the product so commercial teams stop depending on scripts for updates.",
    tags: ["Item master", "CSV import", "SKU governance"],
  },
  onboarding: {
    title: "Guided onboarding rail",
    body: "Turn employee and channel-partner setup into a controlled wizard so hierarchy, role, and defaults are correct on day one.",
    tags: ["Onboarding wizard", "Hierarchy setup", "SuperAdmin control"],
  },
  users: {
    title: "Org & access rail",
    body: "Govern people from the org chart: identity, screen exceptions, and per-user financial authority in one drawer.",
    tags: ["Org & access", "Org hierarchy", "Access control"],
  },
  approval_policy_matrix: {
    title: "Emergency purchase-band rail",
    body: "Edit purchase document amount bands only when coverage or overlaps need an emergency fix. Per-user ceilings stay in Org & access.",
    tags: ["Emergency band editor", "Purchase routing", "Approval bands"],
  },
  rights: {
    title: "Role templates rail",
    body: "Shape role-level screen templates before they reach daily user workflows. User exceptions stay in Org & access.",
    tags: ["Role templates", "Rights Matrix", "Access governance"],
  },
  user_access_preview: {
    title: "Access Preview rail",
    body: "Diagnose effective visibility, then jump into Org & access to fix exceptions for the selected user.",
    tags: ["Access Preview", "Diagnose", "Org & access handoff"],
  },
  templates: {
    title: "Document control rail",
    body: "Template administration stays integrated with the rest of the operating suite.",
    tags: ["Letterheads", "Scope PDFs", "Admin control"],
  },
  pilot_feedback: {
    title: "Pilot notes rail",
    body: "Triage live blocked, confusing, and suggestion notes from pilot users without leaving Josh.",
    tags: ["Blocked first", "Desk context", "Triage queue"],
  },
  access_profiles: {
    title: "Access profile rail",
    body: "Edit access as None / Viewer / Contributor / Approver per module instead of hundreds of switches, with an impact preview before every save.",
    tags: ["12 × 4 grid", "Impact preview", "Baseline rules"],
  },
  chat_readiness: {
    title: "Alert delivery rail",
    body: "Check Google Chat delivery per person and send a test alert before relying on approvals and cover hand-offs.",
    tags: ["Chat DM", "Send-as", "Test alert"],
  },
};

function getContextActions(page, me) {
  const base = PAGE_COMMANDS[page] || PAGE_COMMANDS.home;
  return base.filter((item) => canAccessPage(me, item.page));
}

function groupNavItems(items) {
  const grouped = NAV_GROUP_ORDER.map((group) => ({
    group,
    items: items.filter((item) => (item.group || "Overview") === group),
  })).filter((section) => section.items.length);

  const matchedKeys = new Set(grouped.flatMap((g) => g.items.map((it) => it.key)));
  const unmatched = items.filter((it) => !matchedKeys.has(it.key));
  if (unmatched.length) {
    const extraMap = {};
    unmatched.forEach((it) => {
      const g = it.group || "Overview";
      if (!extraMap[g]) extraMap[g] = [];
      extraMap[g].push(it);
    });
    Object.entries(extraMap).forEach(([group, gItems]) => {
      grouped.push({ group, items: gItems });
    });
  }
  return grouped;
}

function navGroupSlug(group) {
  return String(group || "overview").trim().toLowerCase().replace(/\s+/g, "-");
}

function findNavGroupForPage(groups, pageKey) {
  const match = groups.find((section) => section.items.some((item) => item.key === pageKey));
  return match?.group || "";
}

function getWorkspaceCompanyTheme(company) {
  const code = String(company?.company_code || "").trim().toUpperCase();
  if (code === "AT") {
    return {
      className: "workspace-theme-at",
      shellKicker: "Absstem",
      shellTitle: "Josh",
      shellCopy: "AT Healthcare workspace",
      routeBadge: "AT",
      shellTags: ["Healthcare", "Service", "AT"],
      vars: {
        "--company-accent": "#148a7a",
        "--company-accent-strong": "#0f6e62",
        "--company-accent-soft": "#d7f2ec",
        "--company-accent-tint": "rgba(20, 138, 122, 0.14)",
        "--company-sidebar-top": "#f3fbf8",
        "--company-sidebar-bottom": "#e7f5f1",
        "--company-sidebar-band": "rgba(20, 138, 122, 0.08)",
        "--company-sidebar-card": "rgba(255, 255, 255, 0.76)",
        "--company-sidebar-border": "rgba(20, 138, 122, 0.12)",
        "--company-sidebar-text": "#14433d",
        "--company-sidebar-muted": "#62817b",
        "--company-panel-top": "rgba(244, 251, 249, 0.98)",
        "--company-panel-bottom": "rgba(234, 246, 242, 0.98)",
      },
    };
  }

  return {
    className: "workspace-theme-ai",
    shellKicker: "Absstem",
    shellTitle: "Josh",
    shellCopy: "AI Industrial workspace",
    routeBadge: "AI",
    shellTags: ["Industrial", "Factory", "AI"],
    vars: {
      "--company-accent": "#2f6fb6",
      "--company-accent-strong": "#184f8b",
      "--company-accent-soft": "#dbe8f6",
      "--company-accent-tint": "rgba(47, 111, 182, 0.14)",
      "--company-sidebar-top": "#f4f7fb",
      "--company-sidebar-bottom": "#e9eff7",
      "--company-sidebar-band": "rgba(47, 111, 182, 0.08)",
      "--company-sidebar-card": "rgba(255, 255, 255, 0.76)",
      "--company-sidebar-border": "rgba(48, 95, 148, 0.12)",
      "--company-sidebar-text": "#183653",
      "--company-sidebar-muted": "#64748b",
      "--company-panel-top": "rgba(245, 248, 252, 0.98)",
      "--company-panel-bottom": "rgba(236, 242, 249, 0.98)",
    },
  };
}

function parseLaunchState() {
  if (typeof window === "undefined") {
    return {
      page: null,
      quoteId: null,
      leadId: null,
      assignedTo: "",
      mailConnectStatus: "",
      mailConnectReason: "",
      authError: "",
    };
  }
  const params = new URLSearchParams(window.location.search);
  const page = params.get("page") || null;
  const quoteId = Number(params.get("quoteId"));
  const leadId = Number(params.get("leadId") || params.get("id"));
  return {
    page,
    quoteId: Number.isFinite(quoteId) && quoteId > 0 ? quoteId : null,
    leadId: Number.isFinite(leadId) && leadId > 0 ? leadId : null,
    assignedTo: params.get("assignedTo") || "",
    mailConnectStatus: params.get("mail_connect") || "",
    mailConnectReason: params.get("mail_reason") || "",
    authError: params.get("authError") || "",
  };
}

function ModuleFrameFallback({ page }) {
  const meta = PAGE_META[page] || PAGE_META.home;
  return (
    <div className="screen-state" style={{ minHeight: 320 }}>
      <div className="screen-state-card">
        <div className="eyebrow-pill">{meta.eyebrow}</div>
        <h1>Loading {meta.title}.</h1>
        <p>Chunking this workspace lowers the initial bundle and loads the active module only when you need it.</p>
      </div>
    </div>
  );
}

function InternalApp() {
  const launchState = parseLaunchState();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(launchState.page || "home");
  const [openQuoteId, setOpenQuoteId] = useState(launchState.quoteId);
  const [openSalesOrderId, setOpenSalesOrderId] = useState(null);
  const [openDispatchId, setOpenDispatchId] = useState(null);
  const [openInvoiceId, setOpenInvoiceId] = useState(null);
  const [openReceiptId, setOpenReceiptId] = useState(null);
  const [openCustomerId, setOpenCustomerId] = useState(null);
  const [openPurchaseRequisitionId, setOpenPurchaseRequisitionId] = useState(null);
  const [openPurchaseOrderId, setOpenPurchaseOrderId] = useState(null);
  const [openPurchaseInvoiceId, setOpenPurchaseInvoiceId] = useState(null);
  const [openGoodsReceiptId, setOpenGoodsReceiptId] = useState(null);
  const [openQualityControlId, setOpenQualityControlId] = useState(null);
  const [openSupplierClaimId, setOpenSupplierClaimId] = useState(null);
  const [openVendorPaymentId, setOpenVendorPaymentId] = useState(null);
  const [jobCardsLaunch, setJobCardsLaunch] = useState(null);
  const [quotesLaunch, setQuotesLaunch] = useState(null);
  const [salesDeskLaunch, setSalesDeskLaunch] = useState(null);
  const [salesOrdersLaunch, setSalesOrdersLaunch] = useState(null);
  const [dispatchesLaunch, setDispatchesLaunch] = useState(null);
  const [invoicesLaunch, setInvoicesLaunch] = useState(null);
  const [proformaLaunch, setProformaLaunch] = useState(null);
  const [openProformaId, setOpenProformaId] = useState(null);
  const [tallyExportLaunch, setTallyExportLaunch] = useState(null);
  const [receiptsLaunch, setReceiptsLaunch] = useState(null);
  const [arDeskLaunch, setArDeskLaunch] = useState(null);
  const [glDeskLaunch, setGlDeskLaunch] = useState(null);
  const [vendorPaymentsLaunch, setVendorPaymentsLaunch] = useState(null);
  const [vendorStatementLaunch, setVendorStatementLaunch] = useState(null);
  const [bankBookLaunch, setBankBookLaunch] = useState(null);
  const [tdsLaunch, setTdsLaunch] = useState(null);
  const [goodsReceiptsLaunch, setGoodsReceiptsLaunch] = useState(null);
  const [purchaseOrdersLaunch, setPurchaseOrdersLaunch] = useState(null);
  const [vendorQuotesLaunch, setVendorQuotesLaunch] = useState(null);
  const [subcontractingLaunch, setSubcontractingLaunch] = useState(null);
  const [serviceWarrantyLaunch, setServiceWarrantyLaunch] = useState(null);
  const [serviceTicketsLaunch, setServiceTicketsLaunch] = useState(null);
  const [aftermarketDeskLaunch, setAftermarketDeskLaunch] = useState(null);
  const [amcContractsLaunch, setAmcContractsLaunch] = useState(null);
  const [purchaseInvoicesLaunch, setPurchaseInvoicesLaunch] = useState(null);
  const [approvalDeskLaunch, setApprovalDeskLaunch] = useState(null);
  const [threeWayMatchLaunch, setThreeWayMatchLaunch] = useState(null);
  const [salesReturnsLaunch, setSalesReturnsLaunch] = useState(null);
  const [reverseLogisticsLaunch, setReverseLogisticsLaunch] = useState(null);
  const [returnReworkLaunch, setReturnReworkLaunch] = useState(null);
  const [stockLedgerLaunch, setStockLedgerLaunch] = useState(null);
  const [qualityControlLaunch, setQualityControlLaunch] = useState(null);
  const [adminLaunch, setAdminLaunch] = useState(null);
  const [manufacturingBomsLaunch, setManufacturingBomsLaunch] = useState(null);
  const [leadsLaunch, setLeadsLaunch] = useState(null);
  const [campaignsLaunch, setCampaignsLaunch] = useState(null);
  const [exhibitionsLaunch, setExhibitionsLaunch] = useState(null);
  const [purchaseReturnsLaunch, setPurchaseReturnsLaunch] = useState(null);
  const [expensesLaunch, setExpensesLaunch] = useState(null);
  const [leaveLaunch, setLeaveLaunch] = useState(null);
  const [engineeringDeskLaunch, setEngineeringDeskLaunch] = useState(null);
  const [localEmail, setLocalEmail] = useState("");
  const [localPassword, setLocalPassword] = useState("");
  const [loginError, setLoginError] = useState(() => launchState.authError || "");
  const [loginBusy, setLoginBusy] = useState(false);
  const [deskGuideOpen, setDeskGuideOpen] = useState(false);
  const [mailConnectStatus, setMailConnectStatus] = useState(launchState.mailConnectStatus || "");
  const [mailConnectReason, setMailConnectReason] = useState(launchState.mailConnectReason || "");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("josh-shell-sidebar") === "collapsed";
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(NARROW_VIEWPORT_QUERY).matches
      : false
  );
  const [productDeskLaunch, setProductDeskLaunch] = useState(null);
  const railCollapsed = sidebarCollapsed && !isNarrowViewport;
  const [navQuery, setNavQuery] = useState("");
  const [openSidebarGroup, setOpenSidebarGroup] = useState("");
  const [lastDeskFix, setLastDeskFix] = useState(() => loadLastDeskFix());
  const [pilotFeedbackOpen, setPilotFeedbackOpen] = useState(false);
  const [pilotFeedbackPrefill, setPilotFeedbackPrefill] = useState(null);
  const [forYouUnread, setForYouUnread] = useState(0);
  const [forYouItems, setForYouItems] = useState([]);
  const [forYouOpen, setForYouOpen] = useState(false);
  const [pushState, setPushState] = useState("checking");
  const [notifyChannels, setNotifyChannels] = useState(null);
  const [testAlertBusy, setTestAlertBusy] = useState(false);
  const pushEnabled = pushState !== "available";

  useEffect(() => {
    fetchMe().finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!launchState.authError || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("authError")) return;
    url.searchParams.delete("authError");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [launchState.authError]);

  useEffect(() => {
    if (!me?.id) return;
    refreshNotifyChannels().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  useEffect(() => {
    if (forYouOpen && me?.id) refreshNotifyChannels().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forYouOpen]);

  useEffect(() => {
    if (!me) return undefined;
    let cancelled = false;
    let timer = null;

    async function refreshForYou() {
      try {
        const [summary, items] = await Promise.all([
          fetchNotificationSummary(),
          fetchNotifications({ unreadOnly: true, limit: 12 }),
        ]);
        if (cancelled) return;
        setForYouUnread(summary.unread_count || 0);
        setForYouItems(items);
      } catch {
        /* ignore */
      }
    }

    function schedulePoll() {
      if (timer) window.clearInterval(timer);
      timer = null;
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        timer = window.setInterval(refreshForYou, 60000);
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") {
        refreshForYou();
        schedulePoll();
      } else if (timer) {
        window.clearInterval(timer);
        timer = null;
      }
    }

    refreshForYou();
    schedulePoll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [me]);

  useEffect(() => {
    if (loading || !me) return;
    const next = parseLaunchState();
    if (next.page && canAccessPage(me, next.page)) {
      setPage(next.page);
      if (next.page === "quotes" && next.quoteId) {
        setOpenQuoteId(next.quoteId);
      }
      if (next.page === "leads") {
        setLeadsLaunch({
          assignedTo: next.assignedTo || "me",
          leadId: next.leadId || null,
        });
      }
    }
    if (next.mailConnectStatus) {
      setMailConnectStatus(next.mailConnectStatus);
    }
    if (next.mailConnectReason) {
      setMailConnectReason(next.mailConnectReason);
    }
    if (typeof window !== "undefined" && window.location.search) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [loading, me]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("josh-shell-sidebar", sidebarCollapsed ? "collapsed" : "expanded");
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mql = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const sync = () => {
      setIsNarrowViewport(mql.matches);
      if (!mql.matches) setMobileNavOpen(false);
    };
    sync();
    mql.addEventListener?.("change", sync);
    return () => mql.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen || typeof document === "undefined") return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event) {
      if (event.key === "Escape") setMobileNavOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (page === "home") {
      setLastDeskFix(loadLastDeskFix());
    }
  }, [page]);

  async function fetchMe() {
    const r = await fetch("/auth/session", { credentials: "include" });
    const data = r.ok ? await r.json() : null;
    setMe(data?.user || null);
    return data?.user || null;
  }

  async function logout() {
    await fetch("/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    setMe(null);
    setPage("home");
    setOpenQuoteId(null);
    setOpenSalesOrderId(null);
    setOpenDispatchId(null);
    setOpenInvoiceId(null);
    setOpenReceiptId(null);
    setOpenPurchaseRequisitionId(null);
    setOpenPurchaseOrderId(null);
    setOpenPurchaseInvoiceId(null);
    setOpenGoodsReceiptId(null);
    setOpenQualityControlId(null);
    setOpenSupplierClaimId(null);
    setOpenVendorPaymentId(null);
    setQuotesLaunch(null);
    setSalesDeskLaunch(null);
    setSalesOrdersLaunch(null);
    setDispatchesLaunch(null);
    setInvoicesLaunch(null);
    setReceiptsLaunch(null);
    setArDeskLaunch(null);
    setGlDeskLaunch(null);
    setVendorPaymentsLaunch(null);
    setVendorStatementLaunch(null);
    setBankBookLaunch(null);
    setTdsLaunch(null);
    setGoodsReceiptsLaunch(null);
    setPurchaseOrdersLaunch(null);
    setVendorQuotesLaunch(null);
    setSubcontractingLaunch(null);
    setServiceWarrantyLaunch(null);
    setServiceTicketsLaunch(null);
    setPurchaseInvoicesLaunch(null);
    setApprovalDeskLaunch(null);
    setThreeWayMatchLaunch(null);
    setSalesReturnsLaunch(null);
    setReverseLogisticsLaunch(null);
    setReturnReworkLaunch(null);
    setStockLedgerLaunch(null);
    setQualityControlLaunch(null);
    setAdminLaunch(null);
    setLeadsLaunch(null);
    setCampaignsLaunch(null);
    setExhibitionsLaunch(null);
    setPurchaseReturnsLaunch(null);
    setExpensesLaunch(null);
    setLeaveLaunch(null);
    setEngineeringDeskLaunch(null);
  }

  async function setActiveCompany(companyId) {
    const id = Number(companyId);
    if (!Number.isFinite(id) || id <= 0) return;
    const stayPage = page;
    await fetch("/auth/active-company", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: id }),
    });
    const nextMe = await fetchMe();
    // Clear company-scoped entity opens and desk launches, then stay on page if still allowed.
    navigateTo(canAccessPage(nextMe, stayPage) ? stayPage : "home", { resetQuote: true, accessMe: nextMe });
  }

  async function localLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoginBusy(true);
    try {
      const r = await fetch("/auth/local/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: localEmail, password: localPassword }),
      });
      if (!r.ok) {
        setLoginError("Invalid email or password.");
        return;
      }
      await fetchMe();
    } finally {
      setLoginBusy(false);
    }
  }

  useEffect(() => {
    if (!me) return;
    if (canAccessPage(me, page)) return;
    const deniedLabel = PAGE_META[page]?.title || NAV_ITEMS.find((item) => item.key === page)?.label || page;
    toast(`You don't have access to ${deniedLabel}. Ask an admin or open Home.`, "error");
    setPage("home");
  }, [me, page]);

  function navigateTo(nextPage, options = {}) {
    setMobileNavOpen(false);
    const actor = options.accessMe || me;
    if (!canAccessPage(actor, nextPage)) {
      const deniedLabel = PAGE_META[nextPage]?.title || NAV_ITEMS.find((item) => item.key === nextPage)?.label || nextPage;
      toast(`You don't have access to ${deniedLabel}. Ask an admin or open Home.`, "error");
      setPage("home");
      return;
    }
    if (options.resetQuote) {
      setOpenQuoteId(null);
      setOpenSalesOrderId(null);
      setOpenDispatchId(null);
      setOpenInvoiceId(null);
      setOpenReceiptId(null);
      setOpenCustomerId(null);
      setOpenPurchaseRequisitionId(null);
      setOpenPurchaseOrderId(null);
      setOpenPurchaseInvoiceId(null);
      setOpenGoodsReceiptId(null);
      setOpenQualityControlId(null);
      setOpenSupplierClaimId(null);
      setOpenVendorPaymentId(null);
      setQuotesLaunch(null);
      setSalesDeskLaunch(null);
      setSalesOrdersLaunch(null);
      setDispatchesLaunch(null);
      setInvoicesLaunch(null);
      setReceiptsLaunch(null);
      setArDeskLaunch(null);
      setGlDeskLaunch(null);
      setVendorPaymentsLaunch(null);
      setVendorStatementLaunch(null);
      setBankBookLaunch(null);
      setTdsLaunch(null);
      setGoodsReceiptsLaunch(null);
      setPurchaseOrdersLaunch(null);
      setVendorQuotesLaunch(null);
      setSubcontractingLaunch(null);
      setServiceWarrantyLaunch(null);
      setPurchaseInvoicesLaunch(null);
      setApprovalDeskLaunch(null);
      setThreeWayMatchLaunch(null);
      setSalesReturnsLaunch(null);
      setReverseLogisticsLaunch(null);
      setStockLedgerLaunch(null);
      setQualityControlLaunch(null);
      setAdminLaunch(null);
      setManufacturingBomsLaunch(null);
      setLeadsLaunch(null);
      setCampaignsLaunch(null);
      setExhibitionsLaunch(null);
      setPurchaseReturnsLaunch(null);
    }
    if (options.resetSalesOrder) {
      setOpenSalesOrderId(null);
    }
    if (options.resetDispatch) {
      setOpenDispatchId(null);
    }
    if (options.resetInvoice) {
      setOpenInvoiceId(null);
    }
    if (options.resetReceipt) {
      setOpenReceiptId(null);
    }
    if (nextPage !== "job_cards") {
      setJobCardsLaunch(null);
    } else if (options.jobCardsLaunch && typeof options.jobCardsLaunch === "object") {
      setJobCardsLaunch(options.jobCardsLaunch);
    }
    if (nextPage !== "quotes") {
      setQuotesLaunch(null);
    } else if (options.quotesLaunch && typeof options.quotesLaunch === "object") {
      setQuotesLaunch(options.quotesLaunch);
    }
    if (nextPage !== "sales_desk") {
      setSalesDeskLaunch(null);
    } else if (options.salesDeskLaunch && typeof options.salesDeskLaunch === "object") {
      setSalesDeskLaunch(options.salesDeskLaunch);
    }
    if (nextPage !== "sales_orders") {
      setSalesOrdersLaunch(null);
    } else if (options.salesOrdersLaunch && typeof options.salesOrdersLaunch === "object") {
      setSalesOrdersLaunch(options.salesOrdersLaunch);
    }
    if (nextPage !== "dispatches") {
      setDispatchesLaunch(null);
    } else if (options.dispatchesLaunch && typeof options.dispatchesLaunch === "object") {
      setDispatchesLaunch(options.dispatchesLaunch);
    }
    if (nextPage !== "invoices") {
      setInvoicesLaunch(null);
    } else if (options.invoicesLaunch && typeof options.invoicesLaunch === "object") {
      setInvoicesLaunch(options.invoicesLaunch);
    }
    if (nextPage !== "receipts") {
      setReceiptsLaunch(null);
    } else if (options.receiptsLaunch && typeof options.receiptsLaunch === "object") {
      setReceiptsLaunch(options.receiptsLaunch);
    }
    if (nextPage !== "ar_desk") {
      setArDeskLaunch(null);
    } else if (options.arDeskLaunch && typeof options.arDeskLaunch === "object") {
      setArDeskLaunch(options.arDeskLaunch);
    }
    if (nextPage !== "gl_desk") {
      setGlDeskLaunch(null);
    } else if (options.glDeskLaunch && typeof options.glDeskLaunch === "object") {
      setGlDeskLaunch(options.glDeskLaunch);
    }
    if (nextPage !== "vendor_payments") {
      setVendorPaymentsLaunch(null);
    } else if (options.vendorPaymentsLaunch && typeof options.vendorPaymentsLaunch === "object") {
      setVendorPaymentsLaunch(options.vendorPaymentsLaunch);
    }
    if (nextPage !== "vendor_statement") {
      setVendorStatementLaunch(null);
    } else if (options.vendorStatementLaunch && typeof options.vendorStatementLaunch === "object") {
      setVendorStatementLaunch(options.vendorStatementLaunch);
    }
    if (nextPage !== "bank_book") {
      setBankBookLaunch(null);
    } else if (options.bankBookLaunch && typeof options.bankBookLaunch === "object") {
      setBankBookLaunch(options.bankBookLaunch);
    }
    if (nextPage !== "tds") {
      setTdsLaunch(null);
    } else if (options.tdsLaunch && typeof options.tdsLaunch === "object") {
      setTdsLaunch(options.tdsLaunch);
    }
    if (nextPage !== "goods_receipts") {
      setGoodsReceiptsLaunch(null);
    } else if (options.goodsReceiptsLaunch && typeof options.goodsReceiptsLaunch === "object") {
      setGoodsReceiptsLaunch(options.goodsReceiptsLaunch);
    }
    if (nextPage !== "purchase_orders") {
      setPurchaseOrdersLaunch(null);
    } else if (options.purchaseOrdersLaunch && typeof options.purchaseOrdersLaunch === "object") {
      setPurchaseOrdersLaunch(options.purchaseOrdersLaunch);
    }
    if (nextPage !== "vendor_quotes") {
      setVendorQuotesLaunch(null);
    } else if (options.vendorQuotesLaunch && typeof options.vendorQuotesLaunch === "object") {
      setVendorQuotesLaunch(options.vendorQuotesLaunch);
    }
    if (nextPage !== "subcontracting") {
      setSubcontractingLaunch(null);
    } else if (options.subcontractingLaunch && typeof options.subcontractingLaunch === "object") {
      setSubcontractingLaunch(options.subcontractingLaunch);
    }
    if (nextPage !== "service_warranty") {
      setServiceWarrantyLaunch(null);
    } else if (options.serviceWarrantyLaunch && typeof options.serviceWarrantyLaunch === "object") {
      setServiceWarrantyLaunch(options.serviceWarrantyLaunch);
    }
    if (nextPage !== "service_tickets") {
      setServiceTicketsLaunch(null);
    } else if (options.serviceTicketsLaunch && typeof options.serviceTicketsLaunch === "object") {
      setServiceTicketsLaunch(options.serviceTicketsLaunch);
    }
    if (nextPage !== "aftermarket_desk") {
      setAftermarketDeskLaunch(null);
    } else if (options.aftermarketDeskLaunch && typeof options.aftermarketDeskLaunch === "object") {
      setAftermarketDeskLaunch(options.aftermarketDeskLaunch);
    }
    if (nextPage !== "amc_contracts") {
      setAmcContractsLaunch(null);
    } else if (options.amcContractsLaunch && typeof options.amcContractsLaunch === "object") {
      setAmcContractsLaunch(options.amcContractsLaunch);
    }
    if (nextPage !== "purchase_invoices") {
      setPurchaseInvoicesLaunch(null);
    } else if (options.purchaseInvoicesLaunch && typeof options.purchaseInvoicesLaunch === "object") {
      setPurchaseInvoicesLaunch(options.purchaseInvoicesLaunch);
    }
    if (nextPage !== "approval_desk") {
      setApprovalDeskLaunch(null);
    } else if (options.approvalDeskLaunch && typeof options.approvalDeskLaunch === "object") {
      setApprovalDeskLaunch(options.approvalDeskLaunch);
    }
    if (nextPage !== "three_way_match") {
      setThreeWayMatchLaunch(null);
    } else if (options.threeWayMatchLaunch && typeof options.threeWayMatchLaunch === "object") {
      setThreeWayMatchLaunch(options.threeWayMatchLaunch);
    }
    if (nextPage !== "sales_returns") {
      setSalesReturnsLaunch(null);
    } else if (options.salesReturnsLaunch && typeof options.salesReturnsLaunch === "object") {
      setSalesReturnsLaunch(options.salesReturnsLaunch);
    }
    if (nextPage !== "reverse_logistics") {
      setReverseLogisticsLaunch(null);
    } else if (options.reverseLogisticsLaunch && typeof options.reverseLogisticsLaunch === "object") {
      setReverseLogisticsLaunch(options.reverseLogisticsLaunch);
    }
    if (nextPage !== "return_rework") {
      setReturnReworkLaunch(null);
    } else if (options.returnReworkLaunch && typeof options.returnReworkLaunch === "object") {
      setReturnReworkLaunch(options.returnReworkLaunch);
    }
    if (nextPage !== "stock_ledger") {
      setStockLedgerLaunch(null);
    } else if (options.stockLedgerLaunch && typeof options.stockLedgerLaunch === "object") {
      setStockLedgerLaunch(options.stockLedgerLaunch);
    }
    if (nextPage !== "quality_control") {
      setQualityControlLaunch(null);
    } else if (options.qualityControlLaunch && typeof options.qualityControlLaunch === "object") {
      setQualityControlLaunch(options.qualityControlLaunch);
    }
    if (nextPage !== "manufacturing_boms") {
      setManufacturingBomsLaunch(null);
    } else if (options.manufacturingBomsLaunch && typeof options.manufacturingBomsLaunch === "object") {
      setManufacturingBomsLaunch(options.manufacturingBomsLaunch);
    }
    if (!["admin_masters", "templates", "users", "approval_policy_matrix"].includes(nextPage)) {
      setAdminLaunch(null);
    } else if (options.adminLaunch && typeof options.adminLaunch === "object") {
      setAdminLaunch(options.adminLaunch);
    } else {
      setAdminLaunch(null);
    }
    if (nextPage !== "leads") {
      setLeadsLaunch(null);
    } else if (options.leadsLaunch && typeof options.leadsLaunch === "object") {
      setLeadsLaunch(options.leadsLaunch);
    }
    if (nextPage !== "campaigns") {
      setCampaignsLaunch(null);
    } else if (options.campaignsLaunch && typeof options.campaignsLaunch === "object") {
      setCampaignsLaunch(options.campaignsLaunch);
    }
    if (nextPage !== "exhibitions") {
      setExhibitionsLaunch(null);
    } else if (options.exhibitionsLaunch && typeof options.exhibitionsLaunch === "object") {
      setExhibitionsLaunch(options.exhibitionsLaunch);
    }
    if (nextPage !== "expenses") {
      setExpensesLaunch(null);
    } else if (options.expensesLaunch && typeof options.expensesLaunch === "object") {
      setExpensesLaunch(options.expensesLaunch);
    }
    if (nextPage !== "leave") {
      setLeaveLaunch(null);
    } else if (options.leaveLaunch && typeof options.leaveLaunch === "object") {
      setLeaveLaunch(options.leaveLaunch);
    }
    if (nextPage !== "engineering_desk") {
      setEngineeringDeskLaunch(null);
    } else if (options.engineeringDeskLaunch && typeof options.engineeringDeskLaunch === "object") {
      setEngineeringDeskLaunch(options.engineeringDeskLaunch);
    }
    if (nextPage !== "purchase_returns") {
      setPurchaseReturnsLaunch(null);
    } else if (options.purchaseReturnsLaunch && typeof options.purchaseReturnsLaunch === "object") {
      setPurchaseReturnsLaunch(options.purchaseReturnsLaunch);
    }
    if (nextPage !== "product_master_desk") {
      setProductDeskLaunch(null);
    } else if (options.productDeskLaunch && typeof options.productDeskLaunch === "object") {
      setProductDeskLaunch(options.productDeskLaunch);
    }
    setPage(nextPage);
    if (options.openQuoteId != null) {
      setOpenQuoteId(options.openQuoteId);
    }
    if (options.openSalesOrderId != null) {
      setOpenSalesOrderId(options.openSalesOrderId);
    }
    if (options.openDispatchId != null) {
      setOpenDispatchId(options.openDispatchId);
    }
    if (options.openInvoiceId != null) {
      setOpenInvoiceId(options.openInvoiceId);
    }
    if (options.openReceiptId != null) {
      setOpenReceiptId(options.openReceiptId);
    }
    if (options.openCustomerId != null) {
      setOpenCustomerId(options.openCustomerId);
    }
    if (options.openPurchaseOrderId != null) {
      setOpenPurchaseOrderId(options.openPurchaseOrderId);
    }
    if (options.openPurchaseRequisitionId != null) {
      setOpenPurchaseRequisitionId(options.openPurchaseRequisitionId);
    }
    if (options.openPurchaseInvoiceId != null) {
      setOpenPurchaseInvoiceId(options.openPurchaseInvoiceId);
    }
    if (options.openGoodsReceiptId != null) {
      setOpenGoodsReceiptId(options.openGoodsReceiptId);
    }
    if (options.openVendorPaymentId != null) {
      setOpenVendorPaymentId(options.openVendorPaymentId);
    }
    setLastDeskFix(loadLastDeskFix());
  }

  async function openNotification(item) {
    if (!item) return;
    setForYouOpen(false);
    setForYouItems((current) => current.filter((entry) => entry.id !== item.id));
    setForYouUnread((current) => Math.max(0, current - (item.read_at ? 0 : 1)));
    if (item.id) markNotificationRead(item.id).catch(() => {});

    const nextPage = item.deep_link_page || "home";
    const entityId = Number(item.deep_link_id || item.payload?.lead_id || item.payload?.quote_id || item.payload?.request_id || item.payload?.claim_id || item.payload?.leave_id || item.payload?.ticket_id) || null;

    if (nextPage === "leads") {
      navigateTo("leads", {
        resetQuote: true,
        leadsLaunch: {
          assignedTo: "me",
          leadId: Number(item.deep_link_id || item.payload?.lead_id) || null,
        },
      });
      return;
    }
    if (nextPage === "quotes") {
      navigateTo("quotes", {
        resetQuote: true,
        openQuoteId: entityId || Number(item.payload?.quote_id) || null,
      });
      return;
    }
    if (nextPage === "approval_desk") {
      navigateTo("approval_desk", {
        resetQuote: true,
        approvalDeskLaunch: {
          doc_type: item.payload?.doc_type || null,
          doc_id: entityId || Number(item.payload?.doc_id) || null,
        },
      });
      return;
    }
    if (nextPage === "engineering_desk") {
      navigateTo("engineering_desk", {
        resetQuote: true,
        engineeringDeskLaunch: {
          request_id: Number(item.deep_link_id || item.payload?.request_id) || entityId || null,
        },
      });
      return;
    }
    if (nextPage === "three_way_match") {
      navigateTo("three_way_match", {
        resetQuote: true,
        threeWayMatchLaunch: {
          po_id: Number(item.payload?.po_id || item.deep_link_id || entityId) || null,
        },
      });
      return;
    }
    if (nextPage === "sales_desk") {
      navigateTo("sales_desk", {
        resetQuote: true,
        salesDeskLaunch: {
          bucket: item.payload?.bucket || "dispatch_not_invoiced",
        },
      });
      return;
    }
    if (nextPage === "ar_desk") {
      navigateTo("ar_desk", {
        resetQuote: true,
        arDeskLaunch: {
          q: item.payload?.customer_name || "",
          customer_id: Number(item.payload?.customer_id || entityId) || null,
        },
      });
      return;
    }
    if (nextPage === "service_tickets") {
      navigateTo("service_tickets", {
        resetQuote: true,
        serviceTicketsLaunch: {
          ticket_id: Number(item.deep_link_id || item.payload?.ticket_id) || entityId || null,
        },
      });
      return;
    }
    if (nextPage === "expenses") {
      navigateTo("expenses", {
        resetQuote: true,
        expensesLaunch: {
          claim_id: Number(item.deep_link_id || item.payload?.claim_id) || entityId || null,
        },
      });
      return;
    }
    if (nextPage === "leave") {
      navigateTo("leave", {
        resetQuote: true,
        leaveLaunch: {
          leave_id: Number(item.deep_link_id || item.payload?.leave_id) || entityId || null,
        },
      });
      return;
    }
    navigateTo(nextPage, { resetQuote: true });
  }

  async function refreshNotifyChannels() {
    const [state, channels] = await Promise.all([getPushState(), fetchNotificationChannels()]);
    setPushState(state);
    setNotifyChannels(channels);
  }

  async function runTestAlert() {
    setTestAlertBusy(true);
    try {
      const channels = await sendTestAlert();
      const reached = [];
      if (channels.chat_dm?.ok) reached.push("Google Chat");
      if (channels.chat_webhook?.ok) reached.push("Chat space");
      if (channels.push?.ok && channels.push?.sent) reached.push(`Chrome (${channels.push.sent} device${channels.push.sent === 1 ? "" : "s"})`);
      toast(
        reached.length
          ? `Test alert sent via ${reached.join(", ")}. It is also in your For you list.`
          : "Test alert saved to For you, but no Chrome or Google Chat channel is set up for you yet.",
        reached.length ? "success" : "warning"
      );
      const [summary, items] = await Promise.all([
        fetchNotificationSummary(),
        fetchNotifications({ unreadOnly: true, limit: 12 }),
      ]);
      setForYouUnread(summary.unread_count || 0);
      setForYouItems(items);
    } catch {
      toast("Test alert could not be sent.", "error");
    } finally {
      setTestAlertBusy(false);
    }
  }

  async function enablePush() {
    try {
      await enableDesktopPush();
      setPushState("enabled");
      toast("Desktop alerts enabled.", "success");
    } catch (err) {
      const code = String(err?.message || "");
      if (code === "PUSH_DENIED") setPushState("denied");
      const message =
        code === "PUSH_UNSUPPORTED"
          ? "Desktop push is not supported in this browser."
          : code === "PUSH_DENIED"
            ? "Notifications were blocked. Allow them in Chrome site settings and try again."
            : code === "PUSH_NOT_CONFIGURED"
              ? "Desktop alerts are not configured on the server yet."
              : "Desktop alerts could not be enabled.";
      toast(message, "error");
    }
  }

  async function markForYouRead() {
    const unreadIds = forYouItems.filter((item) => !item.read_at).map((item) => item.id);
    setForYouItems([]);
    setForYouUnread(0);
    setForYouOpen(false);
    try {
      await markAllNotificationsRead();
    } catch {
      setForYouUnread(unreadIds.length);
    }
  }

  function openStockLedgerProduct(productId, q = "") {
    navigateTo("stock_ledger", {
      resetQuote: true,
      stockLedgerLaunch: {
        product_id: productId,
        q,
      },
    });
  }

  function openAftermarketQuote(launch = {}) {
    const seed = launch && typeof launch === "object" ? launch : {};
    navigateTo("quotes", {
      resetQuote: true,
      quotesLaunch: {
        mode: "aftermarket_service",
        quote_route: String(seed.quote_route || "").trim().toLowerCase() === "healthcare" ? "healthcare" : "industrial",
        ...seed,
      },
    });
  }

  function openDispatchesDesk(launchConfig = null) {
    navigateTo("dispatches", {
      dispatchesLaunch: launchConfig && typeof launchConfig === "object" ? launchConfig : null,
    });
  }

  function openApprovalDesk(launchConfig = null) {
    navigateTo("approval_desk", {
      approvalDeskLaunch: launchConfig && typeof launchConfig === "object" ? launchConfig : null,
    });
  }

  function openThreeWayMatchDesk(launchConfig = null) {
    navigateTo("three_way_match", {
      threeWayMatchLaunch: launchConfig && typeof launchConfig === "object" ? launchConfig : null,
    });
  }

  function openGoodsReceiptsDesk(launchConfig = null) {
    navigateTo("goods_receipts", {
      goodsReceiptsLaunch: launchConfig && typeof launchConfig === "object" ? launchConfig : null,
    });
  }

  function openPurchaseInvoicesDesk(launchConfig = null) {
    navigateTo("purchase_invoices", {
      purchaseInvoicesLaunch: launchConfig && typeof launchConfig === "object" ? launchConfig : null,
    });
  }

  function openReceiptsDesk(launchConfig = null) {
    const seed = launchConfig && typeof launchConfig === "object" ? launchConfig : {};
    navigateTo("receipts", {
      receiptsLaunch: seed,
    });
  }

  function openCreditReleaseDesk({ customerId = null, customerName = "", bucket = "release_requested" } = {}) {
    openReceiptsDesk({
      credit_bucket: bucket || "release_requested",
      credit_q: customerName || (customerId ? String(customerId) : ""),
      customer_id: customerId || undefined,
    });
  }

  function handleClearLastDeskFix() {
    clearLastDeskFix();
    setLastDeskFix(null);
  }

  function resumeLastDeskFix() {
    if (!lastDeskFix?.page || !canAccessPage(me, lastDeskFix.page)) return;
    const opts = { resetQuote: true };
    if (lastDeskFix.manufacturingBomsLaunch) opts.manufacturingBomsLaunch = lastDeskFix.manufacturingBomsLaunch;
    if (lastDeskFix.jobCardsLaunch) opts.jobCardsLaunch = lastDeskFix.jobCardsLaunch;
    if (lastDeskFix.adminLaunch) opts.adminLaunch = lastDeskFix.adminLaunch;
    navigateTo(lastDeskFix.page, opts);
  }

  function renderContent() {
    if (page === "home") {
      return (
        <HomePanel
          me={me}
          onNavigate={navigateTo}
          lastDeskFix={lastDeskFix}
          onClearLastDeskFix={handleClearLastDeskFix}
          companyLabel={workspaceTheme.routeBadge}
          forYou={forYouItems}
          onOpenNotification={openNotification}
          onEnablePush={enablePush}
          pushEnabled={pushEnabled}
          onRequestSku={() => {
            setPilotFeedbackPrefill({
              noteType: "suggestion",
              noteBody:
                "SKU request: Product Master is missing an item I need to quote.\n\nItem / description:\nCustomer / opportunity:\nUrgency:",
            });
            setPilotFeedbackOpen(true);
          }}
        />
      );
    }

    if (page === "superadmin_home" && canAccessPage(me, "superadmin_home")) {
      return <SuperAdminHome onNavigate={navigateTo} />;
    }

    if (page === "leads") {
      return (
        <Leads
          me={me}
          launch={leadsLaunch}
          onConsumeLaunch={() => setLeadsLaunch(null)}
          onOpenQuote={(id, options = {}) => {
            if (options?.builder) {
              navigateTo("quotes", { resetQuote: true, quotesLaunch: { builder_quote_id: id } });
              return;
            }
            setOpenQuoteId(id);
            setPage("quotes");
          }}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenCustomer={(id) => {
            setOpenCustomerId(Number(id) || null);
            setPage("customers");
          }}
        />
      );
    }

    if (page === "inbound_lead_review") {
      return (
        <InboundLeadReview
          onOpenLead={(id) => {
            navigateTo("leads", { resetQuote: true, leadsLaunch: { lead_id: id } });
          }}
        />
      );
    }

    if (page === "customers") {
      return (
        <Customers
          openCustomerId={openCustomerId}
          onOpenQuotes={(customer) => {
            navigateTo("quotes", {
              resetQuote: true,
              quotesLaunch: { q: customer?.customer_name || customer?.customer_code || "" },
            });
          }}
          onOpenSalesOrders={(customer) => {
            navigateTo("sales_orders", {
              resetQuote: true,
              salesOrdersLaunch: { q: customer?.customer_name || customer?.customer_code || "" },
            });
          }}
          onOpenInvoices={(customer) => {
            navigateTo("invoices", {
              resetQuote: true,
              invoicesLaunch: { q: customer?.customer_name || customer?.customer_code || "" },
            });
          }}
          onOpenArDesk={(customer) => {
            navigateTo("ar_desk", {
              resetQuote: true,
              arDeskLaunch: { q: customer?.customer_name || customer?.customer_code || "" },
            });
          }}
        />
      );
    }

    if (page === "quotes") {
      return (
        <Quotes
          openQuoteId={openQuoteId}
          launch={quotesLaunch}
          onConsumeLaunch={() => setQuotesLaunch(null)}
          me={me}
          mailConnectStatus={mailConnectStatus}
          mailConnectReason={mailConnectReason}
          onOpenLead={(id) => {
            navigateTo("leads", { resetQuote: true, leadsLaunch: { lead_id: id } });
          }}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenProforma={(id) => {
            setOpenProformaId(Number(id) || null);
            setProformaLaunch(null);
            setPage("proforma_invoices");
          }}
        />
      );
    }

    if (page === "sales_desk") {
      return (
        <SalesDesk
          me={me}
          launch={salesDeskLaunch}
          onConsumeLaunch={() => setSalesDeskLaunch(null)}
          onOpenQuote={(id) => {
            setOpenQuoteId(id);
            setPage("quotes");
          }}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenDispatch={(id) => {
            setOpenDispatchId(id);
            setPage("dispatches");
          }}
          onOpenInvoice={(id) => {
            setOpenInvoiceId(id);
            setPage("invoices");
          }}
          onCreateInvoiceFromSalesOrder={(salesOrderId) => {
            navigateTo("invoices", {
              resetQuote: true,
              invoicesLaunch: { from_sales_order_id: Number(salesOrderId) || null },
            });
          }}
          onConvertQuoteToSalesOrder={async (quoteId) => {
            const id = Number(quoteId);
            if (!Number.isFinite(id) || id <= 0) return;
            if (!canScreenAction(me, "sales_orders", "can_create")) {
              toast("You don't have permission to create sales orders.", "error");
              return;
            }
            try {
              const res = await fetch(`/sales-orders/from-quote/${id}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
              });
              const data = await res.json().catch(() => null);
              if (!res.ok) {
                toast(data?.detail || data?.error || "Convert to sales order failed.", "error");
                return;
              }
              const soId = Number(data?.sales_order?.id || data?.id || 0);
              toast("Quote converted to sales order.", "success");
              if (Number.isFinite(soId) && soId > 0) {
                setOpenSalesOrderId(soId);
                setPage("sales_orders");
              } else {
                setSalesDeskLaunch({ bucket: "quotes_unconverted" });
              }
            } catch (err) {
              toast(err?.message || "Convert to sales order failed.", "error");
            }
          }}
        />
      );
    }

    if (page === "sales_orders") {
      return (
        <SalesOrders
          me={me}
          openSalesOrderId={openSalesOrderId}
          launch={salesOrdersLaunch}
          onConsumeLaunch={() => setSalesOrdersLaunch(null)}
          onOpenJobCardsDesk={(launchConfig) => {
            navigateTo("job_cards", {
              jobCardsLaunch: launchConfig,
            });
          }}
          onOpenDispatchesDesk={(launchConfig) => openDispatchesDesk(launchConfig)}
          onOpenCreditRelease={({ customerId, customerName }) =>
            openCreditReleaseDesk({ customerId, customerName, bucket: "hold" })
          }
          onOpenQuote={(id) => {
            setOpenQuoteId(id);
            setPage("quotes");
          }}
          onOpenDispatch={(id) => {
            setOpenDispatchId(id);
            setPage("dispatches");
          }}
          onOpenInvoice={(id) => {
            setOpenInvoiceId(id);
            setPage("invoices");
          }}
          onOpenProforma={(launchConfig) => {
            setProformaLaunch(launchConfig || null);
            setPage("proforma_invoices");
          }}
          onOpenReceipt={(id) => {
            const numericId = Number(id);
            if (Number.isFinite(numericId) && numericId > 0) {
              setOpenReceiptId(numericId);
              setReceiptsLaunch(null);
              setPage("receipts");
              return;
            }
            const hint = id == null || id === "" ? "" : String(id).trim();
            setOpenReceiptId(null);
            if (hint) setReceiptsLaunch({ q: hint });
            setPage("receipts");
          }}
        />
      );
    }

    if (page === "dispatches") {
      return (
        <Dispatches
          openDispatchId={openDispatchId}
          launch={dispatchesLaunch}
          onConsumeLaunch={() => setDispatchesLaunch(null)}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenGoodsReceipt={(id) => {
            setOpenGoodsReceiptId(id);
            setPage("goods_receipts");
          }}
          onOpenInvoice={(id) => {
            setOpenInvoiceId(id);
            setPage("invoices");
          }}
          onOpenCreditRelease={({ customerId, customerName }) =>
            openCreditReleaseDesk({ customerId, customerName, bucket: "hold" })
          }
        />
      );
    }

    if (page === "subcontracting") {
      return <Subcontracting launch={subcontractingLaunch} onConsumeLaunch={() => setSubcontractingLaunch(null)} />;
    }

    if (page === "proforma_invoices") {
      return (
        <ProformaInvoices
          openProformaId={openProformaId}
          launch={proformaLaunch}
          onConsumeLaunch={() => {
            setProformaLaunch(null);
            setOpenProformaId(null);
          }}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenInvoice={(id) => {
            setOpenInvoiceId(id);
            setPage("invoices");
          }}
        />
      );
    }

    if (page === "invoices") {
      return (
        <Invoices
          openInvoiceId={openInvoiceId}
          launch={invoicesLaunch}
          activeCompanyId={me?.active_company_id || null}
          onConsumeLaunch={() => setInvoicesLaunch(null)}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenReceipt={(id) => {
            setOpenReceiptId(id);
            setPage("receipts");
          }}
          onOpenDispatch={(id) => {
            setOpenDispatchId(id);
            setPage("dispatches");
          }}
        />
      );
    }

    if (page === "receipts") {
      return (
        <Receipts
          openReceiptId={openReceiptId}
          launch={receiptsLaunch}
          onConsumeLaunch={() => setReceiptsLaunch(null)}
          onOpenInvoice={(id) => {
            setOpenInvoiceId(id);
            setPage("invoices");
          }}
          onOpenSalesReturn={(salesReturnId) => {
            navigateTo("sales_returns", {
              resetQuote: true,
              salesReturnsLaunch: { sales_return_id: salesReturnId },
            });
          }}
          onOpenCustomerInvoices={(customerId, customerName) => {
            navigateTo("invoices", {
              resetQuote: true,
              invoicesLaunch: { bucket: "outstanding", customer_id: customerId, customer_name: customerName || "" },
            });
          }}
          onCreateCreditNoteFromInvoice={(invoiceId, disputeId) => {
            navigateTo("sales_returns", {
              resetQuote: true,
              salesReturnsLaunch: { invoice_id: invoiceId, dispute_id: disputeId, auto_create: true },
            });
          }}
          onOpenArDesk={(launch) => navigateTo("ar_desk", { arDeskLaunch: launch || {} })}
        />
      );
    }

    if (page === "ar_desk") {
      return (
        <ArDesk
          launch={arDeskLaunch}
          onConsumeLaunch={() => setArDeskLaunch(null)}
          onOpenReceipts={(launchConfig) => openReceiptsDesk(launchConfig || {})}
          onOpenCreditRelease={({ customerId, customerName, bucket }) =>
            openCreditReleaseDesk({ customerId, customerName, bucket: bucket || "hold" })
          }
          onOpenInvoice={(id) => {
            setOpenInvoiceId(id);
            setPage("invoices");
          }}
          onOpenSalesReturn={(salesReturnId) => {
            navigateTo("sales_returns", {
              resetQuote: true,
              salesReturnsLaunch: { sales_return_id: salesReturnId },
            });
          }}
          onOpenCustomerInvoices={(customerId, customerName) => {
            navigateTo("invoices", {
              resetQuote: true,
              invoicesLaunch: { bucket: "outstanding", customer_id: customerId, customer_name: customerName || "" },
            });
          }}
        />
      );
    }

    if (page === "gl_desk") {
      return <GlDesk launch={glDeskLaunch} onConsumeLaunch={() => setGlDeskLaunch(null)} />;
    }
    if (page === "landed_cost") {
      return <FinanceLandedCostDesk />;
    }

    if (page === "tally_export") {
      return <TallyExport launch={tallyExportLaunch} onConsumeLaunch={() => setTallyExportLaunch(null)} />;
    }

    if (page === "service_warranty") {
      return (
        <ServiceWarranty
          launch={serviceWarrantyLaunch}
          onConsumeLaunch={() => setServiceWarrantyLaunch(null)}
          onCreateAftermarketQuote={(launch) => openAftermarketQuote(launch)}
          canCreateAftermarketQuote={canAccessPage(me, "quotes")}
        />
      );
    }

    if (page === "service_tickets" && canAccessPage(me, "service_tickets")) {
      return (
        <ServiceTickets
          launch={serviceTicketsLaunch}
          onConsumeLaunch={() => setServiceTicketsLaunch(null)}
          onOpenMyDuty={() => navigateTo("my_duty_expenses", { resetQuote: true })}
          onOpenJobCard={(jobCardId) => {
            navigateTo("job_cards", {
              resetQuote: true,
              jobCardsLaunch: { job_card_id: jobCardId },
            });
          }}
        />
      );
    }

    if (page === "commissioning_desk" && canAccessPage(me, "commissioning_desk")) {
      return <CommissioningDesk me={me} />;
    }

    if (page === "aftermarket_desk") {
      return (
        <AftermarketDesk
          launch={aftermarketDeskLaunch}
          onConsumeLaunch={() => setAftermarketDeskLaunch(null)}
          onOpenServiceCase={(serviceCaseId) => {
            navigateTo("service_warranty", {
              resetQuote: true,
              serviceWarrantyLaunch: { service_case_id: serviceCaseId },
            });
          }}
          onOpenAmcContract={(contractId) => {
            navigateTo("amc_contracts", {
              resetQuote: true,
              amcContractsLaunch: { amc_contract_id: contractId },
            });
          }}
          onOpenServiceTickets={() => navigateTo("service_tickets", { resetQuote: true })}
          onOpenReverseLogistics={() => navigateTo("reverse_logistics", { resetQuote: true })}
          onOpenReturnRework={() => navigateTo("return_rework", { resetQuote: true })}
          onCreateAftermarketQuote={(launch) => openAftermarketQuote(launch)}
          canCreateAftermarketQuote={canAccessPage(me, "quotes")}
        />
      );
    }

    if (page === "reverse_logistics") {
      return (
        <ReverseLogistics
          launch={reverseLogisticsLaunch}
          onConsumeLaunch={() => setReverseLogisticsLaunch(null)}
          onOpenSalesReturn={(salesReturnId) => {
            navigateTo("sales_returns", {
              resetQuote: true,
              salesReturnsLaunch: { sales_return_id: salesReturnId },
            });
          }}
          onOpenServiceCase={(serviceCaseId) => {
            navigateTo("service_warranty", {
              resetQuote: true,
              serviceWarrantyLaunch: { service_case_id: serviceCaseId },
            });
          }}
        />
      );
    }

    if (page === "return_rework") {
      return (
        <ReturnRework
          launch={returnReworkLaunch}
          onConsumeLaunch={() => setReturnReworkLaunch(null)}
          onOpenSalesReturn={(salesReturnId) => {
            navigateTo("sales_returns", {
              resetQuote: true,
              salesReturnsLaunch: { sales_return_id: salesReturnId },
            });
          }}
          onOpenServiceCase={(serviceCaseId) => {
            navigateTo("service_warranty", {
              resetQuote: true,
              serviceWarrantyLaunch: { service_case_id: serviceCaseId },
            });
          }}
          onOpenJobCard={(jobCardId) => {
            navigateTo("job_cards", {
              resetQuote: true,
              jobCardsLaunch: { job_card_id: jobCardId },
            });
          }}
        />
      );
    }

    if (page === "job_cards") {
      return (
        <JobCards
          me={me}
          launch={jobCardsLaunch}
          onConsumeLaunch={() => setJobCardsLaunch(null)}
          canApprove={Boolean(me?.permissions?.screens?.job_cards?.can_approve) || me?.group_name === "SuperAdmin"}
          onOpenServiceTicket={(ticketId) => {
            navigateTo("service_tickets", {
              resetQuote: true,
              serviceTicketsLaunch: { ticket_id: ticketId },
            });
          }}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenManufacturingBoms={(launch = null) => {
            navigateTo("manufacturing_boms", {
              resetQuote: true,
              manufacturingBomsLaunch:
                launch && typeof launch === "object"
                  ? launch
                  : { focus: "setup_gaps" },
            });
          }}
          onOpenStockLedger={(productId, q) => openStockLedgerProduct(productId, q)}
          onOpenDispatchesDesk={(launchConfig) => openDispatchesDesk(launchConfig)}
          onOpenPurchaseRequisition={(id) => {
            setOpenPurchaseRequisitionId(id);
            setPage("purchase_requisitions");
          }}
          onOpenPurchaseOrder={(id) => {
            setOpenPurchaseOrderId(id);
            setPage("purchase_orders");
          }}
          onOpenGoodsReceipt={(id) => {
            setOpenGoodsReceiptId(id);
            setPage("goods_receipts");
          }}
        />
      );
    }

    if (page === "shop_floor") {
      return (
        <ShopFloorDesk
          onNavigate={(targetPage, options) => navigateTo(targetPage, options)}
        />
      );
    }

    if (page === "engineering_desk" && canAccessPage(me, "engineering_desk")) {
      return (
        <EngineeringDesk
          launch={engineeringDeskLaunch}
          onConsumeLaunch={() => setEngineeringDeskLaunch(null)}
          onOpenQuote={(id) => {
            const quoteId = Number(id);
            if (!Number.isFinite(quoteId) || quoteId <= 0) return;
            setOpenQuoteId(quoteId);
            setPage("quotes");
          }}
          onOpenManufacturingBoms={(launch = null) =>
            navigateTo("manufacturing_boms", {
              resetQuote: true,
              manufacturingBomsLaunch:
                launch && typeof launch === "object" ? launch : { focus: "bom_gaps" },
            })
          }
          onOpenJobCardsAudit={(releaseBucket) =>
            navigateTo("job_cards", {
              resetQuote: true,
              jobCardsLaunch: { panel: "audit", release_bucket: releaseBucket || "all" },
            })
          }
          onOpenJobCardsStores={(materialBucket) =>
            navigateTo("job_cards", {
              resetQuote: true,
              jobCardsLaunch: { panel: "stores", material_bucket: materialBucket || "all" },
            })
          }
          onOpenQualityControl={(capaBucket) =>
            navigateTo("quality_control", {
              resetQuote: true,
              qualityControlLaunch: { capa_bucket: capaBucket || "all" },
            })
          }
          onOpenProductMaster={() => {
            if (canAccessPage(me, "product_master")) {
              navigateTo("product_master", { resetQuote: true });
              return;
            }
            if (canAccessPage(me, "product_master_desk")) {
              navigateTo("product_master_desk", { resetQuote: true });
              return;
            }
            toast("Product Master Admin needs SuperAdmin access. Open Product Master Desk or send a Pilot note.", "error");
          }}
          canOpenQualityControl={canAccessPage(me, "quality_control")}
          canOpenProductMaster={
            canAccessPage(me, "product_master") || canAccessPage(me, "product_master_desk")
          }
        />
      );
    }

    if (page === "manufacturing_boms" && canAccessPage(me, "manufacturing_boms")) {
      return (
        <ManufacturingBoms
          me={me}
          launch={manufacturingBomsLaunch}
          onConsumeLaunch={() => setManufacturingBomsLaunch(null)}
        />
      );
    }

    if (page === "amc_contracts") {
      return <AmcContracts launch={amcContractsLaunch} onConsumeLaunch={() => setAmcContractsLaunch(null)} onOpenServiceWarranty={() => setPage("service_warranty")} />;
    }

    if (page === "sales_returns") {
      return <SalesReturns launch={salesReturnsLaunch} onConsumeLaunch={() => setSalesReturnsLaunch(null)} />;
    }

    if (page === "purchase_orders") {
      return (
        <PurchaseOrders
          openPurchaseOrderId={openPurchaseOrderId}
          launch={purchaseOrdersLaunch}
          onConsumeLaunch={() => setPurchaseOrdersLaunch(null)}
          onOpenPurchaseRequisition={(id) => {
            setOpenPurchaseRequisitionId(id);
            setPage("purchase_requisitions");
          }}
          onOpenApprovalDesk={(launchConfig) => openApprovalDesk(launchConfig)}
          onOpenGoodsReceipts={(launchConfig) => openGoodsReceiptsDesk(launchConfig)}
        />
      );
    }

    if (page === "purchase_requisitions") {
      return <PurchaseRequisitions openPurchaseRequisitionId={openPurchaseRequisitionId} onNavigate={navigateTo} />;
    }

    if (page === "vendor_quotes") {
      return (
        <VendorQuotes
          launch={vendorQuotesLaunch}
          onConsumeLaunch={() => setVendorQuotesLaunch(null)}
          onNavigate={navigateTo}
        />
      );
    }

    if (page === "purchase_invoices") {
      return (
        <PurchaseInvoices
          openPurchaseInvoiceId={openPurchaseInvoiceId}
          launch={purchaseInvoicesLaunch}
          onConsumeLaunch={() => setPurchaseInvoicesLaunch(null)}
          onOpenApprovalDesk={(launchConfig) => openApprovalDesk(launchConfig)}
          onOpenThreeWayMatch={(launchConfig) => openThreeWayMatchDesk(launchConfig)}
          onOpenVendorPayments={(launchConfig) =>
            navigateTo("vendor_payments", {
              resetQuote: true,
              vendorPaymentsLaunch: launchConfig,
            })
          }
        />
      );
    }

    if (page === "goods_receipts") {
      return (
        <GoodsReceipts
          openGoodsReceiptId={openGoodsReceiptId}
          launch={goodsReceiptsLaunch}
          onConsumeLaunch={() => setGoodsReceiptsLaunch(null)}
          onOpenPurchaseOrder={(id) => {
            setOpenPurchaseOrderId(id);
            setPage("purchase_orders");
          }}
          onOpenQualityControl={(id) => {
            setOpenQualityControlId(id);
            setPage("quality_control");
          }}
          onOpenQualityControlsDesk={() => navigateTo("quality_control", { resetQuote: true })}
          onOpenSupplierClaim={(id) => {
            setOpenSupplierClaimId(id);
            setPage("supplier_claims");
          }}
          onOpenSupplierClaimsDesk={() => navigateTo("supplier_claims", { resetQuote: true })}
          onOpenPurchaseReturns={(launchConfig) =>
            navigateTo("purchase_returns", {
              resetQuote: true,
              purchaseReturnsLaunch: launchConfig && typeof launchConfig === "object" ? launchConfig : {},
            })
          }
          onOpenThreeWayMatch={(launchConfig) => openThreeWayMatchDesk(launchConfig)}
        />
      );
    }

    if (page === "quality_control") {
      return (
        <QualityControls
          openQualityControlId={openQualityControlId}
          onConsumeOpenQualityControl={() => setOpenQualityControlId(null)}
          launch={qualityControlLaunch}
          onConsumeLaunch={() => setQualityControlLaunch(null)}
        />
      );
    }

    if (page === "supplier_claims") {
      return (
        <SupplierClaims
          openSupplierClaimId={openSupplierClaimId}
          onConsumeOpenSupplierClaim={() => setOpenSupplierClaimId(null)}
          onOpenQualityControl={(qcId) => {
            setOpenQualityControlId(qcId);
            setPage("quality_control");
          }}
        />
      );
    }

    if (page === "purchase_returns") {
      return (
        <PurchaseReturns
          launch={purchaseReturnsLaunch}
          onConsumeLaunch={() => setPurchaseReturnsLaunch(null)}
        />
      );
    }

    if (page === "stock_ledger") {
      return <StockLedger launch={stockLedgerLaunch} onConsumeLaunch={() => setStockLedgerLaunch(null)} />;
    }

    if (page === "stock_adjustments") {
      return <StockAdjustments />;
    }

    if (page === "stock_transfers") {
      return <StockTransfers />;
    }

    if (page === "three_way_match") {
      return (
        <ThreeWayMatch
          launch={threeWayMatchLaunch}
          onConsumeLaunch={() => setThreeWayMatchLaunch(null)}
          onOpenGoodsReceipts={(launchConfig) => openGoodsReceiptsDesk(launchConfig)}
          onOpenPurchaseInvoices={(launchConfig) => openPurchaseInvoicesDesk(launchConfig)}
          onOpenVendorPayments={(launchConfig) =>
            navigateTo("vendor_payments", {
              vendorPaymentsLaunch: launchConfig,
            })
          }
        />
      );
    }

    if (page === "approval_desk") {
      return (
        <ApprovalDesk
          me={me}
          launch={approvalDeskLaunch}
          onConsumeLaunch={() => setApprovalDeskLaunch(null)}
          onOpenPurchaseRequisition={(id) => {
            setOpenPurchaseRequisitionId(id);
            setPage("purchase_requisitions");
          }}
          onOpenPurchaseOrder={(id) => {
            setOpenPurchaseOrderId(id);
            setPage("purchase_orders");
          }}
          onOpenGoodsReceipt={(id) => {
            setOpenGoodsReceiptId(id);
            setPage("goods_receipts");
          }}
          onOpenPurchaseInvoice={(id) => {
            setOpenPurchaseInvoiceId(id);
            setPage("purchase_invoices");
          }}
          onOpenVendorPayment={(id) => {
            setOpenVendorPaymentId(id);
            setPage("vendor_payments");
          }}
        />
      );
    }

    if (page === "vendor_payments") {
      return <VendorPayments openVendorPaymentId={openVendorPaymentId} launch={vendorPaymentsLaunch} onConsumeLaunch={() => setVendorPaymentsLaunch(null)} />;
    }

    if (page === "vendor_statement") {
      return (
        <VendorStatement
          launch={vendorStatementLaunch}
          onConsumeLaunch={() => setVendorStatementLaunch(null)}
          onOpenPurchaseInvoice={(id) => {
            setOpenPurchaseInvoiceId(id);
            setPage("purchase_invoices");
          }}
          onOpenVendorPayments={(launchConfig) => {
            navigateTo("vendor_payments", {
              resetQuote: true,
              vendorPaymentsLaunch: launchConfig,
            });
          }}
        />
      );
    }

    if (page === "bank_book") {
      return (
        <BankBook
          launch={bankBookLaunch}
          onConsumeLaunch={() => setBankBookLaunch(null)}
          onOpenReceipt={(id) => {
            setOpenReceiptId(id);
            setPage("receipts");
          }}
          onOpenVendorPayment={(id) => {
            setOpenVendorPaymentId(id);
            setPage("vendor_payments");
          }}
        />
      );
    }

    if (page === "tds") {
      return (
        <Tds
          launch={tdsLaunch}
          onConsumeLaunch={() => setTdsLaunch(null)}
          onOpenVendorPayment={(id) => {
            setOpenVendorPaymentId(id);
            setPage("vendor_payments");
          }}
          onOpenVendorPaymentsDesk={(launchConfig) => {
            navigateTo("vendor_payments", {
              resetQuote: true,
              vendorPaymentsLaunch: launchConfig,
            });
          }}
          onOpenAdminMasters={() => navigateTo("admin_masters", { resetQuote: true })}
        />
      );
    }

    if (page === "hr_desk") {
      return <HrDesk onNavigate={navigateTo} />;
    }

    if (page === "hr_admin" && canAccessPage(me, "hr_admin")) {
      return <HRAdminDesk />;
    }

    if (page === "office_admin" && canAccessPage(me, "office_admin")) {
      return <OfficeAdminDesk />;
    }

    if (page === "my_duty_expenses") {
      return <MyDutyExpenses />;
    }

    if (page === "attendance") {
      return <Attendance />;
    }

    if (page === "expenses") {
      return <Expenses launch={expensesLaunch} onConsumeLaunch={() => setExpensesLaunch(null)} />;
    }

    if (page === "activity_planner") {
      return <ActivityPlanner />;
    }

    if (page === "events") {
      return <Events />;
    }

    if (page === "leave") {
      return <Leave launch={leaveLaunch} onConsumeLaunch={() => setLeaveLaunch(null)} />;
    }

    if (page === "holidays") {
      return <Holidays />;
    }

    if (page === "salary") {
      return <Salary />;
    }

    if (page === "salary_slips") {
      return <SalarySlips />;
    }

    if (page === "executive_command") {
      return (
        <ExecutiveCommandCenter
          onNavigate={(targetPage, options) => navigateTo(targetPage, options)}
        />
      );
    }

    if (page === "commercial_desk") {
      return (
        <CommercialDesk
          onNavigate={(targetPage, options) => navigateTo(targetPage, options)}
        />
      );
    }

    if (page === "finance_desk") {
      return (
        <FinanceDesk
          onNavigate={(targetPage, options) => navigateTo(targetPage, options)}
        />
      );
    }

    if (page === "service_desk") {
      return (
        <ServiceDesk
          onNavigate={(targetPage, options) => navigateTo(targetPage, options)}
        />
      );
    }

    if (page === "mrp_planning_desk") {
      return (
        <MrpPlanningDesk
          onNavigate={(targetPage, options) => navigateTo(targetPage, options)}
        />
      );
    }

    if (page === "product_master_desk") {
      return (
        <ProductMasterDesk
          launch={productDeskLaunch}
          onConsumeLaunch={() => setProductDeskLaunch(null)}
          onNavigate={(targetPage, options) => navigateTo(targetPage, options)}
        />
      );
    }

    if (page === "tally_import_desk") {
      return (
        <TallyImportDesk
          onNavigate={(targetPage, options) => navigateTo(targetPage, options)}
          activeCompanyId={me?.active_company_id || null}
        />
      );
    }

    if (page === "admin_desk") {
      return (
        <AdminDesk
          onNavigate={(targetPage, options) => navigateTo(targetPage, options)}
        />
      );
    }

    if (page === "marketing_desk") {
      return <MarketingDesk me={me} onNavigate={navigateTo} />;
    }

    if (page === "marketing" && canAccessPage(me, "marketing")) {
      return <MarketingRoiDesk />;
    }

    if (page === "management" && canAccessPage(me, "management")) {
      return <ExecutiveBoardDesk />;
    }

    if (page === "campaigns") {
      return (
        <Campaigns
          launch={campaignsLaunch}
          onConsumeLaunch={() => setCampaignsLaunch(null)}
          onNavigate={navigateTo}
        />
      );
    }

    if (page === "exhibitions") {
      return (
        <Exhibitions
          launch={exhibitionsLaunch}
          onConsumeLaunch={() => setExhibitionsLaunch(null)}
          onNavigate={navigateTo}
        />
      );
    }

    if (page === "source_performance") {
      return <SourcePerformance onNavigate={navigateTo} />;
    }

    if (page === "marketing_mailers") {
      return <MarketingMailers />;
    }

    if (page === "receipts") {
      return (
        <Receipts
          openReceiptId={openReceiptId}
          launch={receiptsLaunch}
          onConsumeLaunch={() => setReceiptsLaunch(null)}
          onOpenInvoice={(id) => {
            setOpenInvoiceId(id);
            setPage("invoices");
          }}
          onOpenSalesReturn={(salesReturnId) => {
            navigateTo("sales_returns", {
              resetQuote: true,
              salesReturnsLaunch: { sales_return_id: salesReturnId },
            });
          }}
          onOpenCustomerInvoices={(customerId, customerName) => {
            navigateTo("invoices", {
              resetQuote: true,
              invoicesLaunch: { bucket: "outstanding", customer_id: customerId, customer_name: customerName || "" },
            });
          }}
          onCreateCreditNoteFromInvoice={(invoiceId, disputeId) => {
            navigateTo("sales_returns", {
              resetQuote: true,
              salesReturnsLaunch: { invoice_id: invoiceId, dispute_id: disputeId, auto_create: true },
            });
          }}
          onOpenArDesk={(launch) => navigateTo("ar_desk", { arDeskLaunch: launch || {} })}
        />
      );
    }

    if (page === "dispatches") {
      return (
        <Dispatches
          openDispatchId={openDispatchId}
          launch={dispatchesLaunch}
          onConsumeLaunch={() => setDispatchesLaunch(null)}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenGoodsReceipt={(id) => {
            setOpenGoodsReceiptId(id);
            setPage("goods_receipts");
          }}
          onOpenInvoice={(id) => {
            setOpenInvoiceId(id);
            setPage("invoices");
          }}
          onOpenCreditRelease={({ customerId, customerName }) =>
            openCreditReleaseDesk({ customerId, customerName, bucket: "hold" })
          }
        />
      );
    }

    if (page === "proforma_invoices") {
      return (
        <ProformaInvoices
          openProformaId={openProformaId}
          launch={proformaLaunch}
          onConsumeLaunch={() => {
            setProformaLaunch(null);
            setOpenProformaId(null);
          }}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenInvoice={(id) => {
            setOpenInvoiceId(id);
            setPage("invoices");
          }}
        />
      );
    }

    if (page === "invoices") {
      return (
        <Invoices
          openInvoiceId={openInvoiceId}
          launch={invoicesLaunch}
          activeCompanyId={me?.active_company_id || null}
          onConsumeLaunch={() => setInvoicesLaunch(null)}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenReceipt={(id) => {
            setOpenReceiptId(id);
            setPage("receipts");
          }}
          onOpenDispatch={(id) => {
            setOpenDispatchId(id);
            setPage("dispatches");
          }}
        />
      );
    }

    if (page === "admin_masters" && canAccessPage(me, "admin_masters")) {
      return <AdminMasters me={me} mailConnectStatus={mailConnectStatus} launch={adminLaunch} onConsumeLaunch={() => setAdminLaunch(null)} onNavigate={navigateTo} />;
    }

    if (page === "job_asset_admin" && canAccessPage(me, "job_asset_admin")) {
      return <JobAssetsAdmin />;
    }

    if (page === "product_master" && canAccessPage(me, "product_master")) {
      return <ProductMaster me={me} />;
    }

    if (page === "data_ops" && canAccessPage(me, "data_ops")) {
      return <DataOpsDesk />;
    }

    if (page === "lead_ingestion" && canAccessPage(me, "lead_ingestion")) {
      return <LeadIngestionAdmin />;
    }

    if (page === "onboarding" && canAccessPage(me, "onboarding")) {
      return <OnboardingWizard onOpenUserMaster={() => setPage("users")} />;
    }

    if (page === "users" && canAccessPage(me, "users")) {
      return <UserMaster launch={adminLaunch} onConsumeLaunch={() => setAdminLaunch(null)} onNavigate={navigateTo} />;
    }

    if (page === "approval_policy_matrix" && canAccessPage(me, "approval_policy_matrix")) {
      return <ApprovalPolicyMatrix launch={adminLaunch} onConsumeLaunch={() => setAdminLaunch(null)} />;
    }

    if (page === "intercompany_partners" && canAccessPage(me, "intercompany_partners")) {
      return <IntercompanyPartners />;
    }

    if (page === "intercompany_dashboard" && canAccessPage(me, "intercompany_dashboard")) {
      return (
        <IntercompanyDashboard
          onOpenPurchaseOrder={(id) => {
            setOpenPurchaseOrderId(id);
            setPage("purchase_orders");
          }}
          onOpenSalesOrder={(id) => {
            setOpenSalesOrderId(id);
            setPage("sales_orders");
          }}
          onOpenDispatch={(id) => {
            setOpenDispatchId(id);
            setPage("dispatches");
          }}
          onOpenGoodsReceipt={(id) => {
            setOpenGoodsReceiptId(id);
            setPage("goods_receipts");
          }}
          onOpenInvoice={(id) => {
            setOpenInvoiceId(id);
            setPage("invoices");
          }}
          onOpenPurchaseInvoice={(id) => {
            setOpenPurchaseInvoiceId(id);
            setPage("purchase_invoices");
          }}
        />
      );
    }

    if (page === "rights" && canAccessPage(me, "rights")) {
      return <RightsMatrix onNavigate={navigateTo} />;
    }

    if (page === "user_access_preview" && canAccessPage(me, "user_access_preview")) {
      return (
        <UserAccessPreview
          launch={adminLaunch}
          onConsumeLaunch={() => setAdminLaunch(null)}
          onNavigate={navigateTo}
        />
      );
    }

    if (page === "pilot_feedback" && canAccessPage(me, "pilot_feedback")) {
      return <PilotFeedbackNotes onNavigate={navigateTo} />;
    }

    if (page === "chat_readiness" && canAccessPage(me, "chat_readiness")) {
      return <ChatReadiness />;
    }

    if (page === "access_profiles" && canAccessPage(me, "access_profiles")) {
      return <AccessProfiles />;
    }

    if (page === "templates" && canAccessPage(me, "templates")) {
      return <Templates launch={adminLaunch} onConsumeLaunch={() => setAdminLaunch(null)} />;
    }

    return (
      <HomePanel
        me={me}
        onNavigate={navigateTo}
        lastDeskFix={lastDeskFix}
        onClearLastDeskFix={handleClearLastDeskFix}
        companyLabel={workspaceTheme.routeBadge}
        forYou={forYouItems}
        onOpenNotification={openNotification}
        onEnablePush={enablePush}
        pushEnabled={pushEnabled}
      />
    );
  }

  const navItems = useMemo(() => NAV_ITEMS.filter((item) => canAccessPage(me, item.key)), [me]);
  const canOpenPage = useMemo(() => (key) => canAccessPage(me, key), [me]);
  const primaryNavItems = useMemo(() => navItems.filter((item) => !SUPERADMIN_PAGES.has(item.key)), [navItems]);
  const adminNavItems = useMemo(() => navItems.filter((item) => SUPERADMIN_PAGES.has(item.key)), [navItems]);
  const primaryNavGroups = useMemo(() => groupNavItems(primaryNavItems), [primaryNavItems]);
  const adminNavGroups = useMemo(() => groupNavItems(adminNavItems), [adminNavItems]);
  const pageMeta = PAGE_META[page] || PAGE_META.home;
  const contextActions = getContextActions(page, me);
  const scene = PAGE_SCENE[page] || PAGE_SCENE.home;
  const normalizedNavQuery = navQuery.trim().toLowerCase();
  const filteredPrimaryNavGroups = useMemo(() => {
    if (!normalizedNavQuery) return primaryNavGroups;
    return primaryNavGroups
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => `${item.label} ${item.detail} ${item.accent}`.toLowerCase().includes(normalizedNavQuery)),
      }))
      .filter((section) => section.items.length);
  }, [primaryNavGroups, normalizedNavQuery]);
  const filteredAdminNavGroups = useMemo(() => {
    if (!normalizedNavQuery) return adminNavGroups;
    return adminNavGroups
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => `${item.label} ${item.detail} ${item.accent}`.toLowerCase().includes(normalizedNavQuery)),
      }))
      .filter((section) => section.items.length);
  }, [adminNavGroups, normalizedNavQuery]);
  const renderedPrimaryNavGroups = useMemo(
    () => filteredPrimaryNavGroups.filter((section) => section.group !== "System Administration"),
    [filteredPrimaryNavGroups]
  );
  const renderedAdminNavGroups = useMemo(() => {
    // Merge operational + SuperAdmin desks into one System Administration block.
    // (Previously filtered on group === "Admin", which matched nothing after the rename.)
    const sourceSections = [...filteredPrimaryNavGroups, ...filteredAdminNavGroups].filter(
      (section) => section.group === "System Administration"
    );
    if (!sourceSections.length) return [];
    const mergedItems = [];
    const seen = new Set();
    sourceSections.forEach((section) => {
      section.items.forEach((item) => {
        if (seen.has(item.key)) return;
        seen.add(item.key);
        mergedItems.push(item);
      });
    });
    return mergedItems.length ? [{ group: "System Administration", items: mergedItems }] : [];
  }, [filteredPrimaryNavGroups, filteredAdminNavGroups]);
  const allVisibleNavGroups = useMemo(() => [...renderedPrimaryNavGroups, ...renderedAdminNavGroups], [renderedPrimaryNavGroups, renderedAdminNavGroups]);
  const activePageNavGroup = useMemo(() => findNavGroupForPage([...primaryNavGroups, ...adminNavGroups], page), [primaryNavGroups, adminNavGroups, page]);
  const firstVisibleNavGroup = allVisibleNavGroups[0]?.group || "";

  useEffect(() => {
    if (activePageNavGroup) {
      setOpenSidebarGroup(activePageNavGroup);
    }
  }, [page, normalizedNavQuery, activePageNavGroup]);

  useEffect(() => {
    if (normalizedNavQuery) return;
    if (!allVisibleNavGroups.length) {
      setOpenSidebarGroup("");
      return;
    }
    const hasCurrentOpen = allVisibleNavGroups.some((section) => section.group === openSidebarGroup);
    if (openSidebarGroup && !hasCurrentOpen && firstVisibleNavGroup) {
      setOpenSidebarGroup(firstVisibleNavGroup);
    }
  }, [normalizedNavQuery, allVisibleNavGroups, openSidebarGroup, firstVisibleNavGroup]);

  function renderSidebarGroup(section) {
    const groupSlug = navGroupSlug(section.group);
    const isOpen = railCollapsed || normalizedNavQuery ? true : openSidebarGroup === section.group;
    return (
      <div key={section.group} className={`sidebar-nav-group ${isOpen ? "sidebar-nav-group-open" : ""}`} data-group={groupSlug}>
        <button
          type="button"
          className={`sidebar-nav-group-label ${isOpen ? "sidebar-nav-group-label-open" : ""}`}
          onClick={() => setOpenSidebarGroup((current) => (current === section.group ? "" : section.group))}
          aria-expanded={isOpen}
        >
          <span>{section.group}</span>
          <strong>{isOpen ? "−" : "+"}</strong>
        </button>
        <div className={`sidebar-nav-group-items ${isOpen ? "sidebar-nav-group-items-open" : ""}`}>
          {section.items.map((item) => {
            const active = item.key === page;
            const secondary = Boolean(item.secondary);
            return (
              <button
                key={item.key}
                type="button"
                className={`sidebar-nav-button ${active ? "sidebar-nav-button-active" : ""} ${secondary ? "sidebar-nav-button-secondary" : ""}`}
                onClick={() => {
                  setMobileNavOpen(false);
                  navigateTo(item.key, { resetQuote: true });
                }}
              >
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <em>{item.accent}</em>
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  const quickJumpItems = useMemo(() => {
    const seen = new Set(["home"]);
    const items = [{ label: "Home base", page: "home" }];
    contextActions.forEach((item) => {
      if (!item?.page || seen.has(item.page) || !canAccessPage(me, item.page)) return;
      seen.add(item.page);
      items.push({ label: item.label, page: item.page });
    });
    primaryNavItems.slice(0, 8).forEach((item) => {
      if (seen.has(item.key)) return;
      seen.add(item.key);
      items.push({ label: item.label, page: item.key });
    });
    return items.slice(0, 5);
  }, [contextActions, me, primaryNavItems]);
  const activeWorkspaceCompany =
    Array.isArray(me?.companies) && me.companies.length
      ? me.companies.find((item) => Number(item.company_id) === Number(me.active_company_id)) || me.companies[0] || null
      : null;
  const activeCompanyCode = activeWorkspaceCompany?.company_code || "";
  const workspaceTheme = getWorkspaceCompanyTheme(activeWorkspaceCompany);

  if (loading) {
    return (
      <div className="screen-state">
        <div className="screen-state-card">
          <div className="eyebrow-pill">Launching JOSH</div>
          <h1>Preparing your workspace.</h1>
          <p>Loading your access, navigation, and desks.</p>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <ToastHost>
        <Login
          localEmail={localEmail}
          setLocalEmail={setLocalEmail}
          localPassword={localPassword}
          setLocalPassword={setLocalPassword}
          loginBusy={loginBusy}
          loginError={loginError}
          localLogin={localLogin}
        />
      </ToastHost>
    );
  }

  return (
    <ToastHost>
    <GlobalTimelineProvider>
    <div className={`workspace-shell ${workspaceTheme.className} ${railCollapsed ? "workspace-shell-collapsed" : ""} ${page === "home" ? "workspace-shell-home" : ""} ${mobileNavOpen ? "workspace-nav-open" : ""}`} style={workspaceTheme.vars}>
      {mobileNavOpen && isNarrowViewport ? (
        <button
          type="button"
          className="workspace-nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}
      <CommandPalette
        items={navItems}
        pageMeta={PAGE_META}
        canOpen={canOpenPage}
        onNavigate={(pageKey, options) => navigateTo(pageKey, options || { resetQuote: true })}
      />
      <aside
        id="workspace-sidebar"
        className={`workspace-sidebar ${page === "home" ? "workspace-sidebar-home" : ""} ${railCollapsed ? "workspace-sidebar-collapsed" : ""}`}
        aria-label="Workspace navigation"
        {...(isNarrowViewport ? { role: "dialog", "aria-modal": mobileNavOpen ? "true" : undefined, "aria-hidden": mobileNavOpen ? undefined : "true" } : {})}
      >
        <div className="sidebar-brand">
          <div className="sidebar-brand-head">
            <img className="brand-logo" src="/absstem_logo.svg" alt="absstem" width={180} height={28} />
            {isNarrowViewport ? (
              <button
                type="button"
                className="sidebar-toggle"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation"
              >
                Close
              </button>
            ) : (
              <button
                type="button"
                className="sidebar-toggle"
                onClick={() => setSidebarCollapsed((current) => !current)}
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                {sidebarCollapsed ? "Expand" : "Collapse"}
              </button>
            )}
          </div>
          <div className="sidebar-brand-copy">
            <div className="eyebrow-pill">{workspaceTheme.shellKicker}</div>
            <h1>{workspaceTheme.shellTitle}</h1>
            <p>{workspaceTheme.shellCopy}</p>
            <div className="workspace-company-route-chip">{workspaceTheme.routeBadge}</div>
          </div>
        </div>

        <div className="sidebar-search-shell">
          <label className="sidebar-search-label">
            <span>Find a desk</span>
            <input
              type="text"
              className="shell-input sidebar-search-input"
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
              placeholder="Quotes, dispatch, bank book..."
            />
          </label>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          {renderedPrimaryNavGroups.map((section) => renderSidebarGroup(section))}
          {renderedAdminNavGroups.length ? (
            <div className="sidebar-admin-block">
              {renderedAdminNavGroups.map((section) => renderSidebarGroup(section))}
            </div>
          ) : null}
          {!renderedPrimaryNavGroups.length && !renderedAdminNavGroups.length ? (
            <div className="sidebar-empty-state">
              <strong>No desks found</strong>
              <span>Try a broader search phrase.</span>
            </div>
          ) : null}
        </nav>

        <div className="sidebar-callout">
          {lastDeskFix?.page && canAccessPage(me, lastDeskFix.page) ? (
            <>
              <div className="panel-kicker">Resume last fix</div>
              <h3>{lastDeskFix.label || lastDeskFix.page}</h3>
              <p>Pick up where you left off on this desk.</p>
              <button type="button" className="button-primary compact-button" onClick={resumeLastDeskFix}>
                Resume
              </button>
            </>
          ) : (
            <>
              <div className="panel-kicker">Current desk</div>
              <h3>{pageMeta.title}</h3>
              <p>Open the right desk, review status, and take the next action.</p>
              <div className="signal-list signal-list-compact">
                <div className="signal-chip">{pageMeta.chip}</div>
                <div className="signal-chip">{pageMeta.status}</div>
                {activeCompanyCode ? <div className="signal-chip">{activeCompanyCode}</div> : null}
              </div>
            </>
          )}
        </div>
      </aside>

      <main className={`workspace-main ${page === "home" ? "workspace-main-home" : ""}`}>
        <header className={`workspace-topbar ${page === "home" ? "workspace-topbar-quiet" : ""}`}>
          {page !== "home" ? (
            <div>
              <div className="panel-kicker">{pageMeta.eyebrow}</div>
              <h2>{pageMeta.title}</h2>
              <p>{pageMeta.description}</p>
            </div>
          ) : null}

          <div className="workspace-actions">
            <button
              type="button"
              className="button-ghost compact-button shell-mobile-nav-button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              aria-controls="workspace-sidebar"
              aria-expanded={mobileNavOpen ? "true" : "false"}
            >
              Menu
            </button>
            {Array.isArray(me.companies) && me.companies.length > 1 ? (
              <label className="topbar-company">
                <span className="topbar-company-label">Company • {workspaceTheme.routeBadge}</span>
                <select
                  value={me.active_company_id || ""}
                  onChange={(e) => setActiveCompany(e.target.value)}
                  className="shell-input topbar-company-select"
                >
                  {me.companies.map((c) => (
                    <option key={c.company_id} value={String(c.company_id)}>
                      {c.company_code} • {c.display_name || c.legal_name}
                    </option>
                  ))}
                </select>
              </label>
            ) : Array.isArray(me.companies) && me.companies.length === 1 ? (
              <div className="topbar-chip">{me.companies[0].company_code}</div>
            ) : null}
            {page !== "home" ? <GlobalTimelineBar /> : null}
            {page !== "home" && lastDeskFix?.page && canAccessPage(me, lastDeskFix.page) ? (
              <button type="button" className="button-ghost compact-button topbar-resume-chip" onClick={resumeLastDeskFix}>
                Resume {lastDeskFix.label || lastDeskFix.page}
              </button>
            ) : null}
            <button
              type="button"
              className="button-ghost compact-button"
              onClick={() => window.dispatchEvent(new Event("josh:open-command-palette"))}
              title="Command pilot (Ctrl+K / ⌘K)"
            >
              Jump ⌘K
            </button>
            <button
              type="button"
              className="button-ghost compact-button"
              onClick={() => {
                setPilotFeedbackPrefill(null);
                setPilotFeedbackOpen(true);
              }}
            >
              Send note
            </button>
            <div className="for-you-shell">
              <button
                type="button"
                className={`button-ghost compact-button for-you-trigger ${forYouUnread ? "for-you-trigger-unread" : ""}`}
                onClick={() => setForYouOpen((open) => !open)}
                aria-expanded={forYouOpen}
                aria-haspopup="dialog"
              >
                For you
                {forYouUnread ? <span className="for-you-badge">{forYouUnread > 99 ? "99+" : forYouUnread}</span> : null}
              </button>
              {forYouOpen ? (
                <div className="for-you-popover" role="dialog" aria-label="For you notifications">
                  <div className="for-you-popover-head">
                    <div>
                      <div className="panel-kicker">For you</div>
                      <strong>{forYouUnread ? `${forYouUnread} unread` : "You are caught up"}</strong>
                    </div>
                    {forYouUnread ? (
                      <button type="button" className="button-ghost compact-button" onClick={markForYouRead}>
                        Mark all read
                      </button>
                    ) : null}
                  </div>
                  <div className="for-you-list">
                    {forYouItems.length ? forYouItems.map((item) => (
                      <button key={item.id} type="button" className="for-you-item" onClick={() => openNotification(item)}>
                        <strong>{item.title}</strong>
                        {item.body ? <span>{item.body}</span> : null}
                        <small>{item.created_at ? new Date(item.created_at).toLocaleString() : "New"}</small>
                      </button>
                    )) : (
                      <div className="for-you-empty">New assignments and action alerts will appear here.</div>
                    )}
                  </div>
                  <div className="for-you-channels">
                    <div>
                      <span>Chrome alerts: </span>
                      <strong>
                        {pushState === "enabled"
                          ? "On ✓"
                          : pushState === "denied"
                            ? "Blocked — allow notifications for this site in Chrome settings"
                            : pushState === "unsupported"
                              ? "Not supported here (on iPhone, add Josh to Home Screen first)"
                              : pushState === "checking"
                                ? "Checking…"
                                : notifyChannels && !notifyChannels.push?.configured
                                  ? "Not configured on server"
                                  : "Off"}
                      </strong>
                    </div>
                    <div>
                      <span>Google Chat: </span>
                      <strong>
                        {notifyChannels?.chat_dm?.configured && notifyChannels?.chat_dm?.eligible && !notifyChannels?.chat_dm?.google_linked
                          ? "Log out and sign in with Google once to link Chat"
                          : notifyChannels?.chat_dm?.configured && notifyChannels?.chat_dm?.eligible
                          ? "On ✓ (private message from Josh)"
                          : notifyChannels?.chat_dm?.configured
                            ? `Only for @${notifyChannels.chat_dm.domain} accounts`
                            : "Not set up yet"}
                      </strong>
                    </div>
                  </div>
                  <div className="for-you-channel-actions">
                    {pushState === "available" && notifyChannels?.push?.configured !== false ? (
                      <button type="button" className="button-primary compact-button for-you-enable" onClick={enablePush}>
                        Enable Chrome alerts
                      </button>
                    ) : null}
                    <button type="button" className="button-ghost compact-button" onClick={runTestAlert} disabled={testAlertBusy}>
                      {testAlertBusy ? "Sending…" : "Send test alert"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="user-chip">
              <strong>{me.group_name}</strong>
              <span>{me.email}</span>
            </div>
            {page !== "home" ? (
              <button type="button" className="button-ghost compact-button shell-utility-button" onClick={() => setSidebarCollapsed((current) => !current)}>
                {sidebarCollapsed ? "Expand rail" : "Collapse rail"}
              </button>
            ) : null}
            <button type="button" className="button-ghost compact-button" onClick={logout}>
              Logout
            </button>
          </div>
        </header>

        {page !== "home" ? (
        <section className="workspace-quickbar">
          <div className="panel-kicker">Quick jump</div>
          <div className="workspace-quickbar-actions">
            {quickJumpItems.map((item) => {
              const active = item.page === page;
              return (
                <button
                  key={item.page}
                  type="button"
                  className={`workspace-quickbar-chip ${active ? "workspace-quickbar-chip-active" : ""}`}
                  onClick={() => navigateTo(item.page, { resetQuote: true })}
                >
                  {item.label}
                </button>
              );
            })}
            <button type="button" className="workspace-quickbar-chip" onClick={() => setDeskGuideOpen((open) => !open)}>
              {deskGuideOpen ? "Hide guide" : "Guide"}
            </button>
          </div>
        </section>
        ) : null}

        {page !== "home" && deskGuideOpen ? (
          <>
            <section className="workspace-banner">
              <div>
                <div className="eyebrow-pill">Keep moving</div>
                <p>Review status, complete the task, and move to the next step.</p>
              </div>
              <div className="banner-tags">
                {workspaceTheme.shellTags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </section>

            <section className="workspace-context-strip">
              <div className="context-scene">
                <div className="panel-kicker">What to do here</div>
                <h3>{scene.title}</h3>
                <p>{scene.body}</p>
              </div>
              <div className="context-actions">
                {contextActions.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className="button-ghost compact-button"
                    onClick={() => navigateTo(item.page, { resetQuote: true })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="context-tags">
                {scene.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </section>
          </>
        ) : null}

        <section className={`module-frame ${page === "home" ? "module-frame-home" : ""}`}>
          <Suspense fallback={<ModuleFrameFallback page={page} />}>{renderContent()}</Suspense>
        </section>
      </main>

      <PilotFeedbackModal
        open={pilotFeedbackOpen}
        onClose={() => {
          setPilotFeedbackOpen(false);
          setPilotFeedbackPrefill(null);
        }}
        deskPage={page}
        deskLabel={pageMeta.title}
        companyCode={activeCompanyCode || workspaceTheme.routeBadge || ""}
        initialNoteType={pilotFeedbackPrefill?.noteType || null}
        initialNoteBody={pilotFeedbackPrefill?.noteBody || ""}
      />
    </div>
    </GlobalTimelineProvider>
    </ToastHost>
  );
}

export default function App() {
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/vendor-portal")) {
    return <VendorPortalApp />;
  }
  return <InternalApp />;
}
