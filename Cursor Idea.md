# Cursor Idea — AI Implementation Playbook for JOSH ERP

**Purpose:** This file is the **single source of truth** for any AI agent (Cursor, etc.) extending JOSH. Read **Section 0** first, then execute **one TASK block** per session to avoid large diffs and wasted credits.

**Last reviewed:** June 2026  
**Related:** `ERP_UI_FIRST_EXECUTION_PLAN.md` (business sequence; this doc adds technical execution detail).

---

## 0. Rules for AI agents (read before coding)

### 0.1 Credit-efficient workflow

1. **One TASK per session** — Each `TASK-XXX` below is scoped to ~3–8 files. Do not combine tasks unless explicitly told.
2. **Read before edit** — Open only the files listed in the task's **Touch list**. Do not glob the whole repo.
3. **Copy existing patterns** — Match `adminMasters.js` for CRUD, `Leads.jsx` for list/detail views, `requireScreenAction` for auth.
4. **No drive-by refactors** — Do not reformat unrelated files, rename variables globally, or add TypeScript unless the task says so.
5. **Migrations are append-only** — New SQL only in the next available file under `server/db/migrations/` (for example `019_*.sql`, `020_*.sql`, ...). Register it in `server/db/schema.sql`.
6. **No commits** unless the user asks.
7. **Verify minimally** — Run only what the task's **Verify** section says.
8. **Production DB warning** — On existing production databases, new migration files do **not** auto-run just because code was deployed. If code expects new columns/tables, apply the SQL manually (or through a migration runner) before restarting the API.

### 0.2 How navigation works today (no React Router)

- Shell: `client/src/App.jsx` — `page` state: `home | leads | customers | quotes | admin_masters | users | rights | templates`.
- Deep link on load: `?page=quotes&quoteId=123&mail_connect=success` (parsed in `parseLaunchState()`, then URL cleared).
- Quotes internal views: `client/src/quotes/Quotes.jsx` — `view.type`: `list | new | classic_new | detail | builder_edit`.
- **Do not add React Router in early tasks** — use existing `setPage` / `setView` until `TASK-040`.

### 0.3 Auth & permissions (copy this pattern)

```javascript
// Server route guard
const { requireScreenAction, ownRecordsOnly } = require("../auth/authorization");
router.get("/", requireScreenAction("quotes", "can_view"), async (req, res, next) => { ... });

// SuperAdmin only
if (req.user.group_name !== "SuperAdmin") return res.status(403).json({ ok: false, error: "FORBIDDEN" });

// Client: me.permissions.screens.quotes.can_edit
// SuperAdmin bypass is server-side; client also checks me.group_name === "SuperAdmin"
```

Session: Express + `connect-pg-simple`, cookie `josh.sid`. User on `req.user` from Google OAuth or `session.localUserId`.

### 0.4 API response shape

Success: `{ ok: true, ...payload }`  
Error: `{ ok: false, error: "ERROR_CODE" }` with HTTP 4xx/5xx.

Client `apiFetch` pattern (copy from any module):

```javascript
async function apiFetch(path, options) {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...options });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const err = new Error("Request failed"); err.status = res.status; err.data = data; throw err; }
  return data;
}
```

### 0.5 Dev commands

```bash
# From repo root
npm run db:up          # Postgres + pgAdmin
npm run dev:server     # API :4000
npm run dev:client     # Vite :5173 (proxy to API — check vite.config.js)
```

Production: `docker-compose.prod.yml`, `Caddyfile` routes API paths to `api:4000`.

---

## 1. Repository map (where things live)

