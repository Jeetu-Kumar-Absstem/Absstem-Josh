const XLSX = require("xlsx");

const { normalizeJobNo } = require("./tallyInvoiceEnrichment");
const { syncLegacySoNumberSequence } = require("./legacySoNumbering");
const { linkCustomerToCompany } = require("./customerCompanyAccess");
function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDisplayWithCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return { name: null, code: null, raw: "" };
  const match = raw.match(/^(.*?)(?:\s*:\s*([A-Z]\d+))?$/i);
  return {
    name: String(match?.[1] || raw).trim() || null,
    code: String(match?.[2] || "").trim().toUpperCase() || null,
    raw,
  };
}

function parseLegacyActor(value) {
  const raw = String(value || "").trim();
  if (!raw) return { code: null, name: null, raw: "" };
  const idx = raw.indexOf(":");
  if (idx >= 0) {
    return {
      code: raw.slice(0, idx).trim().replace(/\s+/g, ""),
      name: raw.slice(idx + 1).trim() || null,
      raw,
    };
  }
  return { code: null, name: raw, raw };
}

function parseLegacyDate(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "01-Jan-1900") return null;

  const monthMap = {
    JAN: 0,
    FEB: 1,
    MAR: 2,
    APR: 3,
    MAY: 4,
    JUN: 5,
    JUL: 6,
    AUG: 7,
    SEP: 8,
    OCT: 9,
    NOV: 10,
    DEC: 11,
  };

  const parts = raw.split(/\s+/).filter(Boolean);
  const datePart = parts[0];
  const dm = datePart.split("-");
  if (dm.length !== 3) return null;

  const day = Number(dm[0]);
  const mon = monthMap[String(dm[1] || "").slice(0, 3).toUpperCase()];
  let year = Number(dm[2]);
  if (year < 100) year += 2000;
  if (!Number.isFinite(day) || !Number.isFinite(mon) || !Number.isFinite(year)) return null;

  const dt = new Date(Date.UTC(year, mon, day));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

function mapLegacyOrderStatus(statusRaw) {
  const status = String(statusRaw || "").trim().toLowerCase();
  if (status.includes("pending")) return "draft";
  if (status.includes("approved")) return "confirmed";
  if (status.includes("cancel")) return "cancelled";
  return "confirmed";
}

