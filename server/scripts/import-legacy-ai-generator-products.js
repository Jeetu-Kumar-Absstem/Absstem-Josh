#!/usr/bin/env node
/**
 * Import AI item-master SKUs that Josh is missing, so historical machines and invoices
 * can reference the SKU they were actually sold as.
 *
 * Background: the AI nGEN range was renamed on 12-Mar-2025. Legacy purity was a code
 * suffix -- "nGEN 30" (standard) and "nGEN 30 P" (high purity). The new range splits the
 * same span into HF / SH / UH. Clan retired the legacy SKUs, so the Clan -> Josh product
 * migration skipped them, which leaves every pre-2025 machine with nothing to point at.
 *
 * Legacy SKUs land inactive, and flagged service_only for the company, so they can carry
 * service history and spares without being quotable.
 *
 * Usage:
 *   node scripts/import-legacy-ai-generator-products.js --itemmaster=<ItemMaster_AI.xlsx> [options]
 *
 * Options:
 *   --scope=legacy-invoiced     legacy SKUs that appear on an invoice (default)
 *   --scope=legacy-generators   every legacy nGEN/nGenx generator, invoiced or not
 *   --scope=invoiced            every invoiced code missing from Josh, legacy or current
 *   --scope=active-spares       every active Clan spare/service item missing from Josh
 *   --scope=installed-base      machines with evidence of a sale (invoiced, or referenced by
 *                               a reviewed machine) + the one-off build + every active spare
 *   --scope=all                 every Clan AI code missing from Josh
 *   --invoices=<xlsx>           ERP-invoice-itemwise-report.xlsx
 *                               (required for legacy-invoiced, invoiced, installed-base)
 *   --review=<xlsx>             Service_Master_Review_<company>.xlsx; adds the SKUs its
 *                               Products_To_Import sheet asks for (installed-base only)
 *   --company=AI                company code to attach policies to (default AI)
 *   --apply                     commit; omit for a dry run
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config();

const XLSX = require("xlsx");
const { pool } = require("../src/db/pool");
const { saveProduct } = require("../src/services/productMaster");

/** Date the new HF/SH/UH range replaced the legacy naming. */
const RENAME_DATE = "2025-03-12";

const t = (v) => String(v == null ? "" : v).trim();
/** Whitespace-insensitive key, for *detecting* duplicate SKUs -- never for matching. */
const squash = (v) => t(v).toUpperCase().replace(/\s+/g, "");

function parseArgs(argv) {
  const out = {
    itemMasterFile: "",
    invoicesFile: "",
    reviewFile: "",
    companyCode: "AI",
    scope: "legacy-invoiced",
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
    let v;
    if ((v = take("itemmaster")) !== null) { out.itemMasterFile = path.resolve(v); continue; }
    if ((v = take("invoices")) !== null) { out.invoicesFile = path.resolve(v); continue; }
    if ((v = take("review")) !== null) { out.reviewFile = path.resolve(v); continue; }
    if ((v = take("company")) !== null) { out.companyCode = t(v).toUpperCase(); continue; }
    if ((v = take("scope")) !== null) { out.scope = t(v).toLowerCase(); continue; }
  }
  return out;
}

// ---------------------------------------------------------------- classification

const GENERATOR_CODE = /^(NGENX|NGEN|IDOS|MEDO)/;

/**
 * Family from the item *code*, never the group: Clan has 14 nGEN SKUs mis-filed under
 * "IDOS Oxygen Generator Package", so group would assign a nitrogen machine to oxygen.
 */
function familyFromCode(code, group) {
  const c = squash(code);
  const g = t(group).toUpperCase();
  if (/^AS-/.test(c) || /SHIELD/.test(g)) return "SHIELD";
  if (/^NGENX/.test(c)) return "NGENX";
  if (/^NGEN/.test(c)) return "NGEN";
  // The C variant marker must end the code ("IDOS 2C"); "IDOS 01 CP" is an air package.
  if (/^IDOS/.test(c)) return /^IDOS\d*C$/.test(c) || /IDOS\s*C\b/.test(g) ? "IDOS_C" : "IDOS";
  if (/^MEDO/.test(c)) return /^MEDO\d*C$/.test(c) || /MEDO\s*C\b/.test(g) ? "MEDO_C" : "MEDO";
  return null;
}

