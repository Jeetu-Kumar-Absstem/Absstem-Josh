# Josh ERP — Phase P1 Implementation Plan

Scope: **P1a Proforma Invoices**, **P1b E-Invoice (IRN/QR) readiness**, **P1c Tally export mapper**.

All paths are relative to `C:\Users\sahni\My Drive (amit.s@absstem.com)\Josh`.

This is a design document. No code is included — only file-level instructions, contracts, algorithms, and guard rails.

---

## 0. Verified starting state

Confirmed by reading the repo (not assumed):

| Fact | Evidence |
| --- | --- |
| `proforma_invoices` + `proforma_invoice_lines` exist | `server/db/migrations/142_customer_product_maps_item_codes_v1.sql` lines 76–145 |
| `next_company_document_number(company_id,'PI')` works and yields `PI/26-27/000001` | `server/db/migrations/143_fy_document_numbering_v1.sql` |
| IRN columns + partial unique index exist on `customer_invoices` | migration 142 lines 53–73 |
| Invoice PDF renders an IRN block but prints the literal text `Signed QR on file` | `server/src/pdf/invoicePdf.js` line 713 |
| PDF pipeline is HTML → Chromium (`puppeteer-core`) → `pdf-lib` post-processing | `server/src/pdf/pdfCore.js`, `server/package.json` |
| No `qrcode` dependency installed | `server/package.json` |
| The string `proforma` appears in exactly **one** JS file repo-wide | `server/scripts/qa_quote_q26000037_to_invoice.js` — AR is currently clean |
| `payment_milestones` exists with no `company_id`, no timestamps | `server/db/migrations/008_sales_orders.sql` lines 54–67 |
| A QA fixture already builds AI `Q26000037` → SO (ADV50 50:50) → 2 PIs → tax invoice → PDF | `server/scripts/qa_quote_q26000037_to_invoice.js` |
| New screens are granted by cloning an existing screen's permission row | `server/db/migrations/136_vendor_quotes_compare_v1.sql` lines 128–156 |

### Two blockers found during exploration (fix before anything else)

**B1 — `schema.sql` drift.** `server/db/schema.sql` stops at `\ir migrations/141_...` and also skips `137`. Migrations **142, 143, 144 are not registered**. A fresh database bootstrap therefore has **no `proforma_invoices` table, no FY numbering, and no charge lines**. Every P1a assumption breaks on a clean environment. Fix as step P1a-0.

**B2 — double-scaling bug in the QA proforma fixture.** In `server/scripts/qa_quote_q26000037_to_invoice.js` (`createProformaForMilestone`, ~lines 550–560) the line payload multiplies **both** `qty` **and** `unit_price` by the milestone factor. At 50% this produces **25%** of the order value. The inline comment (`// Better: keep full qty, scale unit prices by milestone %`) confirms the intent was never applied. Consequence: any existing PI rows in the QA database have wrong totals, and `Σ(PI) ≠ SO grand total`. The production implementation must scale **amount only**, and the QA fixture must be corrected in the same workstream.

---

## 1. Assumed product decisions — confirmations and one correction

| # | Assumption | Verdict |
| --- | --- | --- |
| 1 | No cash advances into AR; PI → tax invoice → receipt against tax invoice | **Correct, keep.** This is also the only option that preserves the current AR joins untouched. |
| 2 | Light SO milestone read/create helpers, not a milestones admin desk | **Correct, keep.** Scoped as two endpoints on `salesOrders.js` plus a panel in the SO detail screen. |
| 3 | Proforma PDF in scope, PROFORMA label, reuse letterhead, no IRN | **Correct, keep.** Add one requirement: a statutory "This is not a Tax Invoice" declaration line, because a proforma on Absstem letterhead with GST columns is otherwise mistakable for a tax invoice. |
| 4 | Store + PDF render + `gspAdapter` stub throwing `NOT_CONFIGURED`; no live NIC call | **Correct, but incomplete.** A stub that only throws delivers no user value in P1. Add a `GET .../einvoice/payload` endpoint returning the NIC schema JSON so accounts can upload it to the government offline utility today. Same payload builder is later reused by the live GSP call — zero rework. |
| 5 | Mapper module + GET download endpoint returning XML; ledger map table with defaults; no push | **Correct, keep.** Add a `preview` endpoint that reports unmapped ledgers, because a Tally import with a ledger-name mismatch fails per-voucher and is painful to diagnose from the XML alone. |

### One correction to flag — milestone conversion semantics

The brief implies each proforma converts into its own tax invoice. For a 50:50 milestone order that would create **two tax invoices each priced at 50% of the goods**, which is not a valid GST supply document: a tax invoice must state the actual quantity and value of goods supplied, not a payment slice.

**Recommended P1 rule:**

- `billing_basis = 'qty'` → PI carries real quantities → converts 1:1 into a tax invoice for those quantities. Straightforward.
- `billing_basis = 'milestone' | 'adhoc'` → the PI is a **collection instrument only**. Conversion produces **one** tax invoice for the full remaining goods. Sibling `issued` proformas on the same sales order are flipped to `adjusted` and pointed at the same `converted_invoice_id`.

