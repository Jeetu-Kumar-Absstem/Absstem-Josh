#!/usr/bin/env node
/**
 * Import past service visits from the service team's log into service_tickets,
 * service_ticket_visits and service_ticket_parts.
 *
 * The log is not a complaint register. It is one row per spare per visit, with no ticket
 * id and no symptom text, so a "ticket" here is synthesised from the one thing the log
 * does record: a machine was visited on a date. Rows sharing a machine and a date are
 * therefore folded into a single ticket holding a single completed visit, and the spare
 * lines of that visit become its parts.
 *
 * Two deliberate limits:
 *
 * - symptom_summary is NOT NULL but the log has no symptom. It is filled from the visit
 *   type ("Preventive maintenance visit") and marked as imported, so nobody mistakes a
 *   synthesised line for something a customer actually said.
 * - service_ticket_parts.product_id is NOT NULL, and the workbook's fuzzy spare
 *   suggestions are not good enough to write stock movements from. A spare line only
 *   becomes a part row once a reviewer has put its code in Spares_Mapping.CONFIRM_item_code.
 *   Everything else is kept verbatim in the visit notes, so no history is lost and the
 *   parts can be attached later by re-running.
 *
 * Historical consumption must not move today's stock, so parts are written with
 * stock_deducted = false and no GL entry.
 *
 * Usage:
 *   node scripts/import-service-history.js [options]
 *
 * Options:
 *   --log=<xlsx>      service team's workbook (default Service_master_with_Entry_Form.xlsx)
 *   --review=<xlsx>   reviewed workbook, read for Spares_Mapping (default Service_Master_Review_<company>.xlsx)
 *   --company=AI      company whose visits to import (default AI)
 *   --repair-swapped-dates  recover visits whose day and month were transposed on entry
 *   --apply           commit; omit for a dry run
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config();

const XLSX = require("xlsx");
const { pool } = require("../src/db/pool");
const { parseJobRef } = require("../src/services/jobNumber");
const { canonicalSpareLabel, loadServiceLogRows } = require("./build-service-master-review-workbook");
const { logDate, swappedDate } = require("./lib/service-log-dates");

const TICKET_PREFIX = "SVCLOG";

const t = (v) => String(v == null ? "" : v).trim();
const squash = (v) => t(v).toUpperCase().replace(/\s+/g, "");

function parseArgs(argv) {
  const out = { logFile: "", reviewFile: "", companyCode: "AI", apply: false, repairSwapped: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const take = (name) => {
      if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
      if (token === `--${name}` && argv[i + 1]) { i += 1; return argv[i]; }
      return null;
    };
    if (token === "--apply") { out.apply = true; continue; }
    if (token === "--repair-swapped-dates") { out.repairSwapped = true; continue; }
    let v;
    if ((v = take("log")) !== null) { out.logFile = path.resolve(v); continue; }
    if ((v = take("review")) !== null) { out.reviewFile = path.resolve(v); continue; }
    if ((v = take("company")) !== null) { out.companyCode = t(v).toUpperCase(); continue; }
  }
  if (!out.logFile) out.logFile = path.resolve(__dirname, "../../Service_master_with_Entry_Form.xlsx");
  if (!out.reviewFile) {
    out.reviewFile = path.resolve(__dirname, `../../Service_Master_Review_${out.companyCode}.xlsx`);
  }
  return out;
}

/**
 * Map the free-text Visit Type onto complaint_type.
 *
 * The column is typed by hand and holds misspellings ("Prevntive", "Breakldown"), and
 * sometimes an engineer's name or a spare part instead of a type. Anything unrecognised
 * becomes "other" rather than being forced into a category.
 */
function complaintTypeFrom(visitType) {
  const s = t(visitType).toLowerCase().replace(/[^a-z& ]/g, "");
  if (!s) return { type: "other", label: "Service visit" };
  // Matched on stems, which is what survives the spellings actually present:
  // "Breakldown", "Prevntive", "Prevntiev", "Coustery", "Courestesy". A visit logged as
  // "Preventive/Breakdown" is a breakdown that also got the routine service done, so
  // breakdown is tested first.
  if (/break/.test(s)) return { type: "breakdown", label: "Breakdown attended" };
  if (/prev/.test(s)) return { type: "preventive", label: "Preventive maintenance visit" };
  if (/i&c|instal/.test(s)) return { type: "installation", label: "Installation and commissioning" };
  if (/commission/.test(s)) return { type: "commissioning", label: "Commissioning visit" };
  if (/cou/.test(s)) return { type: "other", label: "Courtesy visit" };
  return { type: "other", label: "Service visit" };
}