```
Josh/
├── client/src/
│   ├── App.jsx              # Shell, login, nav, static home metrics (TO REPLACE)
│   ├── styles.css           # Shell design system — extend for modules gradually
│   ├── main.jsx
│   ├── leads/Leads.jsx
│   ├── customers/Customers.jsx
│   ├── quotes/
│   │   ├── Quotes.jsx       # List, QuoteDetail, QuoteCreate (~2200 lines) — TO SPLIT
│   │   └── SmartQuoteBuilder.jsx  # Builder (~2300 lines) — overlap with Quotes.jsx
│   └── superadmin/
│       ├── AdminMasters.jsx
│       ├── UserMaster.jsx
│       ├── RightsMatrix.jsx
│       └── Templates.jsx
├── server/src/
│   ├── index.js             # HTTP listen
│   ├── app.js               # Express app, route mounting
│   ├── db/pool.js
│   ├── auth/
│   │   ├── authorization.js
│   │   ├── userContext.js   # loads permissions for req.user
│   │   ├── googleStrategy.js
│   │   └── googleMailStrategy.js
│   ├── routes/              # All HTTP handlers today
│   ├── services/            # mailer.js, mailAccounts.js
│   ├── pdf/quotePdf.js      # HTML → PDF via puppeteer-core + pdf-lib merge
│   └── configurator/nitrogen.js  # reads JSON from server/storage/configurator/
├── server/db/
│   ├── schema.sql           # includes all migrations via \ir
│   └── migrations/001..018_*.sql
├── ERP_UI_FIRST_EXECUTION_PLAN.md
└── Cursor Idea.md           # this file
```

### 1.1 Mounted API routes (`server/src/app.js`)

| Prefix | File | Notes |
|--------|------|-------|
| `/auth` | `routes/auth.js` | Google, local login, session |
| `/mail-accounts` | `routes/mailAccounts.js` | Gmail OAuth connect |
| `/leads` | `routes/leads.js` | CRUD-ish, assign, convert, activities |
| `/customers` | `routes/customers.js` | List, get, create — **no PUT yet** |
| `/quotes` | `routes/quotes.js` | **Monolith ~3000 lines** — all quote logic |
| `/products` | `routes/products.js` | **Read-only** search |
| `/templates` | `routes/templates.js` | Letterheads, scope PDFs, cover/terms text |
| `/users` | `routes/users.js` | User master |
| `/permissions` | `routes/permissions.js` | Rights matrix |
| `/admin-masters` | `routes/adminMasters.js` | Distributors + commercial masters |
| `/me` | `app.js` | Alias session user |

Frontend fetches `/auth/session` in `App.jsx` (`fetchMe`).

### 1.2 Mail sending note

- Google mailbox connections are created through `/mail-accounts`.
- **Actual quote sending for Google OAuth now uses the Gmail API, not SMTP**, because Gmail/Workspace may reject SMTP OAuth with `535` even when the mailbox shows as connected.
- Company fallback still uses SMTP from env (`SMTP_*`).

---

## 2. Domain model (tables AI must know)

### 2.1 Core commercial chain

| Table | Purpose |
|-------|---------|
| `leads`, `lead_contacts`, `lead_activities`, `lead_assignments` | Pipeline |
| `customers`, `customer_contacts` | Accounts |
| `quote_headers`, `quote_revisions`, `quote_lines`, `quote_offer_lines` | Quotes |
| `quote_revision_terms` | Per-revision terms (from `terms_master`) |
| `quote_approvals` | Approval chain rows |
| `quote_mail_logs` | Sent mail history |
| `terms_master` | Default term captions/descriptions |
| `exchange_rates`, `exchange_rate_approvals`, `quote_currency_controls` | **Schema only — not wired** |
| `sales_orders`, `sales_order_lines`, `sales_order_revisions`, `payment_milestones` | **Schema only — not wired** |

### 2.2 Quote revision statuses (use exactly)

`draft` → `pending_approval` → `approved` → `issued`  
Or: `rejected` (back to edit as new revision flow).

Approval required when line discount exceeds user's `discount_threshold_pct` (user override) or group `max_autonomous_discount_pct`.

### 2.3 Line pricing metadata (current hack — do not break)

Extra pricing fields live in `quote_lines.line_description` as **JSON string**:

```json
{ "price_list": "list", "gross_unit_price_quote": 1000, "discount_pct": 5, "discount_amt": 50, "remarks": "" }
```

`unit_price_quote` = net unit after discount. Client helpers: `SmartQuoteBuilder.jsx` — `safeParseMeta`, `buildLineMeta`, `normalizePricingFields`.

**Future task** (`TASK-050`) may add columns; until then, keep JSON compatible.

### 2.4 Document numbering

`next_document_number('QUOTE')` → `Q26xxxxxx` via `document_sequences` trigger on `quote_headers`.

---

## 3. What exists vs missing (feature matrix)

Legend: ✅ Done | 🟡 Partial | ❌ Missing