This matches the existing `adjusted` status already in the migration-142 check constraint, which strongly suggests this was the original intent. Confirm before P1a-4 is built.

---

## 2. Workstream order

```
P1a-0  schema.sql repair (B1)                 ← blocks everything
P1b-2  Real QR in invoice PDF                 ← independent, ship first for a visible win
P1a-1  Migration 145 + permissions
P1a-2  Proforma service + routes
P1a-3  Proforma PDF
P1a-4  Convert-to-invoice + QA fixture fix (B2)
P1a-5  Proforma UI + App.jsx wiring
P1b-1  Migration 146 + qrcode dependency
P1b-3  IRN write/clear API
P1b-4  NIC payload builder + gspAdapter stub
P1b-5  E-invoice UI panel
P1c-1  Migration 147 + ledger seeds
P1c-2  XML builders (sales + receipt vouchers)
P1c-3  Tally routes
P1c-4  Tally UI
```

P1b-2 is deliberately pulled ahead of P1b-1: rendering a QR image from `signed_qr_code` needs no schema change at all, and it converts an obviously-fake PDF artefact into a real one.

---

## 3. Migrations

Minimal set: **three new files**, plus the `schema.sql` repair. Everything else reuses existing tables.

### P1a-0 — `server/db/schema.sql` (modify, no new migration)

Append the missing `\ir` lines in order: `137` (verify it exists first — it is absent from the migrations folder listing, so if there is no such file, note the intentional gap in a comment), then `142`, `143`, `144`, and the three new files below. Without this, clean bootstraps have no proforma tables.

### `server/db/migrations/145_proforma_workflow_v1.sql`

Additive only; migration 142 already created the tables.

