import { useEffect, useMemo, useRef, useState } from "react";

/** Natural-language aliases → page keys (ranked preference order). */
const INTENT_ALIASES = {
  home: ["home"],
  "my day": ["home"],
  overview: ["home"],
  quote: ["quotes", "sales_desk"],
  quotes: ["quotes", "sales_desk"],
  quoting: ["quotes", "sales_desk"],
  "sales desk": ["sales_desk", "quotes"],
  "commercial desk": ["sales_desk", "commercial_desk", "quotes"],
  lead: ["leads", "marketing_desk"],
  leads: ["leads", "inbound_lead_review"],
  pipeline: ["leads", "sales_desk"],
  inbound: ["inbound_lead_review", "leads"],
  mailbox: ["inbound_lead_review"],
  customer: ["customers"],
  customers: ["customers"],
  account: ["customers", "ar_desk"],
  so: ["sales_orders", "sales_desk"],
  "sales order": ["sales_orders"],
  order: ["sales_orders", "purchase_orders"],
  dispatch: ["dispatches"],
  shipment: ["dispatches"],
  invoice: ["invoices", "ar_desk"],
  invoices: ["invoices"],
  billing: ["invoices", "proforma_invoices"],
  ar: ["ar_desk", "receipts"],
  "ar desk": ["ar_desk"],
  collection: ["ar_desk", "receipts"],
  collections: ["ar_desk", "receipts"],
  receipt: ["receipts", "ar_desk"],
  ageing: ["ar_desk", "receipts"],
  gl: ["gl_desk"],
  journal: ["gl_desk"],
  tally: ["tally_import_desk", "tally_export"],
  po: ["purchase_orders", "approval_desk"],
  "purchase order": ["purchase_orders"],
  procurement: ["mrp_planning_desk", "purchase_orders", "purchase_requisitions"],
  mrp: ["mrp_planning_desk"],
  planning: ["mrp_planning_desk"],
  pr: ["mrp_planning_desk", "purchase_requisitions", "approval_desk"],
  requisition: ["purchase_requisitions"],
  rfq: ["vendor_quotes"],
  "vendor quote": ["vendor_quotes"],
  grn: ["goods_receipts"],
  receiving: ["goods_receipts"],
  "goods receipt": ["goods_receipts"],
  goods_receipt: ["goods_receipts", "ar_desk"],
  qc: ["quality_control", "goods_receipts"],
  approval: ["approval_desk", "sales_desk"],
  approve: ["approval_desk", "sales_desk"],
  payable: ["vendor_payments"],
  payment: ["vendor_payments", "receipts"],
  stock: ["stock_ledger", "job_cards"],
  inventory: ["stock_ledger"],
  bom: ["manufacturing_boms"],
  job: ["job_cards"],
  engineering: ["engineering_desk"],
  datasheet: ["engineering_desk"],
  service: ["service_tickets", "aftermarket_desk"],
  ticket: ["service_tickets"],
  amc: ["amc_contracts", "aftermarket_desk"],
  aftermarket: ["aftermarket_desk"],
  warranty: ["service_warranty"],
  expense: ["expenses", "my_duty_expenses", "hr_desk"],
  leave: ["leave", "hr_desk"],
  attendance: ["attendance", "hr_desk"],
  hr: ["hr_desk", "hr_admin"],
  skill: ["hr_admin"],
  offboard: ["hr_admin"],
  visitor: ["office_admin"],
  asset: ["office_admin"],
  office: ["office_admin"],
  payroll: ["salary", "salary_slips"],
  marketing: ["marketing_desk", "marketing", "campaigns"],
  campaign: ["campaigns"],
  exhibition: ["exhibitions", "leads", "marketing"],
  roi: ["marketing"],
  "voice of market": ["marketing"],
  board: ["management", "executive_command"],
  executive: ["executive_command", "management"],
  "executive command": ["executive_command", "management"],
  ecc: ["executive_command"],
  manuscript: ["management"],
  finance: ["finance_desk", "ar_desk", "invoices", "gl_desk"],
  "finance desk": ["finance_desk"],
  "vendor payment": ["vendor_payments"],
  "vendor payments": ["vendor_payments"],
  "3 way": ["three_way_match"],
  "three way": ["three_way_match"],
  match: ["three_way_match", "purchase_invoices"],
  proforma: ["proforma_invoices"],
  "aftermarket desk": ["aftermarket_desk"],
  product: ["product_master_desk", "product_master"],
  sku: ["product_master_desk", "product_master"],
  user: ["users", "onboarding"],
  users: ["users"],
  access: ["users", "user_access_preview", "rights"],
  "org chart": ["users"],
  org: ["users"],
  rights: ["rights", "users"],
  "rights matrix": ["rights"],
  rbac: ["rights", "users", "admin_desk"],
  "role templates": ["rights"],
  onboarding: ["onboarding"],
  onboard: ["onboarding"],
  "job asset": ["job_asset_admin"],
  "job assets": ["job_asset_admin"],
  partner: ["intercompany_partners", "intercompany_dashboard"],
  intercompany: ["intercompany_dashboard", "intercompany_partners"],
  master: ["admin_masters", "product_master"],
  admin: ["admin_desk", "superadmin_home", "admin_masters", "users", "rights", "onboarding"],
  audit: ["admin_desk"],
  security: ["admin_desk"],
  backup: ["admin_desk"],
  governance: ["admin_desk"],
  "data ops": ["data_ops"],
  repair: ["data_ops"],
  ingest: ["lead_ingestion"],
  "lead ingestion": ["lead_ingestion"],
  pilot: ["pilot_feedback"],
  feedback: ["pilot_feedback"],
  duty: ["my_duty_expenses"],
};