| Feature | Server | Client | Notes |
|---------|--------|--------|-------|
| Google + local auth | ✅ | ✅ | |
| Rights matrix | ✅ | ✅ | `sales_orders` screen exists in matrix but no module |
| Leads list/create/detail | ✅ | ✅ | |
| Lead activities | ✅ | 🟡 | API exists; UI depth varies |
| Lead → customer convert | ✅ | 🟡 | |
| Lead contacts CRUD | 🟡 | ❌ | In DB; check if API writes exist |
| Customers list/create/detail | ✅ | ✅ | |
| Customer update | ❌ | ❌ | No PUT route |
| Customer contacts read | ✅ | ✅ | Display only |
| Customer contacts CRUD | ❌ | ❌ | |
| Quotes full lifecycle | ✅ | 🟡 | Split across 2 huge components |
| Quote commercial fields | ✅ | ✅ | No FX rate UI |
| Quote approval workflow | ✅ | ✅ | Per-quote only |
| Quote mail + PDF | ✅ | ✅ | Sync puppeteer |
| Smart Quote Builder | ✅ | ✅ | Duplicates Quotes.jsx logic |
| Classic New Quote | ✅ | ✅ | **Remove after parity** |
| Nitrogen configurator | ✅ | ✅ | JSON files on disk |
| Admin masters (commercial) | ✅ | ✅ | |
| Distributor master | ✅ | ✅ | In AdminMasters |
| Terms master (`terms_master`) admin | ❌ | ❌ | Only seed + per-quote edit |
| Global quote terms text | ✅ | ✅ | Templates.jsx textarea |
| Product search | ✅ | ✅ | In quote builders |
| Product master admin | ❌ | ❌ | |
| Exchange rates | ❌ | ❌ | Tables in 007 |
| Dashboard live metrics | ❌ | ❌ | Static in App.jsx |
| Approval inbox (all quotes) | ❌ | ❌ | |
| Sales orders | ❌ | ❌ | Tables in 008 |
| Audit / activity log (global) | ❌ | ❌ | |
| Notifications (email/in-app) | 🟡 | ❌ | Mail on send only |
| Search global | ❌ | ❌ | |
| Export CSV | ❌ | ❌ | |
| File attachments on quote | ❌ | ❌ | |
| Consignee / ship-to on quote | 🟡 | ❌ | Check `quote_shipping` in 006 if exists |
| Duplicate quote / revision | 🟡 | 🟡 | New revision API exists |
| Quote list filters | 🟡 | 🟡 | Basic list only |

---

## 4. Useful features to add (prioritized backlog)

Features **not in execution plan** but high value for users:

| ID | Feature | Why useful | Suggested task |
|----|---------|------------|----------------|
| F-01 | **My Work inbox** | One queue: approvals, draft quotes, stale leads | TASK-030 |
| F-02 | **Live home dashboard** | Replace fake metrics | TASK-030 |
| F-03 | **Customer/lead contact CRUD** | Mail To/CC from real contacts | TASK-021, TASK-022 |
| F-04 | **Customer edit (PUT)** | Daily maintenance without SQL | TASK-020 |
| F-05 | **Quote list filters** | status, distributor, date, "pending my approval" | TASK-031 |
| F-06 | **Exchange rate + quote FX lock** | Export quotes legally consistent | TASK-040 |
| F-07 | **Terms master admin** | Edit default T&C rows without SQL | TASK-035 |
| F-08 | **Sales order from approved quote** | ERP chain continuation | TASK-050 |
| F-09 | **Product master UI** | Stop seed-only catalog changes | TASK-045 |
| F-10 | **Related records on customer** | Quotes + leads tabs on customer detail | TASK-032 |
| F-11 | **Breadcrumb context** | Lead → customer → quote navigation | TASK-033 |
| F-12 | **Approval email notify** | Approver gets link when submitted | TASK-036 |
| F-13 | **Revision diff view** | Approver sees price changes | TASK-037 |
| F-14 | **Quote PDF preview inline** | iframe/modal before send | TASK-038 |
| F-15 | **Recent products in picker** | Faster quoting | TASK-039 |
| F-16 | **Global search** | Jump to quote/customer by number | TASK-042 |
| F-17 | **CSV export quotes** | Management reporting | TASK-043 |
| F-18 | **Configurator admin** | Edit nitrogen JSON via UI | TASK-044 |
| F-19 | **Attachment on quote** | Client drawings, specs | TASK-046 |
| F-20 | **Payment milestone templates** | SO payment schedules | TASK-051 |
| F-21 | **In-app toast/notices** | Replace silent saves | TASK-034 |
| F-22 | **Session timeout warning** | UX for long quote edits | TASK-048 |
| F-23 | **Quote duplicate** | Clone header + lines to new quote | TASK-049 |
| F-24 | **Lead status board** | Kanban by status | TASK-047 |
| F-25 | **Distributor branding preview** | See letterhead on quote before issue | TASK-038 |