1. `proforma_invoice_lines`: add `charge_kind text`, with the same named check constraint pattern as `144_invoice_pf_freight_charges_v1.sql` (`null | 'packing_forwarding' | 'freight'`), and a partial index on `(proforma_invoice_id, charge_kind) where charge_kind is not null`. Gives P&F/freight parity with tax invoices so conversion is symmetric.
2. `proforma_invoices`: add `issued_at timestamptz`, `issued_by integer references erp_users(id)`, `cancelled_at timestamptz`, `cancelled_by integer references erp_users(id)`, `cancel_reason text`.
3. Partial unique index: one live proforma per milestone — on `(payment_milestone_id) where payment_milestone_id is not null and proforma_status not in ('cancelled','expired')`.
4. Partial unique index on `(converted_invoice_id) where converted_invoice_id is not null` **must not be added** — under the milestone rule above, several proformas legitimately share one converted invoice. Add a plain index instead.
5. Index on `(company_id, proforma_status)` for list filtering.
6. `payment_milestones`: add `sort_order integer`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`, `created_by integer references erp_users(id)`. Extend the `status` domain to include `'billed'` (add as a check constraint only if none currently exists — the original table has no check on `status`, so prefer leaving it unconstrained rather than retro-fitting a constraint that could reject legacy rows).
7. Screen permission grant: clone `screen_permissions` rows from `screen_key = 'invoices'` into `'proforma_invoices'`, using the exact `insert … select … on conflict (role_id, screen_key) do update` shape from migration 136.

### `server/db/migrations/146_einvoice_metadata_v1.sql`

1. `customer_invoices` — add:
   - `einvoice_status text not null default 'none'` check in `('none','pending','generated','cancelled','failed')`
   - `einvoice_mode text` check in `('manual','gsp')`
   - `einvoice_provider text`
   - `einvoice_generated_at timestamptz`, `einvoice_generated_by integer references erp_users(id)`
   - `einvoice_cancelled_at timestamptz`, `einvoice_cancel_reason text`, `einvoice_error text`
   - `signed_invoice_payload text` (the JWS from NIC; text not jsonb — it is a signed blob, not queryable JSON)
   - `eway_bill_no text`, `eway_bill_date date`, `eway_valid_till timestamptz` (invoice-level; complements the existing free-text `dispatches.eway_ref`, does not replace it)
   - Check constraint: `signed_qr_code is null or irn is not null` — a QR without an IRN is always a data error.
2. `einvoice_events` — append-only audit: `id`, `company_id`, `customer_invoice_id`, `event_type` (`generate|cancel|manual_capture|payload_download`), `request_payload jsonb`, `response_payload jsonb`, `status`, `error text`, `created_by`, `created_at`. Indexes on `(customer_invoice_id, created_at desc)` and `(company_id, created_at desc)`.
3. `company_einvoice_settings` — one row per company: `company_id` unique, `provider`, `seller_gstin`, `base_url`, `is_enabled boolean default false`, `credential_env_key text`, timestamps. **No secrets in the database** — `credential_env_key` names an environment variable read at call time, consistent with the existing `server/.env` pattern.

### `server/db/migrations/147_tally_export_v1.sql`

1. `tally_ledger_maps`: `id`, `company_id`, `map_scope` check in `('party','sales','output_cgst','output_sgst','output_igst','round_off','bank','cash','freight','packing_forwarding')`, `match_key text` (nullable — customer id, GST rate, or payment mode depending on scope), `tally_ledger_name text not null`, `tally_parent_group text`, `is_active boolean default true`, timestamps. Unique on `(company_id, map_scope, coalesce(match_key,''))`.
2. `tally_export_runs`: audit of every download — `company_id`, `export_type` (`sales|receipts`), `date_from`, `date_to`, `voucher_count`, `filters jsonb`, `generated_by`, `generated_at`.
3. Seed sensible defaults per existing company: `Sales Account`, `Output CGST`, `Output SGST`, `Output IGST`, `Round Off`, `Bank Account`, `Cash`, `Freight Outward`, `Packing & Forwarding`. Party ledgers are resolved by customer name at export time with `match_key` overrides.
4. Screen permission grant: clone from `screen_key = 'gl_desk'` into `'tally_export'`.

---

## 4. P1a — Proforma Invoices

### 4.1 New server files

**`server/src/services/proformaMath.js`** — pure arithmetic, no database.
- `calculateProformaLineAmounts(lines)` — mirrors `calculateInvoiceLineAmounts` in `server/src/routes/invoices.js` (lines 176–198) but writes `unit_price_proforma` / `line_total_proforma`.
- `calculateProformaTotals(lines)` — mirrors lines 200–221.
- `applyBilledPercent(soLines, percent)` — **scales unit price only, never qty** (this is the B2 fix). Distributes the rounding residual onto the last line so `Σ lines == round(SO total × pct)`.
- `assertMilestoneCoverage(existingProformas, newPercent)` — rejects a cumulative billed percent above 100 with `PROFORMA_PERCENT_EXCEEDED`.

Deliberately a standalone module rather than an import from `invoices.js`: that file is an Express router with no exports, and adding exports to it purely for proforma reuse would couple AR to proforma.

**`server/src/routes/proformaInvoices.js`** — new router. Copy the structural conventions of `invoices.js` verbatim: `requireScreenAction("proforma_invoices", …)`, `getDistributorIdForUser`, `requireResolvedCompanyId`, `canAccessCompanyContext`, `ownRecordsOnly`, `begin`/`commit`/`rollback` around writes, `{ ok: true, … }` responses.

**`server/src/pdf/proformaPdf.js`** — adapted from `invoicePdf.js`.
- **One** page/copy, not the three-copy Original/Duplicate/Triplicate set.
- Title `PROFORMA INVOICE`; no copy band.
- **No IRN block at all** — do not port the `showEInvoiceBlock` branch.
- Reuse the letterhead clearance constants, tax-mode inference (`inferTaxMode`), HSN roll-up summary, and `amountToWords` — copy them or lift the shared helpers into a small `server/src/pdf/gstDocShared.js`. Prefer lifting: `inferTaxMode`, `amountToWords`, `numberToWordsIndian`, `deriveStateCode`, `fmtMoney/fmtQty/fmtDate`, `escapeHtml` are identical needs and duplicating ~200 lines invites drift.
- Extra fields: `Valid Till`, `Billing Basis`, milestone name, `Billed %`.
- Footer declaration, mandatory: `This is a Proforma Invoice for advance payment purposes only. It is not a Tax Invoice and does not constitute a supply under GST.`
- Watermark `DRAFT` for draft, `CANCELLED` for cancelled — reuse the `statusWatermark` shape.

### 4.2 Modified server files

- **`server/src/app.js`** — add `const proformaInvoicesRoutes = require("./routes/proformaInvoices");` near the other sales requires (~line 18) and `app.use("/proforma-invoices", proformaInvoicesRoutes);` immediately before `app.use("/invoices", …)` at line 213.
- **`server/src/routes/salesOrders.js`** — add the two milestone endpoints (P1 assumption 2).
- **`server/scripts/qa_quote_q26000037_to_invoice.js`** — fix B2: use `applyBilledPercent` from `proformaMath.js` instead of the inline double-scaling.

### 4.3 API surface

| Method | Path | Screen action | Notes |
| --- | --- | --- | --- |
| GET | `/proforma-invoices` | `proforma_invoices.can_view` | Filters `status`, `q`, `customer_id`, `sales_order_id`, `bucket` (`open`, `awaiting_conversion`, `expired`), `limit`. Mirrors the `invoices.js` list shape but **no outstanding/ageing columns** — see §7. |
| GET | `/proforma-invoices/:id` | `can_view` | Header + lines + SO context + milestone + charge summary. |
| POST | `/proforma-invoices/from-sales-order/:salesOrderId` | `can_create` | Body: `billing_basis`, `payment_milestone_id?`, `billed_percent?`, `lines?`, `valid_till?`, `remarks?`, `customer_po_number?`, `customer_po_date?`. |
| PUT | `/proforma-invoices/:id` | `can_edit` | Line/percent edits **draft only**; status transitions `draft→issued`, `→cancelled`. |
| POST | `/proforma-invoices/:id/convert-to-invoice` | `can_edit` **and** `invoices.can_create` | §4.5. |
| GET | `/proforma-invoices/:id/pdf` | `can_view` | `application/pdf`, filename from `safeFileSegment(proforma_number)`. |
| GET | `/sales-orders/:id/payment-milestones` | `sales_orders.can_view` | Read helper. |
| POST | `/sales-orders/:id/payment-milestones` | `sales_orders.can_edit` | Replace-set semantics; rejects if percentages sum above 100 or if any milestone already has a live proforma. |

Guard rails on creation:
- Sales order must be `confirmed` or `closed` — same gate as `invoices.js` line 1039.
- `billing_basis='milestone'` requires `payment_milestone_id`; the milestone must belong to that sales order.
- `billing_basis='qty'` requires `lines[]`, each qty `> 0` and `<=` remaining-to-invoice computed the same way `buildInvoiceProgressLines` does.
- Cumulative issued percent per sales order must not exceed 100.

**Numbering decision:** issue the `PI` number at **`draft` creation**, matching how `invoices.js` issues `INV` at creation (line 1069). Consistency beats gap-avoidance here; deferring to issue-time would make PI the only document in the system that behaves differently.

### 4.4 Client files

**New: `client/src/proforma/ProformaInvoices.jsx`** — model directly on `client/src/invoices/Invoices.jsx`: same local `apiFetch`, `fmtDate`, `fmtMoney` helpers, `view` state machine (`{type:'list'} | {type:'detail', id}`), `DeskCard`/`DeskChip`/`DeskStat`/`MiniMetric`/`EmptyState`/`toast`/`useSubmitLock` from `../shared/joshUi`, and the `launch`/`onConsumeLaunch` prop contract.

Detail view actions: Download PDF, Issue, Cancel, **Convert to Tax Invoice** (visible only when `issued`/`adjusted` and not yet converted), and a link to the created invoice via `onOpenInvoice`.

**Modified: `client/src/App.jsx`** — seven touch points, mirroring how `invoices` is wired:
1. Lazy import after line 19: `const ProformaInvoices = lazy(() => import("./proforma/ProformaInvoices"));`
2. `NAV_ITEMS` — insert immediately before the `invoices` entry (line 116): `{ key: "proforma_invoices", label: "Proforma Invoices", detail: "Advance / milestone billing", accent: "PI", group: "Accounts" }`
3. `PAGE_META` — entry alongside the `invoices` block at line 209.
4. Page facts array — alongside line 644.
5. Quick links — alongside line 903; add a reciprocal "Open Proforma" link into the `invoices` and `sales_orders` quick-link arrays.
6. Rail copy object — alongside line 1184.
7. State + navigation + render: `const [proformaLaunch, setProformaLaunch] = useState(null);` near line 1548; the `if (nextPage !== "proforma_invoices") …` reset branch near line 1875; and the `if (page === "proforma_invoices") { … }` render branch immediately before the `invoices` branch at line 2302, passing `onOpenInvoice` and `onOpenSalesOrder`.

**Modified: `client/src/home/roleAccess.js`** — add `canAccessPage(me, "proforma_invoices")` to the `sales` and `accounts` lane visibility predicates (lines 285–296), and add `screens.proforma_invoices?.can_view` to the `finance` family detection at line 107.

**Modified: `client/src/salesOrders/SalesOrders.jsx`** — milestone panel in SO detail (list, add, remove) plus a "Create Proforma" action that navigates with `proformaLaunch: { sales_order_id, payment_milestone_id }`.

**Modified: `client/src/invoices/Invoices.jsx`** — read-only "Converted from Proforma <number>" chip in detail view. No AR/list changes.

### 4.5 Convert-to-invoice algorithm

Executed inside one transaction on a pooled client, matching the `begin`/`rollback`/`release` pattern used throughout `invoices.js`.

```
 1. select … from proforma_invoices where id = $1 for update
 2. Guards:
      - proforma exists; canAccessCompanyContext; ownRecordsOnly check
      - proforma_status in ('issued','adjusted')      else 409 PROFORMA_NOT_CONVERTIBLE
      - converted_invoice_id is null                   else → step 12 (idempotent return)
      - caller has invoices.can_create                 else 403 FORBIDDEN
 3. Load SO header (getSalesOrderHeader equivalent, company-scoped) and SO lines.
    Order status must be 'confirmed' or 'closed'.
 4. Compute remaining-invoiceable qty per SO line, using the same query shape as
    getInvoicedQtyMap: sum(invoice_lines.qty) over non-cancelled customer_invoices
    where charge_kind is null.
 5. Build the goods line set:
      billing_basis = 'qty'
        → one invoice line per PI line; qty = pi_line.qty; unit price = SO unit_price_order
          (NOT the percent-scaled proforma price)
        → if any qty > remaining  → 409 QTY_EXCEEDS_REMAINING
      billing_basis = 'milestone' | 'adhoc'
        → one invoice line per SO line with qty = remaining, unit price = SO unit_price_order
        → if every remaining is 0 → 409 FULLY_INVOICED
    In both branches the tax invoice is priced from the SALES ORDER, never from the
    proforma's percent-scaled figures. The proforma governs *collection*, the SO governs
    *value*. This is what keeps the tax invoice GST-valid.
 6. Number: select next_company_document_number(company_id, 'INV')
 7. Insert customer_invoices, invoice_status = 'draft'.
    Header fields: company_id, sales_order_id, customer_id, distributor_id,
    base_currency_id, invoice_currency_id (= proforma_currency_id),
    attention_to, customer_po_number/date  ← proforma value, falling back to SO
 8. Insert invoice_lines: preserve sales_order_line_id, charge_kind = null,
    and re-resolve customer item fields through
    resolveCustomerItemFields(client, {companyId, customerId, productId, …})
    rather than copying the proforma snapshot — the customer product map is the
    source of truth and may have changed since the PI was issued.
 9. Charges: re-derive from SO terms + latest dispatch via buildChargePolicy, then
    syncInvoiceChargeLines. Do NOT copy proforma charge lines. Single source of truth
    is the sales order term plus actual dispatch freight.
