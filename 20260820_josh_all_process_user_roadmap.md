# Josh — All-Process User Roadmap (role-by-role)

Same lens as the Lead/Quote CRM roadmap: a document has a **status**, work has a **due date**, the desk has an **exception bucket**, and the person's Home lane tells them what is late.

The audit found one structural theme: Josh already has excellent bucketed command desks on the server, but Home only surfaces a thin slice of them, and two personas (Stores Keeper, HR Manager) have no Home identity at all.

---

## 1. Purchase Officer

**Current flow:** PR → RFQ/compare → PO → GRN → QC → PI → 3-way match → vendor payment / statement / TDS.

**What works:** Exception desks on PO, GRN, PI, vendor payments, vendor statement, TDS. RFQ compare → create PO. Shortage→PR bridge from job cards. Approval-aged buckets.

**Daily pain:** Pending-receipt Home deep-link used wrong bucket (`pending`). External-processing summary fetched but unused. No promised-date chase on PO lines. No reorder/min-stock. PR and PI queues missing from My Day.

**P0 features**
- Fix Home `receiving_bucket` → `pending_receipt`; surface external-processing `qc_hold` / `replacement_pending`; add `pr_submitted` and PI `match_blocked` cues.
- `promised_date` on PO lines + `po_promise_overdue` exception bucket.

**P1 features**
- Vendor scorecard (on-time %, QC reject %, claim count).
- Reorder levels → auto PR from stock shortfalls.

**Touched files:** `client/src/home/buildMyDayItems.js`, `client/src/home/useHomeFamilyData.js`, `server/src/routes/purchaseOrders.js`, `server/db/migrations/15x_*.sql`.

---

## 2. Stores Keeper

**Current flow:** Expected PO inward → GRN → QC hold/accept → stock ledger / transfers / adjustments → job-card pick & issue.

**What works:** GRN inward control desk (8 buckets), location-aware lines, serial capture, pick-list / batch issue on job cards.

**Daily pain:** Title `store|warehouse` resolves to **operations** Home (dispatch/e-way noise). No stores family. Stock ledger is read-only with no exception desk. No reservation / reorder / batch-lot.

**P0 features**
- New `stores` workspace family with pins (GRN, QC, Stock Ledger, Adjustments, Job Cards stores panel).
- My Day blockers: `pending_receipt`, `grn_in_progress`, `awaiting_qc`, `qc_hold`, `ready_for_reissue`.

**P1 features**
- Stock ledger exception summary (negative stock, stale no-movement).

**Touched files:** `client/src/home/roleAccess.js`, `useHomeFamilyData.js`, `buildMyDayItems.js`, `server/src/routes/stockLedger.js`.

---

## 3. Production Planner

**Current flow:** BOM readiness → job card release → material readiness / shortage → execution → FG receipt.

**What works:** Deep job-card OS (planning release/capacity, stalled WIP, consumption variance, cost control). Shortage→PR loop.

**Daily pain:** Operations My Day only shows `shortage_not_raised`. Capacity overdue and stalled WIP already computed but invisible on Home. No open-jobs-on-old-BOM report.

**P0 features**
- Wire `planning-capacity` / `stalled_wip` / release blockers into Operations My Day.

**P1 features**
- Jobs on superseded BOM revision after revise.
- Reorder levels shared with Purchase (Wave 4).

**Touched files:** `client/src/home/buildMyDayItems.js`, `useHomeFamilyData.js`, `server/src/routes/jobCards.js`.

---

## 4. AR Collections / Accountant

**Current flow:** Invoice → ageing → follow-up / promise → receipt allocation → credit control → GL / bank / Tally.

**What works:** Unified AR Desk (follow-ups, promises, disputes, adjustments, credit, recon). Proforma → tax invoice. GL close readiness cue.

**Daily pain:** Every collection touch is a manual log — no dunning schedule. Credit notes born in three places with no unified list. Bank recon summary unused on Home.

**P0 features**
- Dunning ladder (`dunning_stage`, `next_dunning_at`, `last_dunning_at`) + due/overdue buckets + Finance My Day blockers.

**P1 features**
- Unified credit note view.
- Bank reconciliation on Finance My Day.

**Touched files:** `server/db/migrations/151_ar_dunning_v1.sql`, `server/src/routes/collectionsDesk.js`, `client/src/arDesk/ArDesk.jsx`, `client/src/home/*`.

---

## 5. Service Engineer / Aftermarket Manager

**Current flow:** Ticket → assign → visit → warranty/field return → AMC visits → reverse logistics / sales return.

**What works:** Aftermarket Desk buckets, ticket assignment + visits, AMC from dispatch, failure NCR desk.

**Daily pain:** No engineer calendar. AMC desk buckets visits only — no contract expiry/renewal cue. No ticket SLA tiers. Spares on visit not stock-posted.

**P0 features**
- AMC `expiring_7d` / `expiring_30d` buckets + Home renewal blocker.
- `GET /service-tickets/schedule` + week strip UI.

**P1 features**
- Ticket SLA (`first_response_at`, `resolve_by_at`) + escalation.
- Visit spare parts → stock movement.

**Touched files:** `server/src/routes/aftermarketDesk.js`, `serviceTickets.js`, `client/src/serviceTickets/ServiceTickets.jsx`, `client/src/home/*`.

---

## 6. HR Manager / Employee

**Current flow:** Attendance → leave → expenses (manager → accounts) → salary slips; self-service duty + claims.

**What works:** HR Desk summary, My Duty & Expenses, WaitingOnYou for expense/leave approvals, global HR My Day layer for duty.

**Daily pain:** No `hr` workspace family — HR Manager falls through to Sales. Expense policy limits missing. Leave/expense not in Approval Desk. HR Desk payload not on Home.

**P0 features**
- `hr` family + blockers from `GET /hr/desk` (manager_pending, leave pending, regularization, unpaid slips).

**P1 features**
- Expense category caps / per-diem in Admin Masters.
- Route leave/expense through Approval Desk.
- Real SuperAdmin My Day signals (pilot feedback, intercompany, GSP config, users without rights).

**Touched files:** `client/src/home/roleAccess.js`, `buildMyDayItems.js`, `useHomeFamilyData.js`, `server/src/routes/hr.js`, `approvalDesk.js`, `adminMasters.js`.

---

## Build order

1. **Wave 0** — Home truth-fixes (minutes, high trust).
2. **Wave 1** — Stores family (biggest single identity gap).
3. **Wave 2** — AR dunning (cadence pattern from quotes).
4. **Wave 3** — Service calendar + AMC renewals.
5. **Wave 4** — Planner Home + PO promised date + reorder.
6. **Wave 5** — HR + Admin identity.

Every wave reuses: due-date column, exception bucket, Home blocker, optional WaitingOnYou event.