---

## 5. Target architecture (end state — do not build all at once)

```
server/src/domains/quotes/
  quotesRouter.js          # thin: delegates to services
  quoteApprovalService.js
  quoteCommercialService.js
  quoteLinesService.js
  quoteMailService.js
  quotePdfService.js       # imports ../pdf/quotePdf.js renderers

client/src/quotes/
  Quotes.jsx               # thin: list + routes to subviews
  QuoteDetail.jsx
  QuoteList.jsx
  hooks/useQuote.js
  hooks/useQuoteApproval.js
  hooks/useQuoteMail.js
  hooks/useProductSearch.js
  lib/quoteLinePricing.js  # shared meta JSON helpers
  SmartQuoteBuilder.jsx    # line editor only OR merged into QuoteDetail
```

**Migration strategy:** Extract server services first (no behavior change), then split client components, then delete Classic New Quote.

---

## 6. TASK blocks (execute ONE per AI session)

Each task is **self-contained**. Complete acceptance criteria before marking done.

---

### TASK-010 — Extract quote approval service (server only)

**Goal:** Move approval helpers from `quotes.js` to a service file without behavior change.

**Touch list:**
- `server/src/routes/quotes.js` (remove moved functions, import service)
- `server/src/domains/quotes/quoteApprovalService.js` (create)

**Move these functions** (search in quotes.js): `getApprovalUserProfile`, `canUserApproveQuotes`, `getLineDiscountPct`, `summarizeRevisionDiscounts`, `resolveApprovalChain`, `syncQuoteHeaderStatus`, plus approval route handler bodies if practical.

**Do NOT:** Change SQL logic, response JSON shape, or route paths.

**Verify:** Server starts; `GET /quotes/:id/approval-status` still works (manual or existing client).

---

### TASK-011 — Extract quote mail service (server only)

**Touch list:**
- `server/src/routes/quotes.js`
- `server/src/domains/quotes/quoteMailService.js` (create)

**Move:** mail bootstrap assembly, send-mail handler helpers, CC manager resolution.

**Do NOT:** Change mail payload or `quote_mail_logs` schema.

---

### TASK-012 — Shared client quote pricing lib

**Touch list:**
- `client/src/quotes/lib/quoteLinePricing.js` (create)
- `client/src/quotes/SmartQuoteBuilder.jsx` (import from lib)
- `client/src/quotes/Quotes.jsx` (import from lib — only if duplicates exist)

**Move:** `safeParseMeta`, `toNumber`, `normalizePricingFields`, `buildLineMeta`, `calcLineNetTotal`, `toEditableLine`.

**Do NOT:** Change calculation results.

---

### TASK-020 — Customer update API + UI

**Touch list:**
- `server/src/routes/customers.js` — add `PUT /:id`
- `client/src/customers/Customers.jsx` — edit form on detail view

**PUT body:** same fields as POST create (`customer_name`, address fields, `country_id`, `gstin`, `email`, `phone`, `is_active`).

**Auth:** `requireScreenAction("customers", "can_edit")`, respect `ownRecordsOnly` if applicable (mirror quotes pattern).

**Acceptance:** Edit customer name in UI, refresh, value persists.

---

### TASK-021 — Customer contacts CRUD

**Touch list:**
- `server/src/routes/customers.js` — `POST /:id/contacts`, `PUT /:id/contacts/:contactId`, `DELETE /:id/contacts/:contactId`
- `client/src/customers/Customers.jsx` — forms in `CustomerDetail`

**Table:** `customer_contacts` (see `003_masters.sql`).

**Acceptance:** Add contact with email; appears in list; delete works.

---

### TASK-022 — Lead contacts CRUD

**Touch list:**
- `server/src/routes/leads.js`
- `client/src/leads/Leads.jsx`

**Table:** `lead_contacts`.