10. Recompute totals by summing the PERSISTED invoice_lines and update the header.
    Never trust the proforma's stored totals.
11. Update proforma rows:
      this PI  → proforma_status='converted', converted_invoice_id, converted_at, converted_by
      siblings → when billing_basis='milestone' AND the new invoice covers the full
                 remaining goods: every other 'issued' PI on the same sales_order_id
                 becomes 'adjusted' with the same converted_invoice_id
      payment_milestones for all affected PIs → status = 'billed'
12. Commit. Respond 201 with the invoice payload shaped exactly like
    POST /invoices/from-sales-order/:id (invoice, lines, charge_policy, charges).
    Idempotent path from step 2 responds 200 with the existing invoice — the same
    convention already used for intercompany PI creation at invoices.js:828-844.
```

Failure mapping: any `rollback` leaves the PI untouched; the consumed `INV` sequence number is lost, which is the existing accepted behaviour for `from-sales-order`.

---

## 5. P1b — E-Invoice

### 5.1 QR approach

The invoice PDF is HTML rendered by Chromium (`generateQuotePdfBuffer` → `pdfCore.js`). The company logo and signature already reach the page as **base64 data URLs** (`sellerProfile.logo_data_url`, `signature_data_url`, produced by `enrichCompanyProfileAssets`). The QR should use the identical mechanism — no new PDF primitive, no filesystem write, no network fetch during render.

- Add dependency **`qrcode`** to `server/package.json` (pure JS, no native build, works in the existing Node container). Requires an API image rebuild.
- New `server/src/pdf/qrCode.js` exposing `signedQrToDataUrl(signedQrCode)`:
  - returns `null` for empty input, and returns `null` (never throws) on encode failure so the PDF degrades to the existing text box instead of 500-ing a document download.
  - options: `errorCorrectionLevel: 'L'`, `margin: 0`, `width: 320`, `type: 'image/png'`.
  - **Why level `L`:** the NIC signed QR is a JWS of roughly 1.5–2.5 KB. At level `M` that overflows into very high QR versions with modules too fine to survive laser printing at the ~25 mm box size. Level `L` keeps the module count scannable. Print size must be **at least 25 mm × 25 mm** per NIC guidance.
- `server/src/pdf/invoicePdf.js` (modify): `renderInvoiceHtml` accepts a new `signedQrDataUrl` input. Replace line 713's `<div class="qr-box">Signed QR on file</div>` with an `<img>` at `width:96px;height:96px` (≈25 mm at 96 dpi) when the data URL is present, keeping the existing text box as the fallback when `signed_qr_code` exists but encoding failed. The surrounding `showEInvoiceBlock` condition (line 335) is already correct — the whole block stays hidden when no e-invoice fields are set. Widen the `.irn-row td + td` fixed width from `120px` to fit the image.
- `buildTaxInvoicePdfBuffer` threads `signedQrDataUrl` through to each copy.
- `server/src/routes/invoices.js` `GET /:id/pdf` (modify): generate the data URL once, before the copy loop, and pass it in.
- `server/scripts/regenerate_invoice_pdf.js` and `server/scripts/generate_qa_invoice_pdfs.js` (modify): same threading, so regenerated QA PDFs match the app output.
- `server/scripts/verify_invoice_pdf_locks.js` (modify): assert the locked layout rules — QR renders as an image when `signed_qr_code` is present, the whole IRN block is absent when it is not, and the copy count stays at three.

### 5.2 New service files

- **`server/src/services/einvoice/einvoicePayload.js`** — pure function `buildEinvoicePayload({ invoice, lines, sellerProfile, dispatch })` returning the NIC e-invoice schema 1.1 object (`Version`, `TranDtls`, `DocDtls`, `SellerDtls`, `BuyerDtls`, `ShipDtls`, `ItemList`, `ValDtls`). Reuses `inferTaxMode` for the CGST/SGST vs IGST split so the JSON and the printed PDF can never disagree. No I/O, fully unit-testable.
- **`server/src/services/einvoice/gspAdapter.js`** — `generateIrn(payload, settings)`, `cancelIrn(irn, reason, settings)`, `getIrnByDocNumber(docNumber, settings)`. Reads `company_einvoice_settings` and the env var named by `credential_env_key`. In P1 every method throws an error carrying `code = "NOT_CONFIGURED"` unless `is_enabled` is true, and there is no live implementation behind the flag yet.
- **`server/src/services/einvoice/index.js`** — `attachIrnMetadata(client, { invoiceId, companyId, irn, ackNo, ackDate, signedQr, signedPayload, mode, userId })`. Validates (IRN is 64 lowercase hex; ack date parses; invoice is `issued`; no existing IRN unless an explicit override is passed), persists, and writes an `einvoice_events` row. Also `clearIrnMetadata(...)` for cancellation.

### 5.3 API surface (added to `server/src/routes/invoices.js`)

| Method | Path | Screen action | Behaviour |
| --- | --- | --- | --- |
| GET | `/invoices/:id/einvoice/payload` | `invoices.can_view` | NIC schema JSON for manual portal/offline-utility upload. Logs a `payload_download` event. **This is the shipping user value of P1b.** |
| POST | `/invoices/:id/einvoice/irn` | `invoices.can_edit` | Manual capture of `{irn, irn_ack_no, irn_ack_date, signed_qr_code, signed_invoice_payload?}`. Sets `einvoice_status='generated'`, `einvoice_mode='manual'`. |
| DELETE | `/invoices/:id/einvoice/irn` | `invoices.can_approve` | Clears IRN fields, sets `einvoice_status='cancelled'`, records `einvoice_cancel_reason`. Audit row retains the old values. |
| POST | `/invoices/:id/einvoice/generate` | `invoices.can_edit` | Calls `gspAdapter.generateIrn`. Returns **501** with `{ ok:false, error:"NOT_CONFIGURED" }` in P1. Exists so the UI is wired once and never rebuilt. |

Duplicate-IRN attempts hit the existing partial unique index `idx_customer_invoices_company_irn_unique`; pg `23505` is already mapped to HTTP 409 by the error handler in `app.js` (line 80).

### 5.4 Client

`client/src/invoices/Invoices.jsx` (modify) — an "E-Invoice" `DeskCard` in the detail view showing IRN / Ack No / Ack Date / a "QR stored" badge, with actions: **Download NIC JSON**, **Enter IRN details** (inline form), **Clear IRN** (permission-gated), and **Generate via GSP** rendered disabled with an explanatory caption when the API returns `NOT_CONFIGURED`.

---

## 6. P1c — Tally export

### 6.1 New files

- **`server/src/services/tally/tallyXml.js`** — a ~60-line XML string builder with correct escaping (`& < > " '`). No new dependency; `xml2js`-class libraries add weight for a write-only path.
- **`server/src/services/tally/ledgerMap.js`** — `resolveLedgers(client, companyId)` returning a lookup with hardcoded fallbacks when `tally_ledger_maps` has no row, plus `findUnmapped(...)` used by the preview endpoint.
- **`server/src/services/tally/salesVoucher.js`** — one tax invoice → one `VOUCHER VCHTYPE="Sales"`:
  - `DATE` and `EFFECTIVEDATE` in `YYYYMMDD`
  - `VOUCHERNUMBER` = `invoice_number`
  - `PARTYLEDGERNAME` = mapped party ledger (default: `customers.customer_name`)
  - `ALLLEDGERENTRIES.LIST`: party debit (grand total), sales ledger credit (taxable), CGST/SGST/IGST credits by `inferTaxMode`, round-off balancing entry
  - **Tally sign convention: debit amounts are negative** in the XML. Getting this backwards is the single most common cause of a silently lopsided import — cover it explicitly in the QA assertions.
  - P1 emits **accounting vouchers only** — no `ALLINVENTORYENTRIES.LIST`. Inventory entries require every product to exist as a Tally stock item with a matching name and unit, which is a master-data project in its own right.