/** CP = compressed-air package, ST = storage. Neither is the generator itself. */
function moduleRoleFor(code, group) {
  const c = t(code).toUpperCase();
  const g = t(group).toUpperCase();
  if (/\bCP\b/.test(c) || /AIR PACKAGE|COMPRESSED AIR|AIR SYSTEM/.test(g)) return "air_system";
  if (/\bST\b/.test(c) || /GAS STORAGE|STORAGE TANK|STORAGE VESSEL/.test(g)) return "gas_storage";
  if (/BOOSTER/.test(g)) return "booster";
  if (/SHIELD/.test(g)) return "shield";
  if (/SPARE|SERVICE/.test(g)) return "spare";
  if (GENERATOR_CODE.test(squash(code)) || /GENERATOR|PSA/.test(g)) return "generator";
  return null;
}

/**
 * Purity variant. Only meaningful for nGEN/nGenx.
 *   new     -> trailing UH / SH / HF
 *   legacy  -> "P" suffix (optionally followed by a B package marker), else STD
 */
/**
 * Decompose a legacy *generator* code: "nGEN 10", "nGEN 10 P", "nGEN 10 P B".
 * Returns null for anything else, which deliberately excludes the suffixed accessories
 * that share the nGEN stem -- CP (compressed-air package), ST (storage), DX/DXC (dryer).
 * Those merely start with "nGEN"; they are not the machine and carry no purity grade.
 */
function legacyGeneratorParts(code) {
  const c = t(code).toUpperCase().replace(/\s+/g, " ").trim();
  const s = squash(c);
  if (!/^NGEN/.test(s)) return null;
  if (/(UH|SH|HF)M?$/.test(s)) return null;   // new range
  if (/^NGENX\d{3}/.test(s)) return null;      // new zero-padded nGenx
  const m = c.match(/^(NGENX?)\s*(\d+(?:\.\d+)?)\s*(P)?(?:\s*(B))?$/);
  if (!m) return null;
  return { stem: m[1], size: Number(m[2]), purity: m[3] ? "P" : "STD", isPackage: Boolean(m[4]) };
}

function variantFor(code) {
  const s = squash(code);
  if (!/^NGEN/.test(s)) return null;
  // New range: trailing UH/SH/HF, optionally with an M (modular) marker.
  const nw = s.match(/(UH|SH|HF)M?$/);
  if (nw) return nw[1];
  const parts = legacyGeneratorParts(code);
  return parts ? parts.purity : null;
}

/** Era, used to decide is_active and whether a successor applies. */
function isLegacyCode(code) {
  return legacyGeneratorParts(code) !== null;
}

/**
 * A trailing M after the purity grade ("nGEN002UH M") marks a one-off built to a single
 * job's requirement. Exactly one such code exists. It has to exist in Josh so the machine
 * that was sold can point at it, but it must never be quotable: re-selling a bespoke
 * build as a catalogue line would promise specifications nobody has verified.
 */
function isCustomOneOff(code) {
  return /(UH|SH|HF)\s*M$/i.test(t(code).replace(/\s+/g, " "));
}

/** Spares and service items, which are aftermarket rather than plant. */
function isSpareRow(row) {
  const group = t(row.Group).toUpperCase();
  if (GENERATOR_CODE.test(squash(row["Item Code"]))) return false;
  // "Services1" is a mis-typed group in Clan holding a single item.
  return /^(SPARES?|SERVICES?\d*|CONSUMABLES?)$/.test(group);
}

const isActiveRow = (row) => /^(YES|Y|TRUE|1)$/i.test(t(row.Active));

function sizeOf(code) {
  const parts = legacyGeneratorParts(code);
  if (parts) return parts.size;
  const m = squash(code).match(/^NGENX?(\d+)/);
  return m && Number.isFinite(Number(m[1])) ? Number(m[1]) : null;
}

// No legacy -> current mapping is recorded, deliberately.
//
// The size in a legacy code does not carry across the 12-Mar-2025 rename: nGEN 07 delivers
// 24 Nm3/hr at 99% purity where nGEN007SH delivers 35, and matching on flow instead drifts
// just as unhelpfully (nGEN 30 lands nearest nGEN020SH, nGEN 40 nearest nGEN025SH). The two
// ranges are different machines that happen to share a naming scheme, so any stored pointer
// would eventually be read as authoritative and used to quote a replacement or resolve a BOM.
// A retired SKU therefore records only what it is and that it was retired; sizing a
// replacement is a fresh calculation from the customer's required flow and purity.

// ---------------------------------------------------------------- loading