**Mirror:** TASK-021 pattern.

---

### TASK-030 — Dashboard summary API + wire Home

**Touch list:**
- `server/src/routes/dashboard.js` (create)
- `server/src/app.js` — mount `/dashboard`
- `client/src/App.jsx` — `HomePanel` fetch real data

**Endpoint:** `GET /dashboard/summary`

**Return (example):**
```json
{
  "ok": true,
  "quotes": { "draft": 5, "pending_approval": 3, "approved": 2, "issued": 10 },
  "leads": { "open": 8, "assigned_to_me": 2 },
  "approvals_pending_for_me": 4,
  "recent_mail_count_7d": 12
}
```

**Queries:** Use `quote_revisions` where `is_latest = true` joined to headers; filter by distributor for channel partners (`user_distributor_links`); approvals where `current_approver` = me and status pending (mirror logic from `quotes.js` approval-status).

**Replace:** Static arrays `stats`, `PAGE_PULSE.home`, `readiness` values — only home page, not every PAGE_PULSE key yet.

**Acceptance:** Home shows real counts from DB.

---

### TASK-031 — Quote list filters + pending approval filter

**Touch list:**
- `server/src/routes/quotes.js` — extend `GET /` query params: `status`, `pending_my_approval=true`, `distributor_id`, `q`
- `client/src/quotes/Quotes.jsx` — filter bar on list view

**Acceptance:** Filter "pending my approval" shows only quotes awaiting current user.

---

### TASK-032 — Customer detail: related quotes & leads tabs

**Touch list:**
- `server/src/routes/customers.js` — `GET /:id/quotes`, `GET /:id/leads` (or single related endpoint)
- `client/src/customers/Customers.jsx`

**Acceptance:** Customer detail shows linked quotes/leads with click → navigate quotes/leads (use `onNavigate` prop — may need passing callback from App; minimal change: window location `?page=quotes&quoteId=`).

---

### TASK-033 — Breadcrumb component (minimal)

**Touch list:**
- `client/src/components/Breadcrumb.jsx` (create)
- `client/src/quotes/Quotes.jsx`, `client/src/leads/Leads.jsx` — show when context ids known

**Data:** Pass `customerId`, `leadId`, `quoteNumber` from API responses (may already be on quote detail).

**Acceptance:** Quote opened from lead shows "Lead # / Customer / Quote Q...".

---

### TASK-034 — Toast notification helper

**Touch list:**
- `client/src/components/Toast.jsx` or use simple state in App
- Wire to save actions in one module first (e.g. Customers)

**Acceptance:** Successful save shows green notice; error shows red.

---

### TASK-035 — Terms master admin CRUD

**Touch list:**
- `server/src/routes/adminMasters.js` OR new `server/src/routes/termsMaster.js`
- `client/src/superadmin/AdminMasters.jsx` OR `Templates.jsx` section

**Table:** `terms_master` — fields: `sort_order`, `caption`, `default_description`, `is_active`.

**Do NOT:** Remove global quote terms textarea in Templates (different use case).

**Acceptance:** SuperAdmin can add/edit/deactivate a term row; new quote revision seeds from updated masters.

---

### TASK-036 — Email notifier on approval submit

**Touch list:**
- `server/src/domains/quotes/quoteApprovalService.js` or `quotes.js` submit-approval handler
- `server/src/services/mailer.js`

**Behavior:** On `POST /quotes/:id/submit-approval`, email current approver with subject `Approval required: {quote_number}` and body link `https://josh.absstem.com/?page=quotes&quoteId={id}` (use env `APP_PUBLIC_URL`).

**Acceptance:** Submit approval triggers email to approver (if mail configured).

---

### TASK-037 — Revision diff for approver

**Touch list:**
- `server/src/routes/quotes.js` — `GET /:id/revision-diff` (compare latest vs previous revision lines)
- `client/src/quotes/Quotes.jsx` — `QuoteDetail` approval panel

**Return:** Lines with changed `unit_price_quote`, `qty`, `discount_pct` (from meta).

**Acceptance:** Approver sees highlighted changes.

---

### TASK-038 — Inline PDF preview modal

**Touch list:**
- `client/src/quotes/Quotes.jsx` — modal with `<iframe src="/quotes/:id/pdf?disposition=inline">` or blob fetch

**Server:** May need `Content-Disposition: inline` on existing PDF route (check `GET /quotes/:id/pdf`).

