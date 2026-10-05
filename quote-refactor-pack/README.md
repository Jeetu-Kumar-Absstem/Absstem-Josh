# Quote refactor pack — directory structure

Share this folder (or quote-refactor-pack.zip) with your AI collaborator.

## Tree

```
quote-refactor-pack/
├── README.md                          (this file)
├── client/src/
│   ├── App.jsx                        (~3878 lines) — mounts Quotes page
│   └── quotes/
│       ├── Quotes.jsx                 (~579) — list / routes to builder & detail
│       ├── SmartQuoteBuilder.jsx      (~7130) — create/edit guided builder
│       ├── QuoteDetailPanel.jsx       (~3444) — issued quote detail / mail / PDF
│       ├── QuoteWorkspace.jsx         (~194) — stage chrome (Build / Govern)
│       ├── QuoteReport.jsx            (~600) — reporting view
│       └── quoteShared.js             (~244) — shared helpers / API
└── server/src/
    ├── routes/
    │   └── quotes.js                  (~8112) — all quote HTTP routes (no separate controllers)
    └── pdf/
        ├── quotePdf.js                (~1168) — HTML templates + PDF generation
        └── pdfCore.js                 (~148) — puppeteer / merge helpers used by quotePdf
```

## Architecture notes

- **No separate quote controllers.** Business logic lives in `server/src/routes/quotes.js` plus helpers imported from services/configurator.
- **PDF:** `server/src/pdf/quotePdf.js` (not `services/quotePdfService.js`). Core exports: `renderCoverAndTechnicalHtml`, `renderCommercialHtml`, `renderDefaultTermsHtml`, `renderTermsTextHtml`, `renderRevisionTermsHtml`, `generateQuotePdfBuffer`, `mergePdfBuffers`, `applyPdfBackground`.
- **Frontend entry:** `App.jsx` lazy-loads `./quotes/Quotes` when `page === "quotes"`.
- **Builder flow:** `Quotes.jsx` → `SmartQuoteBuilder` (new) or `QuoteDetailPanel` (existing) inside `QuoteWorkspace`.

## App.jsx mount (excerpt)

```jsx
const Quotes = lazy(() => import("./quotes/Quotes"));
// ...
if (page === "quotes") {
  return (
    <Quotes
      openQuoteId={openQuoteId}
      launch={quotesLaunch}
      onConsumeLaunch={() => setQuotesLaunch(null)}
      me={me}
      mailConnectStatus={mailConnectStatus}
      mailConnectReason={mailConnectReason}
      onOpenLead={(id) => { ... }}
      onOpenSalesOrder={(id) => { ... }}
      onOpenProforma={(id) => { ... }}
    />
  );
}
```

## Key PDF-related API routes (in quotes.js)

- `GET /:id/pdf-meta`
- `GET /:id/pdf`
- `POST /:id/send-mail` (attaches generated PDF)

## Related (not copied — optional follow-ups)

- `server/src/configurator/productFamilyMatrix.js`
- `server/src/configurator/nitrogen.js`
- `server/src/services/mailAccounts.js`
- `server/src/services/mailer.js`
- `server/src/app.js` — mounts `quotesRoutes`