function loadItemMaster(file) {
  const wb = XLSX.readFile(file, { raw: false });
  const sheet = wb.Sheets["Table"] || wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false }).filter((r) => t(r["Item Code"]));
}

/**
 * The SKUs a reviewed Service Master workbook says the installed base points at.
 *
 * Needed because an invoice is not the only evidence a machine exists: a sales order can
 * name a model for a serial we were never able to match to an invoice line. Without this,
 * scoping to "invoiced only" would leave those machines with nothing to reference.
 */
function loadReviewNeededCodes(file) {
  if (!file) return new Set();
  const wb = XLSX.readFile(file, { raw: false });
  const sheet = wb.Sheets["Products_To_Import"];
  if (!sheet) return new Set();
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  return new Set(rows.map((r) => t(r.item_code)).filter(Boolean));
}

function loadInvoicedCodes(file) {
  if (!file) return new Set();
  const wb = XLSX.readFile(file, { raw: false });
  const sheet = wb.Sheets["Invoice Items"];
  if (!sheet) return new Set();
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  // Source rows are triplicated by the extractor; a Set collapses that for us.
  return new Set(rows.map((r) => t(r["Item Code"])).filter(Boolean));
}

/**
 * Of two SKUs differing only in whitespace, keep the one whose group agrees with its
 * code family; that is the twin the invoices actually reference.
 */