**Acceptance:** Preview PDF without download before send.

---

### TASK-040 — Exchange rates module (full vertical slice)

**Touch list:**
- `server/db/migrations/019_exchange_rates_ui.sql` (only if new columns needed)
- `server/src/routes/exchangeRates.js` (create)
- `server/src/app.js`
- `client/src/superadmin/AdminMasters.jsx` or new `ExchangeRates.jsx`
- `server/src/routes/quotes.js` — read/write `quote_currency_controls` on commercial save
- `client/src/quotes/Quotes.jsx` — commercial form: rate picker + override reason

**Tables:** `exchange_rates`, `quote_currency_controls` (see `007_exchange_rates.sql`).

**Rules:**
- When `base_currency_id !== quote_currency_id`, require approved rate on issue.
- Store snapshot on `quote_currency_controls` linked to revision.

**Acceptance:** Create USD→INR rate, apply to export quote, totals use rate.

---

### TASK-045 — Product master admin

**Touch list:**
- `server/src/routes/products.js` — CRUD for categories, groups, products (SuperAdmin or `masters` permission)
- `client/src/superadmin/ProductMaster.jsx` (create)
- `client/src/App.jsx` — nav item `products` superAdminOnly

**Tables:** `product_categories`, `product_groups`, `products`, `product_attributes`.

**Acceptance:** Create product with item_code, list_price; appears in quote product search.

---

### TASK-049 — Duplicate quote

**Touch list:**
- `server/src/routes/quotes.js` — `POST /:id/duplicate`
- `client/src/quotes/Quotes.jsx` — button on detail

**Behavior:** New `quote_headers` + revision 1 copying latest revision lines/terms/commercial (new quote number).

**Acceptance:** Duplicate creates new quote id.

---

### TASK-050 — Sales order vertical slice

**Prerequisites:** TASK-010 done (snapshot helper available).

**Touch list:**
- `server/src/routes/salesOrders.js` (create)
- `server/src/domains/salesOrders/salesOrderService.js` — `createFromQuoteRevision(revisionId)`
- `server/src/app.js`
- `client/src/sales-orders/SalesOrders.jsx` (create)
- `client/src/App.jsx` — page `sales_orders`
- `client/src/superadmin/RightsMatrix.jsx` — enable sales_orders toggles meaningfully

**Tables:** `sales_orders`, `sales_order_lines`, `payment_milestones`.

**Rules:**
- Only from revision with `revision_status = 'approved'` or `'issued'`.
- Snapshot totals/lines frozen; no live link to quote lines after create.

**Acceptance:** Convert approved quote → SO appears in list with matching totals.

---

### TASK-055 — Remove Classic New Quote

**Prerequisites:** SmartQuoteBuilder handles all create paths.

**Touch list:**
- `client/src/quotes/Quotes.jsx` — remove `classic_new`, `QuoteCreate` component
- Verify `POST /quotes` and builder create still work

---

### TASK-060 — Split Quotes.jsx into files

**Prerequisites:** TASK-012 done.

**Create:**
- `QuoteList.jsx`, `QuoteDetail.jsx`, `QuoteCreate.jsx` (if still needed)
- Thin `Quotes.jsx` orchestrator

**Do NOT:** Change behavior; move code only.

---

## 7. Implementation snippets (copy-paste starters)

### 7.1 New route file template

```javascript
const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

router.use(requireAuth);

router.get("/summary", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    // ...
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
```

### 7.2 Register route in app.js

```javascript
const dashboardRoutes = require("./routes/dashboard");
app.use("/dashboard", dashboardRoutes);
```

### 7.3 New migration template

File: `server/db/migrations/019_feature_name.sql`

```sql
-- append-only; no drops of columns in use
alter table ... add column if not exists ...;
```

Add to `server/db/schema.sql` before seed:

```sql
\ir migrations/019_feature_name.sql
```

### 7.4 AdminMasters CRUD pattern

See `MASTER_CONFIG` in `server/src/routes/adminMasters.js` and `MASTER_OPTIONS` in `client/src/superadmin/AdminMasters.jsx`. For new master, add entry to both + bootstrap query.

### 7.5 Quote endpoint reference (existing)

