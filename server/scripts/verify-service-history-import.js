#!/usr/bin/env node
/**
 * Checks on the service-history importer's interpretation of the service log: date
 * parsing, the free-text Visit Type mapping, contract detection, engineer matching and
 * the grouping of spare rows into visits.
 */

const { logDate, swappedDate, complaintTypeFrom, isAmc, groupVisits, matchEngineer } = require("./import-service-history");

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  }
};

// ---- dates: the log writes DD-MM-YYYY, and typos must not be guessed at
check("date DD-MM-YYYY", logDate("14-02-2024"), "2024-02-14");
check("date day > 12 stays the day", logDate("29-04-2024"), "2024-04-29");
check("date ISO passthrough", logDate("2024-02-14"), "2024-02-14");
check("date blank", logDate(""), null);
check("date missing a digit in the year", logDate("17-04-206"), null);
check("date double hyphen", logDate("30-07--2023"), null);
check("date word", logDate("april"), null);
check("date impossible month", logDate("14-13-2024"), null);

// ---- visit type: spellings seen in the real column
check("preventive", complaintTypeFrom("Preventive").type, "preventive");
check("preventive misspelt", complaintTypeFrom("Prevntive").type, "preventive");
check("preventive misspelt again", complaintTypeFrom("Prevntiev").type, "preventive");
check("breakdown", complaintTypeFrom("Breakdown").type, "breakdown");
check("breakdown misspelt", complaintTypeFrom("Breakldown").type, "breakdown");
check("breakdown lowercase", complaintTypeFrom("breakdown").type, "breakdown");
// A visit recorded as both did fix a breakdown, which is the fact worth keeping.
check("both types", complaintTypeFrom("Preventive/Breakdown").type, "breakdown");
check("i and c", complaintTypeFrom("I&C").type, "installation");
check("commissioning", complaintTypeFrom("Commissioning").type, "commissioning");
check("courtesy", complaintTypeFrom("Courtesy Visit").type, "other");
check("courtesy misspelt", complaintTypeFrom("Coustery visit").type, "other");
check("courtesy misspelt again", complaintTypeFrom("Courestesy visit").type, "other");
// The column sometimes holds an engineer or a part instead of a type.
check("engineer name in the type column", complaintTypeFrom("Mr. Ashutosh").type, "other");
check("part name in the type column", complaintTypeFrom("Dryer filter").type, "other");
check("blank type", complaintTypeFrom("").type, "other");
check("blank type label", complaintTypeFrom("").label, "Service visit");

// ---- contract column: CMSS is a contract, PVT/IND describe the customer
check("cmss is amc", isAmc("CMSS"), true);
check("cmss mixed case", isAmc("CMSs"), true);
check("pvt is not amc", isAmc("PVT"), false);
check("ind is not amc", isAmc("IND"), false);
check("blank is not amc", isAmc(""), false);

// ---- grouping: rows sharing a machine and a date are one visit
const log = [
  { "Job No.": "N047", "Engineer Visit Date": "14-02-2024", "Item / Spare": "Oxygen sensor", "Qty.": "1", "Engineer Name": "Mr. Ashutosh", "Visit Type": "Preventive", "CMSS/PVT/IND.": "CMSS" },
  { "Job No.": "N-047", "Engineer Visit Date": "14-02-2024", "Item / Spare": "Oil filter", "Qty.": "2", "Engineer Name": "", "Visit Type": "", "CMSS/PVT/IND.": "CMSS" },
  { "Job No.": "N047", "Engineer Visit Date": "20-05-2024", "Item / Spare": "NRV", "Qty.": "1", "Visit Type": "Breakdown", "CMSS/PVT/IND.": "CMSS" },
  { "Job No.": "M-028", "Engineer Visit Date": "14-02-2024", "Item / Spare": "Oxygen sensor", "Qty.": "1", "CMSS/PVT/IND.": "CMSS" },
  { "Job No.": "N048", "Engineer Visit Date": "", "Visit / item Date": "10-12-2024", "Item / Spare": "Filter", "Qty.": "1" },
  { "Job No.": "N049", "Engineer Visit Date": "", "Visit / item Date": "", "Item / Spare": "Filter", "Qty.": "1" },
  { "Job No.": "", "Engineer Visit Date": "14-02-2024", "Item / Spare": "Filter" },
];
const ai = groupVisits(log, "AI", { today: "2026-09-16" });
check("AI visits found", ai.visits.length, 3);
check("two spellings of one job land on one visit", ai.visits[0].lines.length, 2);
check("serial is canonical", ai.visits[0].serial, "N0047");
check("qty read from the row", ai.visits[0].lines[1].qty, 2);
check("second visit is a different date", ai.visits[1].date, "2024-05-20");
// The spare-issue date stands in when the visit date was never filled in.
check("falls back to the item date", ai.visits[2].date, "2024-12-10");
check("undated row dropped", ai.dropped.filter((d) => d.reason === "NO_USABLE_DATE").length, 1);
check("unreadable job dropped", ai.dropped.filter((d) => d.reason === "JOB_NUMBER_UNREADABLE").length, 1);

// AT rows in the same log must not leak into an AI run, and vice versa.
const at = groupVisits(log, "AT", { today: "2026-09-16" });
check("AT visits found", at.visits.length, 1);
check("AT serial", at.visits[0].serial, "M0028");

