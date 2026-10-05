const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const multer = require("multer");
const path = require("path");

const { PDFDocument, PDFName } = require("pdf-lib");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction, hasScreenAction } = require("../auth/authorization");
const { loadUserContextById } = require("../auth/userContext");
const {
  renderCoverAndTechnicalHtml,
  renderCommercialHtml,
  renderDefaultTermsHtml,
  renderTermsTextHtml,
  renderRevisionTermsHtml,
  generateQuotePdfBuffer,
  mergePdfBuffers,
  applyPdfBackground,
} = require("../pdf/quotePdf");
const { stampPdfPageNumbers, checkPdfReadable } = require("../pdf/pdfCore");
const { buildFamilyContent } = require("../pdf/quoteFamilyBrochureContent");
const { listPsaPurities, recommendNitrogenModel, recommendOxygenModel, recommendCompressor } = require("../configurator/nitrogen");
const { getProductFamilyRule, resolveQuotePresentationPolicy, summarizeQuoteConfiguratorContext } = require("../configurator/productFamilyMatrix");
const { sendMail, isMailConfigured } = require("../services/mailer");
const { getMailBootstrap, markMailAccountUsed, resolveEffectiveMailSource } = require("../services/mailAccounts");
const { canDelegateFor, probeDelegation } = require("../services/gmailDelegation");
const {
  buildCompanyMailInlineAttachments,
  enrichCompanyProfileAssets,
  getCompanyProfile,
  normalizeWebsiteUrl,
} = require("../services/companyProfile");
const { createOwnedAttachment } = require("../services/attachmentOwnership");
const { buildCustomerCompanyScopeSql, ensureCustomerCompanyAccess, linkCustomerToCompany } = require("../services/customerCompanyAccess");
const { createCustomerFromParty } = require("../services/createCustomerFromParty");
const { getCompanyProductByItemCodeOrNull, getCompanyProductByItemNameOrNull, getCompanyProductOrNull } = require("../services/companyProductLookup");
const { notifyQuoteApprovalNeeded, notifyQuoteOutcome, notifyEngineeringSalesReply, notifyUser } = require("../services/notifications");
const { resolveCustomerItemFields } = require("../services/customerProductMaps");
const { isCoveringFor, loadQuoteScope, loadReporteeIds } = require("../services/quoteTeamScope");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});
const QUOTE_MAIL_TRACKING_PIXEL_GIF = Buffer.from("R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

function getPdfLibPageContentBytes(page) {
  try {
    const node = page?.node;
    const contents = node && typeof node.Contents === "function" ? node.Contents() : null;
    if (!contents) return 0;

    const refs = typeof contents.asArray === "function" ? contents.asArray() : [contents];
    let total = 0;
    for (let i = 0; i < refs.length; i += 1) {
      let stream = null;
      try {
        stream = typeof contents.lookup === "function" ? contents.lookup(i) : null;
      } catch {
        stream = null;
      }
      if (stream && typeof stream.getContentsSize === "function") total += Number(stream.getContentsSize()) || 0;
      else if (stream && typeof stream.sizeInBytes === "function") total += Number(stream.sizeInBytes()) || 0;
    }
    return total;
  } catch {
    return 0;
  }
}

function isPdfLibPageEmpty(page) {
  try {
    const node = page?.node;
    const contentsBytes = getPdfLibPageContentBytes(page);
    const res = node && typeof node.Resources === "function" ? node.Resources() : null;
    const hasFont = res && typeof res.lookup === "function" ? !!res.lookup(PDFName.of("Font")) : false;
    const hasXObject = res && typeof res.lookup === "function" ? !!res.lookup(PDFName.of("XObject")) : false;
    if (!contentsBytes) return !hasXObject;

    if (!hasFont && !hasXObject && contentsBytes > 0 && contentsBytes < 600) return true;
    return false;
  } catch {
    return false;
  }
}

async function stripEmptyPdfPages(pdfBuffer) {
  if (!pdfBuffer || !pdfBuffer.length) return pdfBuffer;
  const src = await PDFDocument.load(pdfBuffer);
  const pages = src.getPages();
  if (!pages.length) return pdfBuffer;
  const keep = [];
  for (let i = 0; i < pages.length; i += 1) {
    if (!isPdfLibPageEmpty(pages[i])) keep.push(i);
  }
  if (keep.length === pages.length) return pdfBuffer;
  if (!keep.length) return null;
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, keep);
  for (const p of copied) out.addPage(p);
  const bytes = await out.save();
  return Buffer.from(bytes);
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

async function getDistributorIdForUser(userId) {
  const { rows } = await pool.query(
    `select distributor_id from user_distributor_links where user_id = $1 limit 1`,
    [userId]
  );
  return rows[0]?.distributor_id || null;
}

function quoteOwnerId(quote) {
  const id = Number(quote?.owner_user_id || quote?.created_by);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function quoteScopeUserIdList(req) {
  if (req.quoteScope?.userIds?.size) return [...req.quoteScope.userIds];
  return [Number(req.user.id)];
}

function canAccessQuote(req, quote) {
  if (!quote) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "quotes")) return true;
  const ownerId = quoteOwnerId(quote);
  if (!ownerId) return false;
  if (ownerId === Number(req.user.id)) return true;
  return Boolean(req.quoteScope?.userIds?.has(ownerId));
}

async function getJobAssetOrThrow(client, req, jobAssetId) {
  const assetId = Number(jobAssetId);
  if (!Number.isFinite(assetId) || assetId <= 0) {
    const err = new Error("JOB_ASSET_ID_INVALID");
    err.status = 400;
    throw err;
  }

  const companyId = getActiveCompanyId(req);
  if (!companyId) {
    const err = new Error("COMPANY_NOT_SELECTED");
    err.status = 400;
    throw err;
  }

  const { rows } = await client.query(
    `
      select
        ja.id,
        ja.company_id,
        ja.customer_id,
        ja.sales_order_id,
        ja.sales_order_line_id,
        ja.dispatch_id,
        ja.dispatch_line_id,
        ja.job_card_id,
        ja.asset_status,
        ja.job_id,
        ja.serial_no,
        ja.asset_code,
        ja.asset_name,
        ja.finished_good_product_id,
        ja.finished_good_item_code,
        ja.finished_good_item_name,
        ja.installation_date,
        ja.commissioning_date,
        ja.warranty_start_date,
        ja.warranty_end_date,
        ja.site_name,
        ja.site_address,
        ja.remarks,
        c.customer_name,
        so.so_number,
        d.dispatch_number
      from job_assets ja
      join customers c on c.id = ja.customer_id
      left join sales_orders so on so.id = ja.sales_order_id
      left join dispatches d on d.id = ja.dispatch_id
      where ja.id = $1
        and ja.company_id = $2
      limit 1
    `,
    [assetId, companyId]
  );

  const asset = rows[0];
  if (!asset) {
    const err = new Error("JOB_ASSET_NOT_FOUND");
    err.status = 404;
    throw err;
  }

  await ensureCustomerCompanyAccess(client, req, asset.customer_id);
  return asset;
}

async function resolveQuoteJobAssetContext(client, req, { customerId, jobAssetId }) {
  const assetId = jobAssetId === null || jobAssetId === undefined || jobAssetId === "" ? null : Number(jobAssetId);
  if (assetId === null) {
    return {
      jobAssetId: null,
      quoteJobId: null,
      quoteSerialNo: null,
    };
  }
  if (!Number.isFinite(assetId) || assetId <= 0) {
    const err = new Error("JOB_ASSET_ID_INVALID");
    err.status = 400;
    throw err;
  }

  const asset = await getJobAssetOrThrow(client, req, assetId);
  if (Number(asset.customer_id) !== Number(customerId)) {
    const err = new Error("JOB_ASSET_CUSTOMER_MISMATCH");
    err.status = 400;
    throw err;
  }

  return {
    jobAssetId: asset.id,
    quoteJobId: asset.job_id || null,
    quoteSerialNo: asset.serial_no || null,
  };
}

async function resolveAftermarketQuoteContext(client, req, { customerId, serviceWarrantyCaseId, amcContractId }) {
  const serviceCaseId =
    serviceWarrantyCaseId === null || serviceWarrantyCaseId === undefined || serviceWarrantyCaseId === ""
      ? null
      : Number(serviceWarrantyCaseId);
  const contractId =
    amcContractId === null || amcContractId === undefined || amcContractId === ""
      ? null
      : Number(amcContractId);

  if (serviceCaseId !== null && (!Number.isFinite(serviceCaseId) || serviceCaseId <= 0)) {
    const err = new Error("SERVICE_CASE_ID_INVALID");
    err.status = 400;
    throw err;
  }
  if (contractId !== null && (!Number.isFinite(contractId) || contractId <= 0)) {
    const err = new Error("AMC_CONTRACT_ID_INVALID");
    err.status = 400;
    throw err;
  }

  if (serviceCaseId !== null) {
    const serviceCaseRes = await client.query(
      `
        select id, company_id, customer_id, case_number
        from service_warranty_cases
        where id = $1
        limit 1
      `,
      [serviceCaseId]
    );
    const serviceCase = serviceCaseRes.rows[0] || null;
    if (!serviceCase) {
      const err = new Error("SERVICE_CASE_NOT_FOUND");
      err.status = 404;
      throw err;
    }
    await ensureCustomerCompanyAccess(client, req, serviceCase.customer_id);
    if (Number(serviceCase.customer_id) !== Number(customerId)) {
      const err = new Error("SERVICE_CASE_CUSTOMER_MISMATCH");
      err.status = 400;
      throw err;
    }
  }

  if (contractId !== null) {
    const contractRes = await client.query(
      `
        select id, company_id, customer_id, contract_number
        from amc_contracts
        where id = $1
        limit 1
      `,
      [contractId]
    );
    const contract = contractRes.rows[0] || null;
    if (!contract) {
      const err = new Error("AMC_CONTRACT_NOT_FOUND");
      err.status = 404;
      throw err;
    }
    await ensureCustomerCompanyAccess(client, req, contract.customer_id);
    if (Number(contract.customer_id) !== Number(customerId)) {
      const err = new Error("AMC_CONTRACT_CUSTOMER_MISMATCH");
      err.status = 400;
      throw err;
    }
  }

  return {
    serviceWarrantyCaseId: serviceCaseId,
    amcContractId: contractId,
    quoteOrigin: contractId !== null ? "amc_aftermarket" : serviceCaseId !== null ? "service_aftermarket" : "standard",
  };
}

function getActiveCompanyId(req) {
  const id = Number(req?.ctx?.company_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function getAiCompanyId(client) {
  const res = await client.query(`select company_id_by_code('AI') as company_id`);
  const id = Number(res.rows[0]?.company_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function resolveQuoteCompanyId(client, req, sourceCompanyId = null) {
  const sourceId = Number(sourceCompanyId);
  if (Number.isFinite(sourceId) && sourceId > 0) return sourceId;

  const activeCompanyId = getActiveCompanyId(req);
  if (activeCompanyId) return activeCompanyId;

  if (req?.user?.group_name === "Distributor" || req?.user?.group_name === "SuperAdmin") {
    return getAiCompanyId(client);
  }

  return null;
}

async function syncQuoteNumberSequence(client, companyId) {
  const id = Number(companyId);
  if (!Number.isFinite(id) || id <= 0) return;

  await client.query(
    `
      with seq as (
        select
          $1::int as company_id,
          'QUOTE'::text as document_type,
          to_char(current_date, 'YY')::char(2) as year_2,
          coalesce(
            max(
              case
                when quote_number ~ ('^Q' || to_char(current_date, 'YY') || '[0-9]{6}$')
                  then right(quote_number, 6)::int
                else 0
              end
            ),
            0
          ) as max_no
        from quote_headers
        where company_id = $1
      )
      insert into document_sequences_company (company_id, document_type, year_2, current_number)
      select company_id, document_type, year_2, max_no
      from seq
      on conflict (company_id, document_type, year_2) do update
      set current_number = greatest(document_sequences_company.current_number, excluded.current_number)
    `,
    [id]
  );
}

async function nextQuoteNumber(client, companyId) {
  const res = await client.query(`select next_company_document_number($1, 'QUOTE') as quote_number`, [companyId]);
  const quoteNumber = String(res.rows[0]?.quote_number || "").trim();
  if (!quoteNumber) throw new Error("Failed to generate quote number.");
  return quoteNumber;
}

function isQuoteNumberConflict(err) {
  if (String(err?.code || "") !== "23505") return false;
  const detail = String(err?.detail || "");
  const constraint = String(err?.constraint || "");
  return (
    detail.includes("(company_id, quote_number)") ||
    constraint.includes("quote_headers_company_quote_number") ||
    constraint.includes("quote_headers_quote_number")
  );
}

async function insertQuoteHeaderWithNumberRetry(
  client,
  {
    companyId,
    customerId,
    customerSiteId,
    distributorId,
    leadId,
    attentionTo,
    createdBy,
    jobAssetId,
    quoteJobId,
    quoteSerialNo,
    orderFlow,
    fulfillmentMode,
    buyerPoNumber,
    buyerPoDate,
    poExceptionReason,
    endCustomerName,
    endCustomerPoNumber,
    endCustomerPoDate,
    shipToCustomerSiteId,
    billToName,
    billToAddress,
    shipToName,
    shipToAddress,
    serviceWarrantyCaseId,
    amcContractId,
    quoteOrigin,
  }
) {
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const savepointName = `quote_header_retry_${attempt}`;
    try {
      await client.query(`savepoint ${savepointName}`);
      if (attempt > 0) {
        await syncQuoteNumberSequence(client, companyId);
      }

      const quoteNumber = await nextQuoteNumber(client, companyId);
      const headerRes = await client.query(
        `
          insert into quote_headers (
            company_id,
            quote_number,
            customer_id,
            customer_site_id,
            job_asset_id,
            quote_job_id,
            quote_serial_no,
            distributor_id,
            lead_id,
            attention_to,
            order_flow,
            fulfillment_mode,
            buyer_po_number,
            buyer_po_date,
            po_exception_reason,
            end_customer_name,
            end_customer_po_number,
            end_customer_po_date,
            ship_to_customer_site_id,
            bill_to_name,
            bill_to_address,
            ship_to_name,
            ship_to_address,
            service_warranty_case_id,
            amc_contract_id,
            quote_origin,
            quote_status,
            created_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,'draft',$27)
          returning *
        `,
        [
          companyId,
          quoteNumber,
          customerId,
          customerSiteId || null,
          jobAssetId || null,
          quoteJobId || null,
          quoteSerialNo || null,
          distributorId,
          leadId,
          attentionTo || null,
          orderFlow,
          fulfillmentMode,
          buyerPoNumber || null,
          buyerPoDate || null,
          poExceptionReason || null,
          endCustomerName || null,
          endCustomerPoNumber || null,
          endCustomerPoDate || null,
          shipToCustomerSiteId || null,
          billToName || null,
          billToAddress || null,
          shipToName || null,
          shipToAddress || null,
          serviceWarrantyCaseId || null,
          amcContractId || null,
          quoteOrigin || "standard",
          createdBy,
        ]
      );
      await client.query(`release savepoint ${savepointName}`);
      return headerRes.rows[0];
    } catch (err) {
      await client.query(`rollback to savepoint ${savepointName}`);
      await client.query(`release savepoint ${savepointName}`);
      if (isQuoteNumberConflict(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error("Failed to allocate a unique quote number.");
}

function canAccessCompanyContext(req, quote) {
  if (!quote) return false;
  if (req.user.group_name === "Distributor") return true;
  if (req.user.group_name === "SuperAdmin") return true;
  const activeCompanyId = getActiveCompanyId(req);
  if (!activeCompanyId) return false;
  return Number(quote.company_id) === Number(activeCompanyId);
}

function num(v) {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

let hsnTaxCodeMapReady = null;
let commercialTermMappingsReady = null;

function clampGstPct(value) {
  const parsed = num(value);
  if (parsed === null) return 0;
  return Math.max(0, Math.min(100, Number(parsed)));
}

function normalizeHsnNo(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTermCaption(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function getManagedCommercialTermKindByCaption(value) {
  const caption = normalizeTermCaption(value);
  if (caption === "incoterm" || caption === "incoterms") return "incoterm";
  if (caption === "payment term" || caption === "payment terms") return "payment_term";
  if (caption === "freight term" || caption === "freight terms" || caption === "freight") return "freight_term";
  if (
    caption === "p f" ||
    caption === "p f terms" ||
    caption === "packing forwarding" ||
    caption === "packing and forwarding"
  ) {
    return "p_and_f_term";
  }
  return "";
}

function isManagedCommercialTermCaption(value) {
  return Boolean(getManagedCommercialTermKindByCaption(value));
}

function getManagedCommercialTermRank(value) {
  const kind = getManagedCommercialTermKindByCaption(value);
  if (kind === "incoterm") return 0;
  if (kind === "payment_term") return 1;
  if (kind === "freight_term") return 2;
  if (kind === "p_and_f_term") return 3;
  return 99;
}

async function hasHsnTaxCodeMap(client) {
  if (typeof hsnTaxCodeMapReady === "boolean") return hsnTaxCodeMapReady;
  const r = await client.query(`select to_regclass('public.hsn_tax_code_map') is not null as ready`);
  hsnTaxCodeMapReady = Boolean(r.rows[0]?.ready);
  return hsnTaxCodeMapReady;
}

async function hasCommercialTermMappings(client) {
  if (typeof commercialTermMappingsReady === "boolean") return commercialTermMappingsReady;
  const r = await client.query(`select to_regclass('public.commercial_term_mappings') is not null as ready`);
  commercialTermMappingsReady = Boolean(r.rows[0]?.ready);
  return commercialTermMappingsReady;
}

async function resolveQuoteTaxProfile(client, { hsnNo, fallbackGstPct = 0 }) {
  const normalizedHsn = normalizeHsnNo(hsnNo);
  if (normalizedHsn && (await hasHsnTaxCodeMap(client))) {
    const mappedRes = await client.query(
      `
        select tc.tax_rate
        from hsn_tax_code_map hm
        join tax_codes tc on tc.id = hm.tax_code_id
        where hm.hsn_no = $1
          and hm.is_active = true
          and tc.is_active = true
        order by hm.id asc
        limit 1
      `,
      [normalizedHsn]
    );
    const mappedRate = num(mappedRes.rows[0]?.tax_rate);
    if (mappedRate !== null) {
      return { hsn_no: normalizedHsn, gst_pct: clampGstPct(mappedRate) };
    }
  }

  return {
    hsn_no: normalizedHsn,
    gst_pct: clampGstPct(fallbackGstPct),
  };
}

async function getRevisionCommercialDefaults(client, quoteRevisionId) {
  const res = await client.query(
    `
      select
        r.is_export,
        r.incoterm_id,
        r.payment_term_id,
        r.freight_term_id,
        r.p_and_f_term_id,
        (select trim(concat_ws(' - ', incoterm_code, incoterm_name)) from incoterms where id = r.incoterm_id) as incoterm_label,
        (select term_name from payment_terms where id = r.payment_term_id) as payment_term_label,
        (select term_name from freight_terms where id = r.freight_term_id) as freight_term_label,
        (select term_name from p_and_f_terms where id = r.p_and_f_term_id) as p_and_f_term_label
      from quote_revisions r
      where r.id = $1
      limit 1
    `,
    [quoteRevisionId]
  );
  return res.rows[0] || null;
}

function fallbackTaxTermDescription(isExport) {
  return isExport
    ? "GST as applicable for export supply. Final levy shall be applied at invoice stage as per statutory requirements."
    : "GST as per the commercial table. Final levy shall be reflected as IGST or CGST/SGST at invoice stage based on place of supply.";
}

function resolveMappedCommercialDescription(mapping, commercial) {
  if (mapping?.override_description) return mapping.override_description;
  if (!mapping || !commercial) return "";
  if (mapping.commercial_type === "payment_term") return commercial.payment_term_label || "";
  if (mapping.commercial_type === "freight_term") return commercial.freight_term_label || "";
  if (mapping.commercial_type === "p_and_f_term") return commercial.p_and_f_term_label || "";
  if (mapping.commercial_type === "incoterm") return commercial.incoterm_label || "";
  if (mapping.commercial_type === "tax_mode") return fallbackTaxTermDescription(String(mapping.commercial_value || "") === "export");
  return "";
}

async function listCommercialTermMappingsForRevision(client, quoteRevisionId) {
  const commercial = await getRevisionCommercialDefaults(client, quoteRevisionId);
  if (!commercial || !(await hasCommercialTermMappings(client))) return { commercial, mappings: [] };

  const values = [];
  const clauses = [];

  if (Number.isFinite(Number(commercial.payment_term_id))) {
    values.push("payment_term", String(commercial.payment_term_id));
    clauses.push(`(ctm.commercial_type = $${values.length - 1} and ctm.commercial_value = $${values.length})`);
  }
  if (Number.isFinite(Number(commercial.freight_term_id))) {
    values.push("freight_term", String(commercial.freight_term_id));
    clauses.push(`(ctm.commercial_type = $${values.length - 1} and ctm.commercial_value = $${values.length})`);
  }
  if (Number.isFinite(Number(commercial.p_and_f_term_id))) {
    values.push("p_and_f_term", String(commercial.p_and_f_term_id));
    clauses.push(`(ctm.commercial_type = $${values.length - 1} and ctm.commercial_value = $${values.length})`);
  }
  if (Number.isFinite(Number(commercial.incoterm_id))) {
    values.push("incoterm", String(commercial.incoterm_id));
    clauses.push(`(ctm.commercial_type = $${values.length - 1} and ctm.commercial_value = $${values.length})`);
  }
  values.push("tax_mode", commercial.is_export ? "export" : "domestic");
  clauses.push(`(ctm.commercial_type = $${values.length - 1} and ctm.commercial_value = $${values.length})`);

  if (!clauses.length) return { commercial, mappings: [] };

  const res = await client.query(
    `
      select
        ctm.id,
        ctm.commercial_type,
        ctm.commercial_value,
        ctm.term_master_id,
        ctm.override_description
      from commercial_term_mappings ctm
      where ctm.is_active = true
        and (${clauses.join(" or ")})
      order by ctm.id asc
    `,
    values
  );
  return { commercial, mappings: res.rows };
}

function buildManagedCommercialTermDescription(term, commercial) {
  const kind = getManagedCommercialTermKindByCaption(term?.caption);
  if (!kind || !commercial) return null;

  if (kind === "payment_term" && commercial.payment_term_label) {
    return commercial.payment_term_label;
  }
  if (kind === "freight_term" && commercial.freight_term_label) {
    return commercial.freight_term_label;
  }
  if (kind === "p_and_f_term" && commercial.p_and_f_term_label) {
    return commercial.p_and_f_term_label;
  }
  if (kind === "incoterm" && commercial.incoterm_label) {
    return commercial.incoterm_label;
  }
  const caption = normalizeTermCaption(term?.caption);
  if (caption === "gst" || caption === "tax" || caption === "taxes") {
    return fallbackTaxTermDescription(commercial.is_export);
  }

  return null;
}

async function syncCommercialDefaultsToRevisionTerms(client, quoteRevisionId) {
  const { commercial, mappings } = await listCommercialTermMappingsForRevision(client, quoteRevisionId);
  if (!commercial) return;

  const terms = await getRevisionTerms(client, quoteRevisionId);
  const mappedTermIds = new Set();

  for (const mapping of mappings) {
    const nextDescription = resolveMappedCommercialDescription(mapping, commercial);
    if (!nextDescription) continue;
    const term = terms.find((item) => Number(item.term_master_id) === Number(mapping.term_master_id));
    if (!term) continue;
    mappedTermIds.add(Number(mapping.term_master_id));
    if (nextDescription === term.description && term.is_selected !== false) continue;
    await client.query(
      `
        update quote_revision_terms
        set description = $2, is_selected = true, updated_at = now()
        where id = $1
      `,
      [term.id, nextDescription]
    );
  }

  for (const term of terms) {
    if (mappedTermIds.has(Number(term.term_master_id))) continue;
    const nextDescription = buildManagedCommercialTermDescription(term, commercial);
    if (!nextDescription || nextDescription === term.description) continue;
    await client.query(
      `
        update quote_revision_terms
        set description = $2, is_selected = true, updated_at = now()
        where id = $1
      `,
      [term.id, nextDescription]
    );
  }
}

function normalizeScopeType(v) {
  if (v === "included" || v === "client_scope" || v === "quoted_separately") return v;
  return null;
}

function safeParseJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function roundMoney(value, scale = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** scale;
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

function convertBaseAmountToQuote(baseAmount, exchangeRate) {
  const base = Number(baseAmount);
  const rate = Number(exchangeRate);
  if (!Number.isFinite(base)) return 0;
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return roundMoney(base, 2);
  return roundMoney(base / rate, 2);
}

function convertQuoteAmountToBase(quoteAmount, exchangeRate) {
  const quote = Number(quoteAmount);
  const rate = Number(exchangeRate);
  if (!Number.isFinite(quote)) return 0;
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return roundMoney(quote, 2);
  return roundMoney(quote * rate, 2);
}

async function resolveRevisionExchangeRate(client, revision) {
  const baseCurrencyId = Number(revision?.base_currency_id);
  const quoteCurrencyId = Number(revision?.quote_currency_id);
  if (!Number.isFinite(baseCurrencyId) || !Number.isFinite(quoteCurrencyId) || baseCurrencyId === quoteCurrencyId) {
    return 1;
  }

  const hasExchangeRatesRes = await client.query(`select to_regclass('public.exchange_rates') is not null as ready`);
  if (!hasExchangeRatesRes.rows[0]?.ready) return 1;

  const rateRes = await client.query(
    `
      select rate_value
      from exchange_rates
      where from_currency_id = $1
        and to_currency_id = $2
        and coalesce(is_active, true) = true
      order by rate_date desc nulls last, id desc
      limit 1
    `,
    [baseCurrencyId, quoteCurrencyId]
  );
  const rateValue = num(rateRes.rows[0]?.rate_value);
  if (rateValue && Number(rateValue) > 0) return Number(rateValue);

  const err = new Error("Exchange rate not found.");
  err.status = 400;
  err.code = "EXCHANGE_RATE_NOT_FOUND";
  throw err;
}

async function recalcRevisionQuoteCurrencyAmounts(client, revisionOrId) {
  const revision =
    revisionOrId && typeof revisionOrId === "object"
      ? revisionOrId
      : await getLatestRevisionOrNull(client, Number(revisionOrId));
  if (!revision?.id) return;

  const exchangeRate = await resolveRevisionExchangeRate(client, revision);
  if (exchangeRate === 1) {
    await client.query(
      `
        update quote_lines
        set
          unit_price_quote = round(coalesce(unit_price_base, 0)::numeric, 2),
          line_total_quote = round(coalesce(line_total_base, 0)::numeric, 2)
        where quote_revision_id = $1
      `,
      [revision.id]
    );
    return;
  }

  await client.query(
    `
      update quote_lines
      set
        unit_price_quote = round((coalesce(unit_price_base, 0)::numeric / $2::numeric), 2),
        line_total_quote = round((coalesce(line_total_base, 0)::numeric / $2::numeric), 2)
      where quote_revision_id = $1
    `,
    [revision.id, exchangeRate]
  );
}

async function getApprovalUserProfile(client, userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return null;
  const r = await client.query(
    `
      select
        u.id,
        u.full_name,
        u.email,
        u.primary_manager_user_id,
        u.secondary_manager_user_id,
        ug.group_name,
        coalesce(u.discount_threshold_pct, ug.max_autonomous_discount_pct, 0) as max_autonomous_discount_pct
      from erp_users u
      join user_groups ug on ug.id = u.group_id
      where u.id = $1 and u.is_active = true and ug.is_active = true
      limit 1
    `,
    [id]
  );
  return r.rows[0] || null;
}

async function canUserApproveQuotes(client, userId) {
  const ctx = await loadUserContextById(client, userId);
  if (!ctx) return false;
  return Boolean(
    ctx.group_name === "SuperAdmin" ||
      ctx.permissions?.screens?.quotes?.can_approve ||
      ctx.permissions?.modules?.quotes?.can_approve
  );
}

function getLineDiscountPct(line) {
  const explicit = num(line?.discount_pct);
  if (Number.isFinite(explicit)) {
    return Math.max(0, Math.min(100, Number(explicit)));
  }

  const meta = safeParseJson(line?.line_description);
  const metaPct = num(meta?.discount_pct);
  if (Number.isFinite(metaPct)) {
    return Math.max(0, Math.min(100, Number(metaPct)));
  }

  const grossUnit = num(line?.gross_unit_price_quote) || num(meta?.gross_unit_price_quote);
  const netUnit = num(line?.unit_price_quote);
  if (Number.isFinite(grossUnit) && grossUnit > 0 && Number.isFinite(netUnit)) {
    return Math.max(0, Math.min(100, ((grossUnit - netUnit) / grossUnit) * 100));
  }

  return 0;
}

function resolveLineListSnapshot(line, fallbackListPrice = 0) {
  const snapshot = num(line?.list_price_snapshot);
  if (Number.isFinite(snapshot) && snapshot > 0) return snapshot;
  const gross = num(line?.gross_unit_price_quote);
  if (Number.isFinite(gross) && gross > 0) return gross;
  const meta = safeParseJson(line?.line_description);
  const metaList = num(meta?.source_list_price);
  if (Number.isFinite(metaList) && metaList > 0) return metaList;
  const metaGross = num(meta?.gross_unit_price_quote);
  if (Number.isFinite(metaGross) && metaGross > 0) return metaGross;
  return Number(fallbackListPrice || 0);
}

function resolveLineGrossUnit(line, netUnit) {
  const gross = num(line?.gross_unit_price_quote);
  if (Number.isFinite(gross) && gross > 0) return gross;
  const meta = safeParseJson(line?.line_description);
  const metaGross = num(meta?.gross_unit_price_quote);
  if (Number.isFinite(metaGross) && metaGross > 0) return metaGross;
  const discountPct = getLineDiscountPct({ ...line, unit_price_quote: netUnit });
  if (discountPct > 0 && discountPct < 100 && Number.isFinite(Number(netUnit))) {
    return Number(netUnit) / (1 - discountPct / 100);
  }
  return Number(netUnit || 0);
}

async function loadQuotePricingGuardrails(client, companyId) {
  const ready = await client
    .query(`select to_regclass('public.quote_pricing_guardrails') is not null as ready`)
    .then((r) => r.rows[0]?.ready === true)
    .catch(() => false);
  if (!ready || !Number.isFinite(Number(companyId))) return [];
  const r = await client.query(
    `
      select company_id, product_group_id, min_net_pct_of_list, requires_approval_below_pct
      from quote_pricing_guardrails
      where company_id = $1 and is_active = true
    `,
    [Number(companyId)]
  );
  return r.rows;
}

function matchQuoteGuardrail(guardrails, productGroupId) {
  const list = Array.isArray(guardrails) ? guardrails : [];
  const gid = Number(productGroupId);
  const groupMatch = Number.isFinite(gid) ? list.find((row) => Number(row.product_group_id) === gid) : null;
  if (groupMatch) return groupMatch;
  return list.find((row) => row.product_group_id == null) || null;
}

/**
 * Progressive price control: below requires_approval_below_pct of list → "approval" (soft: warn + route
 * to approval); below min_net_pct_of_list → "floor" (hard block). Either threshold may be left unset.
 */
function classifyLinePriceBand(guardrail, unitPriceQuote, listSnapshot) {
  const list = Number(listSnapshot || 0);
  const price = Number(unitPriceQuote || 0);
  if (!guardrail || !(list > 0)) return null;
  const floorPct = Number(guardrail.min_net_pct_of_list || 0);
  const approvalPct = Number(guardrail.requires_approval_below_pct || 0);
  const netPct = roundMoney((price / list) * 100, 2);
  if (floorPct > 0 && price + 0.0001 < (list * floorPct) / 100) {
    return { band: "floor", threshold_pct: floorPct, net_pct_of_list: netPct, threshold_price: roundMoney((list * floorPct) / 100, 2) };
  }
  if (approvalPct > 0 && price + 0.0001 < (list * approvalPct) / 100) {
    return { band: "approval", threshold_pct: approvalPct, net_pct_of_list: netPct, threshold_price: roundMoney((list * approvalPct) / 100, 2) };
  }
  return null;
}

async function findRevisionPriceBandLines(client, { revisionId, companyId }) {
  const guardrails = await loadQuotePricingGuardrails(client, companyId);
  if (!guardrails.length) return [];
  const hasSnapshot = await hasQuoteLineColumn(client, "list_price_snapshot");
  const r = await client.query(
    `
      select l.line_no, l.item_name, l.unit_price_quote,
             ${hasSnapshot ? "coalesce(nullif(l.list_price_snapshot, 0), p.list_price, 0)" : "coalesce(p.list_price, 0)"} as list_snapshot,
             p.group_id as product_group_id
      from quote_lines l
      left join products p on p.id = l.product_id
      where l.quote_revision_id = $1
        and coalesce(l.scope_type, 'included') <> 'client_scope'
      order by l.line_no asc
    `,
    [revisionId]
  );
  const out = [];
  for (const row of r.rows) {
    const band = classifyLinePriceBand(matchQuoteGuardrail(guardrails, row.product_group_id), row.unit_price_quote, row.list_snapshot);
    if (band) out.push({ line_no: row.line_no, item_name: row.item_name, unit_price_quote: Number(row.unit_price_quote || 0), list_price_snapshot: Number(row.list_snapshot || 0), ...band });
  }
  return out;
}

async function hasQuoteHeaderColumn(client, columnName) {
  const r = await client.query(
    `
      select 1
      from information_schema.columns
      where table_schema = 'public' and table_name = 'quote_headers' and column_name = $1
      limit 1
    `,
    [columnName]
  );
  return Boolean(r.rows[0]);
}

async function hasQuoteLineColumn(client, columnName) {
  const r = await client.query(
    `
      select 1
      from information_schema.columns
      where table_schema = 'public' and table_name = 'quote_lines' and column_name = $1
      limit 1
    `,
    [columnName]
  );
  return Boolean(r.rows[0]);
}

async function hasQuoteRevisionColumn(client, columnName) {
  const r = await client.query(
    `
      select 1
      from information_schema.columns
      where table_schema = 'public' and table_name = 'quote_revisions' and column_name = $1
      limit 1
    `,
    [columnName]
  );
  return Boolean(r.rows[0]);
}

const ANNEXURE_MODES = ["merged", "separate", "none"];

async function loadQuoteFamilyContent(client) {
  const ready = await client.query(`select to_regclass('public.quote_family_content') is not null as ready`);
  if (ready.rows[0]?.ready !== true) return buildFamilyContent([]);
  const r = await client.query(`select * from quote_family_content where is_active = true`);
  return buildFamilyContent(r.rows);
}

function resolveAnnexureMode(revision) {
  const mode = String(revision?.annexure_mode || "").trim();
  if (ANNEXURE_MODES.includes(mode)) return mode;
  return revision?.merge_annexures === false ? "separate" : "merged";
}

function parseOptionalNonNegativeInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

async function stampExpiredQuotes(client, { companyId = null, distributorId = null } = {}) {
  const ready = await hasQuoteHeaderColumn(client, "lapsed_at");
  if (!ready) return 0;
  const params = [["issued", "sent", "approved"]];
  const where = [
    "q.quote_status = any($1::text[])",
    "q.quote_valid_till is not null",
    "q.quote_valid_till < current_date",
  ];
  if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
    params.push(Number(distributorId));
    where.push(`q.distributor_id = $${params.length}`);
  } else if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    where.push(`q.company_id = $${params.length}`);
  }
  const r = await client.query(
    `
      update quote_headers q
      set
        lapsed_at = coalesce(q.lapsed_at, now()),
        quote_status = 'lapsed',
        updated_at = now()
      where ${where.join(" and ")}
        and not exists (
          select 1
          from quote_revisions qr
          join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          where qr.quote_id = q.id
        )
    `,
    params
  );
  return r.rowCount || 0;
}

function summarizeRevisionDiff(fromLines, toLines) {
  const fromMap = new Map((Array.isArray(fromLines) ? fromLines : []).map((line) => [String(line.product_id || line.item_code || line.line_no), line]));
  const toList = Array.isArray(toLines) ? toLines : [];
  const toKeys = new Set(toList.map((line) => String(line.product_id || line.item_code || line.line_no)));
  const added = [];
  const removed = [];
  const changed = [];

  for (const line of toList) {
    const key = String(line.product_id || line.item_code || line.line_no);
    const prev = fromMap.get(key);
    if (!prev) {
      added.push({
        line_no: line.line_no,
        item_name: line.item_name,
        qty: line.qty,
        unit_price_quote: line.unit_price_quote,
        discount_pct: getLineDiscountPct(line),
      });
      continue;
    }
    const qtyChanged = Number(prev.qty || 0) !== Number(line.qty || 0);
    const priceChanged = Number(prev.unit_price_quote || 0) !== Number(line.unit_price_quote || 0);
    const discountChanged = Math.abs(getLineDiscountPct(prev) - getLineDiscountPct(line)) > 0.009;
    if (qtyChanged || priceChanged || discountChanged) {
      changed.push({
        line_no: line.line_no,
        item_name: line.item_name,
        from_qty: prev.qty,
        to_qty: line.qty,
        from_unit_price_quote: prev.unit_price_quote,
        to_unit_price_quote: line.unit_price_quote,
        from_discount_pct: getLineDiscountPct(prev),
        to_discount_pct: getLineDiscountPct(line),
      });
    }
  }

  for (const [key, prev] of fromMap.entries()) {
    if (toKeys.has(key)) continue;
    removed.push({
      line_no: prev.line_no,
      item_name: prev.item_name,
      qty: prev.qty,
      unit_price_quote: prev.unit_price_quote,
      discount_pct: getLineDiscountPct(prev),
    });
  }

  return { added, removed, changed };
}

function summarizeRevisionDiscounts(lines) {
  const normalized = Array.isArray(lines)
    ? lines
        .filter((line) => String(line?.scope_type || "included") !== "client_scope")
        .map((line, index) => ({
          line_id: line?.id || null,
          line_no: line?.line_no || index + 1,
          item_name: line?.item_name || line?.item_code || `Line ${index + 1}`,
          discount_pct: getLineDiscountPct(line),
        }))
        .filter((line) => Number.isFinite(line.discount_pct))
    : [];

  normalized.sort((a, b) => b.discount_pct - a.discount_pct || a.line_no - b.line_no);

  return {
    max_discount_pct: normalized.length ? Number(normalized[0].discount_pct) : 0,
    lines: normalized.slice(0, 5),
  };
}

async function issueRevisionNow(client, { quote, revision, lines }) {
  const readiness = buildQuoteIssueReadiness({ quote, revision, lines });
  if (!readiness.ok) return { ok: false, blockers: readiness.blockers };
  const upd = await client.query(
    `
      update quote_revisions
      set revision_status = 'issued', issued_at = now(), locked_at = now()
      where id = $1
      returning *
    `,
    [revision.id]
  );
  await syncQuoteHeaderStatus(client, quote.id, "issued");
  await client.query(
    `
      update quote_headers
      set quote_valid_till = coalesce(quote_valid_till, (current_date + interval '30 days')::date),
          updated_at = now()
      where id = $1
    `,
    [quote.id]
  );
  return { ok: true, revision: upd.rows[0] || revision };
}

async function markRevisionEdited(client, revisionId, userId) {
  if (!Number.isFinite(Number(revisionId)) || !Number.isFinite(Number(userId))) return;
  await client.query(`update quote_revisions set edited_by = $2, edited_at = now() where id = $1`, [revisionId, userId]);
}

async function syncQuoteHeaderStatus(client, quoteId, revisionStatus) {
  const nextStatus = String(revisionStatus || "").trim() || "draft";
  await client.query(`update quote_headers set quote_status = $2, updated_at = now() where id = $1`, [quoteId, nextStatus]);
}

async function resolveApprovalChain(client, requesterUserId) {
  const requester = await getApprovalUserProfile(client, requesterUserId);
  if (!requester) return [];

  const out = [];
  const seen = new Set([Number(requester.id)]);

  async function tryAdd(userId) {
    const id = Number(userId);
    if (!Number.isFinite(id) || seen.has(id)) return null;
    seen.add(id);
    const profile = await getApprovalUserProfile(client, id);
    if (!profile) return null;
    if (await canUserApproveQuotes(client, profile.id)) {
      out.push(profile);
    }
    return profile;
  }

  const primary = await tryAdd(requester.primary_manager_user_id);
  if (primary) {
    await tryAdd(primary.primary_manager_user_id);
  }
  if (out.length < 2) {
    await tryAdd(requester.secondary_manager_user_id);
  }

  return out.map((profile, index) => ({
    id: profile.id,
    full_name: profile.full_name,
    email: profile.email,
    sequence_no: index + 1,
  }));
}

/**
 * Who may act on a pending approval step: the assigned approver, a colleague covering for
 * them today, or a manager anywhere above that approver in the reporting tree.
 */
async function resolveApprovalAuthority(client, { approverUserId, actorUserId }) {
  const approverId = Number(approverUserId);
  const actorId = Number(actorUserId);
  if (!Number.isFinite(approverId) || !Number.isFinite(actorId) || approverId <= 0 || actorId <= 0) return null;
  if (approverId === actorId) return "assigned";
  if (await isCoveringFor(client, { coverUserId: actorId, absentUserId: approverId })) return "cover";
  const reportees = await loadReporteeIds(client, actorId);
  if (reportees.has(approverId)) return "senior";
  return null;
}

async function notifyApproverAndCover(args) {
  await notifyQuoteApprovalNeeded(args).catch(() => {});
  const covers = await pool
    .query(
      `
        select to_user_id
        from quote_cover_delegations
        where from_user_id = $1
          and cancelled_at is null
          and current_date between start_date and end_date
      `,
      [Number(args.approverUserId)]
    )
    .catch(() => ({ rows: [] }));
  for (const row of covers.rows) {
    await notifyQuoteApprovalNeeded({
      ...args,
      approverUserId: row.to_user_id,
      stepLabel: args.stepLabel ? `${args.stepLabel}, covering` : "covering",
    }).catch(() => {});
  }
}

async function getNextApprovalCycleNo(client, revisionId) {
  const r = await client.query(
    `select coalesce(max(approval_cycle_no), 0) as current_cycle_no from quote_approvals where quote_revision_id = $1`,
    [revisionId]
  );
  return Number(r.rows[0]?.current_cycle_no || 0) + 1;
}

async function getQuoteApprovalRows(client, revisionId) {
  const r = await client.query(
    `
      select
        qa.*,
        approver.full_name as approver_name,
        approver.email as approver_email,
        requester.full_name as requested_by_name,
        requester.email as requested_by_email,
        actor.full_name as acted_by_name,
        actor.email as acted_by_email
      from quote_approvals qa
      left join erp_users approver on approver.id = qa.approver_user_id
      left join erp_users requester on requester.id = qa.requested_by
      left join erp_users actor on actor.id = qa.acted_by_user_id
      where qa.quote_revision_id = $1
      order by qa.approval_cycle_no desc, qa.sequence_no asc, qa.id asc
    `,
    [revisionId]
  );
  return r.rows;
}

async function buildQuoteApprovalSnapshot(client, { quote, revision, actorUserId, lines = null }) {
  const revisionLines = Array.isArray(lines) ? lines : await getRevisionLines(client, revision.id);
  const requester = await getApprovalUserProfile(client, quoteOwnerId(quote) || revision.prepared_by);
  const discountSummary = summarizeRevisionDiscounts(revisionLines);
  const autonomousDiscountPct = Number(requester?.max_autonomous_discount_pct || 0);
  const discountApprovalRequired = discountSummary.max_discount_pct > autonomousDiscountPct + 0.0001;
  const priceBandLines = await findRevisionPriceBandLines(client, {
    revisionId: revision.id,
    companyId: quote.company_id ?? revision.company_id,
  }).catch((bandErr) => {
    console.warn(`[quote-approval] price band check failed: ${bandErr?.message || bandErr}`);
    return [];
  });
  const approvalRequired = discountApprovalRequired || priceBandLines.length > 0;
  const approvals = await getQuoteApprovalRows(client, revision.id);
  const latestCycleNo = approvals.length ? Math.max(...approvals.map((row) => Number(row.approval_cycle_no || 0))) : 0;
  const latestCycleRows = approvals.filter((row) => Number(row.approval_cycle_no || 0) === latestCycleNo);
  const currentPending = latestCycleRows.find((row) => row.approval_status === "pending") || null;
  const suggestedApprovers = approvalRequired ? await resolveApprovalChain(client, requester?.id) : [];
  const actorAuthority =
    currentPending && revision.revision_status === "pending_approval"
      ? await resolveApprovalAuthority(client, { approverUserId: currentPending.approver_user_id, actorUserId })
      : null;

  return {
    revision_status: revision.revision_status,
    autonomous_discount_pct: autonomousDiscountPct,
    max_discount_pct: discountSummary.max_discount_pct,
    approval_required: approvalRequired,
    approval_reasons: [
      ...(discountApprovalRequired ? ["discount_above_autonomy"] : []),
      ...(priceBandLines.length ? ["price_below_approval_band"] : []),
    ],
    price_band_lines: priceBandLines,
    requested_by: requester
      ? {
          id: requester.id,
          full_name: requester.full_name,
          email: requester.email,
        }
      : null,
    current_cycle_no: latestCycleNo || null,
    current_approver: currentPending
      ? {
          id: currentPending.approver_user_id,
          full_name: currentPending.approver_name,
          email: currentPending.approver_email,
          sequence_no: currentPending.sequence_no,
        }
      : null,
    suggested_approvers: suggestedApprovers,
    approvals: approvals.map((row) => ({
      id: row.id,
      approval_cycle_no: row.approval_cycle_no,
      approval_type: row.approval_type,
      approval_status: row.approval_status,
      sequence_no: row.sequence_no,
      approver_user_id: row.approver_user_id,
      approver_name: row.approver_name,
      approver_email: row.approver_email,
      remarks: row.remarks,
      requested_by: row.requested_by,
      requested_by_name: row.requested_by_name,
      requested_by_email: row.requested_by_email,
      acted_by_user_id: row.acted_by_user_id,
      acted_by_name: row.acted_by_name,
      acted_by_email: row.acted_by_email,
      approved_at: row.approved_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    triggering_lines: discountSummary.lines,
    actor_approval_authority: actorAuthority,
    can_actor_approve: Boolean(actorAuthority),
    can_submit:
      revision.revision_status === "draft" && approvalRequired && suggestedApprovers.length > 0,
    can_issue:
      revision.revision_status === "approved" || (revision.revision_status === "draft" && !approvalRequired),
  };
}

async function getQuoteHeaderOrNull(client, { quoteId, distributorId }) {
  const params = [quoteId];
  let where = `where q.id = $1`;
  if (Number.isFinite(distributorId)) {
    params.push(distributorId);
    where += ` and q.distributor_id = $2`;
  }

  const closureReady = await client
    .query(`select to_regclass('public.quote_closure_reasons') is not null as ready`)
    .then((r) => r.rows[0]?.ready === true)
    .catch(() => false);

  const headerRes = await client.query(
    `
      select
        q.*,
        ${closureReady ? "qcr.reason_code as closure_reason_code, qcr.reason_name as closure_reason_name," : "null::text as closure_reason_code, null::text as closure_reason_name,"}
        co.company_code,
        co.display_name as company_display_name,
        co.legal_name as company_legal_name,
        c.customer_name,
        c.customer_code,
        c.address_line1,
        c.address_line2,
        c.address_line3,
        c.city,
        c.state,
        c.pincode,
        c.country_id,
        c.email as customer_email,
        c.phone as customer_phone,
        cs.site_code as customer_site_code,
        cs.site_name as customer_site_name,
        cs.site_type as customer_site_type,
        cs.city as customer_site_city,
        cs.state as customer_site_state,
        cs.gst_status as customer_site_gst_status,
        cs.can_quote as customer_site_can_quote,
        ctr.gstin as customer_site_tax_gstin,
        ctr.registration_name as customer_site_tax_registration_name,
        sts.site_code as ship_to_site_code,
        sts.site_name as ship_to_site_name,
        sts.site_type as ship_to_site_type,
        d.company_name as distributor_name,
        swc.case_number as service_case_number,
        ac.contract_number as amc_contract_number,
        ja.asset_name as job_asset_name,
        ja.asset_code as job_asset_code,
        ja.asset_status as job_asset_status,
        ja.finished_good_item_name as job_asset_finished_good_item_name,
        owner_u.full_name as owner_name,
        owner_u.email as owner_email
      from quote_headers q
      left join erp_users owner_u on owner_u.id = coalesce(q.owner_user_id, q.created_by)
      ${closureReady ? "left join quote_closure_reasons qcr on qcr.id = q.closure_reason_id" : ""}
      left join companies co on co.id = q.company_id
      join customers c on c.id = q.customer_id
      left join customer_sites cs on cs.id = q.customer_site_id
      left join customer_site_tax_links cstl on cstl.site_id = cs.id
      left join customer_tax_registrations ctr on ctr.id = cstl.tax_registration_id
      left join customer_sites sts on sts.id = q.ship_to_customer_site_id
      left join distributors d on d.id = q.distributor_id
      left join service_warranty_cases swc on swc.id = q.service_warranty_case_id
      left join amc_contracts ac on ac.id = q.amc_contract_id
      left join job_assets ja on ja.id = q.job_asset_id
      ${where}
      limit 1
    `,
    params
  );

  return headerRes.rows[0] || null;
}

function normalizeAttentionToValue(v) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  if (/^sir\/madam$/i.test(s)) return "";
  return s;
}

function normalizeNullableText(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
}

function normalizeOptionalDateValue(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function normalizeOrderFlowValue(v, fallback = "direct") {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "direct" || s === "distributor") return s;
  return fallback;
}

function normalizeFulfillmentModeValue(v, fallback = "direct_customer") {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["direct_customer", "stock_sale", "direct_ship_end_customer"].includes(s)) return s;
  return fallback;
}

function validateOrderCapture({ orderFlow, fulfillmentMode, distributorId, buyerPoNumber, poExceptionReason, endCustomerName }) {
  if (orderFlow === "distributor" && !Number.isFinite(Number(distributorId))) {
    return "DISTRIBUTOR_REQUIRED";
  }
  if (orderFlow === "direct" && fulfillmentMode !== "direct_customer") {
    return "INVALID_FULFILLMENT_MODE";
  }
  if (orderFlow === "distributor" && !["stock_sale", "direct_ship_end_customer"].includes(fulfillmentMode)) {
    return "INVALID_FULFILLMENT_MODE";
  }
  if (fulfillmentMode === "direct_ship_end_customer" && !endCustomerName) {
    return "END_CUSTOMER_REQUIRED";
  }
  if (!buyerPoNumber && !poExceptionReason) {
    return null;
  }
  return null;
}

function formatAddressSnapshot(...parts) {
  return parts
    .flat()
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

async function getCustomerHeaderSnapshot(client, customerId) {
  const r = await client.query(
    `
      select id, customer_name, address_line1, address_line2, address_line3, city, state, pincode
      from customers
      where id = $1
      limit 1
    `,
    [Number(customerId)]
  );
  return r.rows[0] || null;
}

async function getDistributorHeaderSnapshot(client, distributorId) {
  const id = Number(distributorId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const r = await client.query(
    `
      select id, company_name
      from distributors
      where id = $1
      limit 1
    `,
    [id]
  );
  return r.rows[0] || null;
}

async function getCustomerShipSiteOrNull(client, { customerId, customerSiteId }) {
  const siteId = Number(customerSiteId);
  if (!Number.isFinite(siteId) || siteId <= 0) return null;
  const r = await client.query(
    `
      select id, site_name, site_code, site_type, address_line1, address_line2, city, state, pincode, is_active, can_dispatch
      from customer_sites
      where id = $1
        and customer_id = $2
      limit 1
    `,
    [siteId, Number(customerId)]
  );
  return r.rows[0] || null;
}

async function resolveQuoteShipToSiteId(client, { customerId, customerSiteId }) {
  const site = await getCustomerShipSiteOrNull(client, { customerId, customerSiteId });
  if (!site) return null;
  if (!site.is_active) {
    const err = new Error("SHIP_TO_SITE_INACTIVE");
    err.status = 400;
    throw err;
  }
  if (site.can_dispatch === false) {
    const err = new Error("SHIP_TO_SITE_CANNOT_DISPATCH");
    err.status = 400;
    throw err;
  }
  return site.id;
}

async function buildQuotePartySnapshots(
  client,
  {
    customerId,
    distributorId,
    orderFlow,
    fulfillmentMode,
    shipToCustomerSiteId,
    billToName,
    billToAddress,
    shipToName,
    shipToAddress,
    endCustomerName,
  }
) {
  const [customer, distributor, shipSite] = await Promise.all([
    getCustomerHeaderSnapshot(client, customerId),
    getDistributorHeaderSnapshot(client, distributorId),
    getCustomerShipSiteOrNull(client, { customerId, customerSiteId: shipToCustomerSiteId }),
  ]);

  const customerAddress = formatAddressSnapshot(
    customer?.address_line1,
    customer?.address_line2,
    customer?.address_line3,
    customer?.city,
    customer?.state,
    customer?.pincode
  );
  const siteAddress = formatAddressSnapshot(shipSite?.address_line1, shipSite?.address_line2, shipSite?.city, shipSite?.state, shipSite?.pincode);

  const resolvedBillToName =
    billToName ||
    (orderFlow === "distributor" ? distributor?.company_name || customer?.customer_name : customer?.customer_name) ||
    null;
  const resolvedBillToAddress = billToAddress || (orderFlow === "direct" ? customerAddress : null);

  let resolvedShipToName = shipToName || null;
  let resolvedShipToAddress = shipToAddress || null;
  if (!resolvedShipToName || !resolvedShipToAddress) {
    if (fulfillmentMode === "stock_sale") {
      resolvedShipToName = resolvedShipToName || distributor?.company_name || customer?.customer_name || null;
      resolvedShipToAddress = resolvedShipToAddress || null;
    } else if (shipSite) {
      resolvedShipToName = resolvedShipToName || shipSite.site_name || endCustomerName || customer?.customer_name || null;
      resolvedShipToAddress = resolvedShipToAddress || siteAddress || customerAddress || null;
    } else {
      resolvedShipToName = resolvedShipToName || endCustomerName || customer?.customer_name || null;
      resolvedShipToAddress = resolvedShipToAddress || customerAddress || null;
    }
  }

  return {
    billToName: resolvedBillToName,
    billToAddress: resolvedBillToAddress,
    shipToName: resolvedShipToName,
    shipToAddress: resolvedShipToAddress,
  };
}

function formatAttentionToFromContactRow(row) {
  if (!row || typeof row !== "object") return "";
  const sal = typeof row.salutation === "string" ? row.salutation.trim() : "";
  const name = typeof row.full_name === "string" ? row.full_name.trim() : "";
  if (!name) return "";
  if (!sal) return name;
  if (name.toLowerCase().startsWith(sal.toLowerCase())) return name;
  return `${sal} ${name}`.trim();
}

async function resolveQuoteAttentionToFromCustomerMaster(client, { customerId, customerSiteId }) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) return "";
  const siteId = Number(customerSiteId);
  const siteIdOrNull = Number.isFinite(siteId) && siteId > 0 ? siteId : null;

  const r = await client.query(
    `
      select
        cc.salutation,
        cc.full_name,
        cc.site_id,
        cc.is_primary,
        bool_or(ccr.role_key = 'quote_recipient') as is_quote_recipient,
        bool_or(ccr.role_key = 'sales_enquiry') as is_sales_enquiry
      from customer_contacts cc
      left join customer_contact_roles ccr on ccr.customer_contact_id = cc.id
      where cc.customer_id = $1 and cc.is_active = true
      group by cc.id
      order by
        case when $2::int is not null and cc.site_id = $2 then 0 else 1 end asc,
        is_quote_recipient desc,
        is_sales_enquiry desc,
        cc.is_primary desc,
        cc.id asc
      limit 1
    `,
    [cid, siteIdOrNull]
  );
  return formatAttentionToFromContactRow(r.rows[0]);
}

async function getCompanyByCode(client, companyCode) {
  const code = String(companyCode || "").trim().toUpperCase();
  if (!code) return null;
  const r = await client.query(
    `
      select id, company_code, legal_name, coalesce(display_name, legal_name) as display_name
      from companies
      where upper(company_code) = upper($1) and is_active = true
      limit 1
    `,
    [code]
  );
  return r.rows[0] || null;
}

async function getCustomerQuoteSiteOrNull(client, { customerId, customerSiteId }) {
  const siteId = Number(customerSiteId);
  const cid = Number(customerId);
  if (!Number.isFinite(siteId) || siteId <= 0 || !Number.isFinite(cid) || cid <= 0) return null;

  const siteRes = await client.query(
    `
      select
        cs.*,
        ctr.gstin as tax_gstin,
        ctr.registration_name as tax_registration_name
      from customer_sites cs
      left join customer_site_tax_links cstl on cstl.site_id = cs.id
      left join customer_tax_registrations ctr on ctr.id = cstl.tax_registration_id
      where cs.id = $1
        and cs.customer_id = $2
      limit 1
    `,
    [siteId, cid]
  );

  return siteRes.rows[0] || null;
}

async function getDefaultCustomerQuoteSiteOrNull(client, customerId) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) return null;

  const siteRes = await client.query(
    `
      select
        cs.*,
        ctr.gstin as tax_gstin,
        ctr.registration_name as tax_registration_name
      from customer_sites cs
      left join customer_site_tax_links cstl on cstl.site_id = cs.id
      left join customer_tax_registrations ctr on ctr.id = cstl.tax_registration_id
      where cs.customer_id = $1
        and cs.is_active = true
        and cs.can_quote = true
      order by cs.is_default_quote_site desc, cs.site_name asc, cs.id asc
      limit 1
    `,
    [cid]
  );

  return siteRes.rows[0] || null;
}

async function resolveQuoteCustomerSiteId(client, { customerId, customerSiteId }) {
  const explicitSiteId = Number(customerSiteId);
  if (!Number.isFinite(explicitSiteId) || explicitSiteId <= 0) {
    const fallbackSite = await getDefaultCustomerQuoteSiteOrNull(client, customerId);
    return fallbackSite?.id || null;
  }

  const site = await getCustomerQuoteSiteOrNull(client, {
    customerId,
    customerSiteId: explicitSiteId,
  });

  if (!site) {
    const err = new Error("INVALID_CUSTOMER_SITE");
    err.status = 400;
    throw err;
  }
  if (!site.is_active) {
    const err = new Error("CUSTOMER_SITE_INACTIVE");
    err.status = 400;
    throw err;
  }
  if (!site.can_quote) {
    const err = new Error("CUSTOMER_SITE_CANNOT_QUOTE");
    err.status = 400;
    throw err;
  }

  return site.id;
}

async function getLatestRevisionOrNull(client, quoteId, { forUpdate = false } = {}) {
  const suffix = forUpdate ? " for update" : "";
  const revRes = await client.query(
    `
      select
        qr.*,
        (select full_name from erp_users where id = qr.prepared_by) as prepared_by_name,
        (select full_name from erp_users where id = qr.edited_by) as edited_by_name
      from quote_revisions qr
      where qr.quote_id = $1 and qr.is_latest = true
      order by qr.revision_no desc
      limit 1
      ${suffix}
    `,
    [quoteId]
  );
  return revRes.rows[0] || null;
}

async function getRevisionLines(client, revisionId) {
  const linesRes = await client.query(
    `
      select
        l.*,
        p.group_id as product_group_id,
        p.item_code as product_item_code,
        p.item_name as product_item_name,
        p.description as product_description,
        coalesce(p.family_key, pg.default_family_key) as product_family_key,
        coalesce(p.module_role, pg.default_module_role) as product_module_role,
        coalesce(p.variant_key, pg.default_variant_key) as product_variant_key,
        p.item_type as product_item_type,
        p.uom as product_uom,
        pg.group_name as product_group_name,
        pc.category_name as product_category_name
      from quote_lines l
      left join products p on p.id = l.product_id
      left join product_groups pg on pg.id = p.group_id
      left join product_categories pc on pc.id = p.category_id
      where l.quote_revision_id = $1
      order by l.line_no asc
    `,
    [revisionId]
  );
  return linesRes.rows;
}

function getPrimaryScopeGroupIds(lines) {
  const included = (Array.isArray(lines) ? lines : []).filter((l) => String(l?.scope_type || "included") === "included");
  const primary = included.find((l) => Number.isFinite(Number(l?.product_group_id))) || null;
  if (primary) return [Number(primary.product_group_id)];
  const fallback = Array.from(
    new Set(
      (Array.isArray(lines) ? lines : [])
        .map((l) => (l?.product_group_id ? Number(l.product_group_id) : null))
        .filter((x) => Number.isFinite(x))
    )
  );
  return fallback;
}

function buildQuoteIssueReadiness({ quote, revision, lines }) {
  const blockers = [];
  const includedLines = (Array.isArray(lines) ? lines : []).filter((l) => String(l?.scope_type || "included") === "included");

  if (!Number.isFinite(Number(quote?.customer_id))) {
    blockers.push({ key: "customer", label: "Customer is missing." });
  }
  if (!includedLines.length) {
    blockers.push({ key: "items", label: "At least one included Product Master line is required." });
  }
  if (!Number.isFinite(Number(revision?.quote_currency_id))) {
    blockers.push({ key: "quote_currency", label: "Quote currency is not selected." });
  }
  if (!Number.isFinite(Number(revision?.payment_term_id))) {
    blockers.push({ key: "payment_term", label: "Payment term is not selected." });
  }
  if (!quote?.quote_valid_till) {
    blockers.push({ key: "validity", label: "Quote validity date is required before issue." });
  }

  return {
    ok: blockers.length === 0,
    blockers,
  };
}

function buildQuoteListReadiness({ quote, revision, includedLineCount = 0 }) {
  const blockers = [];
  if (!Number.isFinite(Number(quote?.customer_id))) {
    blockers.push({ key: "customer", label: "Customer is missing." });
  }
  if (!Number.isFinite(Number(includedLineCount)) || Number(includedLineCount) <= 0) {
    blockers.push({ key: "items", label: "Add at least one included quoted line." });
  }
  if (!Number.isFinite(Number(revision?.quote_currency_id))) {
    blockers.push({ key: "quote_currency", label: "Select the quote currency." });
  }
  return {
    ok: blockers.length === 0,
    blockers,
  };
}

function getDaysSince(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  const diff = Date.now() - dt.getTime();
  return Math.max(0, Math.floor(diff / 86400000));
}

const QUOTE_DORMANT_DAYS = 30;
const QUOTE_DEEP_DORMANT_DAYS = 90;
const QUOTE_CLOSED_STATUSES = new Set(["converted", "closed", "cancelled", "rejected", "lost", "superseded"]);

/**
 * Visual-only dormancy signal for quote lists: open quotes with no touch for 30+ days,
 * or issued/approved quotes whose validity has lapsed without an order.
 * A future follow-up date suppresses the no-activity flag (the rep has it scheduled).
 */
function classifyQuoteDormancy({ quote, status, staleDays, hasSalesOrder }) {
  const none = { is_dormant: false, dormant_days: null, dormancy_level: null, dormancy_reason: null };
  if (hasSalesOrder || QUOTE_CLOSED_STATUSES.has(status)) return none;

  const validTill = quote?.quote_valid_till ? new Date(quote.quote_valid_till) : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const lapsed =
    status === "lapsed" ||
    status === "expired" ||
    (validTill && !Number.isNaN(validTill.getTime()) && validTill < today && ["issued", "sent", "approved"].includes(status));
  if (lapsed) {
    const lapsedDays =
      validTill && !Number.isNaN(validTill.getTime())
        ? Math.max(0, Math.floor((today.getTime() - validTill.getTime()) / 86400000))
        : staleDays;
    return {
      is_dormant: true,
      dormant_days: lapsedDays,
      dormancy_level: "expired",
      dormancy_reason:
        lapsedDays !== null
          ? `Validity lapsed ${lapsedDays} day${lapsedDays === 1 ? "" : "s"} ago without a sales order`
          : "Validity lapsed without a sales order",
    };
  }

  const followUp = quote?.next_follow_up_at ? new Date(quote.next_follow_up_at) : null;
  if (followUp && !Number.isNaN(followUp.getTime()) && followUp >= today) return none;
  if (staleDays === null || staleDays < QUOTE_DORMANT_DAYS) return none;
  return {
    is_dormant: true,
    dormant_days: staleDays,
    dormancy_level: staleDays >= QUOTE_DEEP_DORMANT_DAYS ? "deep" : "dormant",
    dormancy_reason: `No activity for ${staleDays} days`,
  };
}

function buildQuoteInteractionMetadata({
  quote,
  revision,
  includedLineCount = 0,
  hasSalesOrder = false,
  customerOverdueAmount = 0,
}) {
  const headerStatus = String(quote?.quote_status || "").trim().toLowerCase();
  const status = QUOTE_CLOSED_STATUSES.has(headerStatus) || headerStatus === "lapsed"
    ? headerStatus
    : String(revision?.revision_status || quote?.quote_status || "draft")
        .trim()
        .toLowerCase();
  const staleDays = getDaysSince(quote?.updated_at || quote?.created_at || revision?.issued_at || revision?.prepared_at);
  const readiness = buildQuoteListReadiness({ quote, revision, includedLineCount });
  const overdueAmount = Number(customerOverdueAmount || 0);
  const hasCustomerOverdue = overdueAmount > 0.009;

  let pendingReason = "Review the quote and take the next commercial step.";
  let recommendedAction = "open_quote";
  let recommendedActionLabel = "Open quote";
  let attentionLevel = "low";

  if (status === "pending_approval") {
    pendingReason = "Waiting for approval before the sales user can issue or send it.";
    recommendedAction = "review_approval";
    recommendedActionLabel = "Review approval";
    attentionLevel = "high";
  } else if ((status === "issued" || status === "sent") && !hasSalesOrder) {
    pendingReason = "Issued quote is waiting for sales order conversion.";
    recommendedAction = "convert_to_so";
    recommendedActionLabel = "Convert to SO";
    attentionLevel = "high";
  } else if (status === "approved" && !hasSalesOrder) {
    pendingReason = "Approved quote should be issued before order conversion.";
    recommendedAction = "issue_quote";
    recommendedActionLabel = "Issue PDF";
    attentionLevel = "high";
  } else if (status === "draft" && !readiness.ok) {
    pendingReason = readiness.blockers[0]?.label || "Complete the draft before moving ahead.";
    recommendedAction = "complete_quote";
    recommendedActionLabel = "Complete quote";
    attentionLevel = "high";
  } else if (status === "draft") {
    pendingReason =
      staleDays !== null && staleDays >= 3
        ? `Draft is waiting for commercial review for ${staleDays} day${staleDays === 1 ? "" : "s"}.`
        : "Draft quote is ready for the next commercial review.";
    recommendedAction = "request_approval";
    recommendedActionLabel = "Send for approval";
    attentionLevel = staleDays !== null && staleDays >= 3 ? "medium" : "low";
  } else if (hasSalesOrder || status === "converted") {
    pendingReason = "Sales order already exists for this quote.";
    recommendedAction = "open_quote";
    recommendedActionLabel = "Open quote";
    attentionLevel = "low";
  }

  if (recommendedAction === "open_quote" && hasCustomerOverdue && (status === "issued" || status === "sent")) {
    recommendedAction = "follow_up_customer";
    recommendedActionLabel = "Follow up";
    pendingReason = "Customer has overdue invoices before the next sales step.";
    attentionLevel = "medium";
  }

  const dormancy = classifyQuoteDormancy({ quote, status, staleDays, hasSalesOrder });

  return {
    stale_days: staleDays,
    ...dormancy,
    pending_reason: pendingReason,
    recommended_action: recommendedAction,
    recommended_action_label: recommendedActionLabel,
    attention_level: attentionLevel,
    is_issue_ready: readiness.ok,
    is_convertible: (status === "issued" || status === "sent") && !hasSalesOrder,
    can_request_approval: status === "draft" && readiness.ok,
    can_close: !["closed", "cancelled", "converted"].includes(status) && !hasSalesOrder,
    customer_overdue_amount: Number.isFinite(overdueAmount) ? overdueAmount : 0,
    has_customer_overdue: hasCustomerOverdue,
  };
}

async function resolveQuotePresentationContext(client, { quote, revisionId, lines = null }) {
  const effectiveRevisionId = Number(revisionId);
  const effectiveLines =
    Array.isArray(lines) && lines.length
      ? lines
      : Number.isFinite(effectiveRevisionId) && effectiveRevisionId > 0
        ? await getRevisionLines(client, effectiveRevisionId)
        : [];

  const policy = resolveQuotePresentationPolicy({ quote, lines: effectiveLines });
  const fallbackCompanyCode = String(quote?.company_code || "").trim().toUpperCase();
  const requestedCompanyCode = String(policy.presentation_company_code || fallbackCompanyCode || "AI").trim().toUpperCase();
  const companyRow = await getCompanyByCode(client, requestedCompanyCode);
  const presentationCompanyId = Number(companyRow?.id) || Number(quote?.company_id) || null;
  const companyProfile = enrichCompanyProfileAssets(await getCompanyProfile(client, presentationCompanyId));
  const letterheadPath =
    (Number.isFinite(effectiveRevisionId) && effectiveRevisionId > 0
      ? await getRevisionTemplatePath(client, effectiveRevisionId, "letterhead")
      : null) ||
    (presentationCompanyId ? await getCompanyTemplateOverridePath(client, presentationCompanyId, "QUOTE_LETTERHEAD") : null) ||
    (quote?.distributor_id ? await getDistributorLetterheadPath(client, quote.distributor_id) : null) ||
    (await getTemplatePathByKey(client, "QUOTE_LETTERHEAD"));

  return {
    ...policy,
    presentation_company_id: presentationCompanyId,
    presentation_company_code: String(companyRow?.company_code || fallbackCompanyCode || requestedCompanyCode || "").trim().toUpperCase(),
    presentation_company_name: companyRow?.display_name || companyRow?.legal_name || companyProfile?.company_name || "",
    company_profile: companyProfile,
    letterhead_path: letterheadPath,
  };
}

function normalizeDepartmentKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function canEngineeringEditSummaries(user) {
  if (!user) return false;
  if (user.group_name === "SuperAdmin") return true;
  return normalizeDepartmentKey(user.department_key) === "engineering";
}

async function quoteRevisionSummariesReady(client) {
  const r = await client.query(`select to_regclass('public.quote_revision_summaries') is not null as ready`);
  return r.rows[0]?.ready === true;
}

function buildSummarySeedFromLines({ quote, revision, lines }) {
  const deliverables = (Array.isArray(lines) ? lines : [])
    .filter((l) => String(l?.scope_type || "included") === "included")
    .map((l) => ({
      model: String(l?.item_name || l?.product_item_name || l?.item_code || l?.product_item_code || "").trim(),
      item_code: String(l?.item_code || l?.product_item_code || "").trim(),
      description: String(l?.product_description || "").trim(),
      qty: Number(l?.qty || 0) || 0,
      remarks: "",
    }))
    .filter((row) => row.model && row.qty > 0);

  const currency = String(revision?.quote_currency_id || "").trim();
  const subtotal = Number(revision?.subtotal_quote || 0);
  const highlights = [
    quote?.quote_number ? `Quote: ${quote.quote_number}` : "",
    Number.isFinite(subtotal) && subtotal > 0 ? `Subtotal (excl. GST): ${subtotal.toFixed(2)}` : "",
    deliverables.length ? `Deliverables: ${deliverables.length} line items` : "",
  ].filter(Boolean);
  const configuratorSummary = summarizeQuoteConfiguratorContext(lines);
  const presentation = resolveQuotePresentationPolicy({ quote, lines });
  const primaryFamilyRule = getProductFamilyRule(configuratorSummary.primary_family_key);
  const primaryClassifiedLine = (configuratorSummary.classified_lines || []).find(
    (row) => row.family_key === configuratorSummary.primary_family_key
  );

  return {
    executive_summary: {
      problem: "",
      solution: "",
      highlights,
      note: "",
      currency,
    },
    scope_summary: {
      deliverables,
      tech_highlights: [],
      exclusions: [],
      assumptions: [],
      acceptance: [],
      responsibilities: [],
    },
    configurator_context: {
      source: configuratorSummary.primary_family_key ? "derived_from_lines" : "none",
      family_key: configuratorSummary.primary_family_key || null,
      family_name: configuratorSummary.primary_family_name || null,
      variant_key: primaryClassifiedLine?.variant_key || null,
      selected_model:
        String(
          primaryClassifiedLine?.line?.item_name ||
            primaryClassifiedLine?.line?.product_item_name ||
            primaryClassifiedLine?.line?.item_code ||
            primaryClassifiedLine?.line?.product_item_code ||
            ""
        ).trim() || null,
      proposal_profile_key: primaryFamilyRule?.proposal_profile_key || null,
      presentation_company_code: presentation.presentation_company_code || null,
      configurator_quote_mode: presentation.default_quote_mode || null,
      route_reason: presentation.route_reason || "",
      family_keys: Array.isArray(configuratorSummary.family_keys) ? configuratorSummary.family_keys : [],
      mixed_branding_risk: presentation.mixed_branding_risk === true,
      recommended_split_quote: presentation.recommended_split_quote === true,
    },
  };
}

async function getOrCreateRevisionSummary(client, { quote, revision, lines, actorUserId }) {
  const ready = await quoteRevisionSummariesReady(client).catch(() => false);
  const seed = buildSummarySeedFromLines({ quote, revision, lines });
  if (!ready) return { ...seed, is_locked: false, locked_at: null, locked_by: null };

  const existing = await client.query(
    `
      select executive_summary, scope_summary, configurator_context, is_locked, locked_at, locked_by
      from quote_revision_summaries
      where quote_revision_id = $1
      limit 1
    `,
    [revision.id]
  );
  const row = existing.rows[0] || null;
  if (row) {
    return {
      executive_summary: row.executive_summary || seed.executive_summary,
      scope_summary: row.scope_summary || seed.scope_summary,
        configurator_context: row.configurator_context || seed.configurator_context,
      is_locked: row.is_locked === true,
      locked_at: row.locked_at || null,
      locked_by: row.locked_by || null,
    };
  }

  await client.query(
    `
      insert into quote_revision_summaries (quote_revision_id, executive_summary, scope_summary, configurator_context, updated_by, updated_at)
      values ($1,$2,$3,$4,$5,now())
      on conflict (quote_revision_id) do nothing
    `,
    [revision.id, seed.executive_summary, seed.scope_summary, seed.configurator_context, actorUserId || null]
  );
  return { ...seed, is_locked: false, locked_at: null, locked_by: null };
}

function buildEffectiveConfiguratorContext({ summary, presentation }) {
  const saved = summary?.configurator_context && typeof summary.configurator_context === "object" ? summary.configurator_context : {};
  const fallback = presentation && typeof presentation === "object" ? presentation : {};
  const familyKey = saved.family_key || fallback.primary_family_key || null;
  const familyRule = getProductFamilyRule(familyKey);
  return {
    source: saved.source || (familyKey ? "saved_or_derived" : "none"),
    family_key: familyKey,
    family_name: saved.family_name || saved.family_label || familyRule?.family_name || fallback.primary_family_name || null,
    family_title: saved.family_title || familyRule?.positioning || null,
    proposal_profile_key: saved.proposal_profile_key || familyRule?.proposal_profile_key || null,
    variant_key: saved.variant_key || null,
    variant_label: saved.variant_label || saved.variant_key || null,
    variant_story: saved.variant_story || "",
    selected_model: saved.selected_model || null,
    package_mode: saved.package_mode || "",
    presentation_company_code:
      String(saved.presentation_company_code || fallback.presentation_company_code || "").trim().toUpperCase() || null,
    configurator_quote_mode: saved.configurator_quote_mode || fallback.default_quote_mode || null,
    route_reason: saved.route_reason || fallback.route_reason || "",
    family_keys: Array.isArray(saved.family_keys) && saved.family_keys.length ? saved.family_keys : fallback.family_keys || [],
    mixed_branding_risk: saved.mixed_branding_risk === true || fallback.mixed_branding_risk === true,
    recommended_split_quote: saved.recommended_split_quote === true || fallback.recommended_split_quote === true,
    proof_points: Array.isArray(saved.proof_points) ? saved.proof_points : [],
    warnings: Array.isArray(saved.warnings) ? saved.warnings : [],
    preview_problem: saved.preview_problem || "",
    preview_solution: saved.preview_solution || "",
    preview_deliverable_count: Number(saved.preview_deliverable_count || 0) || 0,
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeEmailAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function splitEmailList(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const seen = new Set();
  const out = [];
  for (const part of raw.split(/[;,]+/)) {
    const email = normalizeEmailAddress(part);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function joinEmailList(value) {
  return splitEmailList(value).join(", ");
}

function mergeEmailLists(list, extra) {
  return splitEmailList([...(Array.isArray(list) ? list : []), ...(Array.isArray(extra) ? extra : [])]);
}

function textToHtml(text) {
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; color: #1f2937; white-space: pre-wrap;">${escapeHtml(
    text || ""
  ).replaceAll("\n", "<br/>")}</div>`;
}

function getAppBaseUrl() {
  return String(process.env.APP_BASE_URL || "http://localhost:5173").trim().replace(/\/+$/, "");
}

function buildQuoteMailTrackingToken() {
  return crypto.randomBytes(24).toString("hex");
}

function buildQuoteMailTrackingUrl(token) {
  const key = String(token || "").trim();
  if (!key) return "";
  return `${getAppBaseUrl()}/quotes/mail/open/${encodeURIComponent(key)}`;
}

function formatMailInline(value) {
  const escaped = escapeHtml(value || "");
  return escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function buildMailUspItems(configuratorContext) {
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const familyKey = String(cfg.family_key || "").trim().toUpperCase();
  const variantKey = String(cfg.variant_key || "").trim().toUpperCase();
  const rule = getProductFamilyRule(familyKey);
  const points = Array.isArray(rule?.proposal_blocks?.proof_points) ? rule.proposal_blocks.proof_points : [];

  function copy(pointKey) {
    if (familyKey === "NGEN") {
      if (pointKey === "purity_stability") {
        return "**Uncompromising purity stability** precisely tuned for rigorous industrial duty cycles and consistent high-purity output";
      }
      if (pointKey === "automation") {
        return "**IIoT-ready with live reporting** through advanced automation controls that give your team real-time operating visibility";
      }
      if (pointKey === "industrial_reliability") {
        return "**Long-term industrial reliability** backed by service discipline, robust spares support, and a 10-year molecular sieve warranty";
      }
    }
    if (familyKey === "NGENX") {
      if (pointKey === "footprint") return "**Compact footprint** for faster on-site deployment";
      if (pointKey === "ease_of_use") return "**Simple daily operation** with clean controller workflows";
      if (pointKey === "value_positioning") return "**Value-led scope** with the essentials done right";
    }
    if (familyKey === "IDOS" || familyKey === "IDOS_C") {
      if (pointKey === "process_continuity") return "**Process continuity** with dependable oxygen availability";
      if (pointKey === "oxygen_availability") return "**Availability planning** aligned to plant duty cycles";
      if (pointKey === "industrial_safety") return "**Monitoring-first safety** with clear control and alarms";
      if (pointKey === "compactness") return "**Footprint-aware package** for constrained plant layouts";
      if (pointKey === "faster_installation") return "**Cleaner installation** with simplified interfaces";
      if (pointKey === "value_positioning") return "**Commercial clarity** with a stable, scope-locked offer";
    }
    if (familyKey === "MEDO" || familyKey === "MEDO_C") {
      if (pointKey === "healthcare_positioning") return "**Healthcare-ready delivery** with documentation discipline";
      if (pointKey === "continuity_of_supply") return "**Continuity of supply** positioned for hospital uptime";
      if (pointKey === "operator_simplicity") return "**Simple daily handling** for operator confidence";
      if (pointKey === "compactness") return "**Compact deployment** for space-aware layouts";
      if (pointKey === "faster_installation") return "**Faster commissioning** with cleaner readiness";
      if (pointKey === "value_positioning") return "**Compliance-first scope** without commercial clutter";
    }
    if (familyKey === "NGEN" && variantKey === "UH" && pointKey === "purity_stability") {
      return "**Purity assurance** positioned for ultra-high purity demand";
    }
    if (familyKey === "NGEN" && variantKey === "HF" && pointKey === "industrial_reliability") {
      return "**High-flow duty** aligned to throughput and reliability expectations";
    }
    return "";
  }

  return points
    .map((key) => copy(key))
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

function renderMailBodyHtml(bodyText) {
  const blocks = String(bodyText || "")
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      const looksLikeList = lines.length > 1 && lines.every((line) => /^(-|\u2022)\s+/.test(line));
      if (looksLikeList) {
        return `<ul style="margin:0 0 14px 18px; padding:0; font-size:14px; line-height:1.75; color:#222;">${lines
          .map((line) => line.replace(/^(-|\u2022)\s+/, ""))
          .map((item) => `<li style="margin:0 0 8px;">${formatMailInline(item)}</li>`)
          .join("")}</ul>`;
      }
      return `<p style="margin:0 0 14px; font-size:14px; line-height:1.75; color:#222;">${formatMailInline(block).replaceAll("\n", "<br/>")}</p>`;
    })
    .join("");
}

function buildQuoteMailHtml({ bodyText, sender, companyProfile, quote, groupNames, configuratorContext, trackingUrl }) {
  const bodyBlocks = renderMailBodyHtml(bodyText);
  const uspItems = buildMailUspItems(configuratorContext);
  const groupLabel = Array.isArray(groupNames) && groupNames.length ? groupNames.join(", ") : "";
  const quoteNumber = String(quote?.quote_number || "").trim();
  const headline = quoteNumber ? `${quoteNumber}${groupLabel ? ` • ${groupLabel}` : ""}` : groupLabel;

  const logoUrl = `${getAppBaseUrl()}/absstem_logo.svg`;
  const senderName = escapeHtml(sender?.full_name || "Sales Team");
  const senderDesignation = escapeHtml(sender?.designation || "");
  const senderPhone = escapeHtml(sender?.phone || companyProfile?.contact_phone || "");
  const senderEmail = escapeHtml(sender?.email || companyProfile?.contact_email || "");
  const customSignatureLines = String(sender?.email_signature || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
  const companyName = escapeHtml(companyProfile?.company_name || "Absstem Industrial Solutions Pvt. Ltd.");
  const websiteUrl = normalizeWebsiteUrl(companyProfile?.website || "") || "https://www.absstem.com";
  const websiteLabel = escapeHtml((companyProfile?.website || websiteUrl).replace(/^https?:\/\//i, ""));
  const logoSrc = companyProfile?.logo_file_name ? "cid:company-logo" : `${getAppBaseUrl()}/absstem_logo.svg`;
  const signatureHtml = companyProfile?.signature_file_name
    ? `<div style="margin:10px 0 8px;"><img src="cid:company-signature" alt="Authorised Signature" style="display:block; max-width:180px; max-height:70px;" /></div>`
    : "";
  const trackingPixelHtml = trackingUrl
    ? `<img src="${escapeHtml(trackingUrl)}" alt="" width="1" height="1" style="display:block; width:1px; height:1px; border:0; opacity:0; overflow:hidden;" />`
    : "";
  const uspRowsHtml = uspItems
    .map((item) => {
      const raw = String(item || "").trim();
      const match = raw.match(/^\*\*(.+?)\*\*\s*(.*)$/);
      const title = match ? match[1] : raw;
      const detail = match ? match[2] : "";
      return `
        <tr>
          <td style="vertical-align:top; padding:0 10px 10px 0;">
            <div style="width:22px; height:22px; border-radius:999px; background:#e8f1ff; color:#2354d5; font-size:14px; font-weight:900; line-height:22px; text-align:center;">✓</div>
          </td>
          <td style="vertical-align:top; padding:1px 0 10px;">
            <div style="font-size:14px; line-height:1.55; color:#0f172a;">
              <strong>${escapeHtml(title)}</strong>${detail ? `<span style="color:#334155;"> ${escapeHtml(detail)}</span>` : ""}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; background:#ffffff; color:#111827; max-width:760px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e5e7eb;">
        <tr>
          <td style="padding:20px 18px 14px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:132px; vertical-align:middle;">
                  <img src="${companyProfile?.logo_file_name ? logoSrc : logoUrl}" alt="Company Logo" style="display:block; width:118px; height:auto;" />
                </td>
                <td style="vertical-align:middle;">
                  ${headline ? `<div style="font-size:18px; font-weight:800; letter-spacing:0.2px; color:#0f172a;">${escapeHtml(headline)}</div>` : ""}
                  <div style="margin-top:6px; font-size:13px; color:#475569;">Commercial quotation enclosed for your review and next-step discussion.</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      ${uspItems.length ? `<div style="padding:16px 18px 6px;">
        <div style="border:1px solid #dbe6f4; background:linear-gradient(180deg,#ffffff 0%,#f6f9ff 100%); border-radius:14px; padding:14px 14px 2px;">
          <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.12em; font-weight:900; color:#2354d5;">Why This Proposal Stands Out</div>
          <div style="margin-top:10px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${uspRowsHtml}
            </table>
          </div>
        </div>
      </div>` : ""}

      <div style="padding:8px 18px 0; font-size:14px; line-height:1.7;">
        ${bodyBlocks}
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px; border-top:1px solid #d9dee8;">
        <tr>
          <td style="padding:18px 18px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:132px; vertical-align:top; padding-top:2px;">
                  <img src="${companyProfile?.logo_file_name ? logoSrc : logoUrl}" alt="Company Logo" style="display:block; width:120px; height:auto;" />
                </td>
                <td style="vertical-align:top;">
                  <div style="font-size:13px; color:#5b6472; margin-bottom:8px;">For ${companyName}</div>
                  ${signatureHtml}
                  ${customSignatureLines.length
                    ? `<div style="font-size:18px; font-weight:800; color:#161b22;">${escapeHtml(customSignatureLines[0])}</div>
                  <div style="font-size:13px; color:#4b5563; margin-top:6px; line-height:1.7;">
                    ${customSignatureLines.slice(1).map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
                    <div><a href="${escapeHtml(websiteUrl)}" style="color:#0f4aa1; text-decoration:none;">${websiteLabel}</a></div>
                  </div>`
                    : `<div style="font-size:18px; font-weight:800; color:#161b22;">${senderName}</div>
                  ${senderDesignation ? `<div style="font-size:14px; color:#374151; margin-top:4px;">${senderDesignation}</div>` : ""}
                  <div style="font-size:13px; color:#4b5563; margin-top:8px; line-height:1.7;">
                    ${senderPhone ? `<div>${senderPhone}</div>` : ""}
                    ${senderEmail ? `<div><a href="mailto:${senderEmail}" style="color:#0f4aa1; text-decoration:none;">${senderEmail}</a></div>` : ""}
                    <div><a href="${escapeHtml(websiteUrl)}" style="color:#0f4aa1; text-decoration:none;">${websiteLabel}</a></div>
                  </div>`}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
      ${trackingPixelHtml}
    </div>
  `;
}

async function getUserMailProfile(client, userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return null;
  const r = await client.query(
    `
      select
        id,
        full_name,
        email,
        designation,
        phone,
        email_signature,
        primary_manager_user_id,
        secondary_manager_user_id
      from erp_users
      where id = $1
      limit 1
    `,
    [id]
  );
  return r.rows[0] || null;
}

async function getQuoteGroupNames(client, revisionId) {
  const r = await client.query(
    `
      select distinct pg.group_name
      from quote_lines l
      join products p on p.id = l.product_id
      join product_groups pg on pg.id = p.group_id
      where l.quote_revision_id = $1
        and pg.group_name is not null
        and length(trim(pg.group_name)) > 0
      order by pg.group_name asc
    `,
    [revisionId]
  );
  return r.rows.map((row) => row.group_name).filter((v) => typeof v === "string" && v.trim().length);
}

async function resolveQuoteMailCcUsers(client, userId) {
  const sender = await getUserMailProfile(client, userId);
  if (!sender) return [];

  const seenIds = new Set([Number(sender.id)]);
  const ccUsers = [];

  async function pushUser(nextUserId) {
    const id = Number(nextUserId);
    if (!Number.isFinite(id) || seenIds.has(id)) return null;
    seenIds.add(id);
    const user = await getUserMailProfile(client, id);
    if (user && user.email) ccUsers.push(user);
    return user;
  }

  const primaryManager = await pushUser(sender.primary_manager_user_id);
  if (primaryManager) {
    await pushUser(primaryManager.primary_manager_user_id);
  }
  if (ccUsers.length < 2) {
    await pushUser(sender.secondary_manager_user_id);
  }

  return ccUsers;
}

function buildQuoteMailSubject(quoteNumber, groupNames) {
  const base = String(quoteNumber || "").trim() || "Quote";
  const groups = Array.isArray(groupNames)
    ? groupNames.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  return groups.length ? `${base} Proposal for ${groups.join(", ")}` : `${base} Proposal`;
}

function buildQuoteMailSignature(sender) {
  return [sender?.full_name || "", sender?.designation || "", sender?.phone || "", sender?.email || ""].filter(Boolean);
}

function buildQuoteMailGreeting(quote) {
  return `Dear ${quote.attention_to || quote.customer_name || "Team"},`;
}

function buildQuoteMailIntro({ quote, groupNames, configuratorContext, fallback }) {
  const groupText = Array.isArray(groupNames) && groupNames.length ? ` for ${groupNames.join(", ")}` : "";
  const defaultLine = String(fallback || `Please find attached our commercial proposal ${quote.quote_number}${groupText}.`).trim();
  return buildConfiguratorCoverIntro(configuratorContext) || defaultLine;
}

function buildQuoteMailBody({ quote, sender, groupNames, configuratorContext }) {
  const signature = buildQuoteMailSignature(sender);
  const intro = buildQuoteMailIntro({
    quote,
    groupNames,
    configuratorContext,
    fallback: `Please find attached our commercial proposal ${quote.quote_number}${
      Array.isArray(groupNames) && groupNames.length ? ` for ${groupNames.join(", ")}` : ""
    }.`,
  });
  const familyKey = String(configuratorContext?.family_key || "").trim().toUpperCase();

  return [
    buildQuoteMailGreeting(quote),
    "",
    `Please find enclosed our commercial proposal [${quote.quote_number}]${
      Array.isArray(groupNames) && groupNames.length ? ` for ${groupNames.join(", ")}` : ""
    }.`,
    "",
    familyKey === "NGEN"
      ? "We are pleased to submit this premium nitrogen solution. Because we specialize exclusively in industrial PSA manufacturing, this system is engineered specifically for dependable, heavy-duty industrial performance without the compromises of generalized equipment."
      : intro,
    "The quotation is structured to help your team review the solution fit, proposed scope, and commercial terms in a single pass.",
    "If any operating conditions, inclusions, exclusions, or delivery assumptions require adjustment, please let us know. We can promptly revise the offer to ensure alignment with your requirement.",
    "I look forward to discussing the next steps with you.",
    "",
    "Regards,",
    ...signature,
  ].join("\n");
}

function buildExecutiveCleanMailBody({ quote, sender, groupNames, configuratorContext }) {
  const signature = buildQuoteMailSignature(sender);
  const intro = buildQuoteMailIntro({
    quote,
    groupNames,
    configuratorContext,
    fallback: `Please find attached our proposal ${quote.quote_number}.`,
  });
  const familyKey = String(configuratorContext?.family_key || "").trim().toUpperCase();

  return [
    buildQuoteMailGreeting(quote),
    "",
    `Please find enclosed our commercial proposal [${quote.quote_number}] for your review.`,
    "",
    familyKey === "NGEN"
      ? "We are pleased to submit this premium nitrogen solution, engineered for dependable industrial performance and long-term operating confidence."
      : intro,
    "The quotation presents solution scope and commercials in a clean review format.",
    "Please share any comments or revision points and we will respond promptly.",
    "",
    "Regards,",
    ...signature,
  ].join("\n");
}

function buildTechnicalBalancedMailBody({ quote, sender, groupNames, configuratorContext }) {
  const salutationName = quote.attention_to || quote.customer_name || "Team";
  const signature = buildQuoteMailSignature(sender);
  const intro = buildQuoteMailIntro({
    quote,
    groupNames,
    configuratorContext,
    fallback: `Please find attached our quotation ${quote.quote_number} for your technical and commercial review.`,
  });
  const familyKey = String(configuratorContext?.family_key || "").trim().toUpperCase();

  return [
    `Dear ${salutationName},`,
    "",
    `Please find enclosed our commercial proposal [${quote.quote_number}]${
      Array.isArray(groupNames) && groupNames.length ? ` for ${groupNames.join(", ")}` : ""
    }.`,
    "",
    familyKey === "NGEN"
      ? "We are pleased to submit this nitrogen solution for your review. As an industrial PSA-focused manufacturer, we have positioned this offer around dependable purity, controls visibility, and long-term operating reliability."
      : intro,
    "The quotation is structured to help your team evaluate solution fit, proposed scope, and commercial terms in one pass.",
    "If any operating conditions, inclusions, exclusions, or delivery assumptions require adjustment, we can revise the offer quickly.",
    "",
    "Regards,",
    ...signature,
  ].join("\n");
}

function buildUltraShortMailBody({ quote, sender, groupNames, configuratorContext }) {
  const signature = buildQuoteMailSignature(sender);
  const familyKey = String(configuratorContext?.family_key || "").trim().toUpperCase();
  const groupText = Array.isArray(groupNames) && groupNames.length ? ` for ${groupNames.join(", ")}` : "";
  return [
    buildQuoteMailGreeting(quote),
    "",
    `Please find enclosed our commercial proposal [${quote.quote_number}]${groupText} for your review.`,
    familyKey === "NGEN"
      ? "The offer covers our premium nitrogen solution for dependable industrial duty."
      : "Please let us know if any clarification or revision is required.",
    familyKey === "NGEN" ? "Please let us know if any clarification or revision is required." : "",
    "",
    "Regards,",
    ...signature,
  ].filter(Boolean).join("\n");
}

function buildSparesMailPresets({ quote, sender }) {
  const signature = buildQuoteMailSignature(sender);
  const subject = `${String(quote.quote_number || "").trim() || "Quote"} Quotation for Spares & Consumables`;
  return [
    {
      key: "spares_standard",
      label: "Spares Standard",
      description: "Spares offer note with part verification and PI-based ordering.",
      subject,
      body: [
        buildQuoteMailGreeting(quote),
        "",
        `Please find enclosed our quotation [${quote.quote_number}] for genuine spares and consumables.`,
        "",
        "The schedule lists part numbers, quantities and unit rates. Kindly verify the part numbers against your installed equipment before confirming the order.",
        "On receipt of your purchase order we will raise a Proforma Invoice; ready-stock items are dispatched promptly against advance payment.",
        "",
        "Regards,",
        ...signature,
      ].join("\n"),
    },
    {
      key: "spares_short",
      label: "Ultra Short",
      description: "Minimal dispatch note for repeat spares orders.",
      subject,
      body: [
        buildQuoteMailGreeting(quote),
        "",
        `Please find enclosed our spares quotation [${quote.quote_number}] for your review.`,
        "Please let us know if any clarification is required.",
        "",
        "Regards,",
        ...signature,
      ].join("\n"),
    },
  ];
}

function buildQuoteMailPresets({ quote, sender, groupNames, configuratorContext, offerType }) {
  if (offerType === "spares") return buildSparesMailPresets({ quote, sender });
  const subject = buildQuoteMailSubject(quote.quote_number, groupNames);
  return [
    {
      key: "sales_persuasive",
      label: "Sales Persuasive",
      description: "Benefit-led commercial note for customer-facing proposal delivery.",
      subject,
      body: buildQuoteMailBody({ quote, sender, groupNames, configuratorContext }),
    },
    {
      key: "executive_clean",
      label: "Executive Clean",
      description: "Short, premium, formal mail for quick executive review.",
      subject,
      body: buildExecutiveCleanMailBody({ quote, sender, groupNames, configuratorContext }),
    },
    {
      key: "technical_balanced",
      label: "Technical Balanced",
      description: "Professional note with stronger scope and review clarity.",
      subject,
      body: buildTechnicalBalancedMailBody({ quote, sender, groupNames, configuratorContext }),
    },
    {
      key: "ultra_short",
      label: "Ultra Short",
      description: "Minimal dispatch note with direct review request.",
      subject,
      body: buildUltraShortMailBody({ quote, sender, groupNames, configuratorContext }),
    },
  ];
}

function buildConfiguratorCoverIntro(configuratorContext) {
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const familyKey = String(cfg.family_key || "").trim().toUpperCase();
  const variantKey = String(cfg.variant_key || "").trim().toUpperCase();
  const modelText = String(cfg.selected_model || "").trim();
  const modelSuffix = modelText ? ` based on ${modelText}` : "";

  if (familyKey === "MEDO") {
    return `We are pleased to submit our proposal for a medical oxygen solution${modelSuffix}, designed to support healthcare continuity of supply and dependable day-to-day operation.`;
  }
  if (familyKey === "MEDO_C") {
    return `We are pleased to submit our proposal for a compact medical oxygen solution${modelSuffix}, designed for space-aware healthcare deployment while preserving continuity of supply.`;
  }
  if (familyKey === "IDOS") {
    return `We are pleased to submit our proposal for an industrial oxygen solution${modelSuffix}, designed to support dependable process oxygen availability for plant operations.`;
  }
  if (familyKey === "IDOS_C") {
    return `We are pleased to submit our proposal for a compact industrial oxygen solution${modelSuffix}, designed for footprint-aware deployment and dependable process use.`;
  }
  if (familyKey === "NGENX") {
    return `We are pleased to submit our proposal for a compact nitrogen solution${modelSuffix}, designed for cleaner deployment, practical adoption, and value-focused operation.`;
  }
  if (familyKey === "NGEN" && variantKey === "UH") {
    return `We are pleased to submit our proposal for a purity-led nitrogen solution${modelSuffix}, designed for quality-sensitive applications with stronger performance expectations.`;
  }
  if (familyKey === "NGEN" && variantKey === "HF") {
    return `We are pleased to submit our proposal for a high-flow nitrogen solution${modelSuffix}, designed for stronger throughput requirements and dependable industrial duty.`;
  }
  if (familyKey === "NGEN") {
    return `We are pleased to submit our proposal for a premium nitrogen solution${modelSuffix}, designed for dependable industrial performance, controls, and reliability.`;
  }
  return "";
}

function injectConfiguratorCoverTone(baseText, configuratorContext) {
  const intro = buildConfiguratorCoverIntro(configuratorContext);
  const trimmedBase = String(baseText || "").trim();
  if (!intro) return trimmedBase;
  if (!trimmedBase) return intro;
  if (trimmedBase.toLowerCase().includes(intro.toLowerCase())) return trimmedBase;
  const blocks = trimmedBase.split(/\n\s*\n/g).map((block) => block.trim()).filter(Boolean);
  if (!blocks.length) return intro;
  if (/^dear\b/i.test(blocks[0])) {
    return [blocks[0], intro, ...blocks.slice(1)].join("\n\n");
  }
  return [intro, ...blocks].join("\n\n");
}

function applyTemplateVars(text, vars) {
  const raw = String(text || "");
  const map = vars && typeof vars === "object" ? vars : {};
  let out = raw;
  for (const [key, value] of Object.entries(map)) {
    const v = String(value ?? "");
    out = out
      .replaceAll(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi"), v)
      .replaceAll(new RegExp(`\\$\\{\\s*${key}\\s*\\}`, "gi"), v)
      .replaceAll(new RegExp(`\\[\\[\\s*${key}\\s*\\]\\]`, "gi"), v);
  }
  return out;
}

function buildCoverLetterMailBody({ quote, sender, groupNames, coverLetterText, companyProfile, configuratorContext }) {
  const groupText = Array.isArray(groupNames) && groupNames.length ? groupNames.join(", ") : "";
  const vars = {
    attention_to: quote?.attention_to || "",
    customer_name: quote?.customer_name || "",
    quote_number: quote?.quote_number || "",
    group_names: groupText,
    sender_name: sender?.full_name || "",
    sender_designation: sender?.designation || "",
    sender_phone: sender?.phone || "",
    sender_email: sender?.email || "",
    company_name: companyProfile?.company_name || "",
    company_website: companyProfile?.website || "",
    company_contact_email: companyProfile?.contact_email || "",
    company_contact_phone: companyProfile?.contact_phone || "",
  };

  const baseText =
    typeof coverLetterText === "string" && coverLetterText.trim().length
      ? applyTemplateVars(coverLetterText, vars)
      : "";

  const trimmed = injectConfiguratorCoverTone(baseText.trim(), configuratorContext);
  if (trimmed) {
    return trimmed;
  }

  return injectConfiguratorCoverTone(buildQuoteMailBody({ quote, sender, groupNames, configuratorContext }), configuratorContext);
}

async function getQuoteMailHistory(client, revisionId) {
  const r = await client.query(
    `
      select
        qml.id,
        qml.mail_mode,
        qml.recipient_to,
        qml.recipient_cc,
        qml.recipient_bcc,
        qml.subject,
        qml.body_text,
        qml.smtp_message_id,
        qml.send_status,
        qml.error_text,
        qml.sender_source,
        qml.sender_email,
        qml.opened_at,
        qml.last_opened_at,
        qml.open_count,
        qml.sent_at,
        qml.attachment_id,
        qml.attachments_json,
        qml.attachments_total_bytes,
        qr.revision_no,
        (sa.owner_type = 'quote_sent_pdf') as has_sent_pdf,
        eu.full_name as sent_by_name,
        eu.email as sent_by_email,
        qml.on_behalf_of_user_id,
        obu.full_name as on_behalf_of_name
      from quote_mail_logs qml
      join quote_revisions qr on qr.id = qml.quote_revision_id
      left join attachments sa on sa.id = qml.attachment_id
      left join erp_users eu on eu.id = qml.sent_by
      left join erp_users obu on obu.id = qml.on_behalf_of_user_id
      where qr.quote_id = (select quote_id from quote_revisions where id = $1)
      order by qml.sent_at desc, qml.id desc
    `,
    [revisionId]
  );
  return r.rows;
}

async function markQuoteMailOpenedByToken(client, trackingToken) {
  const token = String(trackingToken || "").trim();
  if (!token) return null;
  const r = await client.query(
    `
      update quote_mail_logs
      set
        opened_at = coalesce(opened_at, now()),
        last_opened_at = now(),
        open_count = coalesce(open_count, 0) + 1
      where tracking_token = $1
        and send_status = 'sent'
      returning id, quote_revision_id, opened_at, last_opened_at, open_count
    `,
    [token]
  );
  return r.rows[0] || null;
}

router.get("/mail/open/:trackingToken", async (req, res) => {
  const token = String(req.params.trackingToken || "").trim();
  try {
    if (token) {
      await markQuoteMailOpenedByToken(pool, token);
      try {
        const { recordQuoteMailOpen } = require("../services/leadScoring");
        const opened = await pool.query(
          `select quote_revision_id from quote_mail_logs where tracking_token = $1 limit 1`,
          [token]
        );
        if (opened.rows[0]?.quote_revision_id) {
          await recordQuoteMailOpen(pool, opened.rows[0].quote_revision_id);
        }
      } catch {
        /* scoring is best-effort */
      }
    }
  } catch {
    // Keep pixel endpoint silent to avoid exposing tracking internals.
  }
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  return res.status(200).send(QUOTE_MAIL_TRACKING_PIXEL_GIF);
});

async function resolveQuoteRecipientEmailFromCustomerContacts(client, { customerId, customerSiteId }) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) return "";
  const siteId = Number(customerSiteId);
  const siteParam = Number.isFinite(siteId) && siteId > 0 ? siteId : null;
  const r = await client.query(
    `
      select
        cc.email,
        cc.is_primary,
        cc.site_id,
        max(case when ccr.role_key = 'quote_recipient' then 1 else 0 end) as is_quote_recipient
      from customer_contacts cc
      left join customer_contact_roles ccr on ccr.customer_contact_id = cc.id
      where cc.customer_id = $1
        and cc.is_active = true
        and nullif(trim(coalesce(cc.email, '')), '') is not null
      group by cc.id
      order by
        case when $2::int is not null and cc.site_id = $2::int then 1 else 0 end desc,
        max(case when ccr.role_key = 'quote_recipient' then 1 else 0 end) desc,
        cc.is_primary desc,
        cc.id asc
      limit 1
    `,
    [id, siteParam]
  );
  return String(r.rows[0]?.email || "").trim();
}

async function buildQuoteMailBootstrap(client, { quote, revision, actorUserId, actorGroupName }) {
  const senderUserId = quoteOwnerId(quote) || Number(revision?.prepared_by) || Number(actorUserId) || null;
  const sender = await getUserMailProfile(client, senderUserId);
  const groupNames = await getQuoteGroupNames(client, revision.id);
  const ccUsers = await resolveQuoteMailCcUsers(client, sender?.id || actorUserId);
  const history = await getQuoteMailHistory(client, revision.id);
  const lines = await getRevisionLines(client, revision.id);
  const summary = await getOrCreateRevisionSummary(client, { quote, revision, lines, actorUserId }).catch(() => null);
  const presentation = await resolveQuotePresentationContext(client, { quote, revisionId: revision.id, lines });
  const coverLetterText = await getTemplateBodyByKey(client, "QUOTE_COVER_LETTER", presentation.presentation_company_id);
  const configuratorContext = buildEffectiveConfiguratorContext({ summary, presentation });
  const companyProfile = presentation.company_profile;
  const offerType = await getRevisionOfferType(client, revision.id).catch(() => "completes");
  const mailPresets = buildQuoteMailPresets({ quote, sender, groupNames, configuratorContext, offerType });
  const defaultMailPreset = mailPresets.find((preset) => preset.key === "sales_persuasive") || mailPresets[0] || null;
  const mailSource = await getMailBootstrap(client, {
    userId: actorUserId,
    userGroupName: actorGroupName || null,
    quoteDistributorId: quote.distributor_id,
  });
  const contactFallbackTo = await resolveQuoteRecipientEmailFromCustomerContacts(client, {
    customerId: quote?.customer_id,
    customerSiteId: quote?.customer_site_id,
  }).catch(() => "");
  const senderPlan = await resolveQuoteSender(client, { quote, actorUserId, actorGroupName });

  return {
    mail_enabled: Boolean(senderPlan.senderSource && senderPlan.senderSource.type !== "none"),
    send_as: summarizeQuoteSender(senderPlan, sender?.email),
    group_names: groupNames,
    sender,
    cc_users: ccUsers.map((user) => ({
      id: user.id,
      full_name: user.full_name,
      email: user.email,
    })),
    default_to: joinEmailList(quote.customer_email || contactFallbackTo || ""),
    default_cc: joinEmailList(ccUsers.map((user) => user.email)),
    default_subject: defaultMailPreset?.subject || buildQuoteMailSubject(quote.quote_number, groupNames),
    default_body: defaultMailPreset?.body || buildCoverLetterMailBody({ quote, sender, groupNames, coverLetterText, companyProfile, configuratorContext }),
    default_preset_key: defaultMailPreset?.key || "",
    mail_presets: mailPresets,
    history,
    company_profile: companyProfile,
    presentation_company_code: presentation.presentation_company_code,
    presentation_company_name: presentation.presentation_company_name,
    configurator_family_key: configuratorContext.family_key,
    configurator_quote_mode: configuratorContext.configurator_quote_mode,
    configurator_route_reason: configuratorContext.route_reason,
    mixed_branding_risk: configuratorContext.mixed_branding_risk,
    recommended_split_quote: configuratorContext.recommended_split_quote,
    configurator_context: configuratorContext,
    mail_source: mailSource,
  };
}

async function recalcRevisionTotals(client, revisionId) {
  await client.query(
    `
      update quote_revisions r
      set
        subtotal_base = coalesce((select sum(line_total_base) from quote_lines where quote_revision_id = r.id and scope_type = 'included'), 0),
        subtotal_quote = coalesce((select sum(line_total_quote) from quote_lines where quote_revision_id = r.id and scope_type = 'included'), 0),
        tax_total_base = case
          when r.is_export then 0
          else coalesce(
            (select sum((line_total_base * gst_pct) / 100.0) from quote_lines where quote_revision_id = r.id and scope_type = 'included'),
            0
          )
        end,
        tax_total_quote = case
          when r.is_export then 0
          else coalesce(
            (select sum((line_total_quote * gst_pct) / 100.0) from quote_lines where quote_revision_id = r.id and scope_type = 'included'),
            0
          )
        end,
        grand_total_base = case
          when r.is_export then coalesce((select sum(line_total_base) from quote_lines where quote_revision_id = r.id and scope_type = 'included'), 0)
          else coalesce((select sum(line_total_base) from quote_lines where quote_revision_id = r.id and scope_type = 'included'), 0)
            + coalesce((select sum((line_total_base * gst_pct) / 100.0) from quote_lines where quote_revision_id = r.id and scope_type = 'included'), 0)
        end,
        grand_total_quote = case
          when r.is_export then coalesce((select sum(line_total_quote) from quote_lines where quote_revision_id = r.id and scope_type = 'included'), 0)
          else coalesce((select sum(line_total_quote) from quote_lines where quote_revision_id = r.id and scope_type = 'included'), 0)
            + coalesce((select sum((line_total_quote * gst_pct) / 100.0) from quote_lines where quote_revision_id = r.id and scope_type = 'included'), 0)
        end
      where r.id = $1
    `,
    [revisionId]
  );
}

function describeUnreadablePdf(label, reason) {
  if (reason === "password_protected") return `${label} is password-protected, so it was left out.`;
  if (reason === "empty") return `${label} has no pages, so it was left out.`;
  return `${label} could not be read (the file may be damaged), so it was left out.`;
}

// The working PDF in storage/quotes is overwritten by every preview; the copy a customer received must never change.
async function freezeSentQuotePdf(client, { quote, revision, artifact, actorUserId }) {
  const storageDir = path.resolve(__dirname, "..", "..", "storage", "quotes", "sent");
  fs.mkdirSync(storageDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  const storedName = `${artifact.fileName.replace(/\.pdf$/i, "")}_sent_${stamp}_${crypto.randomBytes(3).toString("hex")}.pdf`;
  const absFilePath = path.join(storageDir, storedName);
  fs.writeFileSync(absFilePath, artifact.pdf, { flag: "wx" });
  fs.chmodSync(absFilePath, 0o444);
  const attach = await createOwnedAttachment(client, {
    fileName: artifact.fileName,
    filePath: absFilePath,
    mimeType: "application/pdf",
    fileSizeBytes: artifact.pdf.length,
    uploadedBy: actorUserId,
    companyId: quote.company_id,
    ownerType: "quote_sent_pdf",
    ownerId: revision.id,
  });
  return attach?.id || null;
}

async function generateQuotePdfArtifact(client, { quote, revision, clubbed, mergeAnnexures, actorUserId }) {
  const warnings = [];
  const lines = await getRevisionLines(client, revision.id);
  const summary = await getOrCreateRevisionSummary(client, { quote, revision, lines, actorUserId }).catch(() => null);
  const offerType = normalizeOfferType(quote?.offer_type) || "completes";
  const isSpares = offerType === "spares";
  const sparesContext = isSpares ? await loadSparesPdfContext(client, { quote, lines }) : null;
  // Spares offers carry no plant scope annexures.
  const effectiveMergeAnnexures = isSpares
    ? false
    : mergeAnnexures === true || mergeAnnexures === false
      ? mergeAnnexures
      : resolveAnnexureMode(revision) === "merged";
  const masterAttentionTo = normalizeAttentionToValue(quote?.attention_to)
    ? ""
    : await resolveQuoteAttentionToFromCustomerMaster(client, {
        customerId: quote?.customer_id,
        customerSiteId: quote?.customer_site_id,
      }).catch(() => "");
  const effectiveQuote = masterAttentionTo ? { ...quote, attention_to: masterAttentionTo } : quote;

  const productIds = Array.from(
    new Set(lines.map((l) => (l.product_id ? Number(l.product_id) : null)).filter((x) => Number.isFinite(x)))
  );

  const attrsRes = productIds.length
    ? await client.query(
        `
          select product_id, caption, spec_value
          from product_attributes
          where product_id = any($1::int[])
          order by product_id asc, sort_order asc
        `,
        [productIds]
      )
    : { rows: [] };

  const attributesByProductId = new Map();
  for (const row of attrsRes.rows) {
    const pid = Number(row.product_id);
    const list = attributesByProductId.get(pid) || [];
    list.push({ caption: row.caption, spec_value: row.spec_value });
    attributesByProductId.set(pid, list);
  }

  const curRes = await client.query(
    `
      select
        (select currency_code from currencies where id = $1) as base_currency_code,
        (select symbol from currencies where id = $1) as base_currency_symbol,
        (select currency_code from currencies where id = $2) as quote_currency_code,
        (select symbol from currencies where id = $2) as quote_currency_symbol
    `,
    [revision.base_currency_id, revision.quote_currency_id]
  );
  const currencies = curRes.rows[0] || {};
  const commercialLookupRes = await client.query(
    `
      select
        (select trim(concat_ws(' - ', incoterm_code, incoterm_name)) from incoterms where id = $1) as incoterm_label,
        (select term_name from payment_terms where id = $2) as payment_term_label,
        (select term_name from freight_terms where id = $3) as freight_term_label,
        (select term_name from p_and_f_terms where id = $4) as p_and_f_term_label
    `,
    [revision.incoterm_id, revision.payment_term_id, revision.freight_term_id, revision.p_and_f_term_id]
  );
  const commercialLookup = commercialLookupRes.rows[0] || {};
  const commercialTerms = {
    attention_to: effectiveQuote?.attention_to || "",
    pricing_mode: revision?.pricing_display_mode || "",
    quote_currency: currencies?.quote_currency_code || "",
    payment_term: commercialLookup?.payment_term_label || "",
    freight_term: commercialLookup?.freight_term_label || "",
    p_and_f_term: commercialLookup?.p_and_f_term_label || "",
    incoterm: commercialLookup?.incoterm_label || "",
    tax_treatment: revision?.is_export ? "Export quote / GST as applicable for export" : "Domestic quote / GST applicable",
    valid_till: effectiveQuote?.quote_valid_till || "",
    delivery_lead_time:
      Number(revision?.delivery_lead_time_days) > 0
        ? isSpares
          ? `Ex-works, ${Math.ceil(Number(revision.delivery_lead_time_days) / 7)} week${Math.ceil(Number(revision.delivery_lead_time_days) / 7) === 1 ? "" : "s"} from receipt of PO and payment`
          : `${Math.ceil(Number(revision.delivery_lead_time_days) / 7)} week${Math.ceil(Number(revision.delivery_lead_time_days) / 7) === 1 ? "" : "s"} from order confirmation`
        : "",
    warranty:
      Number(revision?.warranty_months) > 0
        ? `${Number(revision.warranty_months)} month${Number(revision.warranty_months) === 1 ? "" : "s"}`
        : "",
  };

  const presentation = await resolveQuotePresentationContext(client, { quote, revisionId: revision.id, lines });
  const configuratorContext = buildEffectiveConfiguratorContext({ summary, presentation });
  const letterheadPath = presentation.letterhead_path;
  // The QUOTE_TERMS / QUOTE_COVER_LETTER templates are written for plant offers; spares use their own keys.
  const termsTemplateKey = isSpares ? "QUOTE_TERMS_SPARES" : "QUOTE_TERMS";
  const termsPath =
    (isSpares ? null : await getRevisionTemplatePath(client, revision.id, "terms")) ||
    (presentation.presentation_company_id ? await getCompanyTemplateOverridePath(client, presentation.presentation_company_id, termsTemplateKey) : null) ||
    (await getTemplatePathByKey(client, termsTemplateKey));
  const termsText = await getTemplateBodyByKey(client, termsTemplateKey, presentation.presentation_company_id);
  const coverLetterText = await getTemplateBodyByKey(
    client,
    isSpares ? "QUOTE_COVER_LETTER_SPARES" : "QUOTE_COVER_LETTER",
    presentation.presentation_company_id
  );
  const salesUser = await getUserMailProfile(
    client,
    quoteOwnerId(quote) || Number(revision?.prepared_by) || Number(actorUserId) || null
  );
  const companyProfile = presentation.company_profile;

  const groupIds = isSpares ? [] : getPrimaryScopeGroupIds(lines);
  const scopeCompanyId = presentation.presentation_company_id || null;

  const scopeRes = groupIds.length
    ? await client.query(
        `
          select
            pg.id as group_id,
            pg.group_name,
            a.id as attachment_id,
            a.file_name,
            a.file_path
          from product_groups pg
          left join lateral (
            select gst.template_id
            from product_group_scope_templates gst
            where gst.product_group_id = pg.id
              and gst.is_active = true
              and (
                $2::int is null
                and gst.company_id is null
                or $2::int is not null
                and (gst.company_id = $2::int or gst.company_id is null)
              )
            order by (gst.company_id = $2::int) desc, gst.id desc
            limit 1
          ) gst on true
          left join document_templates dt
            on dt.id = gst.template_id and dt.is_active = true
          left join attachments a on a.id = dt.attachment_id
          where pg.id = any($1::int[])
          order by pg.group_name asc
        `,
        [groupIds, scopeCompanyId]
      )
    : { rows: [] };

  const resolvedLetterheadPath = letterheadPath
    ? resolveScopePdfPath({ file_path: letterheadPath, file_name: path.basename(letterheadPath) })
    : null;
  let letterheadBuffer = resolvedLetterheadPath ? fs.readFileSync(resolvedLetterheadPath) : null;
  if (letterheadBuffer) {
    const check = await checkPdfReadable(letterheadBuffer);
    if (!check.ok) {
      warnings.push(describeUnreadablePdf("The company letterhead PDF", check.reason));
      letterheadBuffer = null;
    }
  }
  const withLetterhead = async (buf) => (letterheadBuffer ? applyPdfBackground(buf, letterheadBuffer) : buf);

  const familyContent = await loadQuoteFamilyContent(client);
  // CGST/SGST vs IGST is settled at invoicing, once the place of supply is confirmed.
  const revisionTerms = await getRevisionTerms(client, revision.id).catch(() => []);
  const selectedCount = Array.isArray(revisionTerms) ? revisionTerms.filter((t) => t && t.is_selected).length : 0;
  let staticTermsPdf = null;
  if (!selectedCount && termsPath && fs.existsSync(termsPath)) {
    const raw = fs.readFileSync(termsPath);
    const check = await checkPdfReadable(raw);
    if (check.ok) staticTermsPdf = raw;
    else warnings.push(describeUnreadablePdf("The terms & conditions PDF template", check.reason) + " Standard terms were used instead.");
  }
  const termsHtml =
    selectedCount > 0
      ? renderRevisionTermsHtml({ quote: effectiveQuote, revision, terms: revisionTerms, commercialTerms, companyProfile, offerType })
      : staticTermsPdf
        ? null
        : typeof termsText === "string" && termsText.trim().length
          ? renderTermsTextHtml({ quote: effectiveQuote, revision, termsText, companyProfile })
          : renderDefaultTermsHtml({ quote: effectiveQuote, revision, companyProfile, offerType });

  // The three HTML sections are independent; pdfCore caps how many render at once.
  const [coverTechPdf, commercialPdf, renderedTermsPdf] = await Promise.all([
    generateQuotePdfBuffer(
      renderCoverAndTechnicalHtml({
        familyContent,
        quote: effectiveQuote,
        revision,
        lines,
        currencies,
        attributesByProductId,
        coverLetterText,
        salesUser,
        companyProfile,
        executiveSummary: summary?.executive_summary || null,
        scopeSummary: summary?.scope_summary || null,
        configuratorContext,
        annexuresMerged: Boolean(effectiveMergeAnnexures),
        offerType,
        sparesContext,
      })
    ).then(withLetterhead),
    generateQuotePdfBuffer(
      renderCommercialHtml({
        quote: effectiveQuote,
        revision,
        lines,
        clubbed,
        configuratorContext,
        currencies,
        commercialTerms,
        companyProfile,
        offerType,
      })
    ).then(withLetterhead),
    termsHtml ? generateQuotePdfBuffer(termsHtml).then(withLetterhead) : Promise.resolve(null),
  ]);

  const buffers = [coverTechPdf];
  if (effectiveMergeAnnexures) {
    for (const row of scopeRes.rows) {
      const label = `The scope PDF "${String(row.file_name || row.group_name || "annexure").trim()}"`;
      const filePath = resolveScopePdfPath(row);
      if (!filePath) {
        if (row.attachment_id) warnings.push(`${label} is missing from storage, so it was left out.`);
        continue;
      }
      const rawAnnexurePdf = fs.readFileSync(filePath);
      const check = await checkPdfReadable(rawAnnexurePdf);
      if (!check.ok) {
        warnings.push(describeUnreadablePdf(label, check.reason));
        continue;
      }
      const cleanedAnnexurePdf = await stripEmptyPdfPages(rawAnnexurePdf).catch(() => rawAnnexurePdf);
      if (cleanedAnnexurePdf && cleanedAnnexurePdf.length) buffers.push(cleanedAnnexurePdf);
    }
  }
  buffers.push(commercialPdf);
  buffers.push(renderedTermsPdf || staticTermsPdf);

  const pdf = await stampPdfPageNumbers(await mergePdfBuffers(buffers));
  const baseName = safeFileSegment(quote.quote_number || `quote_${quote.id}`);
  const fileName = `${baseName}_rev${revision.revision_no}${clubbed ? "_clubbed" : ""}${effectiveMergeAnnexures || isSpares ? "" : "_main"}.pdf`;

  const storageDir = path.resolve(__dirname, "..", "..", "storage", "quotes");
  fs.mkdirSync(storageDir, { recursive: true });
  const absFilePath = path.join(storageDir, fileName);
  fs.writeFileSync(absFilePath, pdf);

  const attach = await createOwnedAttachment(client, {
    fileName,
    filePath: absFilePath,
    mimeType: "application/pdf",
    fileSizeBytes: pdf.length,
    uploadedBy: actorUserId,
    companyId: quote.company_id,
    ownerType: "quote_document",
    ownerId: revision.id,
  });
  const attachmentId = attach?.id || null;

  await client.query(
    `
      insert into quote_documents (quote_revision_id, document_type, file_path, generated_by)
      values ($1,'quote_pdf',$2,$3)
    `,
    [revision.id, absFilePath, actorUserId]
  );

  return {
    pdf,
    fileName,
    absFilePath,
    attachmentId,
    warnings,
    presentation_company_code: presentation.presentation_company_code,
    presentation_company_name: presentation.presentation_company_name,
    configurator_family_key: presentation.primary_family_key,
    configurator_quote_mode: presentation.default_quote_mode,
    configurator_route_reason: presentation.route_reason,
    mixed_branding_risk: presentation.mixed_branding_risk,
    recommended_split_quote: presentation.recommended_split_quote,
  };
}

function safeFileSegment(s) {
  return String(s || "")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function templatesStorageDir() {
  const d = path.resolve(__dirname, "..", "..", "storage", "templates");
  return d;
}

function resolveScopePdfPath(row) {
  const direct = row?.file_path;
  if (direct && fs.existsSync(direct)) return direct;
  const fileName = typeof row?.file_name === "string" ? row.file_name.trim() : "";
  if (!fileName) return null;
  const candidate = path.join(templatesStorageDir(), path.basename(fileName));
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

async function getRevisionTemplatePath(client, quoteRevisionId, templateRole) {
  const r = await client.query(
    `
      select a.file_path
      from quote_revision_templates qrt
      join document_templates dt on dt.id = qrt.template_id and dt.is_active = true
      join attachments a on a.id = dt.attachment_id
      where qrt.quote_revision_id = $1 and qrt.template_role = $2
      order by qrt.id desc
      limit 1
    `,
    [quoteRevisionId, templateRole]
  );
  return r.rows[0]?.file_path || null;
}

async function getCompanyTemplateOverridePath(client, companyId, templateKey) {
  const cid = Number(companyId);
  if (!Number.isFinite(cid) || cid <= 0) return null;
  const r = await client.query(
    `
      select a.file_path
      from company_template_overrides cto
      join document_templates dt on dt.id = cto.template_id and dt.is_active = true
      join attachments a on a.id = dt.attachment_id
      where cto.company_id = $1 and cto.template_key = $2 and cto.is_active = true
      order by cto.id desc
      limit 1
    `,
    [cid, templateKey]
  );
  return r.rows[0]?.file_path || null;
}

async function getTemplatePathByKey(client, templateKey) {
  const r = await client.query(
    `
      select a.file_path
      from document_templates dt
      join attachments a on a.id = dt.attachment_id
      where dt.template_key = $1 and dt.is_active = true
      order by dt.version_no desc, dt.id desc
      limit 1
    `,
    [templateKey]
  );
  return r.rows[0]?.file_path || null;
}

async function getDistributorLetterheadPath(client, distributorId) {
  if (!Number.isFinite(Number(distributorId))) return null;
  const r = await client.query(
    `
      select a.file_path
      from distributor_letterheads dl
      join document_templates dt on dt.id = dl.template_id and dt.is_active = true
      join attachments a on a.id = dt.attachment_id
      where dl.distributor_id = $1 and dl.is_active = true
      order by dl.id desc
      limit 1
    `,
    [Number(distributorId)]
  );
  return r.rows[0]?.file_path || null;
}

async function getTemplateBodyByKey(client, templateKey, companyId = null) {
  const cid = Number(companyId);
  if (Number.isFinite(cid) && cid > 0) {
    const override = await client.query(
      `
        select template_body
        from company_template_overrides
        where company_id = $1
          and template_key = $2
          and is_active = true
          and template_body is not null
        order by id desc
        limit 1
      `,
      [cid, templateKey]
    );
    if (typeof override.rows[0]?.template_body === "string") {
      return override.rows[0].template_body;
    }
  }
  const r = await client.query(
    `
      select template_body
      from document_templates
      where template_key = $1 and is_active = true and template_body is not null
      order by version_no desc, id desc
      limit 1
    `,
    [templateKey]
  );
  return typeof r.rows[0]?.template_body === "string" ? r.rows[0].template_body : null;
}

async function ensureRevisionTerms(client, quoteRevisionId) {
  const existsRes = await client.query(
    `select 1 from quote_revision_terms where quote_revision_id = $1 limit 1`,
    [quoteRevisionId]
  );
  if (existsRes.rows.length) return;

  const offerType = await getRevisionOfferType(client, quoteRevisionId);
  const termsRes = (await hasOfferTypeColumns(client))
    ? await client.query(
        `
          select id, sort_order, caption,
            case when $1 = 'spares' and nullif(trim(spares_description), '') is not null
              then spares_description else default_description end as default_description
          from terms_master
          where is_active = true and applies_to in ('all', $1)
          order by sort_order asc, id asc
        `,
        [offerType]
      )
    : await client.query(
        `
          select id, sort_order, caption, default_description
          from terms_master
          where is_active = true
          order by sort_order asc, id asc
        `
      );

  for (const t of termsRes.rows) {
    await client.query(
      `
        insert into quote_revision_terms (
          quote_revision_id,
          term_master_id,
          sort_order,
          caption,
          description,
          is_selected
        )
        values ($1,$2,$3,$4,$5,true)
        on conflict (quote_revision_id, term_master_id) do nothing
      `,
      [quoteRevisionId, t.id, t.sort_order, t.caption, t.default_description]
    );
  }

  await syncCommercialDefaultsToRevisionTerms(client, quoteRevisionId);
}

const OFFER_TYPES = new Set(["completes", "spares"]);
const COMPLETES_MODULE_ROLES = new Set(["generator", "air_system", "booster", "gas_storage"]);
let offerTypeColumnsReady = null;

function normalizeOfferType(value) {
  const v = String(value || "").trim().toLowerCase();
  return OFFER_TYPES.has(v) ? v : null;
}

async function hasOfferTypeColumns(client) {
  if (offerTypeColumnsReady === true) return true;
  const r = await client.query(
    `
      select count(*)::int as n
      from information_schema.columns
      where table_schema = current_schema()
        and ((table_name = 'quote_headers' and column_name = 'offer_type')
          or (table_name = 'terms_master' and column_name = 'applies_to'))
    `
  );
  offerTypeColumnsReady = Number(r.rows[0]?.n) === 2;
  return offerTypeColumnsReady;
}

async function getRevisionOfferType(client, quoteRevisionId) {
  if (!(await hasOfferTypeColumns(client))) return "completes";
  const r = await client.query(
    `select q.offer_type from quote_revisions r join quote_headers q on q.id = r.quote_id where r.id = $1`,
    [quoteRevisionId]
  );
  return normalizeOfferType(r.rows[0]?.offer_type) || "completes";
}

// Main equipment (generators, air systems, boosters, storage) makes a completes offer; anything else
// (Absstem Shield or Product Master spares, consumables, service) is spares. No product lines = undecided.
function detectOfferTypeFromLines(lines) {
  const included = (Array.isArray(lines) ? lines : []).filter(
    (l) => String(l?.scope_type || "included") === "included" && l?.product_id
  );
  if (!included.length) return null;
  const hasMainEquipment = included.some(
    (l) =>
      COMPLETES_MODULE_ROLES.has(String(l?.product_module_role || "").trim().toLowerCase()) ||
      String(l?.product_item_type || "").trim().toLowerCase() === "equipment"
  );
  return hasMainEquipment ? "completes" : "spares";
}

// Re-fits a draft revision's terms to the offer type: adds missing applicable clauses, selects only the
// clauses for this type, and swaps Library wording only where the user has not edited it.
async function applyOfferTypeToRevisionTerms(client, quoteRevisionId, offerType) {
  if (!(await hasOfferTypeColumns(client))) return;
  const offer = normalizeOfferType(offerType) || "completes";
  const existing = await client.query(`select 1 from quote_revision_terms where quote_revision_id = $1 limit 1`, [
    quoteRevisionId,
  ]);
  if (!existing.rows.length) {
    await ensureRevisionTerms(client, quoteRevisionId);
    return;
  }

  await client.query(
    `
      insert into quote_revision_terms (quote_revision_id, term_master_id, sort_order, caption, description, is_selected)
      select $1, t.id, t.sort_order, t.caption,
        case when $2 = 'spares' and nullif(trim(t.spares_description), '') is not null
          then t.spares_description else t.default_description end,
        true
      from terms_master t
      where t.is_active = true and t.applies_to = $2
      on conflict (quote_revision_id, term_master_id) do nothing
    `,
    [quoteRevisionId, offer]
  );

  await client.query(
    `
      update quote_revision_terms rt
      set is_selected = (t.applies_to = $2), updated_at = now()
      from terms_master t
      where rt.quote_revision_id = $1
        and t.id = rt.term_master_id
        and t.applies_to <> 'all'
        and rt.is_selected is distinct from (t.applies_to = $2)
    `,
    [quoteRevisionId, offer]
  );

  await client.query(
    `
      update quote_revision_terms rt
      set description = case when $2 = 'spares' then t.spares_description else t.default_description end,
          updated_at = now()
      from terms_master t
      where rt.quote_revision_id = $1
        and t.id = rt.term_master_id
        and nullif(trim(t.spares_description), '') is not null
        and coalesce(rt.description, '') = coalesce(case when $2 = 'spares' then t.default_description else t.spares_description end, '')
    `,
    [quoteRevisionId, offer]
  );

  await applyOfferTypeToRevisionCommercials(client, quoteRevisionId, offer);
  await syncCommercialDefaultsToRevisionTerms(client, quoteRevisionId);
}

function parseWarrantyMonthsText(text) {
  const s = String(text || "");
  const m = s.match(/(\d+)\s*months?\s+from(?:\s+the)?\s+date\s+of\s+Commissioning/i) || s.match(/(\d+)\s*months?/i);
  return m ? Number(m[1]) : null;
}

function parseDeliveryDaysText(text) {
  const s = String(text || "");
  const d = s.match(/(\d+)\s*(?:-|to|–|—)\s*(\d+)\s*days?/i) || s.match(/(\d+)\s*days?/i);
  if (d) return Math.max(Number(d[1]), d[2] !== undefined ? Number(d[2]) : Number(d[1]));
  const w = s.match(/(\d+)\s*(?:-|to|–|—)\s*(\d+)\s*weeks?/i) || s.match(/(\d+)\s*weeks?/i);
  if (w) return Math.max(Number(w[1]), w[2] !== undefined ? Number(w[2]) : Number(w[1])) * 7;
  return null;
}

// Payment term, warranty months and delivery days are re-printed into the PDF terms, so a type switch moves
// them too, but only when they still hold the previous type's default (a deliberate choice is kept).
async function applyOfferTypeToRevisionCommercials(client, quoteRevisionId, offer) {
  const from = offer === "spares" ? "completes" : "spares";
  const masterRes = await client.query(
    `select upper(trim(caption)) as cap, default_description, spares_description from terms_master
     where is_active = true and applies_to = 'all' and upper(trim(caption)) in ('WARRANTY', 'DELIVERY')`
  );
  const textFor = (cap, type) => {
    const row = masterRes.rows.find((r) => r.cap === cap);
    return type === "spares" && String(row?.spares_description || "").trim() ? row.spares_description : row?.default_description || "";
  };
  const payRes = await client.query(
    `select id, upper(trim(term_code)) as code from payment_terms where is_active = true and upper(trim(term_code)) in ('ADV50', 'ADV100')`
  );
  const payId = (code) => payRes.rows.find((r) => r.code === code)?.id ?? null;
  const defaultsFor = (type) => ({
    payment_term_id: type === "spares" ? payId("ADV100") : payId("ADV50"),
    warranty_months: parseWarrantyMonthsText(textFor("WARRANTY", type)),
    delivery_lead_time_days: parseDeliveryDaysText(textFor("DELIVERY", type)),
  });
  const before = defaultsFor(from);
  const after = defaultsFor(offer);
  const rev = (
    await client.query(`select payment_term_id, warranty_months, delivery_lead_time_days from quote_revisions where id = $1`, [quoteRevisionId])
  ).rows[0];
  if (!rev) return;

  const sets = [];
  const values = [quoteRevisionId];
  for (const key of Object.keys(after)) {
    if (after[key] === null || before[key] === null || rev[key] === null || rev[key] === undefined) continue;
    if (Number(rev[key]) !== Number(before[key]) || Number(before[key]) === Number(after[key])) continue;
    values.push(after[key]);
    sets.push(`${key} = $${values.length}`);
  }
  if (sets.length) await client.query(`update quote_revisions set ${sets.join(", ")} where id = $1`, values);
}

async function setQuoteOfferType(client, { quoteId, revisionId, offerType, source }) {
  if (!(await hasOfferTypeColumns(client))) return null;
  const offer = normalizeOfferType(offerType) || "completes";
  const src = source === "manual" ? "manual" : "auto";
  const prev = await client.query(`select offer_type from quote_headers where id = $1`, [quoteId]);
  await client.query(
    `update quote_headers set offer_type = $2, offer_type_source = $3, updated_at = now() where id = $1`,
    [quoteId, offer, src]
  );
  if (revisionId && prev.rows[0]?.offer_type !== offer) {
    await applyOfferTypeToRevisionTerms(client, revisionId, offer);
  }
  return offer;
}

// Only auto-typed quotes on a draft revision follow their lines; manual choices and issued revisions never move.
async function refreshAutoOfferType(client, { quoteId, revisionId }) {
  if (!(await hasOfferTypeColumns(client))) return null;
  const r = await client.query(
    `
      select q.offer_type, q.offer_type_source, r.revision_status
      from quote_headers q
      join quote_revisions r on r.quote_id = q.id
      where q.id = $1 and r.id = $2
    `,
    [quoteId, revisionId]
  );
  const row = r.rows[0];
  if (!row || row.offer_type_source !== "auto" || String(row.revision_status || "draft") !== "draft") return null;
  const detected = detectOfferTypeFromLines(await getRevisionLines(client, revisionId));
  if (!detected || detected === row.offer_type) return null;
  return setQuoteOfferType(client, { quoteId, revisionId, offerType: detected, source: "auto" });
}

async function loadSparesPdfContext(client, { quote, lines }) {
  let equipment = "";
  const jobAssetId = Number(quote?.job_asset_id);
  if (Number.isFinite(jobAssetId) && jobAssetId > 0) {
    const assetRes = await client
      .query(
        `select asset_name, finished_good_item_code, finished_good_item_name, serial_no, job_id from job_assets where id = $1`,
        [jobAssetId]
      )
      .catch(() => ({ rows: [] }));
    const a = assetRes.rows[0];
    if (a) {
      const name = String(a.finished_good_item_name || a.asset_name || "").trim();
      const code = String(a.finished_good_item_code || "").trim();
      equipment = [
        name && code && code !== name ? `${name} (${code})` : name || code,
        a.serial_no ? `S/N ${a.serial_no}` : "",
        a.job_id ? `Job ${a.job_id}` : "",
      ]
        .filter(Boolean)
        .join(" • ");
    }
  }
  if (!equipment) {
    equipment = [
      quote?.quote_serial_no ? `S/N ${quote.quote_serial_no}` : "",
      quote?.quote_job_id ? `Job ${quote.quote_job_id}` : "",
    ]
      .filter(Boolean)
      .join(" • ");
  }

  const productIds = Array.from(
    new Set((Array.isArray(lines) ? lines : []).map((l) => Number(l?.product_id)).filter((id) => Number.isFinite(id) && id > 0))
  );
  const compatibleByProductId = {};
  if (productIds.length) {
    const mapRes = await client
      .query(
        `
          select m.replacement_product_id as product_id,
            string_agg(distinct coalesce(nullif(trim(p.item_code), ''), p.item_name), ', ') as parents
          from product_aftermarket_mappings m
          join products p on p.id = m.parent_product_id
          where m.is_active = true and m.replacement_product_id = any($1::int[])
          group by m.replacement_product_id
        `,
        [productIds]
      )
      .catch(() => ({ rows: [] }));
    for (const row of mapRes.rows) {
      if (row.parents) compatibleByProductId[Number(row.product_id)] = row.parents;
    }
  }
  return { equipment, compatibleByProductId };
}

async function getRevisionTerms(client, quoteRevisionId) {
  const r = await client.query(
    `
      select *
      from quote_revision_terms
      where quote_revision_id = $1
      order by sort_order asc, id asc
    `,
    [quoteRevisionId]
  );
  return r.rows.sort((a, b) => {
    const rankDiff = getManagedCommercialTermRank(a?.caption) - getManagedCommercialTermRank(b?.caption);
    if (rankDiff !== 0) return rankDiff;
    const sortA = Number(a?.sort_order) || 0;
    const sortB = Number(b?.sort_order) || 0;
    if (sortA !== sortB) return sortA - sortB;
    return (Number(a?.id) || 0) - (Number(b?.id) || 0);
  });
}

async function copyRevisionLines(client, fromRevisionId, toRevisionId) {
  const hasPricingCols = await hasQuoteLineColumn(client, "discount_pct");
  if (hasPricingCols) {
    await client.query(
      `
        insert into quote_lines (
          quote_revision_id,
          line_no,
          product_id,
          item_code,
          item_name,
          line_description,
          hsn_no,
          qty,
          unit_price_base,
          unit_price_quote,
          gst_pct,
          line_total_base,
          line_total_quote,
          scope_type,
          customer_item_code,
          customer_item_description,
          discount_pct,
          discount_amt,
          gross_unit_price_quote,
          list_price_snapshot
        )
        select
          $2 as quote_revision_id,
          line_no,
          product_id,
          item_code,
          item_name,
          line_description,
          hsn_no,
          qty,
          unit_price_base,
          unit_price_quote,
          gst_pct,
          line_total_base,
          line_total_quote,
          scope_type,
          customer_item_code,
          customer_item_description,
          coalesce(discount_pct, 0),
          coalesce(discount_amt, 0),
          coalesce(nullif(gross_unit_price_quote, 0), unit_price_quote, 0),
          coalesce(nullif(list_price_snapshot, 0), unit_price_quote, 0)
        from quote_lines
        where quote_revision_id = $1
        order by line_no asc
      `,
      [fromRevisionId, toRevisionId]
    );
    return;
  }

  await client.query(
    `
      insert into quote_lines (
        quote_revision_id,
        line_no,
        product_id,
        item_code,
        item_name,
        line_description,
        hsn_no,
        qty,
        unit_price_base,
        unit_price_quote,
        gst_pct,
        line_total_base,
        line_total_quote,
        scope_type,
        customer_item_code,
        customer_item_description
      )
      select
        $2 as quote_revision_id,
        line_no,
        product_id,
        item_code,
        item_name,
        line_description,
        hsn_no,
        qty,
        unit_price_base,
        unit_price_quote,
        gst_pct,
        line_total_base,
        line_total_quote,
        scope_type,
        customer_item_code,
        customer_item_description
      from quote_lines
      where quote_revision_id = $1
      order by line_no asc
    `,
    [fromRevisionId, toRevisionId]
  );
}

async function copyRevisionTerms(client, fromRevisionId, toRevisionId) {
  await client.query(
    `
      insert into quote_revision_terms (
        quote_revision_id,
        term_master_id,
        sort_order,
        caption,
        description,
        is_selected
      )
      select
        $2 as quote_revision_id,
        term_master_id,
        sort_order,
        caption,
        description,
        is_selected
      from quote_revision_terms
      where quote_revision_id = $1
      order by sort_order asc, id asc
    `,
    [fromRevisionId, toRevisionId]
  );
}

async function copyRevisionTemplates(client, fromRevisionId, toRevisionId) {
  await client.query(
    `
      insert into quote_revision_templates (quote_revision_id, template_role, template_id, product_group_id)
      select $2 as quote_revision_id, template_role, template_id, product_group_id
      from quote_revision_templates
      where quote_revision_id = $1
      order by id asc
    `,
    [fromRevisionId, toRevisionId]
  );
}

router.use(requireAuth);

router.use(async (req, _res, next) => {
  try {
    if (req.user.group_name !== "SuperAdmin" && ownRecordsOnly(req, "quotes")) {
      req.quoteScope = await loadQuoteScope(pool, req.user.id);
    }
    return next();
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await stampExpiredQuotes(pool, {
      companyId: isDistributor ? null : getActiveCompanyId(req),
      distributorId: isDistributor ? distributorId : null,
    });

    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const qText = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim() : "";

    const params = [];
    const filters = [];

    if (isDistributor) {
      params.push(distributorId);
      filters.push(`q.distributor_id = $${params.length}`);
    } else {
      const activeCompanyId = getActiveCompanyId(req);
      if (Number.isFinite(activeCompanyId)) {
        params.push(activeCompanyId);
        filters.push(`q.company_id = $${params.length}`);
      }
      if (ownRecordsOnly(req, "quotes")) {
        params.push(quoteScopeUserIdList(req));
        filters.push(`coalesce(q.owner_user_id, q.created_by) = any($${params.length}::int[])`);
      }
    }

    const ownerScope = typeof req.query.owner_scope === "string" ? req.query.owner_scope.trim() : "";
    if (ownerScope === "mine") {
      params.push(req.user.id);
      filters.push(`coalesce(q.owner_user_id, q.created_by) = $${params.length}`);
    } else if (ownerScope === "team") {
      params.push(req.user.id);
      filters.push(`coalesce(q.owner_user_id, q.created_by) is distinct from $${params.length}`);
    } else if (/^\d+$/.test(ownerScope)) {
      params.push(Number(ownerScope));
      filters.push(`coalesce(q.owner_user_id, q.created_by) = $${params.length}`);
    }

    if (status) {
      params.push(status);
      filters.push(`q.quote_status = $${params.length}`);
    }
    if (qText) {
      params.push(`%${qText}%`);
      filters.push(`(q.quote_number ilike $${params.length} or c.customer_name ilike $${params.length})`);
    }
    if (bucket === "unconverted") {
      params.push(["approved", "issued", "sent"]);
      filters.push(`q.quote_status = any($${params.length}::text[])`);
      filters.push(`so.id is null`);
    }

    const { resolveTimelineFromQuery, pushDateRangeFilter } = require("../services/timelineWindow");
    const timeline = resolveTimelineFromQuery(req.query);
    const quoteDateFilter = pushDateRangeFilter(
      params,
      "coalesce(qr.issued_at, qr.prepared_at, q.created_at)",
      timeline.dateFrom,
      timeline.dateTo
    );
    if (quoteDateFilter) filters.push(quoteDateFilter);

    const where = filters.length ? `where ${filters.join(" and ")}` : "";
    const LIST_CAP = 200;

    const countRes = await pool.query(
      `
        select count(*)::int as n
        from quote_headers q
        join customers c on c.id = q.customer_id
        left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
        left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
        ${where}
      `,
      params
    );
    const totalCount = Number(countRes.rows[0]?.n || 0);
    const statusCountRes = await pool.query(
      `
        select coalesce(q.quote_status, 'unknown') as status, count(*)::int as n
        from quote_headers q
        join customers c on c.id = q.customer_id
        left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
        left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
        ${where}
        group by 1
      `,
      params
    );
    const statusCounts = Object.fromEntries(statusCountRes.rows.map((row) => [row.status, Number(row.n) || 0]));

    const { rows } = await pool.query(
      `
        select
          q.id,
          q.quote_number,
          q.quote_status,
          q.customer_id,
          c.customer_name,
          q.quote_origin,
          q.service_warranty_case_id,
          swc.case_number as service_case_number,
          q.amc_contract_id,
          ac.contract_number as amc_contract_number,
          q.company_id,
          co.company_code,
          q.distributor_id,
          d.company_name as distributor_name,
          q.attention_to,
          q.quote_valid_till,
          q.next_follow_up_at,
          q.quote_kind,
          q.created_at,
          q.updated_at,
          coalesce(q.owner_user_id, q.created_by) as owner_user_id,
          owner_u.full_name as owner_name,
          qr.id as revision_id,
          qr.revision_no,
          qr.revision_status,
          qr.quote_currency_id,
          qr.grand_total_quote,
          qr.prepared_at,
          qr.issued_at,
          coalesce(ql.total_line_count, 0)::int as total_line_count,
          coalesce(ql.included_line_count, 0)::int as included_line_count,
          so.id as sales_order_id,
          coalesce(ar.customer_overdue_amount, 0)::numeric as customer_overdue_amount
        from quote_headers q
        left join companies co on co.id = q.company_id
        join customers c on c.id = q.customer_id
        left join service_warranty_cases swc on swc.id = q.service_warranty_case_id
        left join amc_contracts ac on ac.id = q.amc_contract_id
        left join distributors d on d.id = q.distributor_id
        left join erp_users owner_u on owner_u.id = coalesce(q.owner_user_id, q.created_by)
        left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
        left join (
          select
            quote_revision_id,
            count(*)::int as total_line_count,
            count(*) filter (where coalesce(scope_type, 'included') = 'included')::int as included_line_count
          from quote_lines
          group by quote_revision_id
        ) ql on ql.quote_revision_id = qr.id
        left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
        left join (
          select
            ci.customer_id,
            coalesce(
              sum(
                greatest(
                  ci.grand_total_invoice - coalesce(pr.allocated_invoice, 0) - coalesce(sr.credit_note_amount, 0),
                  0
                )
              ),
              0
            ) as customer_overdue_amount
          from customer_invoices ci
          left join (
            select
              cra.customer_invoice_id,
              coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
            from customer_receipt_allocations cra
            join customer_receipts cr on cr.id = cra.customer_receipt_id
            where cr.receipt_status = 'posted'
            group by cra.customer_invoice_id
          ) pr on pr.customer_invoice_id = ci.id
          left join (
            select
              customer_invoice_id,
              coalesce(sum(credit_note_amount), 0) as credit_note_amount
            from sales_returns
            where return_status = 'posted'
              and customer_invoice_id is not null
            group by customer_invoice_id
          ) sr on sr.customer_invoice_id = ci.id
          where ci.invoice_status = 'issued'
          group by ci.customer_id
        ) ar on ar.customer_id = q.customer_id
        ${where}
        order by q.created_at desc
        limit ${LIST_CAP}
      `,
      params
    );

    const quotes = rows.map((row) => ({
      ...row,
      customer_overdue_amount: Number(row.customer_overdue_amount || 0),
      ...buildQuoteInteractionMetadata({
        quote: row,
        revision: row,
        includedLineCount: Number(row.included_line_count || 0),
        hasSalesOrder: Number(row.sales_order_id) > 0,
        customerOverdueAmount: Number(row.customer_overdue_amount || 0),
      }),
      triggering_lines: [],
    }));

    const pendingRevisionIds = [
      ...new Set(
        quotes
          .filter((q) => String(q.revision_status || q.quote_status || "").toLowerCase() === "pending_approval")
          .map((q) => Number(q.revision_id))
          .filter((id) => Number.isFinite(id) && id > 0)
      ),
    ];
    if (pendingRevisionIds.length) {
      try {
        const lineRes = await pool.query(
          `
            select
              quote_revision_id,
              id,
              line_no,
              item_name,
              item_code,
              discount_pct,
              gross_unit_price_quote,
              unit_price_quote,
              line_description,
              list_price_snapshot
            from quote_lines
            where quote_revision_id = any($1::int[])
            order by quote_revision_id asc, line_no asc
          `,
          [pendingRevisionIds]
        );
        const byRevision = new Map();
        for (const line of lineRes.rows) {
          const revisionId = Number(line.quote_revision_id);
          if (!byRevision.has(revisionId)) byRevision.set(revisionId, []);
          byRevision.get(revisionId).push(line);
        }
        for (const quote of quotes) {
          const revisionId = Number(quote.revision_id);
          if (!byRevision.has(revisionId)) continue;
          quote.triggering_lines = summarizeRevisionDiscounts(byRevision.get(revisionId)).lines;
        }
      } catch {
        // Pricing columns may be absent on older DBs; leave triggering_lines empty.
      }
    }

    return res.json({
      ok: true,
      quotes,
      list: {
        total_count: totalCount,
        returned: quotes.length,
        cap: LIST_CAP,
        capped: totalCount > quotes.length,
        showing_from: quotes.length ? 1 : 0,
        showing_to: quotes.length,
        status_counts: statusCounts,
        dormant_in_view: quotes.filter((row) => row.is_dormant).length,
        owner_scope: ownerScope || "all",
      },
      team: {
        restricted: Boolean(req.quoteScope),
        member_count: req.quoteScope ? req.quoteScope.userIds.size : null,
        covering_for: req.quoteScope?.coveringFor || [],
      },
    });
  } catch (err) {
    return next(err);
  }
});

function parseIsoDate(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : s;
}

async function loadAssignableUsers(client, req) {
  const me = Number(req.user.id);
  const isSuperAdmin = req.user.group_name === "SuperAdmin";
  const params = [];
  let scopeSql = "";
  if (!isSuperAdmin) {
    const ids = await loadReporteeIds(client, me);
    ids.add(me);
    params.push([...ids]);
    scopeSql = `and u.id = any($1::int[])`;
  }
  const r = await client.query(
    `
      select u.id, u.full_name, u.email, u.designation, g.group_name, u.primary_manager_user_id
      from erp_users u
      left join user_groups g on g.id = u.group_id
      where u.is_active = true
        ${scopeSql}
      order by u.full_name asc
    `,
    params
  );
  return r.rows;
}

async function loadCoverColleagues(client, req) {
  const isDistributor = req.user.group_name === "Distributor";
  const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
  const r = await client.query(
    `
      select u.id, u.full_name, u.email, u.designation, g.group_name
      from erp_users u
      left join user_groups g on g.id = u.group_id
      left join user_distributor_links l on l.user_id = u.id
      where u.is_active = true
        and u.id <> $1
        and ${isDistributor ? "l.distributor_id = $2" : "l.distributor_id is null and coalesce(g.group_name, '') <> 'Distributor'"}
      order by u.full_name asc
    `,
    isDistributor ? [req.user.id, distributorId] : [req.user.id]
  );
  return r.rows;
}

async function canManageCoverFor(client, req, fromUserId) {
  const me = Number(req.user.id);
  const target = Number(fromUserId);
  if (target === me || req.user.group_name === "SuperAdmin") return true;
  const reportees = await loadReporteeIds(client, me);
  return reportees.has(target);
}

async function listCoverRows(client, whereSql, params) {
  const r = await client.query(
    `
      select
        d.id, d.from_user_id, fu.full_name as from_user_name,
        d.to_user_id, tu.full_name as to_user_name,
        d.start_date, d.end_date, d.note, d.hr_leave_request_id,
        d.created_by, cu.full_name as created_by_name, d.created_at,
        (current_date between d.start_date and d.end_date) as is_active_today
      from quote_cover_delegations d
      join erp_users fu on fu.id = d.from_user_id
      join erp_users tu on tu.id = d.to_user_id
      left join erp_users cu on cu.id = d.created_by
      where d.cancelled_at is null
        and d.end_date >= current_date
        and ${whereSql}
      order by d.start_date asc, d.id asc
    `,
    params
  );
  return r.rows;
}

router.get("/covers", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const me = Number(req.user.id);
    const reportees = [...(await loadReporteeIds(pool, me))];
    const [given, received, team, leaves, colleagues] = await Promise.all([
      listCoverRows(pool, `d.from_user_id = $1`, [me]),
      listCoverRows(pool, `d.to_user_id = $1`, [me]),
      reportees.length ? listCoverRows(pool, `d.from_user_id = any($1::int[])`, [reportees]) : [],
      pool
        .query(
          `
            select lr.id, lr.start_date, lr.end_date, lr.leave_type, lr.total_days
            from hr_leave_requests lr
            where lr.employee_user_id = $1
              and lr.leave_status = 'approved'
              and lr.end_date >= current_date
              and not exists (
                select 1 from quote_cover_delegations d
                where d.from_user_id = $1
                  and d.cancelled_at is null
                  and d.start_date <= lr.end_date
                  and d.end_date >= lr.start_date
              )
            order by lr.start_date asc
            limit 5
          `,
          [me]
        )
        .then((r) => r.rows)
        .catch(() => []),
      loadCoverColleagues(pool, req),
    ]);
    return res.json({
      ok: true,
      given,
      received,
      team,
      leave_suggestions: leaves,
      colleagues,
      reportees: reportees.length ? await loadAssignableUsers(pool, req) : [],
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/covers", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const fromUserId = Number(body.from_user_id) || Number(req.user.id);
    const toUserId = Number(body.to_user_id);
    const startDate = parseIsoDate(body.start_date);
    const endDate = parseIsoDate(body.end_date);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
    const hrLeaveRequestId = Number(body.hr_leave_request_id) || null;

    if (!Number.isFinite(toUserId) || toUserId <= 0) return res.status(400).json({ ok: false, error: "COVER_USER_REQUIRED" });
    if (toUserId === fromUserId) return res.status(400).json({ ok: false, error: "COVER_SAME_USER" });
    if (!startDate || !endDate) return res.status(400).json({ ok: false, error: "COVER_DATES_REQUIRED" });
    if (endDate < startDate) return res.status(400).json({ ok: false, error: "COVER_DATES_INVALID" });
    if (!(await canManageCoverFor(client, req, fromUserId))) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const usersRes = await client.query(`select id, full_name, is_active from erp_users where id = any($1::int[])`, [[fromUserId, toUserId]]);
    const byId = new Map(usersRes.rows.map((row) => [Number(row.id), row]));
    if (!byId.get(toUserId) || byId.get(toUserId).is_active === false) {
      return res.status(400).json({ ok: false, error: "COVER_USER_INACTIVE" });
    }

    await client.query("begin");
    const overlap = await client.query(
      `
        select d.id, tu.full_name as to_user_name, d.start_date, d.end_date
        from quote_cover_delegations d
        join erp_users tu on tu.id = d.to_user_id
        where d.from_user_id = $1
          and d.cancelled_at is null
          and d.start_date <= $3::date
          and d.end_date >= $2::date
        limit 1
      `,
      [fromUserId, startDate, endDate]
    );
    if (overlap.rows[0]) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "COVER_OVERLAP", existing: overlap.rows[0] });
    }
    const ins = await client.query(
      `
        insert into quote_cover_delegations (company_id, from_user_id, to_user_id, start_date, end_date, note, hr_leave_request_id, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        returning id
      `,
      [getActiveCompanyId(req) || null, fromUserId, toUserId, startDate, endDate, note || null, hrLeaveRequestId, req.user.id]
    );
    await client.query("commit");

    const fromName = byId.get(fromUserId)?.full_name || "A colleague";
    const toName = byId.get(toUserId)?.full_name || "a colleague";
    const range = `${startDate} to ${endDate}`;
    notifyUser({
      userId: toUserId,
      companyId: getActiveCompanyId(req) || null,
      actorUserId: req.user.id,
      eventType: "quote_cover_assigned",
      title: `You are covering ${fromName}'s quotes`,
      body: `From ${range} you can open, send and approve ${fromName}'s quotes (and their team's).${note ? ` Note: ${note}` : ""}`,
      page: "quotes",
    }).catch(() => {});
    if (fromUserId !== Number(req.user.id)) {
      notifyUser({
        userId: fromUserId,
        companyId: getActiveCompanyId(req) || null,
        actorUserId: req.user.id,
        eventType: "quote_cover_set",
        title: `${toName} will cover your quotes`,
        body: `Your manager set ${toName} to cover your quotes from ${range}.`,
        page: "quotes",
      }).catch(() => {});
    }
    return res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

router.delete("/covers/:coverId", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  try {
    const coverId = Number(req.params.coverId);
    if (!Number.isFinite(coverId)) return res.status(400).json({ ok: false });
    const r = await pool.query(`select * from quote_cover_delegations where id = $1 and cancelled_at is null`, [coverId]);
    const cover = r.rows[0];
    if (!cover) return res.status(404).json({ ok: false });
    const me = Number(req.user.id);
    const allowed =
      Number(cover.to_user_id) === me ||
      Number(cover.created_by) === me ||
      (await canManageCoverFor(pool, req, cover.from_user_id));
    if (!allowed) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    await pool.query(`update quote_cover_delegations set cancelled_at = now(), cancelled_by = $2 where id = $1`, [coverId, me]);
    const other = Number(cover.to_user_id) === me ? Number(cover.from_user_id) : Number(cover.to_user_id);
    notifyUser({
      userId: other,
      companyId: getActiveCompanyId(req) || null,
      actorUserId: me,
      eventType: "quote_cover_cancelled",
      title: "Quote cover cancelled",
      body: `The quote cover from ${String(cover.start_date).slice(0, 10)} to ${String(cover.end_date).slice(0, 10)} was cancelled by ${req.user.full_name || req.user.email || "a colleague"}.`,
      page: "quotes",
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.get("/team-members", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const members = await loadAssignableUsers(pool, req);
    return res.json({ ok: true, members, is_manager: members.length > 1 || req.user.group_name === "SuperAdmin" });
  } catch (err) {
    return next(err);
  }
});

router.get("/bootstrap", requireScreenAction("quotes", "can_view"), async (_req, res, next) => {
  try {
    const isDistributor = _req.user?.group_name === "Distributor";
    const [currenciesRes, exchangeRatesRes, incotermsRes, paymentTermsRes, freightTermsRes, pAndFTermsRes, priceTypesRes, countriesRes, statesRes, citiesRes, closureReasonsRes, termsMasterRes] = await Promise.all([
      pool.query(
        `
          select id, currency_code, currency_name, symbol, decimal_precision
          from currencies
          where is_active = true
          order by currency_code asc
        `
      ),
      pool
        .query(`select to_regclass('public.exchange_rates') is not null as ready`)
        .then((r) =>
          r.rows[0]?.ready
            ? pool.query(
                `
                  select id, from_currency_id, to_currency_id, rate_value, rate_date, source_type
                  from exchange_rates
                  where coalesce(is_active, true) = true
                  order by rate_date desc nulls last, id desc
                `
              )
            : { rows: [] }
        ),
      pool.query(
        `
          select id, incoterm_code, incoterm_name
          from incoterms
          where is_active = true
          order by incoterm_code asc
        `
      ),
      pool.query(
        `
          select id, term_code, term_name, credit_days
          from payment_terms
          where is_active = true
          order by term_code asc
        `
      ),
      pool.query(
        `
          select id, term_code, term_name
          from freight_terms
          where is_active = true
          order by term_code asc
        `
      ),
      pool.query(
        `
          select id, term_code, term_name
          from p_and_f_terms
          where is_active = true
          order by term_code asc
        `
      ),
      pool.query(
        `
          select id, price_type_code, price_type_name, multiplier, sort_order
          from price_types
          where is_active = true
          order by sort_order asc, price_type_name asc
        `
      ),
      pool.query(
        `
          select id, iso_code, country_name
          from countries
          where is_active = true
          order by country_name asc
        `
      ),
      pool.query(
        `
          select
            s.id,
            s.country_id,
            c.iso_code as country_code,
            c.country_name,
            s.state_code,
            s.state_name
          from states s
          join countries c on c.id = s.country_id
          where s.is_active = true
          order by c.country_name asc, s.state_name asc
        `
      ),
      pool.query(
        `
          select
            ci.id,
            ci.country_id,
            ci.state_id,
            c.iso_code as country_code,
            c.country_name,
            s.state_code,
            s.state_name,
            ci.city_code,
            ci.city_name
          from cities ci
          join countries c on c.id = ci.country_id
          join states s on s.id = ci.state_id
          where ci.is_active = true
          order by c.country_name asc, s.state_name asc, ci.city_name asc
        `
      ),
      pool
        .query(`select to_regclass('public.quote_closure_reasons') is not null as ready`)
        .then((r) =>
          r.rows[0]?.ready
            ? pool.query(
                `
                  select id, reason_code, reason_name, sort_order,
                    case when reason_code = 'won_customer_po' then 'won' else 'lost' end as outcome_kind
                  from quote_closure_reasons
                  where is_active = true
                  order by sort_order asc, reason_name asc
                `
              )
            : { rows: [] }
        ),
      hasOfferTypeColumns(pool).then((ready) =>
        pool.query(
          `
            select id, sort_order, caption, default_description as description
              ${ready ? ", applies_to, spares_description" : ""}
            from terms_master
            where is_active = true
            order by sort_order asc, id asc
          `
        )
      ),
    ]);

    const activeCompanyId = getActiveCompanyId(_req);
    const pricingGuardrails = Number.isFinite(Number(activeCompanyId))
      ? await loadQuotePricingGuardrails(pool, activeCompanyId)
      : [];

    return res.json({
      ok: true,
      pricing_modes: [
        { key: "detailed", label: "Detailed" },
        { key: "bundled_total", label: "Bundled Total" },
        { key: "group_subtotals", label: "Group Subtotals" },
      ],
      allow_manual_line_entry: false,
      require_catalog_products_for_lines: true,
      allow_distributor_external_items: isDistributor,
      distributor_item_sourcing_mode: isDistributor ? "buy_external" : "",
      currencies: currenciesRes.rows,
      exchange_rates: exchangeRatesRes.rows,
      incoterms: incotermsRes.rows,
      payment_terms: paymentTermsRes.rows,
      freight_terms: freightTermsRes.rows,
      p_and_f_terms: pAndFTermsRes.rows,
      terms_master: termsMasterRes.rows,
      price_types: priceTypesRes.rows,
      pricing_guardrails: pricingGuardrails,
      countries: countriesRes.rows,
      states: statesRes.rows,
      cities: citiesRes.rows,
      quote_closure_reasons: closureReasonsRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

function parseQueryDate(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const dt = new Date(text);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function buildQuoteReportFilterSql({
  isDistributor,
  distributorId,
  activeCompanyId,
  userId,
  applyOwnRecords,
  scopeUserIds,
  dateFrom,
  dateTo,
  status,
  customerId,
  createdBy,
  groupId,
}) {
  const params = [];
  const filters = [];
  const effectiveQuoteDateExpr = `coalesce(qr.issued_at, qr.prepared_at, qh.created_at)`;

  if (isDistributor) {
    params.push(distributorId);
    filters.push(`qh.distributor_id = $${params.length}`);
  } else {
    if (Number.isFinite(activeCompanyId)) {
      params.push(activeCompanyId);
      filters.push(`qh.company_id = $${params.length}`);
    }
    if (applyOwnRecords) {
      params.push(Array.isArray(scopeUserIds) && scopeUserIds.length ? scopeUserIds : [userId]);
      filters.push(`coalesce(qh.owner_user_id, qh.created_by) = any($${params.length}::int[])`);
    }
  }

  if (dateFrom) {
    params.push(dateFrom.toISOString().slice(0, 10));
    filters.push(`${effectiveQuoteDateExpr}::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo.toISOString().slice(0, 10));
    filters.push(`${effectiveQuoteDateExpr}::date <= $${params.length}::date`);
  }
  if (status) {
    params.push(status);
    filters.push(`qh.quote_status = $${params.length}`);
  }
  if (Number.isFinite(customerId)) {
    params.push(customerId);
    filters.push(`qh.customer_id = $${params.length}`);
  }
  if (Number.isFinite(createdBy)) {
    params.push(createdBy);
    filters.push(`coalesce(qh.owner_user_id, qh.created_by) = $${params.length}`);
  }
  if (groupId !== undefined) {
    if (Number.isFinite(groupId)) {
      if (groupId === 0) filters.push(`p.group_id is null`);
      else {
        params.push(groupId);
        filters.push(`p.group_id = $${params.length}`);
      }
    } else {
      filters.push(`p.group_id is null`);
    }
  }

  return {
    params,
    where: filters.length ? `where ${filters.join(" and ")}` : "",
    effectiveQuoteDateExpr,
  };
}

router.get("/report/bootstrap", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const activeCompanyId = isDistributor ? null : getActiveCompanyId(req);

    const { params, where } = buildQuoteReportFilterSql({
      isDistributor,
      distributorId,
      activeCompanyId,
      userId: req.user.id,
      applyOwnRecords: ownRecordsOnly(req, "quotes"),
      scopeUserIds: quoteScopeUserIdList(req),
    });

    const [customersRes, usersRes] = await Promise.all([
      pool.query(
        `
          select distinct c.id, c.customer_name
          from quote_headers qh
          join customers c on c.id = qh.customer_id
          ${where}
          order by c.customer_name asc
          limit 2000
        `,
        params
      ),
      pool.query(
        `
          select distinct u.id, u.full_name
          from quote_headers qh
          join erp_users u on u.id = coalesce(qh.owner_user_id, qh.created_by)
          ${where}
          order by u.full_name asc
        `,
        params
      ),
    ]);

    return res.json({
      ok: true,
      statuses: ["draft", "pending_approval", "approved", "issued", "sent", "converted", "closed", "cancelled"],
      customers: customersRes.rows,
      users: usersRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/report", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const activeCompanyId = isDistributor ? null : getActiveCompanyId(req);

    const dateFrom = parseQueryDate(req.query.date_from);
    const dateTo = parseQueryDate(req.query.date_to);
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const customerId = Number(req.query.customer_id);
    const createdBy = Number(req.query.created_by);

    const { params, where, effectiveQuoteDateExpr } = buildQuoteReportFilterSql({
      isDistributor,
      distributorId,
      activeCompanyId,
      userId: req.user.id,
      applyOwnRecords: ownRecordsOnly(req, "quotes"),
      scopeUserIds: quoteScopeUserIdList(req),
      dateFrom,
      dateTo,
      status,
      customerId,
      createdBy,
    });

    const [registerRes, groupRes, productRes, funnelRes] = await Promise.all([
      pool.query(
        `
          select
            qh.id,
            qh.quote_number,
            qh.quote_status,
            qh.created_at,
            qh.updated_at,
            ${effectiveQuoteDateExpr} as effective_quote_date,
            qh.customer_id,
            c.customer_name,
            qh.company_id,
            co.company_code,
            coalesce(qh.owner_user_id, qh.created_by) as created_by,
            u.full_name as created_by_name,
            qr.id as revision_id,
            qr.revision_no,
            qr.revision_status,
            qr.grand_total_quote,
            qr.quote_currency_id,
            cur.currency_code
          from quote_headers qh
          join customers c on c.id = qh.customer_id
          left join companies co on co.id = qh.company_id
          left join erp_users u on u.id = coalesce(qh.owner_user_id, qh.created_by)
          left join quote_revisions qr
            on qr.quote_id = qh.id
           and qr.is_latest = true
          left join currencies cur on cur.id = qr.quote_currency_id
          ${where}
          order by effective_quote_date desc, qh.id desc
          limit 500
        `,
        params
      ),
      pool.query(
        `
          select
            pg.id as group_id,
            coalesce(pg.group_name, 'Ungrouped') as group_name,
            count(distinct qh.id) as quote_count,
            coalesce(sum(l.qty), 0) as total_qty,
            coalesce(sum(l.line_total_quote), 0) as total_amount_quote
          from quote_headers qh
          left join quote_revisions qr
            on qr.quote_id = qh.id
           and qr.is_latest = true
          join quote_lines l on l.quote_revision_id = qr.id
          left join products p on p.id = l.product_id
          left join product_groups pg on pg.id = p.group_id
          ${where}
          group by pg.id, pg.group_name
          order by total_amount_quote desc nulls last, group_name asc
          limit 200
        `,
        params
      ),
      pool.query(
        `
          select
            p.id as product_id,
            coalesce(l.item_code, p.item_code) as item_code,
            coalesce(l.item_name, p.item_name) as item_name,
            pg.id as group_id,
            coalesce(pg.group_name, 'Ungrouped') as group_name,
            count(distinct qh.id) as quote_count,
            coalesce(sum(l.qty), 0) as total_qty,
            coalesce(sum(l.line_total_quote), 0) as total_amount_quote
          from quote_headers qh
          left join quote_revisions qr
            on qr.quote_id = qh.id
           and qr.is_latest = true
          join quote_lines l on l.quote_revision_id = qr.id
          left join products p on p.id = l.product_id
          left join product_groups pg on pg.id = p.group_id
          ${where}
          group by p.id, l.item_code, l.item_name, p.item_code, p.item_name, pg.id, pg.group_name
          order by total_amount_quote desc nulls last, item_name asc
          limit 300
        `,
        params
      ),
      pool.query(
        `
          select
            status,
            count(*) as lead_count
          from leads
          where (coalesce(legacy_created_at, created_at))::date >= coalesce($1::date, date '1900-01-01')
            and (coalesce(legacy_created_at, created_at))::date <= coalesce($2::date, current_date)
            ${activeCompanyId ? "and company_id = $3" : ""}
          group by status
          order by lead_count desc
        `,
        activeCompanyId
          ? [
              dateFrom ? dateFrom.toISOString().slice(0, 10) : null,
              dateTo ? dateTo.toISOString().slice(0, 10) : null,
              activeCompanyId,
            ]
          : [
              dateFrom ? dateFrom.toISOString().slice(0, 10) : null,
              dateTo ? dateTo.toISOString().slice(0, 10) : null,
            ]
      ),
    ]);

    const totals = registerRes.rows.reduce(
      (acc, row) => {
        acc.quote_count += 1;
        const amount = Number(row.grand_total_quote || 0);
        if (Number.isFinite(amount)) acc.total_amount_quote += amount;
        return acc;
      },
      { quote_count: 0, total_amount_quote: 0 }
    );

    return res.json({
      ok: true,
      totals,
      register: registerRes.rows,
      groups: groupRes.rows,
      products: productRes.rows,
      funnel: funnelRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/report/group-detail", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const activeCompanyId = isDistributor ? null : getActiveCompanyId(req);

    const dateFrom = parseQueryDate(req.query.date_from);
    const dateTo = parseQueryDate(req.query.date_to);
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const customerId = Number(req.query.customer_id);
    const createdBy = Number(req.query.created_by);
    const groupIdRaw = String(req.query.group_id || "").trim();
    const groupId = groupIdRaw === "" ? null : Number(groupIdRaw);

    const { params, where, effectiveQuoteDateExpr } = buildQuoteReportFilterSql({
      isDistributor,
      distributorId,
      activeCompanyId,
      userId: req.user.id,
      applyOwnRecords: ownRecordsOnly(req, "quotes"),
      scopeUserIds: quoteScopeUserIdList(req),
      dateFrom,
      dateTo,
      status,
      customerId,
      createdBy,
      groupId,
    });

    const [quotesRes, itemsRes] = await Promise.all([
      pool.query(
        `
          select
            qh.id,
            qh.quote_number,
            qh.quote_status,
            qh.created_at,
            ${effectiveQuoteDateExpr} as effective_quote_date,
            qh.customer_id,
            c.customer_name,
            coalesce(qh.owner_user_id, qh.created_by) as created_by,
            u.full_name as created_by_name,
            qr.grand_total_quote,
            cur.currency_code
          from quote_headers qh
          join customers c on c.id = qh.customer_id
          left join erp_users u on u.id = coalesce(qh.owner_user_id, qh.created_by)
          left join quote_revisions qr
            on qr.quote_id = qh.id
           and qr.is_latest = true
          left join quote_lines l on l.quote_revision_id = qr.id
          left join products p on p.id = l.product_id
          left join currencies cur on cur.id = qr.quote_currency_id
          ${where}
          group by qh.id, c.customer_name, u.full_name, qr.grand_total_quote, cur.currency_code
          order by effective_quote_date desc, qh.id desc
          limit 200
        `,
        params
      ),
      pool.query(
        `
          select
            qh.id as quote_id,
            qh.quote_number,
            c.customer_name,
            l.line_no,
            coalesce(l.item_code, p.item_code) as item_code,
            coalesce(l.item_name, p.item_name) as item_name,
            l.qty,
            l.unit_price_quote,
            l.gst_pct,
            l.line_total_quote,
            coalesce(pg.group_name, 'Ungrouped') as group_name
          from quote_headers qh
          join customers c on c.id = qh.customer_id
          left join quote_revisions qr
            on qr.quote_id = qh.id
           and qr.is_latest = true
          join quote_lines l on l.quote_revision_id = qr.id
          left join products p on p.id = l.product_id
          left join product_groups pg on pg.id = p.group_id
          ${where}
          order by ${effectiveQuoteDateExpr} desc, qh.id desc, l.line_no asc
          limit 2000
        `,
        params
      ),
    ]);

    return res.json({ ok: true, quotes: quotesRes.rows, items: itemsRes.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/report/win-loss", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const activeCompanyId = isDistributor ? null : getActiveCompanyId(req);
    const dateFrom = parseQueryDate(req.query.date_from);
    const dateTo = parseQueryDate(req.query.date_to);
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const customerId = Number(req.query.customer_id);
    const createdBy = Number(req.query.created_by);

    const { params, where, effectiveQuoteDateExpr } = buildQuoteReportFilterSql({
      isDistributor,
      distributorId,
      activeCompanyId,
      userId: req.user.id,
      applyOwnRecords: ownRecordsOnly(req, "quotes"),
      scopeUserIds: quoteScopeUserIdList(req),
      dateFrom,
      dateTo,
      status,
      customerId: Number.isFinite(customerId) ? customerId : null,
      createdBy: Number.isFinite(createdBy) ? createdBy : null,
    });

    const [byReason, byOwner, byProduct] = await Promise.all([
      pool.query(
        `
          select
            coalesce(qcr.reason_code, 'unspecified') as reason_code,
            coalesce(qcr.reason_name, 'Unspecified') as reason_name,
            count(*)::int as quote_count,
            coalesce(sum(qr.grand_total_quote), 0)::numeric as total_amount_quote
          from quote_headers qh
          left join quote_revisions qr on qr.quote_id = qh.id and qr.is_latest = true
          left join quote_closure_reasons qcr on qcr.id = qh.closure_reason_id
          ${where}
            ${where ? "and" : "where"} qh.quote_status = 'closed'
          group by coalesce(qcr.reason_code, 'unspecified'), coalesce(qcr.reason_name, 'Unspecified')
          order by quote_count desc, reason_name asc
        `,
        params
      ),
      pool.query(
        `
          select
            coalesce(qh.owner_user_id, qh.created_by) as owner_user_id,
            coalesce(u.full_name, 'Unassigned') as owner_name,
            count(*) filter (where qh.quote_status = 'converted')::int as won_count,
            count(*) filter (where qh.quote_status = 'closed')::int as lost_count,
            coalesce(sum(qr.grand_total_quote) filter (where qh.quote_status = 'converted'), 0)::numeric as won_amount,
            coalesce(sum(qr.grand_total_quote) filter (where qh.quote_status = 'closed'), 0)::numeric as lost_amount
          from quote_headers qh
          left join quote_revisions qr on qr.quote_id = qh.id and qr.is_latest = true
          left join erp_users u on u.id = coalesce(qh.owner_user_id, qh.created_by)
          ${where}
            ${where ? "and" : "where"} qh.quote_status in ('converted', 'closed')
          group by coalesce(qh.owner_user_id, qh.created_by), coalesce(u.full_name, 'Unassigned')
          order by (count(*) filter (where qh.quote_status = 'converted')) desc, owner_name asc
        `,
        params
      ),
      pool.query(
        `
          select
            coalesce(p.id, 0) as product_id,
            coalesce(nullif(trim(p.item_code), ''), nullif(trim(ql.item_code), ''), 'UNKNOWN') as item_code,
            coalesce(nullif(trim(p.item_name), ''), nullif(trim(ql.item_name), ''), 'Unknown item') as item_name,
            count(distinct qh.id) filter (where qh.quote_status = 'converted')::int as won_count,
            count(distinct qh.id) filter (where qh.quote_status = 'closed')::int as lost_count,
            coalesce(sum(ql.line_total_quote) filter (where qh.quote_status = 'converted'), 0)::numeric as won_amount,
            coalesce(sum(ql.line_total_quote) filter (where qh.quote_status = 'closed'), 0)::numeric as lost_amount
          from quote_headers qh
          left join quote_revisions qr on qr.quote_id = qh.id and qr.is_latest = true
          join quote_lines ql on ql.quote_revision_id = qr.id
          left join products p on p.id = ql.product_id
          ${where}
            ${where ? "and" : "where"} qh.quote_status in ('converted', 'closed')
          group by coalesce(p.id, 0),
                   coalesce(nullif(trim(p.item_code), ''), nullif(trim(ql.item_code), ''), 'UNKNOWN'),
                   coalesce(nullif(trim(p.item_name), ''), nullif(trim(ql.item_name), ''), 'Unknown item')
          order by (count(distinct qh.id) filter (where qh.quote_status = 'closed')) desc, item_name asc
          limit 100
        `,
        params
      ),
    ]);

    return res.json({
      ok: true,
      by_reason: byReason.rows,
      by_owner: byOwner.rows,
      by_product: byProduct.rows,
      effective_date_expr: effectiveQuoteDateExpr,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/customers/:customerId/job-assets", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isFinite(customerId) || customerId <= 0) return res.status(400).json({ ok: false, error: "CUSTOMER_ID_INVALID" });

  const companyId = getActiveCompanyId(req);
  if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

  try {
    await ensureCustomerCompanyAccess(pool, req, customerId);
    const { rows } = await pool.query(
      `
        select
          ja.id,
          ja.job_id,
          ja.serial_no,
          ja.asset_code,
          ja.asset_name,
          ja.asset_status,
          ja.finished_good_product_id,
          ja.finished_good_item_code,
          ja.finished_good_item_name,
          ja.installation_date,
          ja.commissioning_date,
          ja.warranty_start_date,
          ja.warranty_end_date,
          ja.site_name,
          ja.site_address,
          ja.sales_order_id,
          ja.dispatch_id,
          ja.job_card_id,
          so.so_number,
          d.dispatch_number,
          coalesce(bom.line_count, 0) as installed_bom_line_count,
          coalesce(mapped.recommended_spare_count, 0) as recommended_spare_count
        from job_assets ja
        left join sales_orders so on so.id = ja.sales_order_id
        left join dispatches d on d.id = ja.dispatch_id
        left join (
          select job_asset_id, count(*)::integer as line_count
          from job_asset_bom_lines
          group by job_asset_id
        ) bom on bom.job_asset_id = ja.id
        left join (
          select
            jabl.job_asset_id,
            count(distinct pam.replacement_product_id)::integer as recommended_spare_count
          from job_asset_bom_lines jabl
          join products parent_p
            on parent_p.id = jabl.installed_product_id
            or (jabl.installed_product_id is null and parent_p.item_code = jabl.installed_item_code)
          join product_aftermarket_mappings pam
            on pam.company_id = $2
           and pam.parent_product_id = parent_p.id
           and pam.is_active = true
           and pam.is_recommended = true
          group by jabl.job_asset_id
        ) mapped on mapped.job_asset_id = ja.id
        where ja.company_id = $2
          and ja.customer_id = $1
        order by coalesce(ja.installation_date, ja.commissioning_date) desc nulls last, ja.serial_no asc, ja.id desc
      `,
      [customerId, companyId]
    );

    return res.json({ ok: true, job_assets: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/job-assets/:jobAssetId", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const asset = await getJobAssetOrThrow(pool, req, req.params.jobAssetId);
    const [bomRes, linkedCasesRes, linkedAmcRes] = await Promise.all([
      pool.query(
        `
          select
            jabl.id,
            jabl.line_no,
            jabl.installed_product_id,
            jabl.installed_item_code,
            jabl.installed_item_name,
            jabl.uom,
            jabl.qty_installed,
            jabl.remarks,
            jabl.source_kind
          from job_asset_bom_lines jabl
          where jabl.job_asset_id = $1
          order by jabl.line_no asc, jabl.id asc
        `,
        [asset.id]
      ),
      pool.query(
        `
          select id, case_number, case_status, issue_type, case_date
          from service_warranty_cases
          where customer_id = $1
            and (sales_order_id = $2 or dispatch_id = $3)
          order by case_date desc nulls last, id desc
          limit 10
        `,
        [asset.customer_id, asset.sales_order_id || null, asset.dispatch_id || null]
      ),
      pool.query(
        `
          select id, contract_number, contract_status, start_date, end_date
          from amc_contracts
          where customer_id = $1
            and (sales_order_id = $2 or dispatch_id = $3)
          order by end_date desc nulls last, id desc
          limit 10
        `,
        [asset.customer_id, asset.sales_order_id || null, asset.dispatch_id || null]
      ),
    ]);

    return res.json({
      ok: true,
      job_asset: asset,
      installed_bom_lines: bomRes.rows,
      linked_warranty_cases: linkedCasesRes.rows,
      linked_amc_contracts: linkedAmcRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/job-assets/:jobAssetId/recommended-spares", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const asset = await getJobAssetOrThrow(pool, req, req.params.jobAssetId);
    const companyId = Number(asset.company_id);

    const { rows } = await pool.query(
      `
        with installed_lines as (
          select
            jabl.id as job_asset_bom_line_id,
            jabl.line_no,
            jabl.installed_product_id,
            jabl.installed_item_code,
            jabl.installed_item_name,
            jabl.qty_installed,
            jabl.remarks,
            parent_p.id as parent_product_id,
            parent_p.item_code as parent_item_code,
            parent_p.item_name as parent_item_name
          from job_asset_bom_lines jabl
          join products parent_p
            on parent_p.id = jabl.installed_product_id
            or (jabl.installed_product_id is null and parent_p.item_code = jabl.installed_item_code)
          where jabl.job_asset_id = $1
        ),
        mapped as (
          select
            il.job_asset_bom_line_id,
            il.line_no,
            il.installed_product_id,
            il.installed_item_code,
            il.installed_item_name,
            il.qty_installed,
            il.remarks,
            il.parent_product_id,
            il.parent_item_code,
            il.parent_item_name,
            pam.replacement_product_id,
            pam.mapping_type,
            pam.qty_per_parent,
            pam.is_recommended,
            pam.is_mandatory,
            pam.service_interval_hours,
            pam.service_interval_days,
            pam.notes,
            rp.item_code as replacement_item_code,
            rp.item_name as replacement_item_name,
            rp.uom as replacement_uom,
            rp.hsn_no as replacement_hsn_no,
            rp.gst_pct as replacement_gst_pct,
            rp.list_price as replacement_list_price,
            (il.qty_installed * pam.qty_per_parent)::numeric(18, 4) as recommended_qty
          from installed_lines il
          join product_aftermarket_mappings pam
            on pam.company_id = $2
           and pam.parent_product_id = il.parent_product_id
           and pam.is_active = true
           and pam.is_recommended = true
          join products rp on rp.id = pam.replacement_product_id
          left join company_product_policies cpp
            on cpp.company_id = $2
           and cpp.product_id = rp.id
          where rp.is_active = true
            and coalesce(cpp.sourcing_mode, '') <> 'blocked'
            and coalesce(cpp.is_saleable, true) = true
        )
        select
          m.replacement_product_id as product_id,
          m.replacement_item_code as item_code,
          m.replacement_item_name as item_name,
          m.replacement_uom as uom,
          m.replacement_hsn_no as hsn_no,
          m.replacement_gst_pct as gst_pct,
          m.replacement_list_price as list_price,
          m.mapping_type,
          bool_or(m.is_mandatory) as is_mandatory,
          min(m.service_interval_hours) as service_interval_hours,
          min(m.service_interval_days) as service_interval_days,
          sum(m.recommended_qty)::numeric(18, 4) as qty_recommended,
          jsonb_agg(
            jsonb_build_object(
              'job_asset_bom_line_id', m.job_asset_bom_line_id,
              'line_no', m.line_no,
              'installed_product_id', m.installed_product_id,
              'installed_item_code', m.installed_item_code,
              'installed_item_name', m.installed_item_name,
              'qty_installed', m.qty_installed,
              'qty_per_parent', m.qty_per_parent,
              'recommended_qty', m.recommended_qty,
              'notes', m.notes,
              'remarks', m.remarks
            )
            order by m.line_no asc, m.job_asset_bom_line_id asc
          ) as source_lines
        from mapped m
        group by
          m.replacement_product_id,
          m.replacement_item_code,
          m.replacement_item_name,
          m.replacement_uom,
          m.replacement_hsn_no,
          m.replacement_gst_pct,
          m.replacement_list_price,
          m.mapping_type
        order by m.replacement_item_name asc, m.replacement_item_code asc
      `,
      [asset.id, companyId]
    );

    return res.json({
      ok: true,
      job_asset: {
        id: asset.id,
        customer_id: asset.customer_id,
        customer_name: asset.customer_name,
        job_id: asset.job_id,
        serial_no: asset.serial_no,
        asset_code: asset.asset_code,
        asset_name: asset.asset_name,
        asset_status: asset.asset_status,
        finished_good_product_id: asset.finished_good_product_id,
        finished_good_item_code: asset.finished_good_item_code,
        finished_good_item_name: asset.finished_good_item_name,
        so_number: asset.so_number,
        dispatch_number: asset.dispatch_number,
      },
      recommended_spares: rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/price-reference", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const customerId = Number(req.query.customer_id);
    const productIds = String(req.query.product_ids || req.query.product_id || "")
      .split(",")
      .map((value) => Number(value))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (!Number.isFinite(customerId) || customerId <= 0 || !productIds.length) {
      return res.json({ ok: true, hints: {} });
    }

    const hints = {};
    for (const productId of productIds.slice(0, 40)) {
      const lastQuoted = await pool.query(
        `
          select
            ql.unit_price_quote,
            qh.quote_number,
            qh.quote_status,
            coalesce(qr.issued_at, qh.updated_at) as quoted_at
          from quote_lines ql
          join quote_revisions qr on qr.id = ql.quote_revision_id
          join quote_headers qh on qh.id = qr.quote_id
          where qh.customer_id = $1
            and ql.product_id = $2
            and qh.quote_status in ('issued', 'sent', 'converted', 'closed', 'approved')
          order by coalesce(qr.issued_at, qh.updated_at) desc nulls last, qh.id desc
          limit 1
        `,
        [customerId, productId]
      );
      const lastSold = await pool.query(
        `
          select
            il.unit_price_invoice,
            ci.invoice_number,
            ci.invoice_date
          from invoice_lines il
          join customer_invoices ci on ci.id = il.customer_invoice_id
          where ci.customer_id = $1
            and il.product_id = $2
            and ci.invoice_status not in ('cancelled', 'draft')
          order by ci.invoice_date desc nulls last, ci.id desc
          limit 1
        `,
        [customerId, productId]
      );
      hints[String(productId)] = {
        last_quoted_unit: lastQuoted.rows[0] ? Number(lastQuoted.rows[0].unit_price_quote) : null,
        last_quoted_number: lastQuoted.rows[0]?.quote_number || null,
        last_quoted_at: lastQuoted.rows[0]?.quoted_at || null,
        last_sold_unit: lastSold.rows[0] ? Number(lastSold.rows[0].unit_price_invoice) : null,
        last_sold_number: lastSold.rows[0]?.invoice_number || null,
        last_sold_at: lastSold.rows[0]?.invoice_date || null,
      };
    }

    return res.json({ ok: true, hints });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/revisions/compare", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const hasLeadTimeCols = await hasQuoteRevisionColumn(pool, "delivery_lead_time_days");
    const revisionsRes = await pool.query(
      hasLeadTimeCols
        ? `
        select id, revision_no, revision_status, issued_at, prepared_at, payment_term_id, freight_term_id, incoterm_id, p_and_f_term_id,
          delivery_lead_time_days, warranty_months
        from quote_revisions
        where quote_id = $1
        order by revision_no desc
      `
        : `
        select id, revision_no, revision_status, issued_at, prepared_at, payment_term_id, freight_term_id, incoterm_id, p_and_f_term_id
        from quote_revisions
        where quote_id = $1
        order by revision_no desc
      `,
      [quoteId]
    );
    const revisions = revisionsRes.rows;
    if (revisions.length < 2) {
      return res.json({ ok: true, quote, from_revision: revisions[0] || null, to_revision: revisions[0] || null, lines: { added: [], removed: [], changed: [] } });
    }

    const toNo = Number(req.query.to || revisions[0].revision_no);
    const fromNo = Number(req.query.from || revisions[1].revision_no);
    const toRevision = revisions.find((row) => Number(row.revision_no) === toNo) || revisions[0];
    const fromRevision = revisions.find((row) => Number(row.revision_no) === fromNo) || revisions[1];
    const [fromLines, toLines] = await Promise.all([
      getRevisionLines(pool, fromRevision.id),
      getRevisionLines(pool, toRevision.id),
    ]);

    return res.json({
      ok: true,
      quote,
      from_revision: fromRevision,
      to_revision: toRevision,
      lines: summarizeRevisionDiff(fromLines, toLines),
      commercial: {
        payment_term_changed: Number(fromRevision.payment_term_id || 0) !== Number(toRevision.payment_term_id || 0),
        freight_term_changed: Number(fromRevision.freight_term_id || 0) !== Number(toRevision.freight_term_id || 0),
        incoterm_changed: Number(fromRevision.incoterm_id || 0) !== Number(toRevision.incoterm_id || 0),
        p_and_f_term_changed: Number(fromRevision.p_and_f_term_id || 0) !== Number(toRevision.p_and_f_term_id || 0),
        delivery_lead_time_changed:
          Number(fromRevision.delivery_lead_time_days || 0) !== Number(toRevision.delivery_lead_time_days || 0),
        warranty_months_changed: Number(fromRevision.warranty_months || 0) !== Number(toRevision.warranty_months || 0),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.patch("/:id/cadence", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const hasValidTill = Object.prototype.hasOwnProperty.call(body, "quote_valid_till");
    const hasFollowUp = Object.prototype.hasOwnProperty.call(body, "next_follow_up_at");
    const hasKind = Object.prototype.hasOwnProperty.call(body, "quote_kind");
    if (!hasValidTill && !hasFollowUp && !hasKind) {
      return res.status(400).json({ ok: false, error: "NO_FIELDS" });
    }

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    let quoteValidTill = quote.quote_valid_till || null;
    if (hasValidTill) {
      if (body.quote_valid_till === null || body.quote_valid_till === "") {
        quoteValidTill = null;
      } else {
        const raw = String(body.quote_valid_till).trim();
        const parsed = parseQueryDate(raw) || raw;
        quoteValidTill = parsed || null;
      }
    }

    let nextFollowUpAt = quote.next_follow_up_at || null;
    if (hasFollowUp) {
      if (body.next_follow_up_at === null || body.next_follow_up_at === "") {
        nextFollowUpAt = null;
      } else {
        const stamp = new Date(body.next_follow_up_at);
        if (Number.isNaN(stamp.getTime())) {
          return res.status(400).json({ ok: false, error: "INVALID_FOLLOW_UP" });
        }
        nextFollowUpAt = stamp.toISOString();
      }
    }

    let quoteKind = quote.quote_kind || "firm";
    if (hasKind) {
      const kind = typeof body.quote_kind === "string" ? body.quote_kind.trim().toLowerCase() : "";
      if (!["budgetary", "firm"].includes(kind)) {
        return res.status(400).json({ ok: false, error: "INVALID_QUOTE_KIND" });
      }
      quoteKind = kind;
    }

    const { rows } = await pool.query(
      `
        update quote_headers
        set
          quote_valid_till = $2,
          next_follow_up_at = $3,
          quote_kind = $4,
          updated_at = now()
        where id = $1
        returning id, quote_number, quote_valid_till, next_follow_up_at, quote_kind, quote_status, updated_at
      `,
      [quoteId, quoteValidTill, nextFollowUpAt, quoteKind]
    );

    return res.json({ ok: true, quote: rows[0] });
  } catch (err) {
    return next(err);
  }
});

// body.offer_type: "completes" | "spares" (locks the choice) or "auto" (follow the quote lines).
router.put("/:id/offer-type", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });
    const raw = String(req.body?.offer_type || "").trim().toLowerCase();
    const isAuto = raw === "auto";
    const requested = normalizeOfferType(raw);
    if (!isAuto && !requested) return res.status(400).json({ ok: false, error: "INVALID_OFFER_TYPE" });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");
    if (!(await hasOfferTypeColumns(client))) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "OFFER_TYPE_NOT_READY", detail: "Run migration 199 first." });
    }
    const quote = await getQuoteHeaderOrNull(client, { quoteId, distributorId: isDistributor ? distributorId : null });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }
    if (revision.revision_status !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_EDITABLE" });
    }

    if (isAuto) {
      const detected = detectOfferTypeFromLines(await getRevisionLines(client, revision.id));
      await setQuoteOfferType(client, {
        quoteId,
        revisionId: revision.id,
        offerType: detected || quote.offer_type,
        source: "auto",
      });
    } else {
      await setQuoteOfferType(client, { quoteId, revisionId: revision.id, offerType: requested, source: "manual" });
    }

    const refreshed = await getQuoteHeaderOrNull(client, { quoteId, distributorId: isDistributor ? distributorId : null });
    const terms = await getRevisionTerms(client, revision.id);
    await client.query("commit");
    return res.json({ ok: true, quote: refreshed, revision_id: revision.id, terms });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await stampExpiredQuotes(pool, {
      companyId: isDistributor ? null : getActiveCompanyId(req),
      distributorId: isDistributor ? distributorId : null,
    });

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const revision = await getLatestRevisionOrNull(pool, id);
    const lines = revision ? await getRevisionLines(pool, revision.id) : [];

    let salesOrder = null;
    if (revision?.id) {
      const soRes = await pool.query(
        `select id, so_number, order_status from sales_orders where quote_revision_id = $1 order by id desc limit 1`,
        [revision.id]
      );
      salesOrder = soRes.rows[0] || null;
    }

    return res.json({
      ok: true,
      quote,
      revision,
      lines,
      sales_order_id: salesOrder?.id || null,
      sales_order: salesOrder,
    });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id/commercial", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const attentionTo = typeof body.attention_to === "string" ? body.attention_to.trim() : "";
    const pricingDisplayMode =
      typeof body.pricing_display_mode === "string" ? body.pricing_display_mode.trim() : "";
    const isExport = body.is_export === true || body.is_export === "true";
    const incotermId = body.incoterm_id === null || body.incoterm_id === "" ? null : Number(body.incoterm_id);
    const baseCurrencyId = Number(body.base_currency_id);
    const quoteCurrencyId = Number(body.quote_currency_id);
    const paymentTermId =
      body.payment_term_id === null || body.payment_term_id === "" ? null : Number(body.payment_term_id);
    const freightTermId =
      body.freight_term_id === null || body.freight_term_id === "" ? null : Number(body.freight_term_id);
    const pAndFTermId =
      body.p_and_f_term_id === null || body.p_and_f_term_id === "" ? null : Number(body.p_and_f_term_id);
    const requestedCustomerId =
      body.customer_id === null || body.customer_id === "" || body.customer_id === undefined ? null : Number(body.customer_id);
    const customerSiteId =
      body.customer_site_id === null || body.customer_site_id === "" ? null : Number(body.customer_site_id);
    const requestedJobAssetId =
      body.job_asset_id === null || body.job_asset_id === "" || body.job_asset_id === undefined ? null : Number(body.job_asset_id);
    const buyerPoNumber = normalizeNullableText(body.buyer_po_number);
    const buyerPoDate = normalizeOptionalDateValue(body.buyer_po_date);
    const poExceptionReason = normalizeNullableText(body.po_exception_reason);
    const endCustomerName = normalizeNullableText(body.end_customer_name);
    const endCustomerPoNumber = normalizeNullableText(body.end_customer_po_number);
    const endCustomerPoDate = normalizeOptionalDateValue(body.end_customer_po_date);
    const requestedShipToCustomerSiteId =
      body.ship_to_customer_site_id === null || body.ship_to_customer_site_id === "" || body.ship_to_customer_site_id === undefined
        ? null
        : Number(body.ship_to_customer_site_id);
    const billToName = normalizeNullableText(body.bill_to_name);
    const billToAddress = normalizeNullableText(body.bill_to_address);
    const shipToName = normalizeNullableText(body.ship_to_name);
    const shipToAddress = normalizeNullableText(body.ship_to_address);
    const deliveryLeadTimeDays = parseOptionalNonNegativeInt(body.delivery_lead_time_days);
    const warrantyMonths = parseOptionalNonNegativeInt(body.warranty_months);
    if (
      (body.delivery_lead_time_days !== null &&
        body.delivery_lead_time_days !== undefined &&
        body.delivery_lead_time_days !== "" &&
        deliveryLeadTimeDays === null) ||
      (body.warranty_months !== null && body.warranty_months !== undefined && body.warranty_months !== "" && warrantyMonths === null)
    ) {
      return res.status(400).json({ ok: false, error: "INVALID_LEAD_TIME_OR_WARRANTY" });
    }

    if (!["detailed", "bundled_total", "group_subtotals"].includes(pricingDisplayMode)) {
      return res.status(400).json({ ok: false, error: "INVALID_PRICING_MODE" });
    }
    if (!Number.isFinite(baseCurrencyId) || !Number.isFinite(quoteCurrencyId)) {
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }
    if (requestedCustomerId !== null && (!Number.isFinite(requestedCustomerId) || requestedCustomerId <= 0)) {
      return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    }

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const requestedOrderFlow = normalizeOrderFlowValue(body.order_flow, quote?.distributor_id ? "distributor" : "direct");
    const requestedFulfillmentMode = normalizeFulfillmentModeValue(
      body.fulfillment_mode,
      requestedOrderFlow === "distributor" ? "stock_sale" : "direct_customer"
    );

    const revision = await getLatestRevisionOrNull(client, id);
    if (!revision) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "REVISION_NOT_FOUND" });
    }
    if (revision.revision_status !== "draft") {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "REVISION_NOT_EDITABLE" });
    }

    const effectiveCustomerId = requestedCustomerId || quote.customer_id;
    if (isDistributor && Number(effectiveCustomerId) !== Number(quote.customer_id)) {
      const linkRes = await client.query(
        `
          select 1
          from customer_distributor_links
          where customer_id = $1 and distributor_id = $2
          limit 1
        `,
        [effectiveCustomerId, distributorId]
      );
      if (!linkRes.rows.length) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "CUSTOMER_NOT_ALLOWED" });
      }
    }

    const orderCaptureError = validateOrderCapture({
      orderFlow: requestedOrderFlow,
      fulfillmentMode: requestedFulfillmentMode,
      distributorId: quote.distributor_id,
      buyerPoNumber,
      poExceptionReason,
      endCustomerName,
    });
    if (orderCaptureError) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: orderCaptureError });
    }

    const resolvedCustomerSiteId = await resolveQuoteCustomerSiteId(client, {
      customerId: effectiveCustomerId,
      customerSiteId,
    });
    const resolvedShipToCustomerSiteId = await resolveQuoteShipToSiteId(client, {
      customerId: effectiveCustomerId,
      customerSiteId: requestedShipToCustomerSiteId || resolvedCustomerSiteId,
    });
    const jobAssetContext = await resolveQuoteJobAssetContext(client, req, {
      customerId: effectiveCustomerId,
      jobAssetId: requestedJobAssetId,
    });
    await resolveAftermarketQuoteContext(client, req, {
      customerId: effectiveCustomerId,
      serviceWarrantyCaseId: quote.service_warranty_case_id,
      amcContractId: quote.amc_contract_id,
    });
    const partySnapshots = await buildQuotePartySnapshots(client, {
      customerId: effectiveCustomerId,
      distributorId: quote.distributor_id,
      orderFlow: requestedOrderFlow,
      fulfillmentMode: requestedFulfillmentMode,
      shipToCustomerSiteId: resolvedShipToCustomerSiteId,
      billToName,
      billToAddress,
      shipToName,
      shipToAddress,
      endCustomerName,
    });

    await client.query(
      `
        update quote_headers
        set
          customer_id = $1,
          attention_to = $2,
          customer_site_id = $3,
          job_asset_id = $4,
          quote_job_id = $5,
          quote_serial_no = $6,
          order_flow = $7,
          fulfillment_mode = $8,
          buyer_po_number = $9,
          buyer_po_date = $10,
          po_exception_reason = $11,
          end_customer_name = $12,
          end_customer_po_number = $13,
          end_customer_po_date = $14,
          ship_to_customer_site_id = $15,
          bill_to_name = $16,
          bill_to_address = $17,
          ship_to_name = $18,
          ship_to_address = $19,
          updated_at = now()
        where id = $20
      `,
      [
        effectiveCustomerId,
        attentionTo || null,
        resolvedCustomerSiteId,
        jobAssetContext.jobAssetId,
        jobAssetContext.quoteJobId,
        jobAssetContext.quoteSerialNo,
        requestedOrderFlow,
        requestedFulfillmentMode,
        buyerPoNumber,
        buyerPoDate,
        poExceptionReason,
        endCustomerName,
        endCustomerPoNumber,
        endCustomerPoDate,
        resolvedShipToCustomerSiteId,
        partySnapshots.billToName,
        partySnapshots.billToAddress,
        partySnapshots.shipToName,
        partySnapshots.shipToAddress,
        id,
      ]
    );

    await client.query(
      `
        update quote_revisions
        set
          pricing_display_mode = $1,
          is_export = $2,
          incoterm_id = $3,
          base_currency_id = $4,
          quote_currency_id = $5,
          payment_term_id = $6,
          freight_term_id = $7,
          p_and_f_term_id = $8,
          tax_total_base = case when $2 then 0 else tax_total_base end,
          tax_total_quote = case when $2 then 0 else tax_total_quote end,
          grand_total_base = case when $2 then subtotal_base else grand_total_base end,
          grand_total_quote = case when $2 then subtotal_quote else grand_total_quote end
        where id = $9
      `,
      [
        pricingDisplayMode,
        isExport,
        Number.isFinite(incotermId) ? incotermId : null,
        baseCurrencyId,
        quoteCurrencyId,
        Number.isFinite(paymentTermId) ? paymentTermId : null,
        Number.isFinite(freightTermId) ? freightTermId : null,
        Number.isFinite(pAndFTermId) ? pAndFTermId : null,
        revision.id,
      ]
    );

    if (await hasQuoteRevisionColumn(client, "delivery_lead_time_days")) {
      await client.query(
        `
          update quote_revisions
          set
            delivery_lead_time_days = $2,
            warranty_months = $3
          where id = $1
        `,
        [revision.id, deliveryLeadTimeDays, warrantyMonths]
      );
    }

    const updatedRevision = await getLatestRevisionOrNull(client, id, { forUpdate: true });
    await recalcRevisionQuoteCurrencyAmounts(client, updatedRevision);
    await ensureRevisionTerms(client, revision.id);
    await syncCommercialDefaultsToRevisionTerms(client, revision.id);

    await recalcRevisionTotals(client, revision.id);
    await markRevisionEdited(client, revision.id, req.user.id);

    const refreshedQuote = await getQuoteHeaderOrNull(client, { quoteId: id, distributorId: isDistributor ? distributorId : null });
    const refreshedRevision = await getLatestRevisionOrNull(client, id);
    const refreshedLines = refreshedRevision ? await getRevisionLines(client, refreshedRevision.id) : [];
    await client.query("commit");
    return res.json({ ok: true, quote: refreshedQuote, revision: refreshedRevision, lines: refreshedLines });
  } catch (err) {
    await client.query("rollback");
    const explicitStatus = Number(err?.status);
    if (Number.isFinite(explicitStatus) && explicitStatus >= 400 && explicitStatus < 500) {
      return res.status(explicitStatus).json({
        ok: false,
        error: err?.message || "QUOTE_COMMERCIAL_SAVE_FAILED",
        detail: String(err?.message || "Failed to save quote commercial settings.").slice(0, 500),
        pg_code: err?.code || null,
      });
    }
    const detail = String(err?.detail || err?.message || "Failed to save quote lines.").slice(0, 500);
    const status = /^22|^23/.test(String(err?.code || "")) ? 400 : 500;
    return res.status(status).json({
      ok: false,
      error: err?.code === "23514" ? "INVALID_QUOTE_LINE_DATA" : "QUOTE_LINE_SAVE_FAILED",
      detail,
      pg_code: err?.code || null,
    });
  } finally {
    client.release();
  }
});

function getPsaRecommender(gasType) {
  return gasType === "oxygen" ? recommendOxygenModel : recommendNitrogenModel;
}

function parseLiters(value) {
  const m = String(value || "").match(/([0-9]+(?:\.\d+)?)\s*(?:LITERS?|LITRES?|LTR|L)\b/i);
  return m ? num(m[1]) : null;
}

async function makeProductCodeLine(client, { companyId, itemCode, itemName, productId = null }) {
  let prod = null;
  const pid = Number(productId);
  if (Number.isFinite(pid) && pid > 0) {
    prod = await getCompanyProductOrNull(client, { companyId, productId: pid, mode: "sale" });
    if (!prod) prod = await getCompanyProductOrNull(client, { companyId, productId: pid, mode: null });
  }
  if (!prod && itemCode) {
    prod = await getCompanyProductByItemCodeOrNull(client, { companyId, itemCode, mode: "sale" });
    if (!prod) prod = await getCompanyProductByItemCodeOrNull(client, { companyId, itemCode, mode: null });
  }
  if (!prod && itemName) {
    prod = await getCompanyProductByItemNameOrNull(client, { companyId, itemName, mode: "sale" });
    if (!prod) prod = await getCompanyProductByItemNameOrNull(client, { companyId, itemName, mode: null });
  }
  // Configurator model is often product item_name; also try using model text as a name lookup when code miss.
  if (!prod && itemCode && itemCode !== itemName) {
    prod = await getCompanyProductByItemNameOrNull(client, { companyId, itemName: itemCode, mode: "sale" });
    if (!prod) prod = await getCompanyProductByItemNameOrNull(client, { companyId, itemName: itemCode, mode: null });
  }
  const taxProfile = await resolveQuoteTaxProfile(client, { hsnNo: prod?.hsn_no, fallbackGstPct: prod?.gst_pct });
  return {
    product_id: prod?.id || null,
    item_code: prod?.item_code || itemCode || null,
    item_name: prod?.item_name || itemName || itemCode,
    hsn_no: taxProfile.hsn_no,
    gst_pct: taxProfile.gst_pct,
    unit_price: prod?.list_price || 0,
  };
}

async function makeProductNameLine(client, { companyId, itemName, fallbackName }) {
  const target = String(itemName || "").trim();
  if (!target) {
    return { product_id: null, item_code: null, item_name: fallbackName, hsn_no: null, gst_pct: 0, unit_price: 0 };
  }
  let prod = await getCompanyProductByItemNameOrNull(client, { companyId, itemName: target, mode: "sale" });
  if (!prod) prod = await getCompanyProductByItemNameOrNull(client, { companyId, itemName: target, mode: null });
  if (!prod) prod = await getCompanyProductByItemCodeOrNull(client, { companyId, itemCode: target, mode: "sale" });
  if (!prod) prod = await getCompanyProductByItemCodeOrNull(client, { companyId, itemCode: target, mode: null });
  const taxProfile = await resolveQuoteTaxProfile(client, { hsnNo: prod?.hsn_no, fallbackGstPct: prod?.gst_pct });
  return {
    product_id: prod?.id || null,
    item_code: prod?.item_code || null,
    item_name: prod?.item_name || fallbackName || target,
    hsn_no: taxProfile.hsn_no,
    gst_pct: taxProfile.gst_pct,
    unit_price: prod?.list_price || 0,
  };
}

async function listStorageVesselProducts(client, companyId) {
  const res = await client.query(
    `
      select
        p.id,
        p.item_code,
        p.item_name,
        p.hsn_no,
        p.gst_pct,
        p.list_price
      from products p
      join product_categories pc on pc.id = p.category_id
      left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $1
      where p.is_active = true
        and lower(coalesce(pc.category_name, '')) = 'storage vessel'
        and coalesce(cpp.sourcing_mode, '') <> 'blocked'
        and coalesce(cpp.is_saleable, true) = true
      order by p.item_name asc, p.id asc
    `,
    [Number(companyId)]
  );

  const resolvedRows = await Promise.all(
    res.rows.map(async (row) => {
      const taxProfile = await resolveQuoteTaxProfile(client, { hsnNo: row.hsn_no, fallbackGstPct: row.gst_pct });
      return {
        product_id: row.id,
        item_code: row.item_code,
        item_name: row.item_name,
        hsn_no: taxProfile.hsn_no,
        gst_pct: taxProfile.gst_pct,
        unit_price: row.list_price || 0,
        capacity_liters: parseLiters(row.item_name) ?? parseLiters(row.item_code),
      };
    })
  );

  return resolvedRows
    .filter((row) => row.capacity_liters !== null)
    .sort((a, b) => b.capacity_liters - a.capacity_liters || a.item_name.localeCompare(b.item_name));
}

function planStorageVesselBreakup(targetVolume, vessels) {
  const target = num(targetVolume);
  if (target === null || target <= 0 || !Array.isArray(vessels) || !vessels.length) return [];

  const smallest = vessels[vessels.length - 1]?.capacity_liters || 250;
  let remaining = Math.max(smallest, Math.ceil(target / smallest) * smallest);
  const plan = [];

  for (const vessel of vessels) {
    const capacity = num(vessel.capacity_liters);
    if (capacity === null || capacity <= 0 || remaining <= 0) continue;
    const qty = Math.floor(remaining / capacity);
    if (qty <= 0) continue;
    plan.push({ vessel, qty });
    remaining -= qty * capacity;
  }

  if (remaining > 0) {
    const fallbackVessel = vessels[vessels.length - 1];
    const extraQty = Math.ceil(remaining / fallbackVessel.capacity_liters);
    if (extraQty > 0) {
      const existing = plan.find((entry) => entry.vessel.product_id === fallbackVessel.product_id);
      if (existing) existing.qty += extraQty;
      else plan.push({ vessel: fallbackVessel, qty: extraQty });
    }
  }

  return plan;
}

function withDerivedPackageVolumes(selected, compressor) {
  if (!selected || typeof selected !== "object") return selected;
  return {
    ...selected,
    airVesselVolume: num(selected.airVesselVolume) ?? num(compressor?.dryAirStorageVolume),
  };
}

async function buildPsaPackageItems(client, { companyId, selected, compressor, packageMode = "full_package" }) {
  const mode = String(packageMode || "").trim();
  const generator = await makeProductCodeLine(client, {
    companyId,
    productId: selected?.product_id || null,
    itemCode: selected?.item_code || selected?.model,
    itemName: selected?.model,
  });
  const compressorScope = mode === "psa_only" ? "client_scope" : "included";
  const storageScope = mode === "psa_only" || mode === "psa_compressor" ? "client_scope" : "included";

  const storageCatalog = await listStorageVesselProducts(client, companyId);
  const storageBreakup = planStorageVesselBreakup(selected.storageVolume, storageCatalog);
  const compressorLine = await makeProductNameLine(client, {
    companyId,
    itemName: compressor?.compressorModel || "",
    fallbackName: compressor?.compressorModel
      ? `Compressed Air System - ${compressor.compressorModel}`
      : "Compressed Air System",
  });

  const airCfm = num(selected?.airRequirement);
  const airVessel = num(selected?.airVesselVolume) ?? num(compressor?.dryAirStorageVolume);
  const productStorage = num(selected?.storageVolume);
  const compressorRemarks =
    compressorScope === "client_scope"
      ? [
          "Client scope: compressed air package (air compressor, air dryer, air receiver and primary filter) to be supplied by client.",
          airCfm ? `Minimum dry air requirement: ${Math.ceil(airCfm)} CFM.` : "",
          airVessel ? `Air receiver: min ${Math.ceil(airVessel)} L.` : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "";
  const storageRemarks =
    storageScope === "client_scope"
      ? [
          "Client scope: product gas buffer storage tank to be supplied by client.",
          productStorage ? `Minimum capacity: ${Math.ceil(productStorage)} L.` : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "";

  const compressorRequirement = airCfm ? `Min ${Math.ceil(airCfm)} CFM dry air` : "";
  const storageRequirement = productStorage ? `Min ${Math.ceil(productStorage)} L` : "";

  return [
    { ...generator, qty: 1, scope_type: "included", scope_role: "psa_generator" },
    {
      ...compressorLine,
      qty: 1,
      scope_type: compressorScope,
      scope_role: "compressor_package",
      scope_requirement: compressorRequirement,
      remarks: compressorRemarks,
    },
    ...storageBreakup.map(({ vessel, qty }) => ({
      ...vessel,
      qty,
      scope_type: storageScope,
      scope_role: "product_storage",
      scope_requirement: storageRequirement,
      remarks: storageRemarks,
    })),
  ];
}

async function runPsaRecommend(req, res, next, { gasType, seriesSuffix = "" }) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const purity = body.purity;
    const requiredFlow = body.flow;
    const familyKey = String(body.family_key || "").trim().toUpperCase();
    const baseSeries =
      familyKey === "NGENX"
        ? "nGENX"
        : familyKey === "NGEN"
          ? "nGEN"
          : familyKey === "IDOS" || familyKey === "IDOS_C"
            ? "IDOS"
            : "";

    const rec = await getPsaRecommender(gasType)({ purity, requiredFlow, seriesSuffix, baseSeries, clientOrPool: pool });
    if (!rec.ok) return res.status(400).json({ ok: false, error: rec.error });

    const compressor = await recommendCompressor(rec.recommended?.airRequirement, { clientOrPool: pool });
    const recommended = withDerivedPackageVolumes(rec.recommended, compressor);

    return res.json({
      ok: true,
      gas_type: gasType,
      recommended,
      nearest: rec.nearest,
      lower: rec.lower,
      options: rec.options,
      compressor,
      used_family_fallback: rec.used_family_fallback === true,
      catalog_source_key: rec.catalog_source_key || "",
      catalog_source_label: rec.catalog_source_label || "",
    });
  } catch (err) {
    return next(err);
  }
}

async function runPsaApply(req, res, next, { gasType, seriesSuffix = "" }) {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const purity = body.purity;
    const requiredFlow = body.flow;
    const chosenModel = typeof body.model === "string" ? body.model.trim() : "";
    const bodyProductId = Number(body.product_id);
    const bodyItemCode = typeof body.item_code === "string" ? body.item_code.trim() : "";
    const familyKey = String(body.family_key || "").trim().toUpperCase();
    const baseSeries =
      familyKey === "NGENX"
        ? "nGENX"
        : familyKey === "NGEN"
          ? "nGEN"
          : familyKey === "IDOS" || familyKey === "IDOS_C"
            ? "IDOS"
            : "";
    const replace = body.replace === false ? false : true;
    const packageMode = String(body.package_mode || "").trim() || "full_package";
    const effectivePackageMode = ["full_package", "psa_compressor", "psa_only"].includes(packageMode) ? packageMode : "full_package";

    const rec = await getPsaRecommender(gasType)({
      purity,
      requiredFlow,
      seriesSuffix,
      baseSeries,
      clientOrPool: client,
    });
    if (!rec.ok) return res.status(400).json({ ok: false, error: rec.error });

    const chosenLower = chosenModel.toLowerCase();
    let selected = chosenModel
      ? (rec.options || []).find((o) => String(o.model || "").trim().toLowerCase() === chosenLower) || rec.recommended
      : rec.recommended;
    if (!selected) return res.status(400).json({ ok: false, error: "NO_SELECTION" });
    selected = {
      ...selected,
      product_id: (Number.isFinite(bodyProductId) && bodyProductId > 0 ? bodyProductId : null) || selected.product_id || null,
      item_code: bodyItemCode || selected.item_code || "",
      model: selected.model || chosenModel,
    };

    const compressor = await recommendCompressor(selected.airRequirement, { clientOrPool: client });
    const hydratedSelected = withDerivedPackageVolumes(selected, compressor);

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }
    if (revision.revision_status !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_EDITABLE" });
    }
    const exchangeRate = await resolveRevisionExchangeRate(client, revision);

    if (replace) {
      await client.query(`delete from quote_lines where quote_revision_id = $1`, [revision.id]);
    }

    const existingCountRes = await client.query(
      `select coalesce(max(line_no), 0)::int as cnt from quote_lines where quote_revision_id = $1`,
      [revision.id]
    );
    let lineNo = Number(existingCountRes.rows[0]?.cnt || 0) + 1;

    const items = await buildPsaPackageItems(client, {
      companyId: quote.company_id,
      selected: hydratedSelected,
      compressor,
      packageMode: effectivePackageMode,
    });
    const skippedUnmapped = [];
    const appliedItems = [];
    for (const it of items) {
      if (!it?.product_id) {
        skippedUnmapped.push(it?.item_name || it?.item_code || "Unknown package item");
        continue;
      }
      const qty = Math.max(1, Number(it.qty) || 1);
      const unitPriceBase = roundMoney(Number(it.unit_price || 0), 2);
      const unitPriceQuote = convertBaseAmountToQuote(unitPriceBase, exchangeRate);
      const totalBase = roundMoney(unitPriceBase * qty, 2);
      const totalQuote = roundMoney(unitPriceQuote * qty, 2);
      const lineMeta = JSON.stringify({
        price_list: "list",
        source_list_price: unitPriceQuote,
        gross_unit_price_quote: unitPriceQuote,
        discount_pct: 0,
        discount_amt: 0,
        remarks: it.remarks || "",
        package_applied: true,
        package_mode: effectivePackageMode,
        scope_role: it.scope_role || null,
        scope_requirement: it.scope_requirement || "",
      });
      await client.query(
        `
          insert into quote_lines (
            quote_revision_id,
            line_no,
            product_id,
            item_code,
            item_name,
            hsn_no,
            qty,
            unit_price_base,
            unit_price_quote,
            gst_pct,
            line_total_base,
            line_total_quote,
            scope_type,
            discount_pct,
            discount_amt,
            gross_unit_price_quote,
            list_price_snapshot,
            line_description
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        `,
        [
          revision.id,
          lineNo,
          it.product_id,
          it.item_code,
          it.item_name,
          it.hsn_no,
          qty,
          unitPriceBase,
          unitPriceQuote,
          it.gst_pct,
          totalBase,
          totalQuote,
          it.scope_type,
          0,
          0,
          unitPriceQuote,
          unitPriceQuote,
          lineMeta,
        ]
      );
      appliedItems.push(it);
      lineNo += 1;
    }

    if (!appliedItems.length) {
      await client.query("rollback");
      return res.status(400).json({
        ok: false,
        error: "PACKAGE_ITEMS_NOT_MAPPED",
        detail: `Could not map package items into Product Master for model ${selected?.model || chosenModel || "—"}. Check item name/code and saleable policy for this company.`,
        skipped: skippedUnmapped,
        requested_model: selected?.model || chosenModel || null,
        requested_item_code: selected?.item_code || null,
        requested_product_id: selected?.product_id || null,
      });
    }

    if (await hasQuoteRevisionColumn(client, "annexure_mode")) {
      await client.query(
        `update quote_revisions set annexure_mode = 'none', merge_annexures = false where id = $1 and annexure_mode is null`,
        [revision.id]
      );
    }

    await recalcRevisionTotals(client, revision.id);
    const autoOfferType = await refreshAutoOfferType(client, { quoteId, revisionId: revision.id });

    const outRevision = await getLatestRevisionOrNull(client, quoteId);
    const outLines = outRevision ? await getRevisionLines(client, outRevision.id) : [];

    await client.query("commit");
    return res.json({
      ok: true,
      gas_type: gasType,
      quote: autoOfferType ? { ...quote, offer_type: autoOfferType } : quote,
      revision: outRevision,
      lines: outLines,
      recommendation: { selected: hydratedSelected, compressor },
      skipped_unmapped_items: skippedUnmapped,
      apply_mode: replace ? "replace" : "append",
    });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
}

router.post("/:id/recommend/nitrogen", requireScreenAction("quotes", "can_view"), async (req, res, next) =>
  runPsaRecommend(req, res, next, { gasType: "nitrogen" })
);

router.post("/:id/apply/nitrogen", requireScreenAction("quotes", "can_edit"), async (req, res, next) =>
  runPsaApply(req, res, next, { gasType: "nitrogen" })
);

router.post("/:id/recommend/oxygen", requireScreenAction("quotes", "can_view"), async (req, res, next) =>
  runPsaRecommend(req, res, next, { gasType: "oxygen" })
);

router.post("/:id/apply/oxygen", requireScreenAction("quotes", "can_edit"), async (req, res, next) =>
  runPsaApply(req, res, next, { gasType: "oxygen" })
);

router.get("/configurator/:gas/purities", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const gas = String(req.params.gas || "").trim().toLowerCase();
    if (gas !== "nitrogen" && gas !== "oxygen") return res.status(400).json({ ok: false, error: "INVALID_GAS" });
    const purities = await listPsaPurities(gas, { clientOrPool: pool });
    return res.json({ ok: true, gas_type: gas, purities });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/revisions", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const amendmentReason = typeof body.amendment_reason === "string" ? body.amendment_reason.trim() : "";

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const prev = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!prev) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }

    if (prev.revision_status === "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ALREADY_DRAFT" });
    }

    const nextNo = Number(prev.revision_no) + 1;
    const hasLeadTimeCols = await hasQuoteRevisionColumn(client, "delivery_lead_time_days");
    const revisionPreparedBy = quoteOwnerId(quote) || Number(prev.prepared_by) || req.user.id;

    await client.query(`update quote_revisions set is_latest = false where quote_id = $1`, [quoteId]);

    const revRes = await client.query(
      hasLeadTimeCols
        ? `
        insert into quote_revisions (
          quote_id,
          revision_no,
          revision_status,
          amendment_reason,
          pricing_display_mode,
          is_export,
          incoterm_id,
          base_currency_id,
          quote_currency_id,
          payment_term_id,
          freight_term_id,
          p_and_f_term_id,
          delivery_lead_time_days,
          warranty_months,
          prepared_by,
          prepared_at,
          is_latest
        )
        values ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),true)
        returning *
      `
        : `
        insert into quote_revisions (
          quote_id,
          revision_no,
          revision_status,
          amendment_reason,
          pricing_display_mode,
          is_export,
          incoterm_id,
          base_currency_id,
          quote_currency_id,
          payment_term_id,
          freight_term_id,
          p_and_f_term_id,
          prepared_by,
          prepared_at,
          is_latest
        )
        values ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),true)
        returning *
      `,
      hasLeadTimeCols
        ? [
            quoteId,
            nextNo,
            amendmentReason || null,
            prev.pricing_display_mode,
            prev.is_export,
            prev.incoterm_id,
            prev.base_currency_id,
            prev.quote_currency_id,
            prev.payment_term_id,
            prev.freight_term_id,
            prev.p_and_f_term_id,
            prev.delivery_lead_time_days ?? null,
            prev.warranty_months ?? null,
            revisionPreparedBy,
          ]
        : [
            quoteId,
            nextNo,
            amendmentReason || null,
            prev.pricing_display_mode,
            prev.is_export,
            prev.incoterm_id,
            prev.base_currency_id,
            prev.quote_currency_id,
            prev.payment_term_id,
            prev.freight_term_id,
            prev.p_and_f_term_id,
            revisionPreparedBy,
          ]
    );
    const revision = revRes.rows[0];
    await markRevisionEdited(client, revision.id, req.user.id);
    revision.edited_by = req.user.id;

    if (await hasQuoteRevisionColumn(client, "annexure_mode")) {
      await client.query(`update quote_revisions set merge_annexures = $2, annexure_mode = $3 where id = $1`, [
        revision.id,
        prev.merge_annexures !== false,
        prev.annexure_mode || null,
      ]);
      revision.merge_annexures = prev.merge_annexures !== false;
      revision.annexure_mode = prev.annexure_mode || null;
    } else {
      await client.query(`update quote_revisions set merge_annexures = $2 where id = $1`, [revision.id, prev.merge_annexures !== false]);
      revision.merge_annexures = prev.merge_annexures !== false;
    }

    await copyRevisionLines(client, prev.id, revision.id);

    const prevTermsRes = await client.query(
      `select 1 from quote_revision_terms where quote_revision_id = $1 limit 1`,
      [prev.id]
    );
    if (prevTermsRes.rows.length) {
      await copyRevisionTerms(client, prev.id, revision.id);
    } else {
      await ensureRevisionTerms(client, revision.id);
    }

    const prevTplRes = await client.query(
      `select 1 from quote_revision_templates where quote_revision_id = $1 limit 1`,
      [prev.id]
    );
    if (prevTplRes.rows.length) {
      await copyRevisionTemplates(client, prev.id, revision.id);
    }

    await recalcRevisionTotals(client, revision.id);
    await syncQuoteHeaderStatus(client, quoteId, "draft");

    const lines = await getRevisionLines(client, revision.id);
    const refreshedQuote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });

    await client.query("commit");
    return res.status(201).json({ ok: true, quote: refreshedQuote || quote, revision, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id/approval-status", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const revision = await getLatestRevisionOrNull(pool, id);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    const snapshot = await buildQuoteApprovalSnapshot(pool, {
      quote,
      revision,
      actorUserId: req.user.id,
    });
    return res.json({ ok: true, quote, revision, approval: snapshot });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/owner-history", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    const quote = await getQuoteHeaderOrNull(pool, { quoteId: id, distributorId: isDistributor ? distributorId : null });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const r = await pool.query(
      `
        select c.id, c.from_user_id, fu.full_name as from_user_name, c.to_user_id, tu.full_name as to_user_name,
               c.changed_by, cu.full_name as changed_by_name, c.reason, c.created_at
        from quote_owner_changes c
        left join erp_users fu on fu.id = c.from_user_id
        left join erp_users tu on tu.id = c.to_user_id
        left join erp_users cu on cu.id = c.changed_by
        where c.quote_id = $1
        order by c.created_at desc, c.id desc
      `,
      [id]
    );
    return res.json({ ok: true, history: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/owner", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const toUserId = Number(body.to_user_id);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    if (!Number.isFinite(toUserId) || toUserId <= 0) return res.status(400).json({ ok: false, error: "OWNER_REQUIRED" });
    if (req.user.group_name === "Distributor") return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    await client.query("begin");
    const quote = await getQuoteHeaderOrNull(client, { quoteId: id, distributorId: null });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote) || !canAccessCompanyContext(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const fromUserId = quoteOwnerId(quote);
    if (fromUserId === toUserId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "OWNER_UNCHANGED" });
    }

    const me = Number(req.user.id);
    const isSuperAdmin = req.user.group_name === "SuperAdmin";
    if (!isSuperAdmin) {
      const team = await loadReporteeIds(client, me);
      team.add(me);
      if (team.size <= 1) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "OWNER_OUTSIDE_TEAM", detail: "Only managers can reassign quotes." });
      }
      if (!fromUserId || !team.has(fromUserId) || !team.has(toUserId)) {
        await client.query("rollback");
        return res.status(403).json({
          ok: false,
          error: "OWNER_OUTSIDE_TEAM",
          detail: "You can only reassign quotes between people in your own team.",
        });
      }
    }

    const targetRes = await client.query(
      `
        select u.id, u.full_name, u.is_active, l.distributor_id
        from erp_users u
        left join user_distributor_links l on l.user_id = u.id
        where u.id = $1
      `,
      [toUserId]
    );
    const target = targetRes.rows[0];
    if (!target || target.is_active === false) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "OWNER_INACTIVE" });
    }
    if (target.distributor_id && Number(target.distributor_id) !== Number(quote.distributor_id || 0)) {
      await client.query("rollback");
      return res.status(400).json({
        ok: false,
        error: "OWNER_DISTRIBUTOR_MISMATCH",
        detail: "A channel partner's staff can only own that partner's quotes.",
      });
    }

    await client.query(`update quote_headers set owner_user_id = $2, updated_at = now() where id = $1`, [id, toUserId]);
    await client.query(
      `insert into quote_owner_changes (quote_id, from_user_id, to_user_id, changed_by, reason) values ($1,$2,$3,$4,$5)`,
      [id, fromUserId || null, toUserId, me, reason || null]
    );
    await client.query("commit");

    const actorName = req.user.full_name || req.user.email || "";
    const common = {
      quoteId: id,
      quoteNumber: quote.quote_number,
      actorUserId: me,
      companyId: quote.company_id || null,
      actorName,
      remarks: reason,
    };
    if (toUserId !== me) notifyQuoteOutcome({ ...common, preparerUserId: toUserId, outcome: "owner_changed_to_you" }).catch(() => {});
    if (fromUserId && fromUserId !== me) {
      notifyQuoteOutcome({ ...common, preparerUserId: fromUserId, outcome: "owner_changed_from_you" }).catch(() => {});
    }
    return res.json({ ok: true, quote_id: id, owner_user_id: toUserId, owner_name: target.full_name });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/submit-approval", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }

    if (revision.revision_status !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_SUBMITTABLE" });
    }

    await recalcRevisionTotals(client, revision.id);
    const lines = await getRevisionLines(client, revision.id);
    const snapshot = await buildQuoteApprovalSnapshot(client, {
      quote,
      revision,
      actorUserId: req.user.id,
      lines,
    });

    if (!snapshot.approval_required) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "APPROVAL_NOT_REQUIRED", approval: snapshot });
    }
    if (!snapshot.suggested_approvers.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "APPROVER_NOT_CONFIGURED", approval: snapshot });
    }

    const cycleNo = await getNextApprovalCycleNo(client, revision.id);
    for (const approver of snapshot.suggested_approvers) {
      await client.query(
        `
          insert into quote_approvals (
            quote_revision_id,
            approval_type,
            approval_status,
            approver_user_id,
            remarks,
            sequence_no,
            requested_by,
            approval_cycle_no
          )
          values ($1,'discount_threshold',$2,$3,$4,$5,$6,$7)
        `,
        [
          revision.id,
          approver.sequence_no === 1 ? "pending" : "queued",
          approver.id,
          null,
          approver.sequence_no,
          req.user.id,
          cycleNo,
        ]
      );
    }

    const upd = await client.query(
      `
        update quote_revisions
        set revision_status = 'pending_approval', locked_at = now()
        where id = $1
        returning *
      `,
      [revision.id]
    );
    const outRevision = upd.rows[0] || revision;
    await syncQuoteHeaderStatus(client, quoteId, "pending_approval");
    const refreshedQuote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    const approval = await buildQuoteApprovalSnapshot(client, {
      quote: refreshedQuote || quote,
      revision: outRevision,
      actorUserId: req.user.id,
      lines,
    });

    await client.query("commit");

    const pendingApprovers = (snapshot.suggested_approvers || []).filter((row) => Number(row.sequence_no) === 1);
    const notifyList = pendingApprovers.length ? pendingApprovers : snapshot.suggested_approvers || [];
    const quoteNumber = refreshedQuote?.quote_number || quote.quote_number || `Quote #${quoteId}`;
    const companyId = refreshedQuote?.company_id || quote.company_id || null;

    for (const approver of notifyList) {
      notifyApproverAndCover({
        quoteId,
        quoteNumber,
        approverUserId: approver.id,
        requestedBy: req.user.id,
        companyId,
        stepLabel: Number(approver.sequence_no) > 1 ? `step ${approver.sequence_no}` : "",
        triggeringLines: approval?.triggering_lines || snapshot?.triggering_lines || [],
      }).catch(() => {});
    }

    // Inbox-zero: approvers are notified via For you + Chat/push only — no per-event email.

    return res.json({ ok: true, quote: refreshedQuote || quote, revision: outRevision, lines, approval });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/approve", requireScreenAction("quotes", "can_approve"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const remarks = typeof body.remarks === "string" ? body.remarks.trim() : "";

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }
    if (revision.revision_status !== "pending_approval") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_PENDING_APPROVAL" });
    }

    const approvalRes = await client.query(
      `
        select *
        from quote_approvals
        where quote_revision_id = $1
          and approval_status = 'pending'
        order by approval_cycle_no desc, sequence_no asc, id asc
        limit 1
        for update
      `,
      [revision.id]
    );
    const activeApproval = approvalRes.rows[0] || null;
    const approvalAuthority = activeApproval
      ? await resolveApprovalAuthority(client, { approverUserId: activeApproval.approver_user_id, actorUserId: req.user.id })
      : null;
    if (!activeApproval || !approvalAuthority) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "APPROVAL_NOT_ASSIGNED" });
    }

    await client.query(
      `
        update quote_approvals
        set approval_status = 'approved', approved_at = now(), remarks = $2, acted_by_user_id = $3, updated_at = now()
        where id = $1
      `,
      [activeApproval.id, remarks || null, req.user.id]
    );

    const queuedRes = await client.query(
      `
        select id, approver_user_id, sequence_no
        from quote_approvals
        where quote_revision_id = $1
          and approval_cycle_no = $2
          and sequence_no > $3
          and approval_status = 'queued'
        order by sequence_no asc, id asc
        for update
      `,
      [revision.id, activeApproval.approval_cycle_no, activeApproval.sequence_no]
    );

    let outRevision = revision;
    let nextApproverUserId = null;
    let nextSequenceNo = null;
    for (const step of queuedRes.rows) {
      const stepAuthority = await resolveApprovalAuthority(client, {
        approverUserId: step.approver_user_id,
        actorUserId: req.user.id,
      });
      if (stepAuthority) {
        await client.query(
          `
            update quote_approvals
            set approval_status = 'approved', approved_at = now(), remarks = $2, acted_by_user_id = $3, updated_at = now()
            where id = $1
          `,
          [step.id, remarks || null, req.user.id]
        );
        continue;
      }
      await client.query(`update quote_approvals set approval_status = 'pending', updated_at = now() where id = $1`, [step.id]);
      nextApproverUserId = step.approver_user_id || null;
      nextSequenceNo = step.sequence_no || null;
      break;
    }
    if (!nextApproverUserId) {
      const upd = await client.query(
        `
          update quote_revisions
          set revision_status = 'approved', locked_at = now()
          where id = $1
          returning *
        `,
        [revision.id]
      );
      outRevision = upd.rows[0] || revision;
      await syncQuoteHeaderStatus(client, quoteId, "approved");
    }

    const lines = await getRevisionLines(client, revision.id);
    let issued = false;
    let issueBlockers = [];
    if (body.and_issue === true && outRevision.revision_status === "approved") {
      const issueResult = await issueRevisionNow(client, { quote, revision: outRevision, lines });
      if (issueResult.ok) {
        issued = true;
        outRevision = issueResult.revision;
      } else {
        issueBlockers = issueResult.blockers;
      }
    }
    const refreshedQuote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    const approval = await buildQuoteApprovalSnapshot(client, {
      quote: refreshedQuote || quote,
      revision: outRevision,
      actorUserId: req.user.id,
      lines,
    });

    await client.query("commit");

    const ownerUserId = quoteOwnerId(quote) || Number(revision.prepared_by) || null;
    if (nextApproverUserId) {
      notifyApproverAndCover({
        quoteId,
        quoteNumber: refreshedQuote?.quote_number || quote.quote_number || `Quote #${quoteId}`,
        approverUserId: nextApproverUserId,
        requestedBy: req.user.id,
        companyId: refreshedQuote?.company_id || quote.company_id || null,
        stepLabel: nextSequenceNo ? `step ${nextSequenceNo}` : "next step",
        triggeringLines: approval?.triggering_lines || [],
      }).catch(() => {});
    } else if (["approved", "issued"].includes(outRevision?.revision_status) && ownerUserId) {
      notifyQuoteOutcome({
        quoteId,
        quoteNumber: refreshedQuote?.quote_number || quote.quote_number || null,
        preparerUserId: ownerUserId,
        actorUserId: req.user.id,
        actorName: req.user.full_name || req.user.email || "",
        companyId: refreshedQuote?.company_id || quote.company_id || null,
        outcome: "approved",
        remarks,
      }).catch(() => {});
    }

    return res.json({
      ok: true,
      quote: refreshedQuote || quote,
      revision: outRevision,
      lines,
      approval,
      approval_authority: approvalAuthority,
      issued,
      issue_blockers: issueBlockers,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/reject", requireScreenAction("quotes", "can_approve"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const remarks = typeof body.remarks === "string" ? body.remarks.trim() : "";

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }
    if (revision.revision_status !== "pending_approval") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_PENDING_APPROVAL" });
    }

    const approvalRes = await client.query(
      `
        select *
        from quote_approvals
        where quote_revision_id = $1
          and approval_status = 'pending'
        order by approval_cycle_no desc, sequence_no asc, id asc
        limit 1
        for update
      `,
      [revision.id]
    );
    const activeApproval = approvalRes.rows[0] || null;
    const approvalAuthority = activeApproval
      ? await resolveApprovalAuthority(client, { approverUserId: activeApproval.approver_user_id, actorUserId: req.user.id })
      : null;
    if (!activeApproval || !approvalAuthority) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "APPROVAL_NOT_ASSIGNED" });
    }

    await client.query(
      `
        update quote_approvals
        set approval_status = 'rejected', approved_at = now(), remarks = $2, acted_by_user_id = $3, updated_at = now()
        where id = $1
      `,
      [activeApproval.id, remarks || null, req.user.id]
    );
    await client.query(
      `
        update quote_approvals
        set approval_status = 'skipped', updated_at = now()
        where quote_revision_id = $1
          and approval_cycle_no = $2
          and sequence_no > $3
          and approval_status = 'queued'
      `,
      [revision.id, activeApproval.approval_cycle_no, activeApproval.sequence_no]
    );

    const upd = await client.query(
      `
        update quote_revisions
        set revision_status = 'rejected', locked_at = now()
        where id = $1
        returning *
      `,
      [revision.id]
    );
    const outRevision = upd.rows[0] || revision;
    await syncQuoteHeaderStatus(client, quoteId, "rejected");

    const lines = await getRevisionLines(client, revision.id);
    const refreshedQuote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    const approval = await buildQuoteApprovalSnapshot(client, {
      quote: refreshedQuote || quote,
      revision: outRevision,
      actorUserId: req.user.id,
      lines,
    });

    await client.query("commit");
    const rejectNotifyUserId = quoteOwnerId(quote) || Number(revision.prepared_by) || null;
    if (rejectNotifyUserId) {
      notifyQuoteOutcome({
        quoteId,
        quoteNumber: refreshedQuote?.quote_number || quote.quote_number || null,
        preparerUserId: rejectNotifyUserId,
        actorUserId: req.user.id,
        actorName: req.user.full_name || req.user.email || "",
        companyId: refreshedQuote?.company_id || quote.company_id || null,
        outcome: "rejected",
        remarks,
      }).catch(() => {});
    }
    return res.json({ ok: true, quote: refreshedQuote || quote, revision: outRevision, lines, approval });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/issue", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }

    await recalcRevisionTotals(client, revision.id);
    const lines = await getRevisionLines(client, revision.id);
    const readiness = buildQuoteIssueReadiness({ quote, revision, lines });
    if (!readiness.ok) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ISSUE_READINESS_FAILED", blockers: readiness.blockers });
    }
    const approval = await buildQuoteApprovalSnapshot(client, {
      quote,
      revision,
      actorUserId: req.user.id,
      lines,
    });

    if (revision.revision_status === "draft" && approval.approval_required) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "APPROVAL_REQUIRED", approval });
    }
    if (!["draft", "approved"].includes(revision.revision_status)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_ISSUABLE", approval });
    }

    const upd = await client.query(
      `
        update quote_revisions
        set revision_status = 'issued', issued_at = now(), locked_at = now()
        where id = $1
        returning *
      `,
      [revision.id]
    );
    const outRevision = upd.rows[0] || revision;
    await syncQuoteHeaderStatus(client, quoteId, "issued");
    await client.query(
      `
        update quote_headers
        set quote_valid_till = coalesce(quote_valid_till, (current_date + interval '30 days')::date),
            updated_at = now()
        where id = $1
      `,
      [quoteId]
    );
    const refreshedQuote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    const refreshedApproval = await buildQuoteApprovalSnapshot(client, {
      quote: refreshedQuote || quote,
      revision: outRevision,
      actorUserId: req.user.id,
      lines,
    });

    await client.query("commit");
    return res.json({ ok: true, quote: refreshedQuote || quote, revision: outRevision, lines, approval: refreshedApproval });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/close", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const closureReasonId = Number(body.closure_reason_id);
    const closureRemarks =
      typeof body.closure_remarks === "string" ? body.closure_remarks.trim() : body.closure_remarks == null ? null : String(body.closure_remarks).trim();
    const customerPoRef =
      typeof body.customer_po_ref === "string" ? body.customer_po_ref.trim() : body.customer_po_ref == null ? "" : String(body.customer_po_ref).trim();

    if (!Number.isFinite(closureReasonId) || closureReasonId <= 0) {
      return res.status(400).json({ ok: false, error: "CLOSURE_REASON_REQUIRED" });
    }

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const status = String(quote.quote_status || "").trim().toLowerCase();
    if (["closed", "cancelled", "converted"].includes(status)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QUOTE_NOT_CLOSABLE", detail: `Quote is already ${status}.` });
    }

    const soRes = await client.query(
      `
        select so.id
        from quote_revisions qr
        join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
        where qr.quote_id = $1
        limit 1
      `,
      [quoteId]
    );
    if (soRes.rows[0]?.id) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QUOTE_CONVERTED", detail: "Quote already has a sales order." });
    }

    const reasonRes = await client.query(
      `
        select id, reason_code, reason_name,
          case when reason_code = 'won_customer_po' then 'won' else 'lost' end as outcome_kind
        from quote_closure_reasons
        where id = $1 and is_active = true
        limit 1
      `,
      [closureReasonId]
    );
    if (!reasonRes.rows[0]) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CLOSURE_REASON" });
    }

    const outcomeKind = String(reasonRes.rows[0].outcome_kind || "lost").toLowerCase();
    if (outcomeKind === "won" && !customerPoRef) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "CUSTOMER_PO_REQUIRED", detail: "Capture the customer PO reference when closing a won quote." });
    }

    const hasAcceptanceCols = await hasQuoteHeaderColumn(client, "customer_po_ref");
    if (hasAcceptanceCols) {
      await client.query(
        `
          update quote_headers
          set quote_status = 'closed',
              closure_reason_id = $2,
              closure_remarks = $3,
              customer_po_ref = $4,
              accepted_at = case when $5 = 'won' then coalesce(accepted_at, now()) else accepted_at end,
              updated_at = now()
          where id = $1
        `,
        [quoteId, closureReasonId, closureRemarks || null, customerPoRef || null, outcomeKind]
      );
    } else {
      await client.query(
        `
          update quote_headers
          set quote_status = 'closed',
              closure_reason_id = $2,
              closure_remarks = $3,
              updated_at = now()
          where id = $1
        `,
        [quoteId, closureReasonId, closureRemarks || null]
      );
    }

    const refreshedQuote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    const revision = await getLatestRevisionOrNull(client, quoteId);
    const lines = revision ? await getRevisionLines(client, revision.id) : [];

    await client.query("commit");
    return res.json({
      ok: true,
      quote: refreshedQuote || quote,
      revision,
      lines,
      closure: {
        reason_id: reasonRes.rows[0].id,
        reason_code: reasonRes.rows[0].reason_code,
        reason_name: reasonRes.rows[0].reason_name,
        outcome_kind: reasonRes.rows[0].outcome_kind || "lost",
        remarks: closureRemarks || null,
        customer_po_ref: customerPoRef || null,
      },
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/revive", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");
    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(quote.quote_status || "").toLowerCase() !== "lapsed") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QUOTE_NOT_LAPSED" });
    }

    const nextValidTill =
      typeof body.quote_valid_till === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.quote_valid_till.trim())
        ? body.quote_valid_till.trim()
        : null;

    await client.query(
      `
        update quote_headers
        set quote_status = 'issued',
            lapsed_at = null,
            quote_valid_till = coalesce($2::date, (current_date + interval '30 days')::date),
            updated_at = now()
        where id = $1
      `,
      [quoteId, nextValidTill]
    );

    const refreshedQuote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    const revision = await getLatestRevisionOrNull(client, quoteId);
    const lines = revision ? await getRevisionLines(client, revision.id) : [];
    await client.query("commit");
    return res.json({ ok: true, quote: refreshedQuote || quote, revision, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

async function loadQuoteEngineeringHandoffs(client, quoteId, companyId) {
  const ready = await client.query(`select to_regclass('public.engineering_requests') is not null as ready`);
  if (!ready.rows[0]?.ready) return [];

  const params = [Number(quoteId)];
  let companyFilter = "";
  if (Number.isFinite(Number(companyId))) {
    params.push(Number(companyId));
    companyFilter = ` and er.company_id = $${params.length}`;
  }

  const r = await client.query(
    `
      select
        er.id,
        er.request_type,
        er.request_title,
        er.request_status,
        er.request_priority,
        er.source_desk,
        er.customer_name,
        er.product_code,
        er.product_name,
        er.reference_no,
        er.request_details,
        er.attachment_note,
        er.quote_header_id,
        er.created_at,
        er.updated_at,
        requester.full_name as requester_name,
        assignee.full_name as assignee_name
      from engineering_requests er
      left join erp_users requester on requester.id = er.requester_user_id
      left join erp_users assignee on assignee.id = er.assigned_to_user_id
      where er.quote_header_id = $1
        ${companyFilter}
      order by er.created_at desc, er.id desc
    `,
    params
  );

  const requests = r.rows;
  if (!requests.length) return [];

  const ids = requests.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
  const attachRes = await client.query(
    `
      select
        id,
        owner_id,
        owner_type,
        file_name,
        mime_type,
        file_size_bytes,
        created_at
      from attachments
      where owner_type in ('quote_customer_datasheet', 'quote_engineering_datasheet')
        and owner_id = any($1::bigint[])
      order by created_at desc, id desc
    `,
    [ids]
  );

  const byOwner = new Map();
  for (const row of attachRes.rows) {
    const key = Number(row.owner_id);
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push({
      id: Number(row.id),
      owner_type: row.owner_type,
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size_bytes: Number(row.file_size_bytes || 0),
      created_at: row.created_at,
      direction: row.owner_type === "quote_engineering_datasheet" ? "engineering_return" : "customer_datasheet",
    });
  }

  return requests.map((row) => ({
    ...row,
    id: Number(row.id),
    attachments: byOwner.get(Number(row.id)) || [],
  }));
}

router.get("/:id/engineering-requests", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const requests = await loadQuoteEngineeringHandoffs(pool, quoteId, quote.company_id);
    return res.json({ ok: true, requests });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/engineering-attachments/:attachmentId", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const quoteId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isFinite(quoteId) || !Number.isFinite(attachmentId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const r = await pool.query(
      `
        select a.id, a.file_name, a.file_path, a.mime_type, a.owner_type, a.owner_id
        from attachments a
        join engineering_requests er on er.id = a.owner_id and er.quote_header_id = $1
        where a.id = $2
          and a.owner_type in ('quote_customer_datasheet', 'quote_engineering_datasheet')
        limit 1
      `,
      [quoteId, attachmentId]
    );
    const row = r.rows[0];
    if (!row?.file_path || !fs.existsSync(row.file_path)) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const fileName = row.file_name || `engineering_${attachmentId}`;
    res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileSegment(fileName)}"`);
    return res.sendFile(path.resolve(row.file_path));
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/engineering-request", requireScreenAction("quotes", "can_edit"), upload.single("file"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const notes =
      typeof req.body?.notes === "string"
        ? req.body.notes.trim()
        : typeof req.body?.request_details === "string"
          ? req.body.request_details.trim()
          : "";
    if (!notes) return res.status(400).json({ ok: false, error: "NOTES_REQUIRED" });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const status = String(quote.quote_status || "").trim().toLowerCase();
    if (["closed", "cancelled", "converted"].includes(status)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QUOTE_NOT_EDITABLE" });
    }

    const companyId = Number(quote.company_id);
    if (!Number.isFinite(companyId)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const lines = await getRevisionLines(client, (await getLatestRevisionOrNull(client, quoteId))?.id);
    const firstLine = (Array.isArray(lines) ? lines : []).find((line) => String(line?.scope_type || "included") === "included") || lines?.[0] || null;
    const productCode = String(firstLine?.item_code || firstLine?.product_item_code || "").trim() || null;
    const productName = String(firstLine?.item_name || firstLine?.product_item_name || "").trim() || null;
    const requestTitle = `Custom engineering — ${quote.quote_number || `Q${quoteId}`}`;

    const insertRes = await client.query(
      `
        insert into engineering_requests (
          company_id,
          request_type,
          request_title,
          request_status,
          request_priority,
          source_desk,
          requester_user_id,
          customer_name,
          product_code,
          product_name,
          reference_no,
          request_details,
          attachment_note,
          quote_header_id,
          payload,
          created_by,
          updated_by,
          created_at,
          updated_at
        )
        values ($1,'client_datasheet',$2,'new','high','sales',$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$12,now(),now())
        returning id
      `,
      [
        companyId,
        requestTitle,
        Number(req.user.id),
        quote.customer_name || null,
        productCode,
        productName,
        quote.quote_number || null,
        notes,
        req.file ? String(req.file.originalname || "").trim() || null : null,
        quoteId,
        JSON.stringify({ source: "quote_engineering_request", quote_id: quoteId }),
        Number(req.user.id),
      ]
    );
    const requestId = Number(insertRes.rows[0]?.id);
    if (!Number.isFinite(requestId)) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "ENGINEERING_REQUEST_FAILED" });
    }

    let attachment = null;
    if (req.file) {
      const originalName = String(req.file.originalname || "customer_datasheet").trim() || "customer_datasheet";
      const ext = path.extname(originalName);
      const baseName = safeFileSegment(path.basename(originalName, ext) || `quote_${quoteId}_datasheet`);
      const fileName = `${baseName}_${requestId}_${Date.now()}${ext ? safeFileSegment(ext) : ""}`;
      const storageDir = path.resolve(__dirname, "..", "..", "storage", "quotes", "engineering");
      fs.mkdirSync(storageDir, { recursive: true });
      const absFilePath = path.join(storageDir, fileName);
      fs.writeFileSync(absFilePath, req.file.buffer);

      const attach = await createOwnedAttachment(client, {
        fileName: originalName,
        filePath: absFilePath,
        mimeType: req.file.mimetype || "application/octet-stream",
        fileSizeBytes: req.file.size || req.file.buffer?.length || 0,
        uploadedBy: req.user.id,
        companyId,
        ownerType: "quote_customer_datasheet",
        ownerId: requestId,
      });
      attachment = attach
        ? {
            id: Number(attach.id),
            file_name: attach.file_name || originalName,
            owner_type: "quote_customer_datasheet",
            direction: "customer_datasheet",
          }
        : null;
    }

    await client.query("commit");
    const requests = await loadQuoteEngineeringHandoffs(pool, quoteId, companyId);
    return res.status(201).json({
      ok: true,
      request: requests.find((row) => Number(row.id) === requestId) || { id: requestId },
      attachment,
      requests,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post(
  "/:id/engineering-requests/:requestId/sales-response",
  requireScreenAction("quotes", "can_edit"),
  upload.single("file"),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const quoteId = Number(req.params.id);
      const requestId = Number(req.params.requestId);
      if (!Number.isFinite(quoteId) || !Number.isFinite(requestId)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
      const action = String(req.body?.action || "reply").trim().toLowerCase();
      if (!["reply", "accept"].includes(action)) return res.status(400).json({ ok: false, error: "INVALID_ACTION" });
      const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 4000) : "";
      if (action === "reply" && !message && !req.file) return res.status(400).json({ ok: false, error: "MESSAGE_REQUIRED" });

      const isDistributor = req.user.group_name === "Distributor";
      const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
      if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

      const quote = await getQuoteHeaderOrNull(client, { quoteId, distributorId: isDistributor ? distributorId : null });
      if (!quote) return res.status(404).json({ ok: false });
      if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
      const companyId = Number(quote.company_id);

      await client.query("begin");
      const existingRes = await client.query(
        `
          select id, request_title, request_status, assigned_to_user_id
          from engineering_requests
          where id = $1 and quote_header_id = $2 and company_id = $3
          for update
        `,
        [requestId, quoteId, companyId]
      );
      const existing = existingRes.rows[0];
      if (!existing) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }
      const currentStatus = String(existing.request_status || "");
      if (action === "reply" && !["new", "in_review", "waiting_input", "ready"].includes(currentStatus)) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "REQUEST_CLOSED" });
      }
      if (action === "accept" && currentStatus !== "ready") {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "REQUEST_NOT_READY" });
      }

      const who = req.user.full_name || req.user.email || `User ${req.user.id}`;
      const stamp = new Date().toISOString().slice(0, 10);
      const label = action === "accept" ? "Sales accepted" : "Sales reply";
      const noteLine = `[${label} ${stamp} · ${who}]${message ? ` ${message}` : req.file ? " Datasheet attached." : ""}`;
      const nextStatus = action === "accept" ? "closed" : "in_review";

      await client.query(
        `
          update engineering_requests
          set request_status = $3,
              request_details = concat_ws(E'\\n\\n', nullif(request_details, ''), $4::text),
              updated_by = $5,
              updated_at = now()
          where id = $1 and company_id = $2
        `,
        [requestId, companyId, nextStatus, noteLine, Number(req.user.id)]
      );

      if (req.file) {
        const originalName = String(req.file.originalname || "customer_datasheet").trim() || "customer_datasheet";
        const ext = path.extname(originalName);
        const baseName = safeFileSegment(path.basename(originalName, ext) || `quote_${quoteId}_datasheet`);
        const fileName = `${baseName}_${requestId}_${Date.now()}${ext ? safeFileSegment(ext) : ""}`;
        const storageDir = path.resolve(__dirname, "..", "..", "storage", "quotes", "engineering");
        fs.mkdirSync(storageDir, { recursive: true });
        const absFilePath = path.join(storageDir, fileName);
        fs.writeFileSync(absFilePath, req.file.buffer);
        await createOwnedAttachment(client, {
          fileName: originalName,
          filePath: absFilePath,
          mimeType: req.file.mimetype || "application/octet-stream",
          fileSizeBytes: req.file.size || req.file.buffer?.length || 0,
          uploadedBy: req.user.id,
          companyId,
          ownerType: "quote_customer_datasheet",
          ownerId: requestId,
        });
      }

      await client.query("commit");

      notifyEngineeringSalesReply({
        requestId,
        requestTitle: existing.request_title,
        assignedToUserId: existing.assigned_to_user_id,
        companyId,
        actorUserId: req.user.id,
        action,
      }).catch(() => {});

      const requests = await loadQuoteEngineeringHandoffs(pool, quoteId, companyId);
      return res.json({ ok: true, requests });
    } catch (err) {
      await client.query("rollback").catch(() => {});
      return next(err);
    } finally {
      client.release();
    }
  }
);

router.get("/:id/terms", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const revision = await getLatestRevisionOrNull(pool, id);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    await ensureRevisionTerms(pool, revision.id);
    const terms = await getRevisionTerms(pool, revision.id);

    return res.json({ ok: true, revision_id: revision.id, terms });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/mail-bootstrap", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const revision = await getLatestRevisionOrNull(pool, id);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    const bootstrap = await buildQuoteMailBootstrap(pool, {
      quote,
      revision,
      actorUserId: req.user.id,
      actorGroupName: req.user.group_name,
    });

    return res.json({ ok: true, ...bootstrap });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/mail-history", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const revision = await getLatestRevisionOrNull(pool, id);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    const history = await getQuoteMailHistory(pool, revision.id);
    return res.json({ ok: true, history });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id/terms", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const termsInput = Array.isArray(body.terms) ? body.terms : [];

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }

    if (revision.revision_status !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_EDITABLE" });
    }

    await ensureRevisionTerms(client, revision.id);

    const existingRes = await client.query(
      `select id, caption from quote_revision_terms where quote_revision_id = $1`,
      [revision.id]
    );
    const existingIds = new Set(existingRes.rows.map((r) => r.id));
    const managedExistingIds = new Set(
      existingRes.rows.filter((r) => isManagedCommercialTermCaption(r.caption)).map((r) => r.id)
    );
    const keepIds = new Set();

    let sortOrder = 1;
    for (const t of termsInput) {
      const obj = t && typeof t === "object" ? t : {};
      const id = num(obj.id);
      const caption = typeof obj.caption === "string" ? obj.caption.trim() : "";
      const description = typeof obj.description === "string" ? obj.description : "";
      const isSelected = obj.is_selected === false ? false : true;

      if (!caption) continue;
      if (isManagedCommercialTermCaption(caption)) continue;

      if (Number.isFinite(id) && existingIds.has(id)) {
        await client.query(
          `
            update quote_revision_terms
            set sort_order = $2, caption = $3, description = $4, is_selected = $5, updated_at = now()
            where id = $1 and quote_revision_id = $6
          `,
          [id, sortOrder, caption, description, isSelected, revision.id]
        );
        keepIds.add(id);
      } else {
        const ins = await client.query(
          `
            insert into quote_revision_terms (quote_revision_id, term_master_id, sort_order, caption, description, is_selected)
            values ($1,null,$2,$3,$4,$5)
            returning id
          `,
          [revision.id, sortOrder, caption, description, isSelected]
        );
        keepIds.add(ins.rows[0].id);
      }

      sortOrder += 1;
    }

    const toDelete = Array.from(existingIds).filter((x) => !keepIds.has(x) && !managedExistingIds.has(x));
    if (toDelete.length) {
      await client.query(`delete from quote_revision_terms where quote_revision_id = $1 and id = any($2::int[])`, [
        revision.id,
        toDelete,
      ]);
    }

    const outTerms = await getRevisionTerms(client, revision.id);
    await markRevisionEdited(client, revision.id, req.user.id);
    await client.query("commit");
    return res.json({ ok: true, revision_id: revision.id, terms: outTerms });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id/summary", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const revision = await getLatestRevisionOrNull(client, quoteId);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    const lines = await getRevisionLines(client, revision.id);
    const summary = await getOrCreateRevisionSummary(client, { quote, revision, lines, actorUserId: req.user.id });
    const isDraft = revision.revision_status === "draft";
    const canEngineeringEdit = canEngineeringEditSummaries(req.user);

    return res.json({
      ok: true,
      revision_id: revision.id,
      merge_annexures: resolveAnnexureMode(revision) === "merged",
      annexure_mode: resolveAnnexureMode(revision),
      executive_summary: summary.executive_summary || {},
      scope_summary: summary.scope_summary || {},
      configurator_context: summary.configurator_context || {},
      is_locked: summary.is_locked === true,
      locked_at: summary.locked_at || null,
      locked_by: summary.locked_by || null,
      can_edit: canEngineeringEdit && isDraft && summary.is_locked !== true,
      can_lock: canEngineeringEdit && isDraft && summary.is_locked !== true,
      can_unlock: canEngineeringEdit && isDraft && summary.is_locked === true,
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id/summary", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const wantsModeUpdate = ANNEXURE_MODES.includes(String(body.annexure_mode || "").trim());
    const wantsMergeUpdate = wantsModeUpdate || Object.prototype.hasOwnProperty.call(body, "merge_annexures");
    const wantsSummaryUpdate =
      Object.prototype.hasOwnProperty.call(body, "executive_summary") ||
      Object.prototype.hasOwnProperty.call(body, "scope_summary") ||
      Object.prototype.hasOwnProperty.call(body, "configurator_context");

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }
    if (revision.revision_status !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_EDITABLE" });
    }

    if (wantsMergeUpdate && !canEngineeringEditSummaries(req.user)) {
      const canEditQuote = req.user?.permissions?.screens?.quotes?.can_edit === true;
      if (!canEditQuote) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }
      const nextMode = wantsModeUpdate
        ? String(body.annexure_mode).trim()
        : body.merge_annexures === false
          ? "separate"
          : "merged";
      if (await hasQuoteRevisionColumn(client, "annexure_mode")) {
        await client.query(`update quote_revisions set merge_annexures = $2, annexure_mode = $3 where id = $1`, [
          revision.id,
          nextMode === "merged",
          nextMode,
        ]);
      } else {
        await client.query(`update quote_revisions set merge_annexures = $2 where id = $1`, [revision.id, nextMode === "merged"]);
      }
    }

    const lines = await getRevisionLines(client, revision.id);
    const summary = await getOrCreateRevisionSummary(client, { quote, revision, lines, actorUserId: req.user.id });

    if (wantsSummaryUpdate) {
      if (!canEngineeringEditSummaries(req.user)) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }
      if (summary.is_locked === true) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "SUMMARY_LOCKED" });
      }

      const nextExecutive = body.executive_summary && typeof body.executive_summary === "object" ? body.executive_summary : summary.executive_summary;
      const nextScope = body.scope_summary && typeof body.scope_summary === "object" ? body.scope_summary : summary.scope_summary;
      const nextConfiguratorContext =
        body.configurator_context && typeof body.configurator_context === "object"
          ? body.configurator_context
          : summary.configurator_context;

      if (await quoteRevisionSummariesReady(client).catch(() => false)) {
        await client.query(
          `
            insert into quote_revision_summaries (quote_revision_id, executive_summary, scope_summary, configurator_context, updated_by, updated_at)
            values ($1,$2,$3,$4,$5,now())
            on conflict (quote_revision_id) do update set
              executive_summary = excluded.executive_summary,
              scope_summary = excluded.scope_summary,
              configurator_context = excluded.configurator_context,
              updated_by = excluded.updated_by,
              updated_at = now()
          `,
          [revision.id, nextExecutive, nextScope, nextConfiguratorContext, req.user.id]
        );
      }
    }

    const refreshed = await getOrCreateRevisionSummary(client, { quote, revision, lines, actorUserId: req.user.id });
    const revOut = await getLatestRevisionOrNull(client, quoteId);

    await client.query("commit");
    return res.json({
      ok: true,
      revision_id: revision.id,
      merge_annexures: resolveAnnexureMode(revOut) === "merged",
      annexure_mode: resolveAnnexureMode(revOut),
      executive_summary: refreshed.executive_summary || {},
      scope_summary: refreshed.scope_summary || {},
      configurator_context: refreshed.configurator_context || {},
      is_locked: refreshed.is_locked === true,
      locked_at: refreshed.locked_at || null,
      locked_by: refreshed.locked_by || null,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/summary/lock", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    if (!canEngineeringEditSummaries(req.user)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }
    if (revision.revision_status !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_EDITABLE" });
    }

    const lines = await getRevisionLines(client, revision.id);
    const summary = await getOrCreateRevisionSummary(client, { quote, revision, lines, actorUserId: req.user.id });
    if (summary.is_locked === true) {
      await client.query("commit");
      return res.json({ ok: true });
    }

    if (await quoteRevisionSummariesReady(client).catch(() => false)) {
      await client.query(
        `
          insert into quote_revision_summaries (quote_revision_id, executive_summary, scope_summary, configurator_context, is_locked, locked_by, locked_at, updated_by, updated_at)
          values ($1,$2,$3,$4,true,$5,now(),$5,now())
          on conflict (quote_revision_id) do update set
            is_locked = true,
            locked_by = excluded.locked_by,
            locked_at = excluded.locked_at,
            updated_by = excluded.updated_by,
            updated_at = now()
        `,
        [revision.id, summary.executive_summary || {}, summary.scope_summary || {}, summary.configurator_context || {}, req.user.id]
      );
    }

    await client.query("commit");
    return res.json({ ok: true });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/summary/unlock", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    if (!canEngineeringEditSummaries(req.user)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }
    if (revision.revision_status !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_EDITABLE" });
    }

    if (await quoteRevisionSummariesReady(client).catch(() => false)) {
      await client.query(
        `
          update quote_revision_summaries
          set is_locked = false, updated_by = $2, updated_at = now()
          where quote_revision_id = $1
        `,
        [revision.id, req.user.id]
      );
    }

    await client.query("commit");
    return res.json({ ok: true });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id/annexures", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const revision = await getLatestRevisionOrNull(pool, quoteId);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    const lines = await getRevisionLines(pool, revision.id);
    const groupIds = getPrimaryScopeGroupIds(lines);
    const presentation = await resolveQuotePresentationContext(pool, { quote, revisionId: revision.id, lines });
    const scopeCompanyId = presentation.presentation_company_id || null;

    const scopeRes = groupIds.length
      ? await pool.query(
          `
            select
              pg.id as group_id,
              pg.group_name,
              a.id as attachment_id,
              a.file_name
            from product_groups pg
            left join lateral (
              select gst.template_id
              from product_group_scope_templates gst
              where gst.product_group_id = pg.id
                and gst.is_active = true
                and (
                  $2::int is null
                  and gst.company_id is null
                  or $2::int is not null
                  and (gst.company_id = $2::int or gst.company_id is null)
                )
              order by (gst.company_id = $2::int) desc, gst.id desc
              limit 1
            ) gst on true
            left join document_templates dt
              on dt.id = gst.template_id and dt.is_active = true
            left join attachments a on a.id = dt.attachment_id
            where pg.id = any($1::int[])
            order by pg.group_name asc
          `,
          [groupIds, scopeCompanyId]
        )
      : { rows: [] };

    const annexures = scopeRes.rows
      .map((row) => ({
        group_id: row.group_id,
        group_name: row.group_name,
        attachment_id: row.attachment_id,
        file_name: row.file_name,
      }))
      .filter((row) => Number.isFinite(Number(row.attachment_id)));

    return res.json({ ok: true, annexures });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/annexures/:attachmentId", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const quoteId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isFinite(quoteId) || !Number.isFinite(attachmentId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const revision = await getLatestRevisionOrNull(pool, quoteId);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });
    const lines = await getRevisionLines(pool, revision.id);
    const presentation = await resolveQuotePresentationContext(pool, { quote, revisionId: revision.id, lines });
    const scopeCompanyId = presentation.presentation_company_id || null;

    const allowed = await pool.query(
      `
        select 1
        from quote_lines l
        join products p on p.id = l.product_id
        join product_groups pg on pg.id = p.group_id
        join lateral (
          select gst.template_id
          from product_group_scope_templates gst
          where gst.product_group_id = pg.id
            and gst.is_active = true
            and (
              $3::int is null
              and gst.company_id is null
              or $3::int is not null
              and (gst.company_id = $3::int or gst.company_id is null)
            )
          order by (gst.company_id = $3::int) desc, gst.id desc
          limit 1
        ) gst on true
        join document_templates dt on dt.id = gst.template_id and dt.is_active = true
        join attachments a on a.id = dt.attachment_id
        where l.quote_revision_id = $1 and a.id = $2
        limit 1
      `,
      [revision.id, attachmentId, scopeCompanyId]
    );
    if (!allowed.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const r = await pool.query(`select id, file_name, file_path, mime_type from attachments where id = $1 limit 1`, [attachmentId]);
    const row = r.rows[0] || null;
    if (!row?.file_path || !fs.existsSync(row.file_path)) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const fileName = row.file_name || `annexure_${attachmentId}.pdf`;
    res.setHeader("Content-Type", row.mime_type || "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileSegment(fileName)}"`);
    return res.sendFile(row.file_path);
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/pdf-meta", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const revision = await getLatestRevisionOrNull(pool, id);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    const lines = await getRevisionLines(pool, revision.id);
    const groupIds = getPrimaryScopeGroupIds(lines);
    const presentation = await resolveQuotePresentationContext(pool, { quote, revisionId: revision.id, lines });
    const scopeCompanyId = presentation.presentation_company_id || null;

    const scopeRes = groupIds.length
      ? await pool.query(
          `
            select
              pg.id as group_id,
              pg.group_name,
              a.file_name,
              a.file_path
            from product_groups pg
            left join lateral (
              select gst.template_id
              from product_group_scope_templates gst
              where gst.product_group_id = pg.id
                and gst.is_active = true
                and (
                  $2::int is null
                  and gst.company_id is null
                  or $2::int is not null
                  and (gst.company_id = $2::int or gst.company_id is null)
                )
              order by (gst.company_id = $2::int) desc, gst.id desc
              limit 1
            ) gst on true
            left join document_templates dt
              on dt.id = gst.template_id and dt.is_active = true
            left join attachments a on a.id = dt.attachment_id
            where pg.id = any($1::int[])
            order by pg.group_name asc
          `,
          [groupIds, scopeCompanyId]
        )
      : { rows: [] };
    const scopeGroups = (scopeRes.rows || []).map((row) => ({
      ...row,
      has_scope_pdf: Boolean(resolveScopePdfPath(row)),
    }));

    const summary = await getOrCreateRevisionSummary(pool, { quote, revision, lines, actorUserId: req.user.id }).catch(() => null);
    const configuratorContext = buildEffectiveConfiguratorContext({ summary, presentation });
    const letterheadPath = presentation.letterhead_path;
    const termsPath =
      (await getRevisionTemplatePath(pool, revision.id, "terms")) ||
      (await getTemplatePathByKey(pool, "QUOTE_TERMS"));
    const termsText = await getTemplateBodyByKey(pool, "QUOTE_TERMS", presentation.presentation_company_id);
    const termsCountRes = await pool.query(
      `select count(*)::int as cnt from quote_revision_terms where quote_revision_id = $1 and is_selected = true`,
      [revision.id]
    );
    const hasRevisionTerms = Number(termsCountRes.rows[0]?.cnt || 0) > 0;

    const summaryLocked = await (async () => {
      const ready = await quoteRevisionSummariesReady(pool).catch(() => false);
      if (!ready) return false;
      const r = await pool.query(`select is_locked from quote_revision_summaries where quote_revision_id = $1 limit 1`, [revision.id]);
      return r.rows[0]?.is_locked === true;
    })();

    return res.json({
      ok: true,
      scope_groups: scopeGroups,
      has_letterhead: Boolean(letterheadPath),
      merge_annexures: resolveAnnexureMode(revision) === "merged",
      annexure_mode: resolveAnnexureMode(revision),
      summary_locked: summaryLocked,
      presentation_company_code: presentation.presentation_company_code,
      presentation_company_name: presentation.presentation_company_name,
      configurator_family_key: configuratorContext.family_key,
      configurator_quote_mode: configuratorContext.configurator_quote_mode,
      configurator_route_reason: configuratorContext.route_reason,
      mixed_branding_risk: configuratorContext.mixed_branding_risk,
      recommended_split_quote: configuratorContext.recommended_split_quote,
      configurator_context: configuratorContext,
      has_terms:
        hasRevisionTerms || Boolean(termsPath) || (typeof termsText === "string" && termsText.trim().length > 0),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/pdf", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(pool, {
      quoteId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const revision = await getLatestRevisionOrNull(pool, id);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    const clubbed =
      req.query.club === "1" ||
      req.query.club === "true" ||
      req.query.mode === "clubbed" ||
      revision.pricing_display_mode === "bundled_total";
    const annexuresParam = String(req.query.annexures || "").trim().toLowerCase();
    const mergeAnnexures =
      annexuresParam === "0" || annexuresParam === "false"
        ? false
        : annexuresParam === "1" || annexuresParam === "true"
          ? true
          : undefined;
    const artifact = await generateQuotePdfArtifact(pool, {
      quote,
      revision,
      clubbed,
      mergeAnnexures,
      actorUserId: req.user.id,
    });

    const forceDownload = req.query.download === "1" || req.query.download === "true";
    res.setHeader("X-Josh-Attachment-Id", String(artifact.attachmentId || ""));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${forceDownload ? "attachment" : "inline"}; filename="${artifact.fileName}"`);
    return res.status(200).send(artifact.pdf);
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/mail-attachments", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const revision = await getLatestRevisionOrNull(client, quoteId);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    const attachmentsRes = await client.query(
      `
        select id as attachment_id, file_name, mime_type, file_size_bytes, created_at
        from attachments
        where owner_type = 'quote_mail_attachment'
          and owner_id = $1
        order by created_at desc, id desc
      `,
      [revision.id]
    );

    return res.json({ ok: true, attachments: attachmentsRes.rows });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/mail-attachments", requireScreenAction("quotes", "can_edit"), upload.single("file"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });
    if (!req.file) return res.status(400).json({ ok: false, error: "FILE_REQUIRED" });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) return res.status(404).json({ ok: false });
    if (!canAccessQuote(req, quote)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, quote)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const revision = await getLatestRevisionOrNull(client, quoteId);
    if (!revision) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    const originalName = String(req.file.originalname || "quote_mail_attachment").trim() || "quote_mail_attachment";
    const ext = path.extname(originalName);
    const baseName = safeFileSegment(path.basename(originalName, ext) || `quote_${quoteId}_mail_attachment`);
    const uniqueSuffix = `${revision.id}_${Date.now()}`;
    const fileName = `${baseName}_${uniqueSuffix}${ext ? safeFileSegment(ext) : ""}`;
    const storageDir = path.resolve(__dirname, "..", "..", "storage", "quotes", "mail_attachments");
    fs.mkdirSync(storageDir, { recursive: true });
    const absFilePath = path.join(storageDir, fileName);
    fs.writeFileSync(absFilePath, req.file.buffer);

    const attach = await createOwnedAttachment(client, {
      fileName: originalName,
      filePath: absFilePath,
      mimeType: req.file.mimetype || "application/octet-stream",
      fileSizeBytes: req.file.size || req.file.buffer?.length || 0,
      uploadedBy: req.user.id,
      companyId: quote.company_id,
      ownerType: "quote_mail_attachment",
      ownerId: revision.id,
    });

    return res.status(201).json({
      ok: true,
      attachment: {
        attachment_id: attach?.id || null,
        file_name: attach?.file_name || originalName,
        mime_type: req.file.mimetype || "application/octet-stream",
        file_size_bytes: req.file.size || req.file.buffer?.length || 0,
      },
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

const MAIL_ATTACHMENT_WARN_BYTES = 20 * 1024 * 1024;

function resolveQuoteMailInputs({ body, bootstrap, revision }) {
  const mailMode =
    body.clubbed === true || body.clubbed === "true" || revision.pricing_display_mode === "bundled_total"
      ? "clubbed"
      : "standard";
  const manualAttachmentIds = Array.isArray(body.manual_attachment_ids)
    ? body.manual_attachment_ids.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  return {
    mailMode,
    manualAttachmentIds,
    toList: splitEmailList(body.to || bootstrap.default_to),
    ccList: splitEmailList(body.cc || bootstrap.default_cc),
    bccList: splitEmailList(body.bcc || ""),
    subject: typeof body.subject === "string" && body.subject.trim().length ? body.subject.trim() : bootstrap.default_subject,
    bodyText: typeof body.body === "string" && body.body.trim().length ? body.body : bootstrap.default_body,
  };
}

async function buildQuoteMailAttachments(client, { quote, revision, inputs, actorUserId }) {
  const annexureMode = resolveAnnexureMode(revision);
  const artifact = await generateQuotePdfArtifact(client, {
    quote,
    revision,
    clubbed: inputs.mailMode === "clubbed",
    mergeAnnexures: annexureMode === "merged",
    actorUserId,
  });
  const warnings = [...(artifact.warnings || [])];
  const files = [{ kind: "quote_pdf", filename: artifact.fileName, content: artifact.pdf, contentType: "application/pdf" }];

  if (annexureMode === "separate") {
    const lines = await getRevisionLines(client, revision.id);
    const groupIds = getPrimaryScopeGroupIds(lines);
    if (groupIds.length) {
      const scopeRes = await client.query(
        `
          select
            pg.group_name,
            a.file_name,
            a.file_path
          from product_groups pg
          left join product_group_scope_templates gst
            on gst.product_group_id = pg.id and gst.is_active = true
          left join document_templates dt
            on dt.id = gst.template_id and dt.is_active = true
          left join attachments a on a.id = dt.attachment_id
          where pg.id = any($1::int[])
          order by pg.group_name asc
        `,
        [groupIds]
      );
      for (const row of scopeRes.rows) {
        const filePath = resolveScopePdfPath(row);
        if (!filePath) continue;
        const originalName = String(row.file_name || "").trim();
        const groupName = String(row.group_name || "").trim();
        const filename = originalName || `Annexure_${groupName ? safeFileSegment(groupName) : "scope"}.pdf`;
        const content = fs.readFileSync(filePath);
        const check = await checkPdfReadable(content);
        if (!check.ok) {
          warnings.push(describeUnreadablePdf(`The scope PDF "${filename}"`, check.reason));
          continue;
        }
        files.push({ kind: "annexure", filename, content, contentType: "application/pdf" });
      }
    }
  }

  if (inputs.manualAttachmentIds.length) {
    const manualRes = await client.query(
      `
        select id, file_name, file_path, mime_type
        from attachments
        where owner_type = 'quote_mail_attachment'
          and owner_id = $1
          and id = any($2::int[])
        order by created_at asc, id asc
      `,
      [revision.id, inputs.manualAttachmentIds]
    );
    for (const row of manualRes.rows) {
      const filename = String(row.file_name || `Quote_Attachment_${row.id}`).trim() || `Quote_Attachment_${row.id}`;
      if (!row?.file_path || !fs.existsSync(row.file_path)) {
        warnings.push(`"${filename}" is missing from storage, so it will not be attached.`);
        continue;
      }
      files.push({
        kind: "manual",
        filename,
        content: fs.readFileSync(row.file_path),
        contentType: row.mime_type || "application/octet-stream",
      });
    }
  }

  const summary = files.map((file) => ({ kind: file.kind, file_name: file.filename, size_bytes: file.content.length }));
  const totalBytes = summary.reduce((sum, item) => sum + item.size_bytes, 0);
  return {
    artifact,
    warnings,
    mailAttachments: files.map(({ filename, content, contentType }) => ({ filename, content, contentType })),
    summary,
    totalBytes,
    overLimit: totalBytes > MAIL_ATTACHMENT_WARN_BYTES,
  };
}

function isOwnMailboxSource(source) {
  return source?.type === "user_oauth" || source?.type === "distributor_oauth";
}

async function resolveActorMailSource(client, { actor, actorGroupName, quote }) {
  const source = await resolveEffectiveMailSource(client, {
    userId: actor?.id,
    userGroupName: actorGroupName || null,
    quoteDistributorId: quote.distributor_id,
  });
  if (isOwnMailboxSource(source) || !actor?.email || !canDelegateFor(actor.email)) return source;
  const probe = await probeDelegation(actor.email);
  if (!probe.ok) return source;
  return { type: "delegated_gmail", provider: "google", email: actor.email, displayName: actor.full_name || actor.email, account: null };
}

/**
 * Picks the From address. The customer should see the quote owner: Workspace delegation first,
 * then the owner's own connected mailbox; otherwise the actor's mailbox with the owner CC'd and as Reply-To.
 */
async function resolveQuoteSender(client, { quote, actorUserId, actorGroupName }) {
  const actorId = Number(actorUserId);
  const ownerId = quoteOwnerId(quote);
  const actor = await getUserMailProfile(client, actorId);
  const ownerRow = ownerId && ownerId !== actorId
    ? (await client.query(`select id, full_name, email, is_active from erp_users where id = $1`, [ownerId])).rows[0] || null
    : null;

  if (!ownerRow) {
    const senderSource = await resolveActorMailSource(client, { actor, actorGroupName, quote });
    return { senderSource, mode: "self", onBehalfOfUserId: null, owner: null, extraCc: [] };
  }

  const owner = { id: Number(ownerRow.id), full_name: ownerRow.full_name, email: ownerRow.email || "" };
  if (ownerRow.is_active !== false && owner.email && canDelegateFor(owner.email)) {
    const probe = await probeDelegation(owner.email);
    if (probe.ok) {
      return {
        senderSource: { type: "delegated_gmail", provider: "google", email: owner.email, displayName: owner.full_name || owner.email, account: null },
        mode: "owner_address",
        onBehalfOfUserId: owner.id,
        owner,
        extraCc: [],
      };
    }
  }
  if (ownerRow.is_active !== false) {
    const ownerSource = await resolveEffectiveMailSource(client, {
      userId: owner.id,
      userGroupName: null,
      quoteDistributorId: quote.distributor_id,
    });
    if (isOwnMailboxSource(ownerSource)) {
      return { senderSource: ownerSource, mode: "owner_address", onBehalfOfUserId: owner.id, owner, extraCc: [] };
    }
  }

  const senderSource = await resolveActorMailSource(client, { actor, actorGroupName, quote });
  return {
    senderSource,
    mode: "fallback_cc",
    onBehalfOfUserId: owner.id,
    owner,
    extraCc: ownerRow.is_active !== false && owner.email ? [owner.email] : [],
  };
}

function summarizeQuoteSender(plan, replyTo) {
  const source = plan?.senderSource;
  const email = source?.email || "";
  const name = source?.displayName || "";
  return {
    from: email ? (name ? `${name} <${email}>` : email) : "",
    source: source?.type || "none",
    ready: Boolean(source && source.type !== "none"),
    mode: plan?.mode || "self",
    owner: plan?.owner || null,
    extra_cc: plan?.extraCc || [],
    reply_to: replyTo || email || "",
  };
}

async function loadQuoteForMail(client, req) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { status: 400, error: null };
  const isDistributor = req.user.group_name === "Distributor";
  const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
  if (isDistributor && !distributorId) return { status: 400, error: "DISTRIBUTOR_NOT_LINKED" };
  const quote = await getQuoteHeaderOrNull(client, { quoteId: id, distributorId: isDistributor ? distributorId : null });
  if (!quote) return { status: 404, error: null };
  if (!canAccessQuote(req, quote)) return { status: 403, error: "FORBIDDEN" };
  if (!canAccessCompanyContext(req, quote)) return { status: 403, error: "COMPANY_CONTEXT_MISMATCH" };
  const revision = await getLatestRevisionOrNull(client, id);
  if (!revision) return { status: 400, error: "NO_REVISION" };
  return { id, quote, revision, isDistributor, distributorId };
}

router.post("/:id/mail-preview", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const loaded = await loadQuoteForMail(client, req);
    if (loaded.status) return res.status(loaded.status).json({ ok: false, ...(loaded.error ? { error: loaded.error } : {}) });
    const { quote, revision } = loaded;

    const bootstrap = await buildQuoteMailBootstrap(client, {
      quote,
      revision,
      actorUserId: req.user.id,
      actorGroupName: req.user.group_name,
    });
    const senderPlan = await resolveQuoteSender(client, {
      quote,
      actorUserId: req.user.id,
      actorGroupName: req.user.group_name,
    });
    const senderSource = senderPlan.senderSource;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const inputs = resolveQuoteMailInputs({ body, bootstrap, revision });
    inputs.ccList = mergeEmailLists(inputs.ccList, senderPlan.extraCc);
    const pack = await buildQuoteMailAttachments(client, { quote, revision, inputs, actorUserId: req.user.id });

    let html = buildQuoteMailHtml({
      bodyText: inputs.bodyText,
      sender: bootstrap.sender,
      companyProfile: bootstrap.company_profile,
      quote,
      groupNames: bootstrap.group_names,
      configuratorContext: bootstrap.configurator_context,
      trackingUrl: null,
    });
    for (const inline of buildCompanyMailInlineAttachments(bootstrap.company_profile)) {
      if (!inline?.cid || !inline?.content) continue;
      const dataUri = `data:${inline.contentType || "image/png"};base64,${Buffer.from(inline.content).toString("base64")}`;
      html = html.split(`cid:${inline.cid}`).join(dataUri);
    }

    const senderEmail = senderSource?.email || "";
    const senderName = senderSource?.displayName || "";
    return res.json({
      ok: true,
      from: senderEmail ? (senderName ? `${senderName} <${senderEmail}>` : senderEmail) : "",
      mailbox_ready: Boolean(senderSource && senderSource.type !== "none"),
      send_as: summarizeQuoteSender(senderPlan, bootstrap.sender?.email),
      reply_to: bootstrap.sender?.email || senderEmail || "",
      to: joinEmailList(inputs.toList),
      cc: joinEmailList(inputs.ccList),
      bcc: joinEmailList(inputs.bccList),
      subject: inputs.subject,
      html,
      attachments: pack.summary,
      total_bytes: pack.totalBytes,
      limit_bytes: MAIL_ATTACHMENT_WARN_BYTES,
      over_limit: pack.overLimit,
      warnings: pack.warnings,
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id/mail-logs/:logId/pdf", requireScreenAction("quotes", "can_view"), async (req, res, next) => {
  try {
    const loaded = await loadQuoteForMail(pool, req);
    if (loaded.status) return res.status(loaded.status).json({ ok: false, ...(loaded.error ? { error: loaded.error } : {}) });
    const logId = Number(req.params.logId);
    if (!Number.isFinite(logId)) return res.status(400).json({ ok: false });
    const r = await pool.query(
      `
        select a.file_name, a.file_path, a.owner_type
        from quote_mail_logs qml
        join quote_revisions qr on qr.id = qml.quote_revision_id
        join attachments a on a.id = qml.attachment_id
        where qml.id = $1 and qr.quote_id = $2
        limit 1
      `,
      [logId, loaded.id]
    );
    const row = r.rows[0];
    if (!row || row.owner_type !== "quote_sent_pdf") return res.status(404).json({ ok: false, error: "SENT_PDF_NOT_ARCHIVED" });
    if (!row.file_path || !fs.existsSync(row.file_path)) return res.status(404).json({ ok: false, error: "SENT_PDF_MISSING" });
    const safeName = String(row.file_name || "quote.pdf").replace(/[^\w.\-]+/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    return res.status(200).send(fs.readFileSync(row.file_path));
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/send-mail", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const loaded = await loadQuoteForMail(client, req);
    if (loaded.status) return res.status(loaded.status).json({ ok: false, ...(loaded.error ? { error: loaded.error } : {}) });
    const { id, quote, revision, isDistributor, distributorId } = loaded;
    if (revision.revision_status !== "issued") {
      return res.status(409).json({ ok: false, error: "REVISION_NOT_ISSUED" });
    }

    const bootstrap = await buildQuoteMailBootstrap(client, {
      quote,
      revision,
      actorUserId: req.user.id,
      actorGroupName: req.user.group_name,
    });
    const senderPlan = await resolveQuoteSender(client, {
      quote,
      actorUserId: req.user.id,
      actorGroupName: req.user.group_name,
    });
    const senderSource = senderPlan.senderSource;

    const body = req.body && typeof req.body === "object" ? req.body : {};
    // Must match GET /:id/pdf so the customer receives the same layout the salesperson previewed.
    const inputs = resolveQuoteMailInputs({ body, bootstrap, revision });
    inputs.ccList = mergeEmailLists(inputs.ccList, senderPlan.extraCc);
    const { mailMode, toList, ccList, bccList, subject, bodyText } = inputs;

    if (!toList.length) {
      return res.status(400).json({ ok: false, error: "NO_RECIPIENT" });
    }
    if (!subject) {
      return res.status(400).json({ ok: false, error: "MISSING_SUBJECT" });
    }
    if (!senderSource || senderSource.type === "none") {
      return res.status(400).json({ ok: false, error: "MAIL_ACCOUNT_NOT_CONFIGURED" });
    }

    if (body.confirm_resend !== true) {
      const recentRes = await client.query(
        `
          select sent_at, recipient_to
          from quote_mail_logs
          where quote_revision_id = $1
            and send_status = 'sent'
            and sent_at > now() - interval '10 minutes'
            and lower(recipient_to) = lower($2)
          order by sent_at desc
          limit 1
        `,
        [revision.id, joinEmailList(toList)]
      );
      if (recentRes.rows[0]) {
        return res.status(409).json({
          ok: false,
          error: "RECENTLY_SENT",
          sent_at: recentRes.rows[0].sent_at,
          recipient_to: recentRes.rows[0].recipient_to,
        });
      }
    }

    const pack = await buildQuoteMailAttachments(client, { quote, revision, inputs, actorUserId: req.user.id });
    const { artifact } = pack;
    if (pack.overLimit && body.confirm_large_attachments !== true) {
      return res.status(409).json({
        ok: false,
        error: "ATTACHMENTS_TOO_LARGE",
        total_bytes: pack.totalBytes,
        limit_bytes: MAIL_ATTACHMENT_WARN_BYTES,
        attachments: pack.summary,
      });
    }
    let loggedAttachmentId = artifact.attachmentId;

    const trackingToken = buildQuoteMailTrackingToken();
    let mailDelivered = false;
    let mailInfo = null;
    try {
      const trackingUrl = buildQuoteMailTrackingUrl(trackingToken);
      mailInfo = await sendMail({
        to: joinEmailList(toList),
        cc: joinEmailList(ccList),
        bcc: joinEmailList(bccList),
        subject,
        text: bodyText,
        html: buildQuoteMailHtml({
          bodyText,
          sender: bootstrap.sender,
          companyProfile: bootstrap.company_profile,
          quote,
          groupNames: bootstrap.group_names,
          configuratorContext: bootstrap.configurator_context,
          trackingUrl,
        }),
        replyTo: bootstrap.sender?.email || undefined,
        senderSource,
        attachments: [...buildCompanyMailInlineAttachments(bootstrap.company_profile), ...pack.mailAttachments],
      });
      mailDelivered = true;

      try {
        loggedAttachmentId = await freezeSentQuotePdf(client, { quote, revision, artifact, actorUserId: req.user.id });
      } catch (freezeErr) {
        process.stderr.write(`Quote ${id} sent but frozen PDF copy failed: ${freezeErr?.stack || freezeErr}\n`);
      }

      await client.query(
        `
          insert into quote_mail_logs (
            quote_revision_id,
            attachment_id,
            mail_mode,
            recipient_to,
            recipient_cc,
            recipient_bcc,
            subject,
            body_text,
            smtp_message_id,
            tracking_token,
            sender_source,
            sender_email,
            send_status,
            sent_by,
            attachments_json,
            attachments_total_bytes,
            on_behalf_of_user_id
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sent',$13,$14::jsonb,$15,$16)
        `,
        [
          revision.id,
          loggedAttachmentId,
          mailMode,
          joinEmailList(toList),
          joinEmailList(ccList) || null,
          joinEmailList(bccList) || null,
          subject,
          bodyText,
          mailInfo.messageId,
          trackingToken,
          senderSource.type,
          senderSource.email || null,
          req.user.id,
          JSON.stringify(pack.summary),
          pack.totalBytes,
          senderPlan.onBehalfOfUserId,
        ]
      );
      if (senderSource.account?.id) {
        await markMailAccountUsed(client, senderSource.account.id);
      }

      const history = await getQuoteMailHistory(client, revision.id);
      if (await hasQuoteHeaderColumn(client, "first_sent_at")) {
        await client.query(
          `
            update quote_headers
            set
              first_sent_at = coalesce(first_sent_at, now()),
              last_sent_at = now(),
              quote_status = case
                when quote_status in ('converted', 'closed', 'cancelled', 'lapsed') then quote_status
                else 'sent'
              end,
              updated_at = now()
            where id = $1
          `,
          [id]
        );
      }

      if (quote?.lead_id) {
        await client.query(
          `
            insert into lead_activities (
              lead_id,
              activity_type,
              subject,
              notes,
              activity_at,
              created_by
            )
            values ($1, 'email', $2, $3, now(), $4)
          `,
          [
            quote.lead_id,
            `Quote ${quote.quote_number || id} Dispatched`,
            `Formal quotation ${quote.quote_number || id} (Rev ${revision.revision_no}) sent to ${joinEmailList(toList)}. Subject: ${subject}`,
            req.user.id,
          ]
        ).catch(() => {});
      }
      const sentQuote = await getQuoteHeaderOrNull(client, {
        quoteId: id,
        distributorId: isDistributor ? distributorId : null,
      });
      const notifyOwnerId = quoteOwnerId(quote) || Number(revision.prepared_by) || null;
      if (notifyOwnerId && notifyOwnerId !== Number(req.user.id)) {
        notifyQuoteOutcome({
          quoteId: id,
          quoteNumber: quote.quote_number || null,
          preparerUserId: notifyOwnerId,
          actorUserId: req.user.id,
          actorName: req.user.full_name || req.user.email || "",
          companyId: quote.company_id || null,
          outcome: senderPlan.mode === "owner_address" ? "sent_from_your_address" : "sent_by_other",
          recipientEmail: joinEmailList(toList),
        }).catch(() => {});
      }
      return res.json({
        ok: true,
        attachment_id: loggedAttachmentId,
        file_name: artifact.fileName,
        message_id: mailInfo.messageId,
        warnings: pack.warnings,
        history,
        quote: sentQuote || quote,
      });
    } catch (mailErr) {
      if (mailDelivered) {
        // The customer already has the email; reporting failure here would invite a duplicate resend.
        process.stderr.write(`Quote ${id} mail delivered but bookkeeping failed: ${mailErr?.stack || mailErr}\n`);
        const history = await getQuoteMailHistory(client, revision.id).catch(() => []);
        return res.json({
          ok: true,
          warning: "SENT_BUT_NOT_RECORDED",
          attachment_id: loggedAttachmentId,
          file_name: artifact.fileName,
          message_id: mailInfo?.messageId || null,
          history,
          quote,
        });
      }
      const mailboxNeedsReconnect =
        senderSource.type === "user_oauth" &&
        (mailErr?.code === "MAIL_GOOGLE_TOKEN_FAILED" ||
          Number(mailErr?.responseCode) === 401 ||
          /invalid_grant|expired or revoked|unauthorized/i.test(String(mailErr?.message || "")));
      await client.query(
        `
          insert into quote_mail_logs (
            quote_revision_id,
            attachment_id,
            mail_mode,
            recipient_to,
            recipient_cc,
            recipient_bcc,
            subject,
            body_text,
            tracking_token,
            sender_source,
            sender_email,
            send_status,
            error_text,
            sent_by,
            on_behalf_of_user_id
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'failed',$12,$13,$14)
        `,
        [
          revision.id,
          artifact.attachmentId,
          mailMode,
          joinEmailList(toList),
          joinEmailList(ccList) || null,
          joinEmailList(bccList) || null,
          subject,
          bodyText,
          trackingToken || null,
          senderSource.type || null,
          senderSource.email || null,
          String(mailErr?.message || "MAIL_SEND_FAILED").slice(0, 2000),
          req.user.id,
          senderPlan.onBehalfOfUserId,
        ]
      );
      const history = await getQuoteMailHistory(client, revision.id);
      return res.status(mailboxNeedsReconnect ? 409 : 500).json({
        ok: false,
        error: mailboxNeedsReconnect ? "MAILBOX_RECONNECT_REQUIRED" : "MAIL_SEND_FAILED",
        sender_email: senderSource.email || null,
        mail_error: {
          code: mailErr?.code || null,
          response_code: mailErr?.responseCode || null,
          message: String(mailErr?.message || "MAIL_SEND_FAILED").slice(0, 500),
        },
        history,
      });
    }
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id/lines", requireScreenAction("quotes", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const linesInput = Array.isArray(body.lines) ? body.lines : [];

    await client.query("begin");

    const quote = await getQuoteHeaderOrNull(client, {
      quoteId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessQuote(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const revision = await getLatestRevisionOrNull(client, quoteId, { forUpdate: true });
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }

    if (revision.revision_status !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REVISION_NOT_EDITABLE" });
    }

    const hasPricingCols = await hasQuoteLineColumn(client, "discount_pct");
    const existingRes = await client.query(
      hasPricingCols
        ? `
        select
          l.id,
          l.product_id,
          l.unit_price_quote,
          l.discount_pct,
          l.gst_pct,
          l.item_name,
          l.scope_type,
          l.line_description,
          l.customer_item_code,
          l.customer_item_description,
          l.gross_unit_price_quote,
          l.list_price_snapshot,
          p.group_id as product_group_id,
          p.list_price
        from quote_lines l
        left join products p on p.id = l.product_id
        where l.quote_revision_id = $1
      `
        : `
        select
          l.id,
          l.product_id,
          l.unit_price_quote,
          l.gst_pct,
          l.item_name,
          l.scope_type,
          l.line_description,
          l.customer_item_code,
          l.customer_item_description,
          p.group_id as product_group_id,
          p.list_price
        from quote_lines l
        left join products p on p.id = l.product_id
        where l.quote_revision_id = $1
      `,
      [revision.id]
    );
    const existingById = new Map(existingRes.rows.map((r) => [r.id, r]));
    const exchangeRate = await resolveRevisionExchangeRate(client, revision);
    const guardrails = await loadQuotePricingGuardrails(client, quote.company_id ?? revision.company_id);
    const floorBreaches = [];
    const priceBandWarnings = [];
    const auditRows = [];

    // Lines are renumbered 1..n below while removed lines are only deleted afterwards; park the
    // current numbers out of range first so unique (quote_revision_id, line_no) cannot collide.
    await client.query(`update quote_lines set line_no = -line_no where quote_revision_id = $1 and line_no > 0`, [revision.id]);

    let lineNo = 1;
    const keepIds = new Set();

    for (const l of linesInput) {
      const obj = l && typeof l === "object" ? l : {};

      const id = num(obj.id);
      const qty = num(obj.qty);
      const unitPriceQuote = num(obj.unit_price_quote);
      const gstPct = num(obj.gst_pct);
      const scopeType = normalizeScopeType(obj.scope_type);

      const productIdRaw = obj.product_id === null || obj.product_id === undefined ? null : num(obj.product_id);
      const itemNameRaw = typeof obj.item_name === "string" ? obj.item_name.trim() : "";
      const lineDescRaw = typeof obj.line_description === "string" ? obj.line_description.trim() : "";
      const hasCustomerItemInput =
        Object.prototype.hasOwnProperty.call(obj, "customer_item_code") ||
        Object.prototype.hasOwnProperty.call(obj, "customer_item_description");

      if (!Number.isFinite(qty) || qty <= 0) continue;
      if (!Number.isFinite(productIdRaw)) {
        await client.query("rollback");
        return res.status(409).json({
          ok: false,
          error: "PRODUCT_REQUIRED",
          detail: "Every quote line must come from Product Master. Manual line entry is not allowed.",
        });
      }

      if (Number.isFinite(id) && existingById.has(id)) {
        const ex = existingById.get(id);
        const finalUnitPriceQuote = unitPriceQuote === null ? Number(ex.unit_price_quote) : unitPriceQuote;
        const finalUnitPriceBase = convertQuoteAmountToBase(finalUnitPriceQuote, exchangeRate);
        const finalGstPct = gstPct === null ? Number(ex.gst_pct) : clampGstPct(gstPct);
        const finalItemName = itemNameRaw || ex.item_name || null;
        const finalScope = scopeType || ex.scope_type || "included";
        const finalLineDesc = lineDescRaw || ex.line_description || null;
        const totalBase = roundMoney(Number(finalUnitPriceBase) * Number(qty), 2);
        const totalQuote = roundMoney(Number(finalUnitPriceQuote) * Number(qty), 2);
        const pricing = {
          ...obj,
          unit_price_quote: finalUnitPriceQuote,
          line_description: finalLineDesc,
          discount_pct: obj.discount_pct ?? ex.discount_pct,
          gross_unit_price_quote: obj.gross_unit_price_quote ?? ex.gross_unit_price_quote,
          list_price_snapshot: obj.list_price_snapshot ?? ex.list_price_snapshot,
        };
        const discountPct = getLineDiscountPct(pricing);
        const grossUnit = resolveLineGrossUnit(pricing, finalUnitPriceQuote);
        const listSnapshot = resolveLineListSnapshot(pricing, Number(ex.list_price || 0));
        const discountAmt = roundMoney(Math.max(0, (grossUnit - finalUnitPriceQuote) * Number(qty)), 4);
        const priceBand =
          finalScope === "client_scope"
            ? null
            : classifyLinePriceBand(matchQuoteGuardrail(guardrails, ex.product_group_id), finalUnitPriceQuote, listSnapshot);
        if (priceBand) {
          const bandRow = { line_no: lineNo, item_name: finalItemName, unit_price_quote: finalUnitPriceQuote, list_price_snapshot: listSnapshot, ...priceBand };
          if (priceBand.band === "floor") floorBreaches.push({ ...bandRow, min_net_pct_of_list: priceBand.threshold_pct, floor: priceBand.threshold_price });
          else priceBandWarnings.push(bandRow);
        }
        if (Math.abs(Number(ex.unit_price_quote || 0) - Number(finalUnitPriceQuote || 0)) > 0.009 || Math.abs(Number(ex.discount_pct || 0) - discountPct) > 0.009) {
          auditRows.push({
            quote_line_id: id,
            old_unit_price_quote: ex.unit_price_quote,
            new_unit_price_quote: finalUnitPriceQuote,
            old_discount_pct: ex.discount_pct,
            new_discount_pct: discountPct,
          });
        }
        const customerItem = await resolveCustomerItemFields(client, {
          companyId: quote.company_id ?? revision.company_id,
          customerId: quote.customer_id,
          productId: Number.isFinite(productIdRaw) ? productIdRaw : ex.product_id,
          customerItemCode: hasCustomerItemInput ? obj.customer_item_code : ex.customer_item_code,
          customerItemDescription: hasCustomerItemInput ? obj.customer_item_description : ex.customer_item_description,
        });

        await client.query(
          hasPricingCols
            ? `
            update quote_lines
            set
              line_no = $2,
              item_name = $3,
              qty = $4,
              unit_price_base = $5,
              unit_price_quote = $6,
              gst_pct = $7,
              line_total_base = $8,
              line_total_quote = $9,
              scope_type = $10,
              line_description = $12,
              customer_item_code = $13,
              customer_item_description = $14,
              discount_pct = $15,
              discount_amt = $16,
              gross_unit_price_quote = $17,
              list_price_snapshot = $18
            where id = $1 and quote_revision_id = $11
          `
            : `
            update quote_lines
            set
              line_no = $2,
              item_name = $3,
              qty = $4,
              unit_price_base = $5,
              unit_price_quote = $6,
              gst_pct = $7,
              line_total_base = $8,
              line_total_quote = $9,
              scope_type = $10,
              line_description = $12,
              customer_item_code = $13,
              customer_item_description = $14
            where id = $1 and quote_revision_id = $11
          `,
          hasPricingCols
            ? [
                id,
                lineNo,
                finalItemName,
                qty,
                finalUnitPriceBase,
                finalUnitPriceQuote,
                finalGstPct,
                totalBase,
                totalQuote,
                finalScope,
                revision.id,
                finalLineDesc,
                customerItem.customer_item_code,
                customerItem.customer_item_description,
                discountPct,
                discountAmt,
                grossUnit,
                listSnapshot,
              ]
            : [
                id,
                lineNo,
                finalItemName,
                qty,
                finalUnitPriceBase,
                finalUnitPriceQuote,
                finalGstPct,
                totalBase,
                totalQuote,
                finalScope,
                revision.id,
                finalLineDesc,
                customerItem.customer_item_code,
                customerItem.customer_item_description,
              ]
        );

        keepIds.add(id);
        lineNo += 1;
        continue;
      }

      if (!Number.isFinite(productIdRaw) && !itemNameRaw) continue;

      let resolved = null;
      if (Number.isFinite(productIdRaw)) {
        resolved = await getCompanyProductOrNull(client, { companyId: revision.company_id, productId: productIdRaw, mode: "sale" });
      }

      if (!resolved) {
        await client.query("rollback");
        return res.status(404).json({
          ok: false,
          error: "PRODUCT_NOT_FOUND",
          detail: "Selected product was not found in Product Master.",
        });
      }

      const finalItemCode = resolved?.item_code || null;
      const finalItemName = resolved?.item_name || itemNameRaw || null;
      const taxProfile = await resolveQuoteTaxProfile(client, { hsnNo: resolved?.hsn_no, fallbackGstPct: resolved?.gst_pct });
      const hsnNo = taxProfile.hsn_no;
      const finalGstPct = gstPct === null ? taxProfile.gst_pct : clampGstPct(gstPct);
      const defaultUnitPriceQuote = convertBaseAmountToQuote(Number(resolved?.list_price || 0), exchangeRate);
      const finalUnitPriceQuote = unitPriceQuote === null ? defaultUnitPriceQuote : unitPriceQuote;
      const finalUnitPriceBase = convertQuoteAmountToBase(finalUnitPriceQuote, exchangeRate);
      const totalBase = roundMoney(Number(finalUnitPriceBase) * Number(qty), 2);
      const totalQuote = roundMoney(Number(finalUnitPriceQuote) * Number(qty), 2);
      const finalScope = scopeType || "included";
      const finalLineDesc = lineDescRaw || null;

      if (!finalItemName) continue;

      const pricing = {
        ...obj,
        unit_price_quote: finalUnitPriceQuote,
        line_description: finalLineDesc,
      };
      const discountPct = getLineDiscountPct(pricing);
      const grossUnit = resolveLineGrossUnit(pricing, finalUnitPriceQuote);
      const listSnapshot = resolveLineListSnapshot(pricing, Number(resolved?.list_price || 0));
      const discountAmt = roundMoney(Math.max(0, (grossUnit - finalUnitPriceQuote) * Number(qty)), 4);
      const priceBand =
        finalScope === "client_scope"
          ? null
          : classifyLinePriceBand(matchQuoteGuardrail(guardrails, resolved?.group_id), finalUnitPriceQuote, listSnapshot);
      if (priceBand) {
        const bandRow = { line_no: lineNo, item_name: finalItemName, unit_price_quote: finalUnitPriceQuote, list_price_snapshot: listSnapshot, ...priceBand };
        if (priceBand.band === "floor") floorBreaches.push({ ...bandRow, min_net_pct_of_list: priceBand.threshold_pct, floor: priceBand.threshold_price });
        else priceBandWarnings.push(bandRow);
      }

      const customerItem = await resolveCustomerItemFields(client, {
        companyId: quote.company_id ?? revision.company_id,
        customerId: quote.customer_id,
        productId: Number.isFinite(productIdRaw) ? productIdRaw : null,
        customerItemCode: obj.customer_item_code,
        customerItemDescription: obj.customer_item_description,
      });

      const insRes = await client.query(
        hasPricingCols
          ? `
          insert into quote_lines (
            quote_revision_id,
            line_no,
            product_id,
            item_code,
            item_name,
            hsn_no,
            line_description,
            qty,
            unit_price_base,
            unit_price_quote,
            gst_pct,
            line_total_base,
            line_total_quote,
            scope_type,
            customer_item_code,
            customer_item_description,
            discount_pct,
            discount_amt,
            gross_unit_price_quote,
            list_price_snapshot
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          returning id
        `
          : `
          insert into quote_lines (
            quote_revision_id,
            line_no,
            product_id,
            item_code,
            item_name,
            hsn_no,
            line_description,
            qty,
            unit_price_base,
            unit_price_quote,
            gst_pct,
            line_total_base,
            line_total_quote,
            scope_type,
            customer_item_code,
            customer_item_description
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          returning id
        `,
        hasPricingCols
          ? [
              revision.id,
              lineNo,
              Number.isFinite(productIdRaw) ? productIdRaw : null,
              finalItemCode,
              finalItemName,
              hsnNo,
              finalLineDesc,
              qty,
              finalUnitPriceBase,
              finalUnitPriceQuote,
              finalGstPct,
              totalBase,
              totalQuote,
              finalScope,
              customerItem.customer_item_code,
              customerItem.customer_item_description,
              discountPct,
              discountAmt,
              grossUnit,
              listSnapshot,
            ]
          : [
              revision.id,
              lineNo,
              Number.isFinite(productIdRaw) ? productIdRaw : null,
              finalItemCode,
              finalItemName,
              hsnNo,
              finalLineDesc,
              qty,
              finalUnitPriceBase,
              finalUnitPriceQuote,
              finalGstPct,
              totalBase,
              totalQuote,
              finalScope,
              customerItem.customer_item_code,
              customerItem.customer_item_description,
            ]
      );

      keepIds.add(insRes.rows[0].id);
      lineNo += 1;
    }

    const existingIds = existingRes.rows.map((r) => r.id);
    const toDelete = existingIds.filter((x) => !keepIds.has(x));
    if (toDelete.length) {
      await client.query(`delete from quote_lines where quote_revision_id = $1 and id = any($2::int[])`, [
        revision.id,
        toDelete,
      ]);
    }

    if (floorBreaches.length) {
      await client.query("rollback");
      return res.status(409).json({
        ok: false,
        error: "PRICE_FLOOR_BREACH",
        detail: "One or more lines are below the company list-price floor.",
        lines: floorBreaches,
      });
    }

    if (auditRows.length) {
      const auditReady = await client
        .query(`select to_regclass('public.quote_line_price_audit') is not null as ready`)
        .then((r) => r.rows[0]?.ready === true)
        .catch(() => false);
      if (auditReady) {
        for (const row of auditRows) {
          await client.query(
            `
              insert into quote_line_price_audit (
                quote_line_id,
                quote_revision_id,
                old_unit_price_quote,
                new_unit_price_quote,
                old_discount_pct,
                new_discount_pct,
                changed_by
              )
              values ($1,$2,$3,$4,$5,$6,$7)
            `,
            [
              row.quote_line_id,
              revision.id,
              row.old_unit_price_quote,
              row.new_unit_price_quote,
              row.old_discount_pct,
              row.new_discount_pct,
              req.user.id,
            ]
          );
        }
      }
    }

    await recalcRevisionTotals(client, revision.id);
    await markRevisionEdited(client, revision.id, req.user.id);
    const autoOfferType = await refreshAutoOfferType(client, { quoteId, revisionId: revision.id });

    const outRevision = await getLatestRevisionOrNull(client, quoteId);
    const outLines = outRevision ? await getRevisionLines(client, outRevision.id) : [];

    await client.query("commit");
    return res.json({
      ok: true,
      quote: autoOfferType ? { ...quote, offer_type: autoOfferType } : quote,
      revision: outRevision,
      lines: outLines,
      offer_type_changed: Boolean(autoOfferType),
      pricing_warnings: priceBandWarnings.length
        ? {
            code: "PRICE_BELOW_APPROVAL_BAND",
            detail: `${priceBandWarnings.length} line(s) are below the approval band — the revision will route to commercial approval before issue.`,
            lines: priceBandWarnings,
          }
        : null,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/from-lead/:leadId", requireScreenAction("quotes", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");

    const companyId = await resolveQuoteCompanyId(client, req);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const leadRes = await client.query(
      `
        select l.*, c.customer_name
        from leads l
        left join customers c on c.id = l.customer_id
        where l.id = $1
          and l.company_id = $2
        limit 1
      `,
      [leadId, companyId]
    );
    const lead = leadRes.rows[0] || null;
    if (!lead) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }

    if (!lead.customer_id) {
      const autoCreate =
        body.create_customer === true ||
        body.create_customer === "true" ||
        body.create_customer === 1 ||
        body.create_customer === "1" ||
        String(req.query.create_customer || "").trim() === "1";
      if (!autoCreate) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "LEAD_NOT_LINKED_TO_CUSTOMER" });
      }
      if (!hasScreenAction(req, "customers", "can_create") && !hasScreenAction(req, "customers", "can_edit")) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "CUSTOMER_PERMISSION_REQUIRED" });
      }

      const contactRes = await client.query(
        `
          select *
          from lead_contacts
          where lead_id = $1
          order by is_primary desc, id asc
          limit 1
        `,
        [leadId]
      );
      const contact = contactRes.rows[0] || null;
      const contactEmail =
        contact && typeof contact.email === "string" && contact.email.length ? contact.email.toLowerCase() : null;
      const contactPhone =
        contact && typeof contact.phone === "string" && contact.phone.length ? contact.phone : null;

      const result = await createCustomerFromParty(client, {
        party: {
          customer_name: lead.company_name,
          email: contactEmail,
          phone: contactPhone,
          contact_name: contact?.full_name || null,
          contact_email: contactEmail,
          contact_phone: contactPhone,
          contact_designation: contact?.designation || null,
          contact_roles: ["sales_enquiry", "quote_recipient"],
        },
        companyId,
        distributorId: Number.isFinite(Number(lead.distributor_id)) ? Number(lead.distributor_id) : isDistributor ? distributorId : null,
        reuseExistingByEmail: true,
        ownershipType: "owned",
      });
      const customer = result.customer;
      await client.query(
        `
          update leads
          set customer_id = $1,
              converted_customer_id = coalesce(converted_customer_id, $1),
              updated_at = now()
          where id = $2
        `,
        [customer.id, leadId]
      );
      lead.customer_id = customer.id;
      lead.customer_name = customer.customer_name;
    }

    await ensureCustomerCompanyAccess(client, req, lead.customer_id);

    if (isDistributor) {
      if (!lead.distributor_id || lead.distributor_id !== distributorId) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }

      const linkRes = await client.query(
        `
          select 1
          from customer_distributor_links
          where customer_id = $1 and distributor_id = $2
          limit 1
        `,
        [lead.customer_id, distributorId]
      );
      if (!linkRes.rows.length) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "CUSTOMER_NOT_ALLOWED" });
      }
    } else if (Number.isFinite(lead.distributor_id)) {
      await client.query(
        `
          insert into customer_distributor_links (customer_id, distributor_id)
          values ($1,$2)
          on conflict (customer_id, distributor_id) do nothing
        `,
        [lead.customer_id, lead.distributor_id]
      );
    }

    const contactRes = await client.query(
      `
        select full_name
        from lead_contacts
        where lead_id = $1
        order by is_primary desc, id asc
        limit 1
      `,
      [leadId]
    );
    const attentionTo = contactRes.rows[0]?.full_name || null;

    const customerSiteId = await resolveQuoteCustomerSiteId(client, {
      customerId: lead.customer_id,
      customerSiteId: null,
    });

    const quote = await insertQuoteHeaderWithNumberRetry(client, {
      companyId,
      customerId: lead.customer_id,
      customerSiteId,
      distributorId: isDistributor ? distributorId : lead.distributor_id || null,
      leadId: lead.id,
      attentionTo,
      createdBy: req.user.id,
      orderFlow: lead.distributor_id || isDistributor ? "distributor" : "direct",
      fulfillmentMode: lead.distributor_id || isDistributor ? "stock_sale" : "direct_customer",
      buyerPoNumber: null,
      buyerPoDate: null,
      poExceptionReason: null,
      endCustomerName: null,
      endCustomerPoNumber: null,
      endCustomerPoDate: null,
      shipToCustomerSiteId: customerSiteId,
      billToName: null,
      billToAddress: null,
      shipToName: null,
      shipToAddress: null,
    });

    const inrRes = await client.query(
      `select id from currencies where currency_code = 'INR' limit 1`
    );
    const inrId = inrRes.rows[0]?.id;
    if (!inrId) throw new Error("INR currency not seeded");

    const revRes = await client.query(
      `
        insert into quote_revisions (
          quote_id,
          company_id,
          revision_no,
          revision_status,
          base_currency_id,
          quote_currency_id,
          prepared_by,
          prepared_at,
          is_latest
        )
        values ($1,$2,1,'draft',$3,$3,$4,now(),true)
        returning *
      `,
      [quote.id, companyId, inrId, req.user.id]
    );
    const revision = revRes.rows[0];

    await ensureRevisionTerms(client, revision.id);

    await client.query(
      `
        update leads
        set
          status = case when status = 'order_won' then status else 'quoted' end,
          lifecycle_status = case when lifecycle_status in ('won', 'lost', 'cancelled') then lifecycle_status else 'negotiation' end,
          sales_activity_status = case
            when sales_activity_status in ('order_closed', 'lost_order') then sales_activity_status
            else 'quote_sent'
          end,
          customer_id = coalesce(customer_id, $2),
          converted_quote_id = $3,
          converted_to_quote_at = coalesce(converted_to_quote_at, now()),
          converted_customer_id = coalesce(converted_customer_id, $2),
          last_sales_engagement_at = now(),
          newsletter_segment = null,
          dormant_since = null,
          updated_at = now()
        where id = $1
      `,
      [lead.id, lead.customer_id, quote.id]
    );

    await client.query("commit");
    return res.status(201).json({ ok: true, quote, revision });
  } catch (err) {
    await client.query("rollback");
    const detail = String(err?.detail || err?.message || "Failed to create quote.").slice(0, 500);
    const status = /^22|^23/.test(String(err?.code || "")) ? 400 : 500;
    return res.status(status).json({
      ok: false,
      error: "QUOTE_CREATE_FAILED",
      detail,
      pg_code: err?.code || null,
    });
  } finally {
    client.release();
  }
});

router.post("/", requireScreenAction("quotes", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const customerId = Number(body.customer_id);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false });

    const attentionTo = typeof body.attention_to === "string" ? body.attention_to.trim() : "";
    const leadId = Number(body.lead_id);
    const requestedCustomerSiteId =
      body.customer_site_id === null || body.customer_site_id === undefined || body.customer_site_id === ""
        ? null
        : Number(body.customer_site_id);
    const requestedJobAssetId =
      body.job_asset_id === null || body.job_asset_id === undefined || body.job_asset_id === ""
        ? null
        : Number(body.job_asset_id);
    const requestedServiceWarrantyCaseId =
      body.service_warranty_case_id === null || body.service_warranty_case_id === undefined || body.service_warranty_case_id === ""
        ? null
        : Number(body.service_warranty_case_id);
    const requestedAmcContractId =
      body.amc_contract_id === null || body.amc_contract_id === undefined || body.amc_contract_id === ""
        ? null
        : Number(body.amc_contract_id);
    const buyerPoNumber = normalizeNullableText(body.buyer_po_number);
    const buyerPoDate = normalizeOptionalDateValue(body.buyer_po_date);
    const poExceptionReason = normalizeNullableText(body.po_exception_reason);
    const endCustomerName = normalizeNullableText(body.end_customer_name);
    const endCustomerPoNumber = normalizeNullableText(body.end_customer_po_number);
    const endCustomerPoDate = normalizeOptionalDateValue(body.end_customer_po_date);
    const requestedShipToCustomerSiteId =
      body.ship_to_customer_site_id === null || body.ship_to_customer_site_id === undefined || body.ship_to_customer_site_id === ""
        ? null
        : Number(body.ship_to_customer_site_id);
    const billToName = normalizeNullableText(body.bill_to_name);
    const billToAddress = normalizeNullableText(body.bill_to_address);
    const shipToName = normalizeNullableText(body.ship_to_name);
    const shipToAddress = normalizeNullableText(body.ship_to_address);
    const linesInput = Array.isArray(body.lines) ? body.lines : [];

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    if (isDistributor) {
      const linkRes = await client.query(
        `
          select 1
          from customer_distributor_links
          where customer_id = $1 and distributor_id = $2
          limit 1
        `,
        [customerId, distributorId]
      );
      if (!linkRes.rows.length) {
        return res.status(403).json({ ok: false, error: "CUSTOMER_NOT_ALLOWED" });
      }
    }

    const requestedOrderFlow = normalizeOrderFlowValue(body.order_flow, isDistributor ? "distributor" : "direct");
    const requestedFulfillmentMode = normalizeFulfillmentModeValue(
      body.fulfillment_mode,
      requestedOrderFlow === "distributor" ? "stock_sale" : "direct_customer"
    );
    const orderCaptureError = validateOrderCapture({
      orderFlow: requestedOrderFlow,
      fulfillmentMode: requestedFulfillmentMode,
      distributorId: isDistributor ? distributorId : null,
      buyerPoNumber,
      poExceptionReason,
      endCustomerName,
    });
    if (orderCaptureError) {
      return res.status(400).json({ ok: false, error: orderCaptureError });
    }

    await client.query("begin");

    const companyId = await resolveQuoteCompanyId(client, req);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    await ensureCustomerCompanyAccess(client, req, customerId);

    let lead = null;
    if (Number.isFinite(leadId)) {
      const leadRes = await client.query(
        `
          select id, customer_id, distributor_id, company_id
          from leads
          where id = $1
            and company_id = $2
          limit 1
        `,
        [leadId, companyId]
      );
      lead = leadRes.rows[0] || null;
      if (!lead) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "LEAD_NOT_FOUND" });
      }
      if (Number(lead.customer_id) !== customerId) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "LEAD_CUSTOMER_MISMATCH" });
      }
      if (isDistributor && Number(lead.distributor_id || 0) !== Number(distributorId)) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }
    }

    const customerSiteId = await resolveQuoteCustomerSiteId(client, {
      customerId,
      customerSiteId: requestedCustomerSiteId,
    });
    const shipToCustomerSiteId = await resolveQuoteShipToSiteId(client, {
      customerId,
      customerSiteId: requestedShipToCustomerSiteId || requestedCustomerSiteId,
    });
    const jobAssetContext = await resolveQuoteJobAssetContext(client, req, {
      customerId,
      jobAssetId: requestedJobAssetId,
    });
    const aftermarketContext = await resolveAftermarketQuoteContext(client, req, {
      customerId,
      serviceWarrantyCaseId: requestedServiceWarrantyCaseId,
      amcContractId: requestedAmcContractId,
    });
    const partySnapshots = await buildQuotePartySnapshots(client, {
      customerId,
      distributorId: isDistributor ? distributorId : null,
      orderFlow: requestedOrderFlow,
      fulfillmentMode: requestedFulfillmentMode,
      shipToCustomerSiteId,
      billToName,
      billToAddress,
      shipToName,
      shipToAddress,
      endCustomerName,
    });

    const quote = await insertQuoteHeaderWithNumberRetry(client, {
      companyId,
      customerId,
      customerSiteId,
      jobAssetId: jobAssetContext.jobAssetId,
      quoteJobId: jobAssetContext.quoteJobId,
      quoteSerialNo: jobAssetContext.quoteSerialNo,
      distributorId: isDistributor ? distributorId : null,
      leadId: Number.isFinite(leadId) ? leadId : null,
      attentionTo,
      createdBy: req.user.id,
      orderFlow: requestedOrderFlow,
      fulfillmentMode: requestedFulfillmentMode,
      buyerPoNumber,
      buyerPoDate,
      poExceptionReason,
      endCustomerName,
      endCustomerPoNumber,
      endCustomerPoDate,
      shipToCustomerSiteId,
      billToName: partySnapshots.billToName,
      billToAddress: partySnapshots.billToAddress,
      shipToName: partySnapshots.shipToName,
      shipToAddress: partySnapshots.shipToAddress,
      serviceWarrantyCaseId: aftermarketContext.serviceWarrantyCaseId,
      amcContractId: aftermarketContext.amcContractId,
      quoteOrigin: aftermarketContext.quoteOrigin,
    });

    const inrRes = await client.query(
      `select id from currencies where currency_code = 'INR' limit 1`
    );
    const inrId = inrRes.rows[0]?.id;
    if (!inrId) throw new Error("INR currency not seeded");

    const revRes = await client.query(
      `
        insert into quote_revisions (
          quote_id,
          company_id,
          revision_no,
          revision_status,
          base_currency_id,
          quote_currency_id,
          prepared_by,
          prepared_at,
          is_latest
        )
        values ($1,$2,1,'draft',$3,$3,$4,now(),true)
        returning *
      `,
      [quote.id, companyId, inrId, req.user.id]
    );
    const revision = revRes.rows[0];

    const requestedOfferType = normalizeOfferType(body.offer_type);
    if (requestedOfferType) {
      quote.offer_type = await setQuoteOfferType(client, { quoteId: quote.id, offerType: requestedOfferType, source: "manual" });
    } else if (aftermarketContext.quoteOrigin && aftermarketContext.quoteOrigin !== "standard") {
      quote.offer_type = await setQuoteOfferType(client, { quoteId: quote.id, offerType: "spares", source: "auto" });
    }

    await ensureRevisionTerms(client, revision.id);

    let lineNo = 1;
    for (const l of linesInput) {
      const obj = l && typeof l === "object" ? l : {};
      const productId =
        obj.product_id === null || obj.product_id === undefined ? null : Number(obj.product_id);
      const qty = obj.qty === null || obj.qty === undefined ? 1 : Number(obj.qty);
      const itemCode = typeof obj.item_code === "string" ? obj.item_code.trim() : "";
      const itemName = typeof obj.item_name === "string" ? obj.item_name.trim() : "";

      if (!Number.isFinite(qty) || qty <= 0) continue;
      if (!Number.isFinite(productId)) {
        await client.query("rollback");
        return res.status(409).json({
          ok: false,
          error: "PRODUCT_REQUIRED",
          detail: "Every quote line must come from Product Master. Manual line entry is not allowed.",
        });
      }

      let resolved = null;
      if (Number.isFinite(productId)) {
        resolved = await getCompanyProductOrNull(client, { companyId, productId, mode: "sale" });
      }

      if (!resolved) {
        await client.query("rollback");
        return res.status(404).json({
          ok: false,
          error: "PRODUCT_NOT_FOUND",
          detail: "Selected product was not found in Product Master.",
        });
      }

      const finalItemCode = resolved?.item_code || itemCode || null;
      const finalItemName = resolved?.item_name || itemName;
      const taxProfile = await resolveQuoteTaxProfile(client, { hsnNo: resolved?.hsn_no, fallbackGstPct: resolved?.gst_pct });
      const hsnNo = taxProfile.hsn_no;
      const gstPct = taxProfile.gst_pct;
      const unitPrice = resolved?.list_price || 0;
      const total = Number(unitPrice) * Number(qty);

      await client.query(
        `
          insert into quote_lines (
            quote_revision_id,
            line_no,
            product_id,
            item_code,
            item_name,
            hsn_no,
            qty,
            unit_price_base,
            unit_price_quote,
            gst_pct,
            line_total_base,
            line_total_quote
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$10)
        `,
        [
          revision.id,
          lineNo,
          Number.isFinite(productId) ? productId : null,
          finalItemCode,
          finalItemName,
          hsnNo,
          qty,
          unitPrice,
          gstPct,
          total,
        ]
      );

      lineNo += 1;
    }

    await recalcRevisionTotals(client, revision.id);
    const autoOfferType = await refreshAutoOfferType(client, { quoteId: quote.id, revisionId: revision.id });
    if (autoOfferType) quote.offer_type = autoOfferType;

    await client.query("commit");
    return res.status(201).json({ ok: true, quote, revision_id: revision.id });
  } catch (err) {
    await client.query("rollback");
    const detail = String(err?.detail || err?.message || "Failed to create quote.").slice(0, 500);
    const status = /^22|^23/.test(String(err?.code || "")) ? 400 : 500;
    return res.status(status).json({
      ok: false,
      error: "QUOTE_CREATE_FAILED",
      detail,
      pg_code: err?.code || null,
    });
  } finally {
    client.release();
  }
});

module.exports = router;
