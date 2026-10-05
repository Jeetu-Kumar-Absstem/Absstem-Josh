/**
 * E-invoice / IRN metadata service.
 *
 * P1 supports manual IRN capture only: a user generates the IRN/QR through the
 * GSP/NIC portal outside Josh, then pastes the returned fields back via
 * attachIrnMetadata. All writes are journalled to einvoice_events for audit.
 */

function cleanText(value) {
  return String(value ?? "").trim();
}

class EinvoiceValidationError extends Error {
  constructor(message, code = "EINVOICE_VALIDATION_ERROR", status = 400) {
    super(message);
    this.name = "EinvoiceValidationError";
    this.code = code;
    this.status = status;
  }
}

class EinvoiceNotFoundError extends Error {
  constructor(message = "Invoice not found.") {
    super(message);
    this.name = "EinvoiceNotFoundError";
    this.code = "NOT_FOUND";
    this.status = 404;
  }
}

const ATTACHABLE_INVOICE_STATUSES = new Set(["issued", "paid"]);

async function getInvoiceForEinvoice(client, { invoiceId, companyId }) {
  const id = Number(invoiceId);
  if (!Number.isFinite(id) || id <= 0) throw new EinvoiceValidationError("Invalid invoice id.", "INVALID_ID");
  const params = [id];
  let companyFilter = "";
  if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    companyFilter = ` and company_id = $${params.length}`;
  }
  const r = await client.query(
    `select id, company_id, invoice_number, invoice_status, irn, einvoice_status
       from customer_invoices
      where id = $1 ${companyFilter}
      limit 1`,
    params
  );
  const row = r.rows[0];
  if (!row) throw new EinvoiceNotFoundError();
  return row;
}

async function logEinvoiceEvent(
  client,
  { companyId, invoiceId, eventType, requestPayload = null, responsePayload = null, status = null, error = null, userId = null }
) {
  const validEventTypes = new Set([
    "generate",
    "cancel",
    "manual_capture",
    "payload_download",
    "clear",
    "eway_generate",
    "eway_cancel",
  ]);
  const type = cleanText(eventType);
  if (!validEventTypes.has(type)) throw new EinvoiceValidationError(`Invalid einvoice event_type: ${type}`, "INVALID_EVENT_TYPE");
  await client.query(
    `
      insert into einvoice_events (
        company_id, customer_invoice_id, event_type, request_payload, response_payload, status, error, created_by
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8)
    `,
    [
      Number(companyId) || null,
      Number(invoiceId) || null,
      type,
      requestPayload ? JSON.stringify(requestPayload) : null,
      responsePayload ? JSON.stringify(responsePayload) : null,
      status ? cleanText(status) : null,
      error ? cleanText(error) : null,
      Number(userId) || null,
    ]
  );
}

function normalizeOptionalDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Attach IRN/QR metadata to an invoice (manual capture flow, or future GSP response).
 * Requires the invoice to be `issued` or `paid`, and IRN to be non-empty.
 */