/** CMSS is a maintenance contract; PVT/IND describe the customer, not a contract. */
function isAmc(contractField) {
  return /^cmss$/i.test(t(contractField));
}

/**
 * Dates a reviewer corrected on the workbook's Date_Corrections sheet, keyed by the log
 * row and column they point at. A confirmed date beats anything read from the log.
 */
function loadDateCorrections(file) {
  const wb = XLSX.readFile(file, { raw: false });
  const sheet = wb.Sheets["Date_Corrections"];
  const byCell = new Map();
  if (!sheet) return byCell;
  for (const row of XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false })) {
    const fixed = logDate(row.CONFIRM_correct_date);
    const sourceRow = Number(t(row.source_row));
    if (!fixed || !sourceRow) continue;
    byCell.set(`${sourceRow}|${t(row.column)}`, fixed);
  }
  return byCell;
}

/** Reviewer-confirmed spare codes, keyed by the same canonical label the workbook used. */
function loadConfirmedSpares(file) {
  const wb = XLSX.readFile(file, { raw: false });
  const sheet = wb.Sheets["Spares_Mapping"];
  if (!sheet) return { confirmed: new Map(), serviceCharges: new Set() };
  const confirmed = new Map();
  const serviceCharges = new Set();
  for (const row of XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false })) {
    const label = t(row.canonical_label);
    if (!label) continue;
    if (/^y(es)?$/i.test(t(row.is_service_charge_not_a_part))) serviceCharges.add(label);
    const code = t(row.CONFIRM_item_code);
    if (code) confirmed.set(label, code);
  }
  return { confirmed, serviceCharges };
}

/**
 * Fold log rows into visits: one per machine per date.
 *
 * Grouping on the date rather than on a row counter is what makes a re-run land on the
 * same tickets, since the ticket number is derived from the same pair.
 */
function groupVisits(rows, companyCode, options = {}) {
  const {
    today = new Date().toISOString().slice(0, 10),
    repairSwapped = false,
    corrections = new Map(),
  } = options;
  const visits = new Map();
  const dropped = [];
  const repaired = [];
  const corrected = [];
  for (const row of rows) {
    const rawJob = t(row["Job No."]);
    let ref = null;
    try {
      ref = parseJobRef(rawJob);
    } catch {
      ref = null;
    }
    if (!ref || !ref.primary) {
      dropped.push({ job: rawJob || "(blank)", reason: "JOB_NUMBER_UNREADABLE" });
      continue;
    }
    if (ref.company !== companyCode) continue;

    // Engineer Visit Date is the visit; Visit / item Date is when the spare was issued
    // and is the fallback when the visit date was never filled in. A date the service
    // team corrected on the review workbook replaces either of them.
    const fixed =
      corrections.get(`${row.__row}|Engineer Visit Date`) || corrections.get(`${row.__row}|Visit / item Date`);
    const raw = fixed || logDate(row["Engineer Visit Date"]) || logDate(row["Visit / item Date"]);
    if (!raw) {
      dropped.push({ job: ref.primary, reason: "NO_USABLE_DATE" });
      continue;
    }
    if (fixed) corrected.push({ job: ref.primary, to: fixed });

    // A visit cannot have happened yet.
    let date = raw;
    if (date > today) {
      const swap = swappedDate(date);
      if (repairSwapped && swap && swap <= today) {
        repaired.push({ job: ref.primary, from: date, to: swap });
        date = swap;
      } else {
        dropped.push({ job: ref.primary, reason: "VISIT_DATE_IN_FUTURE", date });
        continue;
      }
    }

    const serial = ref.primary;
    const key = `${serial}|${date}`;
    if (!visits.has(key)) {
      visits.set(key, {
        serial,
        date,
        visitTypes: [],
        engineers: new Set(),
        contract: t(row["CMSS/PVT/IND."]),
        lines: [],
        dateRepairedFrom: date === raw ? null : raw,
        dateConfirmedByReviewer: Boolean(fixed),
      });
    }
    const v = visits.get(key);
    if (t(row["Visit Type"])) v.visitTypes.push(t(row["Visit Type"]));
    // The name column has picked up stray dates from a shifted row in places; storing
    // those as an engineer would put nonsense on the visit record.
    const engineer = t(row["Engineer Name"]);
    if (engineer && !/^\d/.test(engineer)) v.engineers.add(engineer);
    const spare = t(row["Item / Spare"]);
    if (spare) {
      v.lines.push({
        raw: spare,
        label: canonicalSpareLabel(spare),
        qty: Number(t(row["Qty."])) > 0 ? Number(t(row["Qty."])) : 1,
        cost: Number(t(row["Cost"])) > 0 ? Number(t(row["Cost"])) : 0,
      });
    }
  }
  return { visits: [...visits.values()], dropped, repaired, corrected };
}