- **`server/src/services/tally/receiptVoucher.js`** — one posted receipt → one `VOUCHER VCHTYPE="Receipt"`: bank/cash ledger debit (mapped from `customer_receipts.payment_mode` / `bank_name`), party credit, and `BILLALLOCATIONS.LIST` with `BILLTYPE = Agst Ref` and `NAME = invoice_number` for each row in `customer_receipt_allocations`. Any unallocated remainder becomes a single `New Ref` / `Advance` allocation.
- **`server/src/routes/tallyExport.js`** — new router.
- **`client/src/tally/TallyExport.jsx`** — date range, type toggle, preview panel listing unmapped ledgers, ledger-map editor table, Download XML.

### 6.2 API surface

| Method | Path | Screen action | Notes |
| --- | --- | --- | --- |
| GET | `/tally-export/preview` | `tally_export.can_view` | `?type=sales\|receipts&from=&to=` → counts, totals, unmapped-ledger warnings, sample voucher. |
| GET | `/tally-export/xml` | `tally_export.can_view` | Same filters → `text/xml`, `Content-Disposition: attachment; filename="TALLY_SALES_<COMPANY_CODE>_<from>_<to>.xml"`. Writes a `tally_export_runs` row. |
| GET | `/tally-export/ledger-map` | `tally_export.can_view` | Current map plus effective defaults. |
| PUT | `/tally-export/ledger-map` | `tally_export.can_edit` | Upsert mappings. |