function pickCorrectTwin(rows) {
  if (rows.length === 1) return rows[0];
  const scored = rows.map((r) => {
    const fam = familyFromCode(r["Item Code"], r.Group);
    const g = t(r.Group).toUpperCase();
    let score = 0;
    if (fam === "NGEN" || fam === "NGENX") score += /NGEN/.test(g) ? 2 : /IDOS|OXYGEN/.test(g) ? -2 : 0;
    if (fam === "IDOS" || fam === "IDOS_C") score += /IDOS|OXYGEN/.test(g) ? 2 : 0;
    if (fam === "MEDO" || fam === "MEDO_C") score += /MEDO|MEDICAL/.test(g) ? 2 : 0;
    return { row: r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].row;
}

function buildPayload(row, { legacy, family, moduleRole, variant, custom = false }) {
  // Three ways a product must stay out of quoting: it belongs to the retired nGEN range,
  // it is a bespoke build, or Clan itself has already stopped selling it -- which is how
  // retired IDOS and MedO machines present, since they predate the nGEN rename entirely.
  const notSaleable = legacy || custom || !isActiveRow(row);
  const payload = {
    Category: row.Category,
    Group: row.Group,
    Brand: row.Brand,
    ItemCode: t(row["Item Code"]),
    ItemName: t(row["Item Name"]) || t(row["Item Code"]),
    HSNNO: row["HSN NO"],
    UOM: row.UOM,
    ListPrice: row["List Price"],
    GSTPer: row.GSTPer,
    ItemType: row["Item Type"],
    Description: row.ItemDescription,
    LastPurchasePrice: row.LPP,
    VariancePer: row.VariancePer,
    SerialNoRequired: /^(YES|Y|TRUE|1)$/i.test(t(row.IsSerialNo)),
    IsManufactured: false,
    // Legacy SKUs are retired catalogue-wide; the new range keeps Clan's own flag.
    Active: notSaleable ? "NO" : t(row.Active) || "YES",
    "Family Key": family,
    "Module Role": moduleRole,
    "Variant Key": variant,
    // Company policy: retired machines still need service and spares, but must not be sold.
    company_policy: {
      sourcing_mode: notSaleable ? "service_only" : "buy_external",
      is_saleable: !notSaleable,
      is_purchaseable: !notSaleable,
      is_stocked: !notSaleable,
      remarks: legacy
        ? `Retired ${RENAME_DATE} (nGEN rename). Imported for installed-base history. Not equivalent to any current SH/UH/HF model -- size a replacement from required flow and purity.`
        : custom
          ? "One-off build made to a single job's requirement. Exists so that machine's history resolves; not a catalogue model, so do not quote it -- size a standard SKU instead."
          : notSaleable
            ? "Withdrawn in Clan. Imported for installed-base history and spares; size a current model rather than quoting this."
            : "",
    },
  };
  // Clan exposes up to 18 caption/spec pairs; saveProduct maps these to product_attributes.
  for (let i = 1; i <= 18; i += 1) {
    const caption = t(row[`Caption${i}`]);
    const spec = t(row[`Specification${i}`]);
    if (!caption && !spec) continue;
    payload[`Caption ${i}`] = caption;
    payload[`Description ${i}`] = spec;
  }
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.itemMasterFile || !fs.existsSync(args.itemMasterFile)) {
    console.error(`Missing or unreadable --itemmaster (got: ${args.itemMasterFile || "<none>"})`);
    process.exitCode = 1;
    return;
  }
  if (["invoiced", "legacy-invoiced", "installed-base"].includes(args.scope) && !args.invoicesFile) {
    console.error(`--scope=${args.scope} requires --invoices=<ERP-invoice-itemwise-report.xlsx>`);
    process.exitCode = 1;
    return;
  }

  const rows = loadItemMaster(args.itemMasterFile);
  const invoicedCodes = loadInvoicedCodes(args.invoicesFile);
  const invoicedSquashed = new Set([...invoicedCodes].map(squash));
  const neededCodes = loadReviewNeededCodes(args.reviewFile);
  const neededSquashed = new Set([...neededCodes].map(squash));

  // Collapse whitespace-twins to the correctly-grouped one.
  const bySquash = new Map();
  for (const r of rows) {
    const k = squash(r["Item Code"]);
    if (!bySquash.has(k)) bySquash.set(k, []);
    bySquash.get(k).push(r);
  }
  const twinGroups = [...bySquash.values()].filter((v) => v.length > 1);
  const chosen = [...bySquash.values()].map(pickCorrectTwin);
  const rejectedTwins = twinGroups.flatMap((v) => {
    const keep = pickCorrectTwin(v);
    return v.filter((r) => r !== keep).map((r) => ({ dropped: t(r["Item Code"]), group: t(r.Group), active: t(r.Active), kept: t(keep["Item Code"]) }));
  });

  const existsExact = (code) => bySquash.has(squash(code));

  const client = await pool.connect();
  try {
    await client.query("begin");

    const companyRes = await client.query(`select id, company_code from companies where upper(company_code) = $1 limit 1`, [args.companyCode]);
    const company = companyRes.rows[0];
    if (!company) throw new Error(`COMPANY_NOT_FOUND: ${args.companyCode}`);

    const existingRes = await client.query(`select item_code from products`);
    const existing = new Set(existingRes.rows.map((r) => t(r.item_code)));
    const existingSquashed = new Set(existingRes.rows.map((r) => squash(r.item_code)));

    // Candidate selection
    const candidates = chosen.filter((r) => {
      const code = t(r["Item Code"]);
      if (existing.has(code) || existingSquashed.has(squash(code))) return false;
      if (args.scope === "all") return true;
      const isGen = GENERATOR_CODE.test(squash(code));
      if (args.scope === "invoiced") return invoicedSquashed.has(squash(code));
      if (args.scope === "legacy-invoiced") return isLegacyCode(code) && invoicedSquashed.has(squash(code));
      if (args.scope === "active-spares") return isSpareRow(r) && isActiveRow(r);
      // Everything the installed base can point at. Machines are limited to those with
      // evidence of a real sale -- an invoice line or a reviewed machine referencing them --
      // rather than the whole retired catalogue, which would import ~80 SKUs nobody owns.
      // Spares are not limited, since any of them may be needed to quote a repair.
      if (args.scope === "installed-base") {
        // Evidence of a sale is the gate, not the era. isLegacyCode only recognises the
        // nGEN rename, so gating on it would strand retired IDOS and MedO machines --
        // "IDOS 09" is inactive in Clan and owned by two customers.
        const wanted = invoicedSquashed.has(squash(code)) || neededSquashed.has(squash(code));
        return (isGen && wanted) || isCustomOneOff(code) || (isSpareRow(r) && isActiveRow(r));
      }
      return isGen && isLegacyCode(code);
    });

    const planned = candidates.map((r) => {
      const code = t(r["Item Code"]);
      return {
        row: r,
        code,
        legacy: isLegacyCode(code),
        custom: isCustomOneOff(code),
        spare: isSpareRow(r),
        // Already withdrawn in Clan, but predating the nGEN rename so not "legacy" here.
        withdrawn: !isActiveRow(r) && !isLegacyCode(code) && !isCustomOneOff(code),
        family: familyFromCode(code, r.Group),
        moduleRole: moduleRoleFor(code, r.Group),
        variant: variantFor(code),
      };
    });

    const summary = planned.reduce((acc, p) => {
      const era = p.legacy
        ? "legacy"
        : p.custom
          ? "custom one-off"
          : p.spare
            ? "spare"
            : p.withdrawn
              ? "withdrawn"
              : "current";
      const k = `${era} / ${p.family || "-"} / ${p.variant || "-"} / ${p.moduleRole || "?"}`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    console.log("");
    console.log(`Mode        : ${args.apply ? "APPLY" : "DRY RUN"}`);
    console.log(`Company     : ${company.company_code} (id ${company.id})`);
    console.log(`Scope       : ${args.scope}`);
    console.log(`ItemMaster  : ${args.itemMasterFile}`);
    if (args.invoicesFile) console.log(`Invoices    : ${args.invoicesFile}  (${invoicedCodes.size} distinct codes)`);
    if (args.reviewFile) console.log(`Review      : ${args.reviewFile}  (${neededCodes.size} SKUs the installed base needs)`);
    console.log("");
    console.log(`Clan codes            : ${rows.length}`);
    console.log(`Whitespace twin pairs : ${twinGroups.length}  (keeping the correctly-grouped twin)`);
    console.log(`Already in Josh       : ${chosen.filter((r) => existingSquashed.has(squash(r["Item Code"]))).length}`);
    console.log(`To import             : ${planned.length}`);
    console.log(`  ...legacy (inactive): ${planned.filter((p) => p.legacy).length}`);
    console.log(`  ...custom one-off   : ${planned.filter((p) => p.custom).length}  (not quotable)`);
    console.log(`  ...withdrawn in Clan: ${planned.filter((p) => p.withdrawn).length}  (not quotable)`);
    console.log(`  ...spares (active)  : ${planned.filter((p) => p.spare).length}`);
    console.log(`  ...invoiced         : ${planned.filter((p) => invoicedSquashed.has(squash(p.code))).length}`);
    console.log("");
    console.log("Breakdown (era / family / variant / module):");
    Object.entries(summary).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`   ${String(n).padStart(4)}  ${k}`));

    if (rejectedTwins.length) {
      console.log("");
      console.log(`Mis-filed duplicate SKUs skipped (retire these in Clan) -- ${rejectedTwins.length}:`);
      rejectedTwins.slice(0, 20).forEach((d) => console.log(`   '${d.dropped}' [${d.group}] active=${d.active}  -> kept '${d.kept}'`));
    }

    // A family only means something for plant. Spares are keyed by their own part number,
    // so a missing family there is normal and not worth warning about.
    const noFamily = planned.filter((p) => !p.family && !p.spare);
    if (noFamily.length) {
      console.log("");
      console.log(`Warning: ${noFamily.length} non-spare rows have no resolvable family; e.g. ${noFamily.slice(0, 8).map((p) => p.code).join(", ")}`);
    }

    if (!args.apply) {
      await client.query("rollback");
      console.log("");
      console.log("Sample of planned imports:");
      planned.slice(0, 15).forEach((p) =>
        console.log(
          `   ${p.code.padEnd(18)} ${(p.family || "-").padEnd(7)} ${(p.variant || "-").padEnd(4)} ` +
            (p.legacy
              ? "LEGACY (inactive)"
              : p.custom
                ? "CUSTOM (not quotable)"
                : p.withdrawn
                  ? "WITHDRAWN (not quotable)"
                  : p.spare
                    ? "spare (active)"
                    : "current")
        )
      );
      console.log("");
      console.log("Dry run only. Re-run with --apply to write.");
      return;
    }

    let imported = 0;
    for (const p of planned) {
      const payload = buildPayload(p.row, {
        legacy: p.legacy,
        family: p.family,
        moduleRole: p.moduleRole,
        variant: p.variant,
      });
      const saved = await saveProduct(client, payload, { companyId: company.id });
      const productId = saved?.id || saved?.product?.id || null;
      if (productId && p.legacy) {
        // Record the retirement date only. superseded_by_item_code stays null: the legacy
        // and current ranges are not interchangeable, so no successor is asserted.
        await client.query(
          `update products set superseded_on = $2::date, updated_at = now() where id = $1`,
          [productId, RENAME_DATE]
        );
      }
      imported += 1;
    }

    await client.query("commit");
    console.log("");
    console.log(`Imported: ${imported}`);
    console.log("");
  } catch (err) {
    await client.query("rollback");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = {
  RENAME_DATE,
  familyFromCode,
  moduleRoleFor,
  variantFor,
  isLegacyCode,
  isCustomOneOff,
  isSpareRow,
  isActiveRow,
  legacyGeneratorParts,
  sizeOf,
  pickCorrectTwin,
};
