const fs = require("fs");

const DEFAULT_SELLER_NAME = "Absstem Industrial Solutions Pvt. Ltd.";

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanNullable(value) {
  const text = cleanText(value);
  return text || null;
}

function deriveStateCode(value) {
  const text = cleanText(value);
  if (!text) return "";
  const match = text.match(/^(\d{2})/);
  return match ? match[1] : "";
}

function derivePan(gstin, explicitPan) {
  const pan = cleanText(explicitPan);
  if (pan) return pan;
  const text = cleanText(gstin).replace(/\s+/g, "");
  return text.length >= 12 ? text.slice(2, 12) : "";
}

function getCompanyProfileFromEnv() {
  const gstin = cleanText(process.env.JOSH_SELLER_GSTIN);
  return {
    company_name: cleanText(process.env.JOSH_SELLER_NAME) || DEFAULT_SELLER_NAME,
    website: cleanText(process.env.JOSH_SELLER_WEBSITE || process.env.APP_BASE_URL || ""),
    address_line1: cleanText(process.env.JOSH_SELLER_ADDRESS1),
    address_line2: cleanText(process.env.JOSH_SELLER_ADDRESS2),
    address_line3: cleanText(process.env.JOSH_SELLER_ADDRESS3),
    city: cleanText(process.env.JOSH_SELLER_CITY),
    state: cleanText(process.env.JOSH_SELLER_STATE),
    state_code: cleanText(process.env.JOSH_SELLER_STATE_CODE) || deriveStateCode(gstin),
    pincode: cleanText(process.env.JOSH_SELLER_PINCODE),
    country: cleanText(process.env.JOSH_SELLER_COUNTRY) || "India",
    gstin,
    pan: derivePan(gstin, process.env.JOSH_SELLER_PAN),
    contact_name: cleanText(process.env.JOSH_SELLER_CONTACT),
    contact_email: cleanText(process.env.JOSH_SELLER_EMAIL),
    contact_phone: "",
    bank_name: cleanText(process.env.JOSH_SELLER_BANK_NAME),
    bank_branch: cleanText(process.env.JOSH_SELLER_BANK_BRANCH),
    account_name: cleanText(process.env.JOSH_SELLER_ACCOUNT_NAME) || cleanText(process.env.JOSH_SELLER_NAME) || DEFAULT_SELLER_NAME,
    account_no: cleanText(process.env.JOSH_SELLER_ACCOUNT_NO),
    ifsc: cleanText(process.env.JOSH_SELLER_IFSC),
    invoice_declaration:
      cleanText(process.env.JOSH_INVOICE_DECLARATION) ||
      "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.",
  };
}

function normalizeCompanyProfile(row) {
  const envFallback = getCompanyProfileFromEnv();
  const base = row && typeof row === "object" ? row : {};
  const gstin = cleanText(base.gstin) || envFallback.gstin;
  return {
    id: 1,
    company_id: base.company_id ? Number(base.company_id) : null,
    company_name: cleanText(base.company_name) || envFallback.company_name,
    website: cleanText(base.website) || envFallback.website,
    address_line1: cleanText(base.address_line1) || envFallback.address_line1,
    address_line2: cleanText(base.address_line2) || envFallback.address_line2,
    address_line3: cleanText(base.address_line3) || envFallback.address_line3,
    city: cleanText(base.city) || envFallback.city,
    state: cleanText(base.state) || envFallback.state,
    state_code: cleanText(base.state_code) || deriveStateCode(gstin) || envFallback.state_code,
    pincode: cleanText(base.pincode) || envFallback.pincode,
    country: cleanText(base.country) || envFallback.country || "India",
    gstin,
    pan: cleanText(base.pan) || derivePan(gstin, envFallback.pan),
    contact_name: cleanText(base.contact_name) || envFallback.contact_name,
    contact_email: cleanText(base.contact_email) || envFallback.contact_email,
    contact_phone: cleanText(base.contact_phone) || envFallback.contact_phone,
    bank_name: cleanText(base.bank_name) || envFallback.bank_name,
    bank_branch: cleanText(base.bank_branch) || envFallback.bank_branch,
    account_name: cleanText(base.account_name) || envFallback.account_name,
    account_no: cleanText(base.account_no) || envFallback.account_no,
    ifsc: cleanText(base.ifsc) || envFallback.ifsc,
    invoice_declaration: cleanText(base.invoice_declaration) || envFallback.invoice_declaration,
    logo_attachment_id: base.logo_attachment_id || null,
    signature_attachment_id: base.signature_attachment_id || null,
    logo_file_name: cleanText(base.logo_file_name),
    logo_file_path: cleanText(base.logo_file_path),
    logo_mime_type: cleanText(base.logo_mime_type),
    signature_file_name: cleanText(base.signature_file_name),
    signature_file_path: cleanText(base.signature_file_path),
    signature_mime_type: cleanText(base.signature_mime_type),
    updated_at: base.updated_at || null,
  };
}