Data scope, enforced in SQL:
- Sales: `customer_invoices` where `company_id = active` and `invoice_status in ('issued','paid')` and `invoice_date between from and to`. Cancelled and **draft** invoices excluded.
- Receipts: `customer_receipts` where `company_id = active` and `receipt_status = 'posted'` and `receipt_date between from and to`.
- **`proforma_invoices` is never queried by this module.**

Envelope: `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>…` wrapping `<TALLYMESSAGE>` blocks.

### 6.3 Client wiring

`client/src/App.jsx` — same seven touch points as §4.4, with `{ key: "tally_export", label: "Tally Export", detail: "Sales + receipt vouchers", accent: "TLY", group: "Accounts" }` placed after `gl_desk` (line 119). `client/src/home/roleAccess.js` — add to the `accounts` lane predicate.

---

## 7. Non-goals and AR isolation guarantees

### Explicit non-goals for P1

- No cash/advance receipt against a proforma. Money is only recorded against a tax invoice.
- No GL posting, journal, or `gl_desk` entry originating from a proforma.
- No proforma in ageing, outstanding, collections, credit control, dunning, or customer statements.
- No live NIC/GSP call, no IRN auto-generation, no e-way bill API.
- No automated push into Tally (no ODBC, no HTTP POST to port 9000) — file download only.
- No Tally inventory vouchers, no purchase/payment voucher export.
- No proforma milestone administration desk beyond the read/create helpers.
- No proforma email dispatch (reuse of the quote mailer is a P2 candidate).