// A spare line with no quantity still counts as one part rather than zero, since
// service_ticket_parts requires a positive quantity.
const noQty = groupVisits([{ "Job No.": "N047", "Engineer Visit Date": "14-02-2024", "Item / Spare": "Sensor", "Qty.": "" }], "AI", { today: "2026-09-16" });
check("blank qty becomes one", noQty.visits[0].lines[0].qty, 1);

// A visit dated after the run cannot have happened, and the intended date is not
// recoverable from a transposition, so it is reported instead of imported.
const future = groupVisits(
  [
    { "Job No.": "N047", "Engineer Visit Date": "07-12-2026", "Item / Spare": "Sensor" },
    { "Job No.": "N047", "Engineer Visit Date": "20-05-2036", "Item / Spare": "Sensor" },
    { "Job No.": "N047", "Engineer Visit Date": "16-09-2026", "Item / Spare": "Sensor" },
  ],
  "AI",
  { today: "2026-09-16" }
);
check("future dates dropped", future.dropped.filter((d) => d.reason === "VISIT_DATE_IN_FUTURE").length, 2);
check("a visit dated today is kept", future.visits.length, 1);

// ---- the day/month transposition behind those future dates
check("swap a transposed date", swappedDate("2026-10-07"), "2026-07-10");
check("swap is symmetric", swappedDate("2026-12-01"), "2026-01-12");
// A day past 12 was never misread as a month, so there is nothing to swap.
check("day 20 cannot be a month", swappedDate("2026-05-20"), null);
// 2026-02-30 is not a date, so this reading was never plausible.
check("swap that makes an impossible date", swappedDate("2026-30-02"), null);
check("swap rejects rubbish", swappedDate("not a date"), null);

const repairLog = [
  // 10 July written DD-MM, stored by Excel as 7 October.
  { "Job No.": "N047", "Engineer Visit Date": "07-10-2026", "Item / Spare": "Sensor" },
  // 20 May 2036 is a plain typo, not a transposition, and must stay dropped.
  { "Job No.": "N047", "Engineer Visit Date": "20-05-2036", "Item / Spare": "Sensor" },
];
const norepair = groupVisits(repairLog, "AI", { today: "2026-09-16" });
check("repair is off by default", norepair.visits.length, 0);
check("nothing reported as repaired", norepair.repaired.length, 0);

const withRepair = groupVisits(repairLog, "AI", { today: "2026-09-16", repairSwapped: true });
check("transposed date recovered", withRepair.visits.length, 1);
check("recovered to the intended day", withRepair.visits[0].date, "2026-07-10");
check("original kept for the audit trail", withRepair.visits[0].dateRepairedFrom, "2026-10-07");
check("repair is reported", withRepair.repaired.length, 1);
check("the 2036 typo is still dropped", withRepair.dropped.filter((d) => d.reason === "VISIT_DATE_IN_FUTURE").length, 1);

// ---- a date the service team corrected on the Date_Corrections sheet wins outright
const corrections = new Map([
  ["12|Engineer Visit Date", "2026-03-05"],
  ["13|Visit / item Date", "2025-11-30"],
]);
const reviewed = groupVisits(
  [
    // Reads as a perfectly plausible 5 March, but the team says otherwise.
    { __row: 12, "Job No.": "N047", "Engineer Visit Date": "05-03-2026", "Item / Spare": "Sensor" },
    // The correction rescues a row that was unreadable and would have been dropped.
    { __row: 13, "Job No.": "N048", "Visit / item Date": "15-05-206", "Item / Spare": "Sensor" },
    { __row: 14, "Job No.": "N049", "Engineer Visit Date": "05-03-2026", "Item / Spare": "Sensor" },
  ],
  "AI",
  { today: "2026-09-16", corrections }
);
check("confirmed date applied", reviewed.visits.find((v) => v.serial === "N0047").date, "2026-03-05");
check("confirmed date marked", reviewed.visits.find((v) => v.serial === "N0047").dateConfirmedByReviewer, true);
check("correction rescues an unreadable date", reviewed.visits.find((v) => v.serial === "N0048").date, "2025-11-30");
check("uncorrected row untouched", reviewed.visits.find((v) => v.serial === "N0049").date, "2026-03-05");
check("uncorrected row not flagged", reviewed.visits.find((v) => v.serial === "N0049").dateConfirmedByReviewer, false);
check("corrections counted", reviewed.corrected.length, 2);

// A date that landed in the engineer column must not become an engineer's name.
const shifted = groupVisits(
  [{ "Job No.": "N047", "Engineer Visit Date": "14-02-2024", "Item / Spare": "Sensor", "Engineer Name": "02-03-2024" }],
  "AI",
  { today: "2026-09-16" }
);
check("date in the name column ignored", shifted.visits[0].engineers.size, 0);

// ---- engineer names
const users = new Map([["ASHUTOSHSHARMA", { id: 7, full_name: "Ashutosh Sharma" }]]);
check("honorific stripped before matching", matchEngineer(["Mr. Ashutosh Sharma"], users).id, 7);
check("exact name matches", matchEngineer(["Ashutosh Sharma"], users).id, 7);
check("unknown engineer stays unlinked", matchEngineer(["Someone Else"], users), null);
check("no engineer named", matchEngineer([], users), null);

console.log(`pass ${pass}/${pass + fail}`);
if (fail) process.exitCode = 1;