async function getCompanyProfile(client, companyId = null) {
  const cid = Number(companyId);
  if (Number.isFinite(cid) && cid > 0) {
    const r = await client.query(
      `
        select
          c.id as company_id,
          coalesce(cp.company_name, c.display_name, c.legal_name) as company_name,
          cp.website,
          coalesce(cp.address_line1, c.address_line1) as address_line1,
          coalesce(cp.address_line2, c.address_line2) as address_line2,
          coalesce(cp.address_line3, c.address_line3) as address_line3,
          coalesce(cp.city, c.city) as city,
          coalesce(cp.state, c.state) as state,
          coalesce(cp.state_code, c.state_code) as state_code,
          coalesce(cp.pincode, c.pincode) as pincode,
          coalesce(cp.country, c.country) as country,
          coalesce(cp.gstin, c.gstin) as gstin,
          coalesce(cp.pan, c.pan) as pan,
          cp.contact_name,
          coalesce(cp.contact_email, c.contact_email) as contact_email,
          coalesce(cp.contact_phone, c.contact_phone) as contact_phone,
          cp.bank_name,
          cp.bank_branch,
          cp.account_name,
          cp.account_no,
          cp.ifsc,
          cp.invoice_declaration,
          cp.logo_attachment_id,
          cp.signature_attachment_id,
          logo.file_name as logo_file_name,
          logo.file_path as logo_file_path,
          logo.mime_type as logo_mime_type,
          signature.file_name as signature_file_name,
          signature.file_path as signature_file_path,
          signature.mime_type as signature_mime_type,
          cp.updated_at
        from companies c
        left join company_profiles_v2 cp on cp.company_id = c.id
        left join attachments logo on logo.id = cp.logo_attachment_id
        left join attachments signature on signature.id = cp.signature_attachment_id
        where c.id = $1 and c.is_active = true
        limit 1
      `,
      [cid]
    );
    if (r.rows[0]) return normalizeCompanyProfile(r.rows[0]);
  }

  const r = await client.query(
    `
      select
        cp.id,
        company_name,
        website,
        address_line1,
        address_line2,
        address_line3,
        city,
        state,
        state_code,
        pincode,
        country,
        gstin,
        pan,
        contact_name,
        contact_email,
        contact_phone,
        bank_name,
        bank_branch,
        account_name,
        account_no,
        ifsc,
        invoice_declaration,
        cp.logo_attachment_id,
        cp.signature_attachment_id,
        logo.file_name as logo_file_name,
        logo.file_path as logo_file_path,
        logo.mime_type as logo_mime_type,
        signature.file_name as signature_file_name,
        signature.file_path as signature_file_path,
        signature.mime_type as signature_mime_type,
        cp.updated_at
      from company_profiles cp
      left join attachments logo on logo.id = cp.logo_attachment_id
      left join attachments signature on signature.id = cp.signature_attachment_id
      where cp.id = 1
      limit 1
    `
  );
  return normalizeCompanyProfile(r.rows[0] || null);
}

function buildCompanyProfilePayload(body) {
  const payload = {
    company_name: cleanText(body.company_name) || DEFAULT_SELLER_NAME,
    website: cleanNullable(body.website),
    address_line1: cleanNullable(body.address_line1),
    address_line2: cleanNullable(body.address_line2),
    address_line3: cleanNullable(body.address_line3),
    city: cleanNullable(body.city),
    state: cleanNullable(body.state),
    state_code: cleanNullable(body.state_code),
    pincode: cleanNullable(body.pincode),
    country: cleanNullable(body.country) || "India",
    gstin: cleanNullable(body.gstin),
    pan: cleanNullable(body.pan),
    contact_name: cleanNullable(body.contact_name),
    contact_email: cleanNullable(body.contact_email),
    contact_phone: cleanNullable(body.contact_phone),
    bank_name: cleanNullable(body.bank_name),
    bank_branch: cleanNullable(body.bank_branch),
    account_name: cleanNullable(body.account_name),
    account_no: cleanNullable(body.account_no),
    ifsc: cleanNullable(body.ifsc),
    invoice_declaration: cleanNullable(body.invoice_declaration),
  };
  if (!payload.state_code && payload.gstin) payload.state_code = deriveStateCode(payload.gstin) || null;
  if (!payload.pan && payload.gstin) payload.pan = derivePan(payload.gstin, "") || null;
  return payload;
}

function normalizeWebsiteUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return `https://${text}`;
}

function fileToDataUrl(filePath, mimeType) {
  const absPath = cleanText(filePath);
  if (!absPath || !fs.existsSync(absPath)) return "";
  const mime = cleanText(mimeType) || "application/octet-stream";
  return `data:${mime};base64,${fs.readFileSync(absPath).toString("base64")}`;
}

function buildInlineAttachment(filePath, mimeType, fileName, cid) {
  const absPath = cleanText(filePath);
  if (!absPath || !fs.existsSync(absPath)) return null;
  return {
    filename: cleanText(fileName) || cid,
    content: fs.readFileSync(absPath),
    contentType: cleanText(mimeType) || "application/octet-stream",
    cid,
    contentDisposition: "inline",
  };
}

function enrichCompanyProfileAssets(profile) {
  const base = normalizeCompanyProfile(profile);
  return {
    ...base,
    website_url: normalizeWebsiteUrl(base.website),
    logo_data_url: fileToDataUrl(base.logo_file_path, base.logo_mime_type),
    signature_data_url: fileToDataUrl(base.signature_file_path, base.signature_mime_type),
  };
}

function buildCompanyMailInlineAttachments(profile) {
  const base = normalizeCompanyProfile(profile);
  return [
    buildInlineAttachment(base.logo_file_path, base.logo_mime_type, base.logo_file_name, "company-logo"),
    buildInlineAttachment(base.signature_file_path, base.signature_mime_type, base.signature_file_name, "company-signature"),
  ].filter(Boolean);
}

module.exports = {
  buildCompanyProfilePayload,
  buildCompanyMailInlineAttachments,
  enrichCompanyProfileAssets,
  getCompanyProfile,
  getCompanyProfileFromEnv,
  normalizeWebsiteUrl,
  normalizeCompanyProfile,
};