### AR isolation — the invariant

**No table, query, or code path that computes receivables may reference `proforma_invoices` or `proforma_invoice_lines`.**

Guaranteed structurally by four things:

1. **No foreign keys inward.** `customer_receipt_allocations.customer_invoice_id` continues to reference `customer_invoices` only. Migration 145 adds no FK from any AR table to a proforma table. The only link is the outward `proforma_invoices.converted_invoice_id`, which AR never traverses.
2. **Outstanding is computed in exactly one place per route** — `getOutstandingInvoiceExpr` / `getArAdjustmentsJoin` in `invoices.js` (lines 40–57) and the equivalents in `receipts.js`. These functions are not modified by P1 and receive no new join.
3. **Protected file list.** These files must contain zero occurrences of `proforma` at the end of P1:
   - `server/src/routes/receipts.js`
   - `server/src/routes/collectionsDesk.js`
   - `server/src/routes/collectionsAnalytics.js`
   - `server/src/routes/creditControl.js`
   - `server/src/routes/reconciliationDesk.js`
   - `server/src/routes/glDesk.js`
   - `server/src/routes/salesDesk.js`
   - `server/src/services/creditControl.js`
   - `server/src/services/tally/*`
   - `client/src/arDesk/ArDesk.jsx`
   - `client/src/receipts/Receipts.jsx`
   - The `invoices.js` list/detail **outstanding** expressions (a `converted_from_proforma_number` display column is permitted; a join affecting any amount is not).
4. **Automated guard: `server/scripts/verify_ar_isolation.js`** (new) — scans the list above for the case-insensitive substring `proforma` and exits non-zero on any hit. Run it in the P1 QA path and, ideally, in CI. This is cheap and it is what stops the invariant from eroding in P2.

Behavioural assertion for QA: for a customer with an issued proforma and no new tax invoice, `GET /receipts` ageing, `GET /invoices?bucket=outstanding`, and `GET /collections-desk/summary` must return **byte-identical** payloads before and after the proforma exists.

---

## 8. Test and QA path

Built on the existing fixture `server/scripts/qa_quote_q26000037_to_invoice.js` (AI · `Q26000037` · ADV50 50:50 · 2 proformas · 1 tax invoice).

### Step 0 — environment
Apply `145`, `146`, `147`; repair `schema.sql` (B1); rebuild the API image for the new `qrcode` dependency; verify on a **fresh** database that `to_regclass('public.proforma_invoices')` is non-null (this is the actual test of the B1 fix).

### Step 1 — regenerate the fixture
Re-run the QA script after the B2 fix. Assert `Σ(proforma.grand_total_proforma) == sales_order.grand_total_order` within ₹1. Before the fix this sums to ~50% of the order; that delta is the regression test.

### Step 2 — new script `server/scripts/qa_p1_proforma_einvoice_tally.js`
1. Load the two proformas for the QA sales order; render both PDFs to `server/storage/qa-proforma-pdfs/<date>/`. Visually confirm: `PROFORMA INVOICE` title, letterhead applied, **no IRN block**, the not-a-tax-invoice declaration, and single-page output.
2. Convert PI #2. Assert: a new `customer_invoices` row in `draft`; PI #2 is `converted`; PI #1 is `adjusted`; both carry the same `converted_invoice_id`; both milestones are `billed`; invoice line quantities equal the SO remaining quantities (**not** 50%).
3. Re-run conversion on PI #2 — assert HTTP 200 with the same invoice id and no duplicate invoice (idempotency).
4. Attach a realistic dummy IRN (64 hex chars) plus a ~2 KB sample signed-QR string. Regenerate the invoice PDF; assert the IRN block is present and contains an `<img src="data:image/png;base64,…">`. Print one copy and physically scan the QR — the module-density risk in §5.1 is not detectable on screen.
5. Clear the IRN; regenerate; assert the entire e-invoice block is absent.
6. `GET /invoices/:id/einvoice/payload` — assert the JSON validates against the NIC 1.1 field list and that its CGST/SGST/IGST split matches the PDF's tax summary exactly.
7. `POST /invoices/:id/einvoice/generate` — assert 501 `NOT_CONFIGURED`.
8. Tally: export sales and receipts for the QA date range. Assert well-formed XML (parse it), the voucher count matches the source query, every voucher balances to zero, debits are negative, and no ledger is unmapped. Import into a scratch Tally company as the manual acceptance gate.
9. AR isolation: capture `/invoices?bucket=outstanding`, `/receipts`, `/collections-desk/summary` before proforma creation and after; assert deep equality.

