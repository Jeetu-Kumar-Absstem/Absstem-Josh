#!/usr/bin/env node
/**
 * Import the installed base from a reviewed Service Master workbook into
 * installed_equipment.
 *
 * The workbook produced by build-service-master-review-workbook.js resolves what can be
 * resolved mechanically and leaves the rest to a human. This script is the other half:
 * it reads that workbook back, prefers whatever a reviewer typed into the CONFIRM_
 * columns over the script's own guess, and writes only the rows that are complete.
 *
 * installed_equipment.customer_id, item_code and item_name are all NOT NULL, so a row
 * missing any of them cannot be written at all -- those are reported, never forced.
 * product_id is nullable, which lets a machine record the SKU it was sold as even before
 * that SKU exists in Josh, though the default is to wait for the product so the machine
 * inherits its spares and BOM.
 *
 * Usage:
 *   node scripts/import-installed-equipment.js [options]
 *
 * Options:
 *   --review=<xlsx>            reviewed workbook (default Service_Master_Review_<company>.xlsx)
 *   --company=AI               company whose machines to import (default AI)
 *   --allow-unlinked-product   write rows whose item_code has no product row yet
 *   --apply                    commit; omit for a dry run
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config();

const XLSX = require("xlsx");
const { pool } = require("../src/db/pool");

const t = (v) => String(v == null ? "" : v).trim();
const squash = (v) => t(v).toUpperCase().replace(/\s+/g, "");

function parseArgs(argv) {
  const out = {
    reviewFile: "",
    companyCode: "AI",
    allowUnlinkedProduct: false,
    apply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const take = (name) => {
      if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
      if (token === `--${name}` && argv[i + 1]) { i += 1; return argv[i]; }
      return null;
    };
    if (token === "--apply") { out.apply = true; continue; }
    if (token === "--allow-unlinked-product") { out.allowUnlinkedProduct = true; continue; }
    let v;
    if ((v = take("review")) !== null) { out.reviewFile = path.resolve(v); continue; }
    if ((v = take("company")) !== null) { out.companyCode = t(v).toUpperCase(); continue; }
  }
  if (!out.reviewFile) {
    out.reviewFile = path.resolve(__dirname, `../../Service_Master_Review_${out.companyCode}.xlsx`);
  }
  return out;
}

/** An ISO date, or null. The builder already normalised these; anything else is corrupt. */
function isoDate(value) {
  const s = t(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Fold a reviewer's CONFIRM_ columns over the script's own resolution.
 *
 * A confirmed value always wins, including when the script had resolved something
 * different -- that is the point of the column. Recorded so the run can report how much
 * of the import rests on human correction rather than on matching.
 */
function applyConfirmations(row) {
  const confirmed = [];
  const pick = (confirmKey, resolvedKey) => {
    const override = t(row[confirmKey]);
    const resolved = t(row[resolvedKey]);
    if (!override) return resolved;
    if (squash(override) !== squash(resolved)) confirmed.push(resolvedKey);
    return override;
  };
  return {
    serialNumber: pick("CONFIRM_serial_number", "serial_number"),
    customerCode: pick("CONFIRM_customer_code", "customer_code"),
    itemCode: pick("CONFIRM_item_code", "item_code"),
    confirmed,
  };
}

function loadReview(file, companyCode) {
  const wb = XLSX.readFile(file, { raw: false });
  const sheet = wb.Sheets["Equipment_Import"];
  if (!sheet) throw new Error(`sheet "Equipment_Import" not found in ${path.basename(file)}`);
  return XLSX.utils
    .sheet_to_json(sheet, { defval: "", raw: false })
    .filter((r) => t(r.serial_number) || t(r.CONFIRM_serial_number))
    .filter((r) => !t(r.company_code) || t(r.company_code).toUpperCase() === companyCode);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.reviewFile)) {
    console.error(`review workbook not found: ${args.reviewFile}`);
    console.error("run scripts/build-service-master-review-workbook.js first");
    process.exitCode = 1;
    return;
  }

  const rows = loadReview(args.reviewFile, args.companyCode);
  const client = await pool.connect();
  try {
    await client.query("begin");

    const companyRes = await client.query(
      `select id, company_code from companies where upper(company_code) = $1 limit 1`,
      [args.companyCode]
    );
    const company = companyRes.rows[0];
    if (!company) throw new Error(`COMPANY_NOT_FOUND: ${args.companyCode}`);

    // Customer codes are unique across Josh, so one lookup serves every row.
    const customerRes = await client.query(
      `select id, customer_code, customer_name from customers where customer_code is not null`
    );
    const customerByCode = new Map(customerRes.rows.map((c) => [squash(c.customer_code), c]));

    const productRes = await client.query(`select id, item_code, item_name from products`);
    const productByCode = new Map(productRes.rows.map((p) => [squash(p.item_code), p]));

    const existingRes = await client.query(
      `select serial_number from installed_equipment where company_id = $1`,
      [company.id]
    );
    const existing = new Set(existingRes.rows.map((r) => squash(r.serial_number)));

    const ready = [];
    const skipped = [];
    const seen = new Map();

    for (const row of rows) {
      const { serialNumber, customerCode, itemCode, confirmed } = applyConfirmations(row);
      const reasons = [];

      if (!serialNumber) reasons.push("NO_SERIAL");

      const customer = customerCode ? customerByCode.get(squash(customerCode)) : null;
      if (!customerCode) reasons.push("NO_CUSTOMER_CODE");
      else if (!customer) reasons.push(`CUSTOMER_CODE_NOT_IN_JOSH(${customerCode})`);

      const product = itemCode ? productByCode.get(squash(itemCode)) : null;
      if (!itemCode) reasons.push("NO_ITEM_CODE");
      else if (!product && !args.allowUnlinkedProduct) reasons.push(`PRODUCT_NOT_IN_JOSH(${itemCode})`);

      // A serial is the identity of a machine, so two rows claiming one serial is a data
      // conflict to resolve in the sheet, not something to silently collapse.
      if (serialNumber && seen.has(squash(serialNumber))) {
        reasons.push(`DUPLICATE_IN_WORKBOOK(row ${seen.get(squash(serialNumber))})`);
      } else if (serialNumber) {
        seen.set(squash(serialNumber), row.source_row || "?");
      }

      if (reasons.length) {
        skipped.push({ serial: serialNumber || `(row ${row.source_row})`, reasons });
        continue;
      }

      ready.push({
        serialNumber,
        customer,
        itemCode,
        // item_name is NOT NULL; the product's own name is better than the sheet's guess.
        itemName: product ? product.item_name : t(row.item_name) || itemCode,
        productId: product ? product.id : null,
        siteLocation: t(row.site_location) || null,
        siteAddress: t(row.site_address) || null,
        commissioningDate: isoDate(row.commissioning_date),
        warrantyEndDate: isoDate(row.warranty_end_date),
        notes: [
          `Imported from ${path.basename(args.reviewFile)} (service master row ${t(row.source_row) || "?"}).`,
          t(row.service_client_name) ? `Service sheet client: ${t(row.service_client_name)}.` : "",
          t(row.match_method) ? `Customer matched by ${t(row.match_method)}.` : "",
          t(row.item_code_basis) ? `Item code basis ${t(row.item_code_basis)}.` : "",
          confirmed.length ? `Reviewer overrode: ${confirmed.join(", ")}.` : "",
          t(row.data_issues) ? `Source data issues: ${t(row.data_issues)}.` : "",
        ].filter(Boolean).join(" "),
        isUpdate: existing.has(squash(serialNumber)),
        confirmed,
      });
    }

    const reasonTally = skipped.reduce((acc, s) => {
      for (const r of s.reasons) {
        const key = r.replace(/\(.*\)$/, "");
        acc[key] = (acc[key] || 0) + 1;
      }
      return acc;
    }, {});

    console.log("");
    console.log(`Mode       : ${args.apply ? "APPLY" : "DRY RUN"}`);
    console.log(`Company    : ${company.company_code} (id ${company.id})`);
    console.log(`Workbook   : ${args.reviewFile}`);
    console.log(`Unlinked products ${args.allowUnlinkedProduct ? "allowed (product_id null)" : "not allowed"}`);
    console.log("");
    console.log(`Rows for this company : ${rows.length}`);
    console.log(`  importable          : ${ready.length}`);
    console.log(`    new               : ${ready.filter((r) => !r.isUpdate).length}`);
    console.log(`    updating existing : ${ready.filter((r) => r.isUpdate).length}`);
    console.log(`    unlinked product  : ${ready.filter((r) => !r.productId).length}`);
    console.log(`    reviewer-corrected: ${ready.filter((r) => r.confirmed.length).length}`);
    console.log(`  skipped             : ${skipped.length}`);

    if (Object.keys(reasonTally).length) {
      console.log("");
      console.log("Why rows were skipped:");
      Object.entries(reasonTally)
        .sort((a, b) => b[1] - a[1])
        .forEach(([k, n]) => console.log(`   ${String(n).padStart(4)}  ${k}`));
    }

    if (!args.apply) {
      await client.query("rollback");
      console.log("");
      console.log("Sample of importable machines:");
      ready.slice(0, 15).forEach((r) =>
        console.log(
          `   ${r.serialNumber.padEnd(8)} ${r.itemCode.padEnd(14)} ${String(r.customer.customer_code).padEnd(8)} ` +
            `${(r.commissioningDate || "no comm date").padEnd(12)} ${r.isUpdate ? "update" : "new"}`
        )
      );
      console.log("");
      console.log("Dry run only. Re-run with --apply to write.");
      return;
    }

    let inserted = 0;
    let updated = 0;
    for (const r of ready) {
      // Re-running must not duplicate a machine or clobber later edits made in Josh, so
      // the serial is the conflict target and only the fields this import owns are set.
      const res = await client.query(
        `insert into installed_equipment (
           company_id, serial_number, product_id, item_code, item_name, customer_id,
           site_location, site_address, commissioning_date, warranty_end_date, notes
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11)
         on conflict (company_id, serial_number) do update set
           product_id         = coalesce(excluded.product_id, installed_equipment.product_id),
           item_code          = excluded.item_code,
           item_name          = excluded.item_name,
           customer_id        = excluded.customer_id,
           site_location      = coalesce(excluded.site_location, installed_equipment.site_location),
           site_address       = coalesce(excluded.site_address, installed_equipment.site_address),
           commissioning_date = coalesce(excluded.commissioning_date, installed_equipment.commissioning_date),
           warranty_end_date  = coalesce(excluded.warranty_end_date, installed_equipment.warranty_end_date),
           notes              = excluded.notes,
           updated_at         = now()
         returning (xmax = 0) as was_insert`,
        [
          company.id,
          r.serialNumber,
          r.productId,
          r.itemCode,
          r.itemName,
          r.customer.id,
          r.siteLocation,
          r.siteAddress,
          r.commissioningDate,
          r.warrantyEndDate,
          r.notes,
        ]
      );
      res.rows[0].was_insert ? inserted++ : updated++;
    }

    await client.query("commit");
    console.log("");
    console.log(`Applied: ${inserted} inserted, ${updated} updated.`);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { applyConfirmations, isoDate };