async function attachIrnMetadata(
  client,
  {
    invoiceId,
    companyId,
    irn,
    ackNo,
    ackDate,
    signedQr,
    signedPayload,
    mode = "manual",
    userId = null,
    ewayBillNo = null,
    ewayBillDate = null,
    ewayValidTill = null,
  }
) {
  const irnValue = cleanText(irn);
  if (!irnValue) throw new EinvoiceValidationError("IRN is required.", "IRN_REQUIRED");

  const invoice = await getInvoiceForEinvoice(client, { invoiceId, companyId });
  const status = cleanText(invoice.invoice_status).toLowerCase();
  if (!ATTACHABLE_INVOICE_STATUSES.has(status)) {
    throw new EinvoiceValidationError(
      "Invoice must be issued or paid before attaching e-invoice/IRN details.",
      "INVOICE_NOT_ELIGIBLE",
      409
    );
  }

  const normalizedMode = cleanText(mode).toLowerCase() === "gsp" ? "gsp" : "manual";

  try {
    const r = await client.query(
      `
        update customer_invoices
        set irn = $2,
            irn_ack_no = $3,
            irn_ack_date = $4,
            signed_qr_code = $5,
            signed_invoice_payload = $6,
            einvoice_status = 'generated',
            einvoice_mode = $7,
            einvoice_provider = coalesce(einvoice_provider, $7),
            einvoice_generated_at = now(),
            einvoice_generated_by = $8,
            einvoice_error = null,
            einvoice_cancelled_at = null,
            einvoice_cancel_reason = null,
            eway_bill_no = coalesce($9, eway_bill_no),
            eway_bill_date = coalesce($10, eway_bill_date),
            eway_valid_till = coalesce($11, eway_valid_till),
            updated_at = now()
        where id = $1
        returning *
      `,
      [
        invoice.id,
        irnValue,
        cleanText(ackNo) || null,
        ackDate || null,
        cleanText(signedQr) || null,
        cleanText(signedPayload) || null,
        normalizedMode,
        Number(userId) || null,
        cleanText(ewayBillNo) || null,
        normalizeOptionalDate(ewayBillDate),
        ewayValidTill || null,
      ]
    );

    await logEinvoiceEvent(client, {
      companyId: invoice.company_id,
      invoiceId: invoice.id,
      eventType: normalizedMode === "gsp" ? "generate" : "manual_capture",
      requestPayload: { irn: irnValue, ackNo: cleanText(ackNo) || null, mode: normalizedMode },
      responsePayload: { irn: irnValue, ackNo: cleanText(ackNo) || null, ackDate: ackDate || null },
      status: "success",
      userId,
    });

    return r.rows[0];
  } catch (err) {
    await logEinvoiceEvent(client, {
      companyId: invoice.company_id,
      invoiceId: invoice.id,
      eventType: normalizedMode === "gsp" ? "generate" : "manual_capture",
      requestPayload: { irn: irnValue },
      status: "failed",
      error: err.message,
      userId,
    });
    throw err;
  }
}

/** Clear IRN/QR metadata from an invoice (e.g. IRN cancelled on the GST portal). */
async function clearIrnMetadata(client, { invoiceId, companyId, reason, userId = null }) {
  const invoice = await getInvoiceForEinvoice(client, { invoiceId, companyId });
  if (!cleanText(invoice.irn)) {
    throw new EinvoiceValidationError("Invoice has no IRN to clear.", "NO_IRN_ON_INVOICE", 409);
  }

  try {
    const r = await client.query(
      `
        update customer_invoices
        set irn = null,
            irn_ack_no = null,
            irn_ack_date = null,
            signed_qr_code = null,
            signed_invoice_payload = null,
            einvoice_status = 'cancelled',
            einvoice_cancelled_at = now(),
            einvoice_cancel_reason = $2,
            updated_at = now()
        where id = $1
        returning *
      `,
      [invoice.id, cleanText(reason) || null]
    );

    await logEinvoiceEvent(client, {
      companyId: invoice.company_id,
      invoiceId: invoice.id,
      eventType: "clear",
      requestPayload: { reason: cleanText(reason) || null },
      responsePayload: { previous_irn: invoice.irn },
      status: "success",
      userId,
    });

    return r.rows[0];
  } catch (err) {
    await logEinvoiceEvent(client, {
      companyId: invoice.company_id,
      invoiceId: invoice.id,
      eventType: "clear",
      requestPayload: { reason: cleanText(reason) || null },
      status: "failed",
      error: err.message,
      userId,
    });
    throw err;
  }
}

module.exports = {
  EinvoiceValidationError,
  EinvoiceNotFoundError,
  ATTACHABLE_INVOICE_STATUSES,
  getInvoiceForEinvoice,
  logEinvoiceEvent,
  attachIrnMetadata,
  clearIrnMetadata,
};