function buildShipToAddress(row) {
  const parts = [
    row.consigneeAddressLine1,
    row.consigneeAddressLine2,
    row.consigneeCity,
    row.consigneePincode,
    row.state,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function parseSalesOrderReportRows(buffer, fileName = "") {
  const lower = String(fileName || "").toLowerCase();
  let objects = [];

  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return [];
    objects = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
  } else {
    const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return [];
    const headers = lines[0].split(",").map((h) => h.trim());
    objects = lines.slice(1).map((line) => {
      const cells = line.split(",");
      const row = {};
      headers.forEach((header, idx) => {
        row[header] = cells[idx] || "";
      });
      return row;
    });
  }

  return objects
    .map((raw) => {
      const customer = parseDisplayWithCode(raw.Customer);
      const salesperson = parseLegacyActor(raw.SalesPerson);
      const soNo = String(raw["SO No"] || raw.so_no || "").trim().toUpperCase();
      if (!soNo) return null;

      return {
        so_number: soNo,
        so_date: parseLegacyDate(raw["SO Date"] || raw.so_date),
        customer_name: customer.name,
        customer_code: customer.code,
        salesperson_code: salesperson.code,
        salesperson_name: salesperson.name,
        group_name: String(raw.Group || "").trim() || null,
        status_raw: String(raw.Status || "").trim() || null,
        order_status: mapLegacyOrderStatus(raw.Status),
        so_remarks: String(raw.SORemarks || "").trim() || null,
        city: String(raw.City || "").trim() || null,
        state: String(raw.State || "").trim() || null,
        job_no: normalizeJobNo(raw.JobNo || raw.job_no),
        consignee_name: String(raw.ConsigneeName || "").trim() || null,
        consigneeAddressLine1: String(raw.ConsigneeAddressLine1 || "").trim() || null,
        consigneeAddressLine2: String(raw.ConsigneeAddressLine2 || "").trim() || null,
        consignee_city: String(raw.ConsigneeCity || "").trim() || null,
        consignee_pincode: String(raw.ConsigneePincode || "").trim() || null,
        consignee_phone: String(raw.ConsigneePhoneNo || "").trim() || null,
        consignee_email: String(raw.ConsigneeEmailID || "").trim() || null,
        consignee_gstin: String(raw.ConsigneeGSTNo || "").trim() || null,
        cmc: String(raw.CMC || "").trim() || null,
        raw,
      };
    })
    .filter(Boolean);
}

async function getDefaultInrCurrencyId(client) {
  const res = await client.query(`select id from currencies where currency_code = 'INR' limit 1`);
  return res.rows[0]?.id || null;
}

async function resolveCompanyId(client, companyIdOrCode) {
  const raw = String(companyIdOrCode || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const byId = await client.query(`select id from companies where id = $1 limit 1`, [Number(raw)]);
    return byId.rows[0]?.id || null;
  }
  const byCode = await client.query(
    `select id from companies where upper(company_code) = upper($1) limit 1`,
    [raw]
  );
  return byCode.rows[0]?.id || null;
}

async function resolveCustomerForLegacySo(client, companyId, row) {
  const customerCode = row.customer_code ? String(row.customer_code).trim().toUpperCase() : null;

  if (customerCode) {
    const byCode = await client.query(
      `
        select id
        from customers
        where upper(trim(customer_code)) = upper(trim($1))
        limit 1
      `,
      [customerCode]
    );
    if (byCode.rows[0]?.id) {
      await linkCustomerToCompany(client, byCode.rows[0].id, companyId, "legacy_shared");
      return { customerId: byCode.rows[0].id, created: false };
    }
  }

  const customerName = String(row.customer_name || "").trim();
  if (customerName) {
    const byName = await client.query(
      `
        select id
        from customers
        where (company_id = $1 or company_id is null)
          and lower(trim(customer_name)) = lower(trim($2))
        limit 1
      `,
      [companyId, customerName]
    );
    if (byName.rows[0]?.id) {
      await linkCustomerToCompany(client, byName.rows[0].id, companyId, "legacy_shared");
      return { customerId: byName.rows[0].id, created: false };
    }

    const all = await client.query(
      `select id, customer_name from customers where company_id = $1 or company_id is null`,
      [companyId]
    );
    const nameKey = normalizeText(customerName);
    const match = all.rows.find((cust) => {
      const custKey = normalizeText(cust.customer_name);
      return custKey === nameKey || custKey.includes(nameKey) || nameKey.includes(custKey);
    });
    if (match?.id) {
      await linkCustomerToCompany(client, match.id, companyId, "legacy_shared");
      return { customerId: match.id, created: false };
    }
  }

  const insertName = customerName || customerCode || `Legacy Customer ${row.so_number}`;
  const insertCode =
    customerCode ||
    `CUST-${insertName.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "X")}-${Date.now().toString().slice(-4)}`;

  const ins = await client.query(
    `
      insert into customers (
        company_id, customer_code, customer_name, city, state, gstin, email, phone,
        credit_limit, is_active, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 500000, true, now(), now())
      returning id
    `,
    [
      companyId,
      insertCode,
      insertName,
      row.city,
      row.state,
      row.consignee_gstin || null,
      row.consignee_email || null,
      row.consignee_phone || null,
    ]
  );
  const customerId = ins.rows[0]?.id || null;
  if (customerId) {
    await linkCustomerToCompany(client, customerId, companyId, "owned");
  }
  return { customerId, created: true };
}

async function importLegacySalesOrdersFromReport(client, {
  companyId,
  rows = [],
  userId = null,
  updateExisting = true,
}) {
  const currencyId = await getDefaultInrCurrencyId(client);
  if (!currencyId) {
    const err = new Error("INR_CURRENCY_NOT_FOUND");
    err.status = 500;
    throw err;
  }

  const results = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let customersCreated = 0;

  for (const row of rows) {
    await client.query("SAVEPOINT legacy_so_import_row");
    try {
      const existingRes = await client.query(
        `select id, so_number, customer_id from sales_orders where company_id = $1 and so_number = $2 limit 1`,
        [companyId, row.so_number]
      );
      const existing = existingRes.rows[0];

      const { customerId, created: customerCreated } = await resolveCustomerForLegacySo(client, companyId, row);
      if (!customerId) {
        results.push({ ...row, ok: false, error: "CUSTOMER_NOT_RESOLVED" });
        await client.query("ROLLBACK TO SAVEPOINT legacy_so_import_row");
        continue;
      }
      if (customerCreated) customersCreated += 1;

      const shipToAddress = buildShipToAddress({
        consigneeAddressLine1: row.consigneeAddressLine1,
        consigneeAddressLine2: row.consigneeAddressLine2,
        consigneeCity: row.consignee_city,
        consigneePincode: row.consignee_pincode,
        state: row.state,
      });
      const remarks = [row.so_remarks, row.group_name ? `Group: ${row.group_name}` : null, row.cmc ? `CMC: ${row.cmc}` : null]
        .filter(Boolean)
        .join(" | ");

      if (existing?.id) {
        if (!updateExisting) {
          skipped += 1;
          results.push({
            ok: true,
            action: "skipped_existing",
            sales_order_id: existing.id,
            so_number: row.so_number,
            customer_id: existing.customer_id,
          });
          await client.query("RELEASE SAVEPOINT legacy_so_import_row");
          continue;
        }

        await client.query(
          `
            update sales_orders
            set
              customer_id = coalesce($2, customer_id),
              order_status = coalesce($3, order_status),
              order_date = coalesce($4::date, order_date),
              job_no = coalesce($5, job_no),
              remarks = coalesce($6, remarks),
              ship_to_name = coalesce($7, ship_to_name),
              ship_to_address = coalesce($8, ship_to_address),
              updated_at = now()
            where id = $1
          `,
          [
            existing.id,
            customerId,
            row.order_status,
            row.so_date,
            row.job_no,
            remarks || null,
            row.consignee_name,
            shipToAddress,
          ]
        );
        if (row.job_no) {
          await client.query(
            `
              update customer_invoices
              set job_no = coalesce(nullif(trim(job_no), ''), $2), updated_at = now()
              where company_id = $1
                and sales_order_id = $3
                and coalesce(trim(job_no), '') = ''
            `,
            [companyId, row.job_no, existing.id]
          );
        }
        updated += 1;
        results.push({
          ok: true,
          action: "updated",
          sales_order_id: existing.id,
          so_number: row.so_number,
          customer_id: customerId,
          job_no: row.job_no,
        });
        await client.query("RELEASE SAVEPOINT legacy_so_import_row");
        continue;
      }

      const ins = await client.query(
        `
          insert into sales_orders (
            so_number,
            company_id,
            quote_revision_id,
            customer_id,
            order_status,
            base_currency_id,
            order_currency_id,
            order_date,
            subtotal_base,
            subtotal_order,
            tax_total_base,
            tax_total_order,
            grand_total_base,
            grand_total_order,
            created_by,
            job_no,
            remarks,
            ship_to_name,
            ship_to_address,
            order_flow,
            fulfillment_mode
          )
          values (
            $1, $2, null, $3, $4, $5, $5, coalesce($6::date, current_date),
            0, 0, 0, 0, 0, 0, $7, $8, $9, $10, $11, 'direct', 'direct_customer'
          )
          returning id, so_number
        `,
        [
          row.so_number,
          companyId,
          customerId,
          row.order_status,
          currencyId,
          row.so_date,
          userId,
          row.job_no,
          remarks || null,
          row.consignee_name,
          shipToAddress,
        ]
      );

      created += 1;
      results.push({
        ok: true,
        action: "created",
        sales_order_id: ins.rows[0]?.id,
        so_number: ins.rows[0]?.so_number,
        customer_id: customerId,
        job_no: row.job_no,
      });
      await client.query("RELEASE SAVEPOINT legacy_so_import_row");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT legacy_so_import_row");
      results.push({
        ok: false,
        so_number: row.so_number,
        error: err?.message || String(err),
      });
    }
  }
  await syncLegacySoNumberSequence(client, companyId);

  return {
    ok: true,
    total_rows: rows.length,
    created,
    updated,
    skipped,
    customers_created: customersCreated,
    failed: results.filter((row) => !row.ok).length,
    results,
  };
}

async function importLegacySalesOrdersFromFile(client, { companyId, fileBuffer, fileName, userId, updateExisting }) {
  const rows = parseSalesOrderReportRows(fileBuffer, fileName);
  if (!rows.length) {
    const err = new Error("NO_SALES_ORDER_ROWS");
    err.status = 400;
    throw err;
  }
  return importLegacySalesOrdersFromReport(client, {
    companyId,
    rows,
    userId,
    updateExisting: updateExisting !== false,
  });
}

module.exports = {
  parseSalesOrderReportRows,
  importLegacySalesOrdersFromReport,
  importLegacySalesOrdersFromFile,
  resolveCompanyId,
};