### Step 3 — existing guards
Run `server/scripts/verify_invoice_pdf_locks.js` (extended per §5.1) and the new `verify_ar_isolation.js`.

---

## 9. Risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | **`schema.sql` stops at 141** — clean bootstraps have no proforma tables, no FY numbering, no charge lines | **High** | P1a-0 blocks all other work. Verify on a fresh database, not just the running one. |
| R2 | **QA fixture double-scales proforma amounts** (25% instead of 50%) | **High** | Fixed in P1a-4 via `applyBilledPercent`; existing QA proforma rows must be regenerated, not patched. |
| R3 | **Percent-priced tax invoices would be GST-invalid** if milestone PIs converted 1:1 | **High** | The §4.5 rule prices every tax invoice from the sales order. Needs product sign-off before P1a-4. |
| R4 | Signed QR is 1.5–2.5 KB → high QR version → modules too fine to scan when printed | Medium | Error-correction level `L`, ≥25 mm print size, and a **physical print-and-scan** test in QA step 2.4. Screen inspection will not catch this. |
| R5 | Tally import fails silently per-voucher on any ledger-name mismatch | Medium | `preview` endpoint reports unmapped ledgers before download; scratch-company import is the acceptance gate. |
| R6 | Tally debit/credit sign convention inverted | Medium | Explicit balance-to-zero and sign assertions in QA step 2.8. |
| R7 | New `qrcode` dependency requires an API image rebuild | Low | Sequence P1b-1 before P1b-2 in deployment even though P1b-2 is authored first. |
| R8 | `payment_milestones` has no `company_id`; scoping is indirect through `sales_order_id` | Low | Always join through `sales_orders` and filter on `so.company_id`; never query the milestone table standalone. Migration 145 does not add the column — backfilling it is not worth the churn for P1. |
| R9 | `PI` numbers are consumed by rolled-back drafts, creating gaps | Low | Accepted — identical to existing `INV`/`SO` behaviour. Document it rather than special-casing proforma. |
| R10 | Proforma leaks into AR during P2 | Medium | `verify_ar_isolation.js` in CI is the durable control; the file list in §7 is its allow-list. |
| R11 | `inferTaxMode`/`amountToWords` duplicated between invoice and proforma PDFs, then drift | Low | Lift into `server/src/pdf/gstDocShared.js` during P1a-3 rather than copy-pasting ~200 lines. |

---

## 10. File manifest

**New — server (16)**
```
server/db/migrations/145_proforma_workflow_v1.sql
server/db/migrations/146_einvoice_metadata_v1.sql
server/db/migrations/147_tally_export_v1.sql
server/src/services/proformaMath.js
server/src/routes/proformaInvoices.js
server/src/pdf/proformaPdf.js
server/src/pdf/gstDocShared.js
server/src/pdf/qrCode.js
server/src/services/einvoice/einvoicePayload.js
server/src/services/einvoice/gspAdapter.js
server/src/services/einvoice/index.js
server/src/services/tally/tallyXml.js
server/src/services/tally/ledgerMap.js
server/src/services/tally/salesVoucher.js
server/src/services/tally/receiptVoucher.js
server/src/routes/tallyExport.js
```

**New — scripts (2)**
```
server/scripts/qa_p1_proforma_einvoice_tally.js
server/scripts/verify_ar_isolation.js
```

**New — client (2)**
```
client/src/proforma/ProformaInvoices.jsx
client/src/tally/TallyExport.jsx
```

**Modified — server (8)**
```
server/db/schema.sql                              register 142–147 (+ note the 137 gap)
server/package.json                               add qrcode
server/src/app.js                                 mount /proforma-invoices, /tally-export
server/src/routes/invoices.js                     e-invoice endpoints; QR data URL into PDF
server/src/routes/salesOrders.js                  payment-milestone read/create
server/src/pdf/invoicePdf.js                      real QR image; widen QR cell
server/scripts/qa_quote_q26000037_to_invoice.js   fix double-scaling (B2)
server/scripts/regenerate_invoice_pdf.js          thread signedQrDataUrl
server/scripts/generate_qa_invoice_pdfs.js        thread signedQrDataUrl
server/scripts/verify_invoice_pdf_locks.js        assert QR image / IRN suppression
```

**Modified — client (4)**
```
client/src/App.jsx                    lazy import, NAV_ITEMS, PAGE_META, facts,
                                      quick links, rail copy, launch state, render branch
client/src/home/roleAccess.js         lane visibility + finance family detection
client/src/salesOrders/SalesOrders.jsx  milestone panel + Create Proforma
client/src/invoices/Invoices.jsx      e-invoice panel + converted-from-proforma chip
```