/** Match an engineer's free-text name to a Josh user, or leave it unlinked. */
function matchEngineer(names, usersByName) {
  for (const raw of names) {
    const cleaned = t(raw).replace(/^(mr|mrs|ms|shri|smt)\.?\s+/i, "");
    const hit = usersByName.get(squash(cleaned));
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const [label, file] of [["service log", args.logFile], ["review workbook", args.reviewFile]]) {
    if (!fs.existsSync(file)) {
      console.error(`${label} not found: ${file}`);
      process.exitCode = 1;
      return;
    }
  }

  const logRows = loadServiceLogRows(args.logFile);
  const { confirmed, serviceCharges } = loadConfirmedSpares(args.reviewFile);
  const corrections = loadDateCorrections(args.reviewFile);
  const today = new Date().toISOString().slice(0, 10);
  const { visits, dropped, repaired, corrected } = groupVisits(logRows, args.companyCode, {
    today,
    repairSwapped: args.repairSwapped,
    corrections,
  });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const companyRes = await client.query(
      `select id, company_code from companies where upper(company_code) = $1 limit 1`,
      [args.companyCode]
    );
    const company = companyRes.rows[0];
    if (!company) throw new Error(`COMPANY_NOT_FOUND: ${args.companyCode}`);

    // A visit can only be recorded against a machine that exists, because the ticket
    // needs the machine's customer to satisfy a NOT NULL.
    const machineRes = await client.query(
      `select id, serial_number, customer_id, item_code, site_location
         from installed_equipment where company_id = $1`,
      [company.id]
    );
    const machineBySerial = new Map(machineRes.rows.map((m) => [squash(m.serial_number), m]));

    const productRes = await client.query(
      `select id, item_code, item_name, coalesce(uom, 'NOS') as uom from products`
    );
    const productByCode = new Map(productRes.rows.map((p) => [squash(p.item_code), p]));

    const userRes = await client.query(`select id, full_name from erp_users where full_name is not null`);
    const usersByName = new Map(userRes.rows.map((u) => [squash(u.full_name), u]));

    const ready = [];
    const skipped = [];
    const unmappedSpares = new Map();

    for (const v of visits) {
      const machine = machineBySerial.get(squash(v.serial));
      if (!machine) {
        skipped.push({ serial: v.serial, date: v.date, reason: "MACHINE_NOT_IN_JOSH" });
        continue;
      }

      // A breakdown anywhere in the visit's rows wins over a routine entry.
      const classified = v.visitTypes.map(complaintTypeFrom);
      const kind =
        classified.find((c) => c.type === "breakdown") ||
        classified.find((c) => c.type !== "other") ||
        classified[0] ||
        complaintTypeFrom("");

      const engineer = matchEngineer(v.engineers, usersByName);
      const parts = [];
      const unresolved = [];
      for (const line of v.lines) {
        if (serviceCharges.has(line.label)) {
          unresolved.push({ ...line, why: "service charge, not a part" });
          continue;
        }
        const code = confirmed.get(line.label);
        const product = code ? productByCode.get(squash(code)) : null;
        if (!product) {
          unresolved.push({ ...line, why: code ? `confirmed code ${code} not in Josh` : "awaiting CONFIRM_item_code" });
          if (!code) unmappedSpares.set(line.label, (unmappedSpares.get(line.label) || 0) + 1);
          continue;
        }
        parts.push({ product, qty: line.qty, cost: line.cost, raw: line.raw });
      }

      ready.push({
        ...v,
        machine,
        kind,
        engineer,
        parts,
        unresolved,
        ticketNumber: `${TICKET_PREFIX}-${v.serial}-${v.date.replace(/-/g, "")}`,
        engineerNames: [...v.engineers],
      });
    }

    const existingRes = await client.query(
      `select ticket_number from service_tickets where company_id = $1 and ticket_number like $2`,
      [company.id, `${TICKET_PREFIX}-%`]
    );
    const existing = new Set(existingRes.rows.map((r) => squash(r.ticket_number)));
    for (const r of ready) r.isUpdate = existing.has(squash(r.ticketNumber));

    const tally = (list) =>
      Object.entries(
        list.reduce((acc, k) => {
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {})
      ).sort((a, b) => b[1] - a[1]);

    console.log("");
    console.log(`Mode       : ${args.apply ? "APPLY" : "DRY RUN"}`);
    console.log(`Company    : ${company.company_code} (id ${company.id})`);
    console.log(`Service log: ${args.logFile}`);
    console.log(`Review     : ${args.reviewFile}`);
    console.log(`             ${confirmed.size} confirmed spare codes, ${corrections.size} corrected dates`);
    console.log("");
    console.log(`Log rows                 : ${logRows.length}`);
    console.log(`Visits for this company  : ${visits.length}`);
    console.log(`  importable             : ${ready.length}`);
    console.log(`    new                  : ${ready.filter((r) => !r.isUpdate).length}`);
    console.log(`    already imported     : ${ready.filter((r) => r.isUpdate).length}`);
    console.log(`  skipped                : ${skipped.length}`);
    console.log("");
    console.log(`Spare lines on those visits: ${ready.reduce((n, r) => n + r.parts.length + r.unresolved.length, 0)}`);
    console.log(`  written as parts         : ${ready.reduce((n, r) => n + r.parts.length, 0)}`);
    console.log(`  kept in notes only       : ${ready.reduce((n, r) => n + r.unresolved.length, 0)}`);

    console.log("");
    console.log("Visit types:");
    for (const [k, n] of tally(ready.map((r) => r.kind.type))) console.log(`   ${String(n).padStart(4)}  ${k}`);

    if (skipped.length) {
      console.log("");
      console.log("Visits not imported:");
      for (const [k, n] of tally(skipped.map((s) => s.reason))) console.log(`   ${String(n).padStart(4)}  ${k}`);
      const serials = [...new Set(skipped.filter((s) => s.reason === "MACHINE_NOT_IN_JOSH").map((s) => s.serial))];
      if (serials.length) {
        console.log(`   machines involved (${serials.length}): ${serials.slice(0, 20).join(", ")}`);
      }
    }
    if (dropped.length) {
      console.log("");
      // An unreadable job number cannot be attributed to a company, so that count spans
      // the whole log rather than just this company's rows.
      console.log("Log rows dropped before grouping:");
      for (const [k, n] of tally(dropped.map((d) => d.reason))) console.log(`   ${String(n).padStart(4)}  ${k}`);
      if (dropped.some((d) => d.reason === "VISIT_DATE_IN_FUTURE") && !args.repairSwapped) {
        console.log("   these are day/month transpositions -- see --repair-swapped-dates");
      }
    }

    if (corrected.length) {
      console.log("");
      console.log(`Dates taken from the reviewer's Date_Corrections sheet: ${corrected.length}`);
    }

    if (repaired.length) {
      console.log("");
      console.log(`Dates repaired by swapping day and month: ${repaired.length}`);
      repaired.slice(0, 8).forEach((r) => console.log(`   ${r.job.padEnd(8)} ${r.from} -> ${r.to}`));
      console.log("   The same fault silently altered rows whose true day was 1-9; those");
      console.log("   read as valid past dates and cannot be found in the file.");
    }

    if (unmappedSpares.size) {
      console.log("");
      console.log(`Top spare labels still needing CONFIRM_item_code (${unmappedSpares.size} distinct):`);
      [...unmappedSpares.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .forEach(([label, n]) => console.log(`   ${String(n).padStart(4)}  ${label}`));
    }

    if (!args.apply) {
      await client.query("rollback");
      console.log("");
      console.log("Sample of visits to import:");
      ready.slice(0, 15).forEach((r) =>
        console.log(
          `   ${r.ticketNumber.padEnd(24)} ${r.machine.item_code.padEnd(12)} ${r.kind.type.padEnd(12)} ` +
            `${r.parts.length}p/${r.unresolved.length}u ${r.engineer ? r.engineer.full_name : r.engineerNames[0] || "no engineer"}`
        )
      );
      console.log("");
      console.log("Dry run only. Re-run with --apply to write.");
      return;
    }

    let tickets = 0;
    let visitRows = 0;
    let partRows = 0;
    for (const r of ready) {
      const partsCost = r.parts.reduce((sum, p) => sum + p.qty * p.cost, 0);
      const notes = [
        `Imported from ${path.basename(args.logFile)}.`,
        r.contract ? `Logged as ${r.contract}.` : "",
        r.visitTypes.length ? `Visit type as written: ${[...new Set(r.visitTypes)].join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");

      const ticketRes = await client.query(
        `insert into service_tickets (
           company_id, ticket_number, ticket_status, ticket_priority, complaint_type,
           customer_id, installed_equipment_id, site_name, symptom_summary, remarks,
           reported_at, resolved_at, is_under_amc, parts_cost_total
         ) values ($1, $2, 'closed', 'normal', $3, $4, $5, $6, $7, $8, $9::date, $9::date, $10, $11)
         on conflict (company_id, ticket_number) do update set
           complaint_type        = excluded.complaint_type,
           installed_equipment_id = excluded.installed_equipment_id,
           symptom_summary       = excluded.symptom_summary,
           remarks               = excluded.remarks,
           is_under_amc          = excluded.is_under_amc,
           parts_cost_total      = excluded.parts_cost_total,
           updated_at            = now()
         returning id`,
        [
          company.id,
          r.ticketNumber,
          r.kind.type,
          r.machine.customer_id,
          r.machine.id,
          r.machine.site_location || null,
          `${r.kind.label} on ${r.machine.item_code} ${r.serial} (imported from service log)`,
          notes,
          r.date,
          isAmc(r.contract),
          partsCost.toFixed(2),
        ]
      );
      const ticketId = ticketRes.rows[0].id;
      tickets += 1;

      // Spare lines that could not become part rows are written here so the visit still
      // records what was actually done, exactly as the service team wrote it.
      const visitNotes = [
        r.engineerNames.length ? `Engineer: ${r.engineerNames.join(", ")}.` : "",
        r.engineer ? "" : r.engineerNames.length ? "(name not matched to a Josh user)" : "",
        r.unresolved.length
          ? `Unmapped from log: ${r.unresolved.map((u) => `${u.raw} x${u.qty} [${u.why}]`).join("; ")}.`
          : "",
        r.dateRepairedFrom ? `Date corrected from ${r.dateRepairedFrom} (day/month transposed in the log).` : "",
        r.dateConfirmedByReviewer ? "Visit date confirmed by the service team." : "",
      ]
        .filter(Boolean)
        .join(" ");

      await client.query(
        `insert into service_ticket_visits (
           ticket_id, visit_no, scheduled_date, visit_status, engineer_user_id, visit_notes
         ) values ($1, 1, $2::date, 'completed', $3, $4)
         on conflict (ticket_id, visit_no) do update set
           scheduled_date   = excluded.scheduled_date,
           visit_status     = excluded.visit_status,
           engineer_user_id = coalesce(excluded.engineer_user_id, service_ticket_visits.engineer_user_id),
           visit_notes      = excluded.visit_notes,
           updated_at       = now()`,
        [ticketId, r.date, r.engineer ? r.engineer.id : null, visitNotes || null]
      );
      visitRows += 1;

      // service_ticket_parts has no natural key to upsert on. These tickets are owned by
      // this import (SVCLOG- prefix), so clearing their parts first is what keeps a
      // re-run from stacking duplicates as more spares get confirmed.
      await client.query(`delete from service_ticket_parts where service_ticket_id = $1`, [ticketId]);
      for (const p of r.parts) {
        await client.query(
          `insert into service_ticket_parts (
             company_id, service_ticket_id, product_id, item_code, item_name, uom,
             qty_issued, unit_cost, total_cost, stock_deducted, issued_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10::date)`,
          [
            company.id,
            ticketId,
            p.product.id,
            p.product.item_code,
            p.product.item_name,
            p.product.uom,
            p.qty,
            p.cost,
            (p.qty * p.cost).toFixed(2),
            r.date,
          ]
        );
        partRows += 1;
      }
    }

    await client.query("commit");
    console.log("");
    console.log(`Applied: ${tickets} tickets, ${visitRows} visits, ${partRows} part lines.`);
    console.log("Parts were written with stock_deducted = false; historical use does not move today's stock.");
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

module.exports = { logDate, swappedDate, complaintTypeFrom, isAmc, groupVisits, matchEngineer };
