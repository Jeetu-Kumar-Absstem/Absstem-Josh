/**
 * Minimal vendor create for procurement desks (PO / GRN) without Admin Masters.
 */

function cleanText(v) {
  return typeof v === "string" ? v.trim() : "";
}

function cleanNullable(v) {
  const s = cleanText(v);
  return s.length ? s : null;
}

function cleanInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeVendorQuickPayload(body = {}) {
  return {
    vendor_code: cleanNullable(body.vendor_code),
    company_name: cleanText(body.company_name),
    country_id: cleanInt(body.country_id),
    gstin: cleanNullable(body.gstin),
    pan_no: cleanNullable(body.pan_no),
    address_line1: cleanNullable(body.address_line1),
    city: cleanNullable(body.city),
    state: cleanNullable(body.state),
    pincode: cleanNullable(body.pincode),
    contact_name: cleanNullable(body.contact_name),
    contact_email: cleanNullable(body.contact_email),
    contact_phone: cleanNullable(body.contact_phone),
    is_active: body.is_active !== false,
  };
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {{ companyId: number, party: object }} options
 */
async function createVendorQuick(db, options = {}) {
  const companyId = Number(options.companyId);
  const payload = normalizeVendorQuickPayload(options.party || {});
  if (!Number.isFinite(companyId) || companyId <= 0) {
    const err = new Error("COMPANY_NOT_SELECTED");
    err.status = 400;
    throw err;
  }
  if (!payload.company_name) {
    const err = new Error("COMPANY_NAME_REQUIRED");
    err.status = 400;
    throw err;
  }

  const companyRes = await db.query(`select id from companies where id = $1 and is_active = true limit 1`, [companyId]);
  if (!companyRes.rows[0]?.id) {
    const err = new Error("INVALID_COMPANY");
    err.status = 400;
    throw err;
  }

  const r = await db.query(
    `
      insert into vendors (
        company_id,
        vendor_code,
        company_name,
        country_id,
        gstin,
        pan_no,
        address_line1,
        city,
        state,
        pincode,
        contact_name,
        contact_email,
        contact_phone,
        msme_registered,
        tds_enabled,
        tds_exempt,
        is_active,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,false,false,$14,now())
      returning *
    `,
    [
      companyId,
      payload.vendor_code,
      payload.company_name,
      payload.country_id,
      payload.gstin,
      payload.pan_no,
      payload.address_line1,
      payload.city,
      payload.state,
      payload.pincode,
      payload.contact_name,
      payload.contact_email,
      payload.contact_phone,
      payload.is_active,
    ]
  );
  return r.rows[0] || null;
}

module.exports = {
  createVendorQuick,
  normalizeVendorQuickPayload,
};