const STRIP_PREFIX =
  /^(open|go to|goto|jump to|show|take me to|navigate to|switch to|find|search)\s+/i;

function normalizeQuery(raw) {
  return String(raw || "")
    .trim()
    .replace(STRIP_PREFIX, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Typed prefixes that narrow the record search to one entity kind, e.g. "so 2604", "inv 118". */
const ENTITY_PREFIXES = [
  [/^(so|sales order|order)\s+/, "sales_order"],
  [/^(po|purchase order)\s+/, "purchase_order"],
  [/^(inv|invoice)\s+/, "invoice"],
  [/^(qt|quote)\s+/, "quote"],
  [/^(cust|customer)\s+/, "customer"],
  [/^(ven|vendor|supplier)\s+/, "vendor"],
  [/^(item|sku|product)\s+/, "item"],
];

export function parseEntityQuery(q) {
  for (const [re, kind] of ENTITY_PREFIXES) {
    const m = q.match(re);
    if (m) {
      const term = q.slice(m[0].length).trim();
      if (term.length >= 2) return { kind, term };
    }
  }
  return { kind: null, term: q };
}

const ENTITY_KIND_LABELS = {
  quote: "Quote",
  sales_order: "Sales order",
  purchase_order: "Purchase order",
  invoice: "Invoice",
  customer: "Customer",
  vendor: "Vendor",
  item: "Item",
};

function scoreItem(item, q, pageMeta, aliasHits) {
  if (!q) return item.key === "home" ? 5 : 1;
  const key = String(item.key || "").toLowerCase();
  const label = String(item.label || "").toLowerCase();
  const detail = String(item.detail || "").toLowerCase();
  const group = String(item.group || "").toLowerCase();
  const accent = String(item.accent || "").toLowerCase();
  const meta = pageMeta?.[item.key] || {};
  const metaBlob = `${meta.title || ""} ${meta.description || ""} ${meta.eyebrow || ""} ${meta.chip || ""}`.toLowerCase();
  const hay = `${key} ${label} ${detail} ${group} ${accent} ${metaBlob}`;

  let score = 0;
  if (aliasHits.has(key)) score += 100 - aliasHits.get(key) * 8;
  if (key === q || label === q) score += 95;
  if (key.startsWith(q) || label.startsWith(q)) score += 70;
  if (label.includes(q)) score += 45;
  if (key.includes(q)) score += 40;
  if (detail.includes(q) || group.includes(q) || accent.includes(q)) score += 25;
  if (metaBlob.includes(q)) score += 20;
  if (hay.includes(q)) score += 8;

  // Prefer desks over deep lists when query is generic commercial words
  if ((q === "quote" || q === "quotes") && key === "sales_desk") score += 6;
  if ((q === "ar" || q === "collections") && key === "ar_desk") score += 6;

  return score;
}

function resolveAliasHits(q) {
  const hits = new Map();
  if (!q) return hits;

  if (INTENT_ALIASES[q]) {
    INTENT_ALIASES[q].forEach((key, idx) => {
      if (!hits.has(key)) hits.set(key, idx);
    });
  }

  for (const [alias, keys] of Object.entries(INTENT_ALIASES)) {
    if (alias === q) continue;
    if (q.includes(alias) || alias.includes(q)) {
      keys.forEach((key, idx) => {
        const rank = idx + (alias.includes(q) ? 0 : 2);
        if (!hits.has(key) || hits.get(key) > rank) hits.set(key, rank);
      });
    }
  }
  return hits;
}

function buildQuickActions(items, q) {
  const byKey = new Set(items.map((i) => i.key));
  const actions = [];
  const add = (action) => {
    if (!action?.targetKey || !byKey.has(action.targetKey)) return;
    actions.push(action);
  };

  add({
    id: "qa-sales-desk",
    kind: "action",
    label: "Review quote approvals",
    detail: "Sales Desk · submitted quotes inbox",
    group: "Quick action",
    targetKey: "sales_desk",
    launch: { salesDeskLaunch: { bucket: "quotes_submitted" } },
    keywords: "approve approval quotes pending",
  });
  add({
    id: "qa-quotes",
    kind: "action",
    label: "Open quote workspace",
    detail: "Build and issue commercial offers",
    group: "Quick action",
    targetKey: "quotes",
    keywords: "new quote quoting commercial",
  });
  add({
    id: "qa-ar",
    kind: "action",
    label: "Work AR follow-ups",
    detail: "AR Desk · overdue collection queue",
    group: "Quick action",
    targetKey: "ar_desk",
    launch: { arDeskLaunch: { panel: "followups", bucket: "overdue" } },
    keywords: "collect chase overdue ageing",
  });
  add({
    id: "qa-po",
    kind: "action",
    label: "Open purchase orders",
    detail: "Procurement desk",
    group: "Quick action",
    targetKey: "purchase_orders",
    keywords: "buy vendor po procurement",
  });
  add({
    id: "qa-approval",
    kind: "action",
    label: "Open Approval Desk",
    detail: "PR / PO submitted queue",
    group: "Quick action",
    targetKey: "approval_desk",
    keywords: "approve stamp requisition",
  });
  add({
    id: "qa-leads",
    kind: "action",
    label: "Open my lead queue",
    detail: "Overdue / due-today follow-ups",
    group: "Quick action",
    targetKey: "leads",
    launch: { leadsLaunch: { queue: "overdue", assignedTo: "me" } },
    keywords: "pipeline follow up crm",
  });

  if (!q) return actions.slice(0, 4);
  return actions
    .map((action) => {
      const blob = `${action.label} ${action.detail} ${action.keywords}`.toLowerCase();
      let score = 0;
      if (blob.includes(q)) score += 50;
      q.split(/\s+/).forEach((part) => {
        if (part && blob.includes(part)) score += 15;
      });
      return { ...action, _score: score };
    })
    .filter((a) => a._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 4);
}

/**
 * Global Cmd/Ctrl+K command pilot — fast jump across accessible desks + quick actions.
 */
export default function CommandPalette({ items = [], pageMeta = {}, onNavigate, canOpen = null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [entities, setEntities] = useState([]);
  const [entityState, setEntityState] = useState("idle");
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    function openPalette() {
      setIsOpen(true);
      setQuery("");
      setActiveIndex(0);
    }
    function handleKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((prev) => {
          if (prev) return false;
          setQuery("");
          setActiveIndex(0);
          return true;
        });
      } else if (e.key === "Escape" && isOpen) {
        e.preventDefault();
        setIsOpen(false);
      }
    }
    function handleOpenEvent() {
      openPalette();
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("josh:open-command-palette", handleOpenEvent);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("josh:open-command-palette", handleOpenEvent);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setEntities([]);
      setEntityState("idle");
      return undefined;
    }
    const { kind, term } = parseEntityQuery(normalizeQuery(query));
    if (term.length < 2) {
      setEntities([]);
      setEntityState("idle");
      return undefined;
    }
    let cancelled = false;
    setEntityState("loading");
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: term });
      if (kind) params.set("kind", kind);
      fetch(`/api/search/entities?${params.toString()}`, { credentials: "include" })
        .then((res) => res.json().catch(() => null))
        .then((data) => {
          if (cancelled) return;
          setEntities(Array.isArray(data?.entities) ? data.entities : []);
          setEntityState(data?.ok ? (data.partial ? "partial" : "ready") : "error");
        })
        .catch(() => {
          if (cancelled) return;
          setEntities([]);
          setEntityState("error");
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, query]);

  const results = useMemo(() => {
    const q = normalizeQuery(query);
    const { kind: entityKind, term: entityTerm } = parseEntityQuery(q);
    const aliasHits = resolveAliasHits(q);
    const accessible = (key) => (typeof canOpen === "function" ? canOpen(key) : true);
    const deskRows = (items || [])
      .map((item) => {
        const score = scoreItem(item, q, pageMeta, aliasHits);
        const meta = pageMeta?.[item.key] || {};
        return {
          id: `nav-${item.key}`,
          kind: "nav",
          key: item.key,
          label: item.label,
          detail: meta.description || item.detail || meta.eyebrow || "",
          group: item.group || meta.chip || "",
          accent: item.accent,
          targetKey: item.key,
          launch: null,
          _score: score,
        };
      })
      .filter((row) => (q ? row._score > 0 : true))
      .sort((a, b) => b._score - a._score || String(a.label).localeCompare(String(b.label)));

    const actions = buildQuickActions(items, q).map((action) => ({
      ...action,
      _score: (action._score || 0) + (q ? 10 : 120),
    }));

    const termLower = String(entityTerm || "").toLowerCase();
    const entityRows = (entities || [])
      .map((entity, index) => {
        let targetKey = entity.page;
        let launch = entity.launch || null;
        if (!accessible(targetKey)) {
          if (entity.alt_page && accessible(entity.alt_page)) {
            targetKey = entity.alt_page;
            launch = entity.alt_launch || null;
          } else {
            return null;
          }
        }
        const label = String(entity.label || "");
        const exact = label.toLowerCase() === termLower;
        const prefix = !exact && label.toLowerCase().startsWith(termLower);
        return {
          id: `entity-${entity.kind}-${entity.id}`,
          kind: "entity",
          label,
          detail: entity.detail || "",
          badge: entity.kind_label || ENTITY_KIND_LABELS[entity.kind] || "Record",
          group: "Jump to record",
          targetKey,
          launch,
          _score: (exact ? 160 : prefix ? 130 : 110) - index * 0.01,
        };
      })
      .filter(Boolean);

    if (entityKind) {
      return entityRows.slice(0, 14);
    }

    const merged = q
      ? [...entityRows, ...actions, ...deskRows].sort((a, b) => b._score - a._score).slice(0, 14)
      : [...actions.slice(0, 3), ...deskRows.slice(0, 10)];

    return merged;
  }, [items, pageMeta, query, entities, canOpen]);

  useEffect(() => {
    const node = listRef.current?.querySelector?.(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, isOpen]);

  if (!isOpen) return null;

  function choose(row) {
    if (!row?.targetKey) return;
    setIsOpen(false);
    setQuery("");
    const opts = { resetQuote: true };
    if (row.launch && typeof row.launch === "object") Object.assign(opts, row.launch);
    onNavigate?.(row.targetKey, opts);
  }

  const modKey = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || "") ? "⌘" : "Ctrl";

  return (
    <div className="command-palette-overlay" role="presentation" onClick={() => setIsOpen(false)}>
      <div
        className="command-palette-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Command pilot"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="command-palette-head">
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder='Desk name, quote / SO / PO / invoice #, customer, vendor, item code… (try “so 2604”)'
            aria-label="Search desks and records"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(results[activeIndex]);
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="command-palette-kbd">{modKey}+K</kbd>
        </div>

        <div className="command-palette-list" role="listbox" ref={listRef}>
          {results.length ? (
            results.map((row, index) => (
              <button
                key={row.id}
                type="button"
                role="option"
                data-index={index}
                aria-selected={index === activeIndex}
                className={`command-palette-row ${index === activeIndex ? "is-active" : ""} ${row.kind === "action" ? "is-action" : ""}`}
                onClick={() => choose(row)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="command-palette-row-main">
                  <strong>{row.label}</strong>
                  <small>{row.detail || row.group}</small>
                </span>
                <em className={row.kind === "entity" ? "is-record" : undefined}>
                  {row.kind === "action" ? "Action" : row.kind === "entity" ? row.badge : row.group || row.accent}
                </em>
              </button>
            ))
          ) : (
            <div className="command-palette-empty">
              {entityState === "loading"
                ? "Searching records…"
                : entityState === "error"
                  ? "Record search is unavailable right now. Desk names still work."
                  : "No desks, actions or records match. Records are limited to screens you can open in the active company."}
            </div>
          )}
        </div>

        <div className="command-palette-foot">
          <span>↑↓ navigate</span>
          <span>Enter open</span>
          <span>Esc close</span>
          <span>Prefix: so · po · inv · quote · cust · vendor · item</span>
          {entityState === "loading" ? <span className="command-palette-status">Searching records…</span> : null}
          {entityState === "partial" ? <span className="command-palette-status">Some record types could not be searched</span> : null}
        </div>
      </div>
    </div>
  );
}
