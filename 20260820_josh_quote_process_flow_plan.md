# Quote Process Flow — Sales Executive Review and Improvement Plan

Date: 2026-08-20

## How it works today

Two screens own one lifecycle. `SmartQuoteBuilder` creates; `QuoteDetail` (inside Quotes.jsx) governs. A sales exec cannot finish a quote in either one alone.

- Builder: Customer → Build Offer → Review → Deliver (submit / issue / PDF / email)
- Detail: validity, follow-up, quote kind, new revision, approver name, close, engineering
- Lead conversion used to land in detail, not the guided builder
- Discount lived in `quote_lines.line_description` JSON, so there was no server-side price floor
- Issued quotes never lapsed; `sent` appeared in filters but was never written
- No scheduler exists — every reminder stays pull-based via Sales Desk / My Day

## Target flow

One Quote Workspace with Build (guided steps) and Govern (approvals, revisions, delivery, closure). Validity and follow-up are confirmed on Review. Issue and send are separate commercial acts. Discount is a real column. Expired quotes leave the live pipeline. Send writes `sent` and a delivery timeline. Won closure captures the customer PO.

## Waves

- Wave 0 — Friction: cadence in Review, inline approver, split issue vs send, lead-to-builder, revise in builder
- Wave 1 — Unified workspace: QuoteWorkspace + extracted QuoteDetailPanel + collapsed step mapping
- Wave 2 — Migration 152: real discount/gross/list snapshot, send/lapse/acceptance columns, guardrails, price audit
- Wave 3 — Commercial discipline: percent-of-list floor, payment + validity required to issue, lapse bucket, last-quoted / last-sold hint
- Wave 4 — Delivery: write `sent`, issued-not-sent bucket, open-tracking timeline, customer PO on won close, revision compare
- Wave 5 (out of this build) — auto follow-up seed, stage ageing, QuoteReport metrics

## Out of scope

Non-catalog lines, margin floors (no product cost), cron / push schedulers, WhatsApp sharing.