| Method | Path | Action |
|--------|------|--------|
| GET | `/quotes` | List |
| GET | `/quotes/bootstrap` | Currencies, incoterms, etc. |
| POST | `/quotes` | Create |
| POST | `/quotes/from-lead/:leadId` | Create from lead |
| GET | `/quotes/:id` | Detail + latest revision |
| PUT | `/quotes/:id/commercial` | Commercial header |
| PUT | `/quotes/:id/lines` | Replace lines |
| PUT | `/quotes/:id/terms` | Revision terms |
| POST | `/quotes/:id/revisions` | New revision |
| GET | `/quotes/:id/approval-status` | Approval state |
| POST | `/quotes/:id/submit-approval` | Submit |
| POST | `/quotes/:id/approve` | Approve |
| POST | `/quotes/:id/reject` | Reject |
| POST | `/quotes/:id/issue` | Issue |
| GET | `/quotes/:id/pdf` | PDF download |
| GET | `/quotes/:id/pdf-meta` | PDF options |
| GET | `/quotes/:id/mail-bootstrap` | Mail composer defaults |
| POST | `/quotes/:id/send-mail` | Send |
| POST | `/quotes/:id/recommend/nitrogen` | Configurator |
| POST | `/quotes/:id/apply/nitrogen` | Apply lines |

---

## 8. UX standards (when touching UI)

1. **Prefer `styles.css` classes** over inline styles for new UI (existing modules use inline — migrate gradually).
2. **Buttons:** `button-primary`, `button-ghost`, `compact-button` from shell.
3. **Forms:** `field-label`, `shell-input` from login/shell.
4. **Tables:** On mobile, use card layout for quote lines (see eval_variant_3_1.md feedback).
5. **Channel partner labels:** "New quote" not "Smart Quote Builder".
6. **Errors:** Map `error` codes to human messages (pattern in Quotes.jsx `DISTRIBUTOR_NOT_LINKED`).

---

## 9. What NOT to do (common AI mistakes)

| Don't | Why |
|-------|-----|
| Add React Router mid-refactor | Breaks App.jsx navigation model |
| Rewrite quotes.js in one PR | Too large; use TASK-010, 011, etc. |
| Store secrets in repo | Use `.env` / `server/.env.example` |
| Skip `credentials: "include"` on fetch | Session won't send |
| Change `line_description` JSON keys | Breaks pricing and PDF |
| Issue quote without checking approval | Business rule in `issue` handler |
| Use `git push --force` | User rule |
| Create markdown docs unless asked | User preference |

---

## 10. Session handoff template (paste at end of each AI session)

```markdown
## JOSH session handoff
- **Completed task:** TASK-XXX
- **Files changed:** (list)
- **Migrations:** 019_... (if any)
- **Manual verify:** (steps)
- **Next recommended task:** TASK-YYY
- **Known issues:** (if any)
```

---

## 11. Recommended execution order (minimal credits path to MVP)

```
Phase 1 — Low risk, high clarity (server extracts + small APIs)
  TASK-010 → TASK-011 → TASK-030 → TASK-020 → TASK-021 → TASK-022

Phase 2 — Commercial completeness
  TASK-035 → TASK-040 → TASK-031 → TASK-036 → TASK-037

Phase 3 — Client debt
  TASK-012 → TASK-034 → TASK-033 → TASK-038 → TASK-060 → TASK-055

Phase 4 — ERP chain
  TASK-045 → TASK-049 → TASK-050

Phase 5 — Polish & power features
  TASK-032 → TASK-039 → TASK-042 → TASK-043 → TASK-044 → TASK-047
```

**MVP definition:** Live dashboard, full quote cycle with FX, terms admin, customer/contact maintenance, approval inbox filter, SO conversion.

---

## 12. Summary for humans

| Question | Answer |
|----------|--------|
| Missing features? | Yes — SO, FX rates, product admin, contacts CRUD, live dashboard, inbox, customer edit, terms master admin, and many UX enhancements (Section 4). |
| Better architecture? | Yes — domain services on server, split quote components, shared pricing lib on client (Section 5). |
| How should AI work? | **One TASK per session**, touch only listed files, copy existing patterns (Section 0 + Section 6). |
| First task to run? | **TASK-010** or **TASK-030** (user choice: tech debt vs visible dashboard). |

---

*End of playbook. When starting a new Cursor chat, say: "Read Cursor Idea.md and implement TASK-030 only."*
