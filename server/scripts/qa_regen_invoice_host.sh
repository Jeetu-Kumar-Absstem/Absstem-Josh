#!/bin/sh
# Host-side QA: rebuild API and regenerate invoice PDF with hard checks.
# Run from /opt/josh:
#   sh server/scripts/qa_regen_invoice_host.sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "== host root: $ROOT"

if ! grep -q 'INVOICE_LETTERHEAD_CLEARANCE' server/src/pdf/invoicePdf.js; then
  echo "FAIL: server/src/pdf/invoicePdf.js missing INVOICE_LETTERHEAD_CLEARANCE."
  echo "Upload the latest server/ from your PC to /opt/josh first."
  exit 1
fi

if ! grep -q 'top: "12mm"' server/src/pdf/invoicePdf.js; then
  echo "FAIL: expected CLEARANCE.top = 12mm (single-page copy target) on HOST."
  exit 1
fi

if ! grep -q 'domcontentloaded' server/src/pdf/pdfCore.js; then
  echo "FAIL: server/src/pdf/pdfCore.js on HOST still uses old setContent wait (need domcontentloaded)."
  echo "Upload the latest server/ from your PC to /opt/josh first."
  exit 1
fi

echo "== rebuild api (no cache)"
docker compose -f docker-compose.prod.yml build --no-cache api
docker compose -f docker-compose.prod.yml up -d api

echo "== verify padding inside RUNNING container"
docker compose -f docker-compose.prod.yml exec -T api \
  node -e "const m=require('./src/pdf/invoicePdf'); console.log('CLEARANCE', m.INVOICE_LETTERHEAD_CLEARANCE); console.log('COPIES', m.INVOICE_COPY_LABELS); if(m.INVOICE_LETTERHEAD_CLEARANCE.top!=='12mm') process.exit(2); if(typeof m.buildTaxInvoicePdfBuffer!=='function') process.exit(3);"

echo "== regenerate invoice 1"
docker compose -f docker-compose.prod.yml exec -T api \
  sh -c 'QA_INVOICE_ID=1 node scripts/regenerate_invoice_pdf.js'

echo "== latest output on host"
ls -lt server/storage/qa-invoice-pdfs/latest/ | head -n 20
echo "== status marker"
cat server/storage/qa-invoice-pdfs/latest/regen-status.txt || true
if [ -f server/storage/qa-invoice-pdfs/latest/regen-error.txt ]; then
  echo "== error marker"
  cat server/storage/qa-invoice-pdfs/latest/regen-error.txt
  exit 1
fi
