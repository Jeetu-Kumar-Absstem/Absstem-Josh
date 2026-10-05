const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const OUTPUT_DIR = path.join(ROOT_DIR, "Suggestions");

const VOLUNTEERS = [
  ["Sales", "Tanu Pandey", "tanu.p@absstem.com"],
  ["Sales", "Pramod Kumar", "pramod@absstem.com"],
  ["Marketing", "Anshita Verma", "contact@absstem.com"],
  ["Purchase", "Nanadani", "purchase@absstem.com"],
  ["Purchase", "Arun Rai", "arun.r@absstem.com"],
  ["Engineering", "Pradeep Sati", "info@absstem.com"],
  ["Manufacturing", "Rohit Singh", "production@absstem.com"],
  ["Stores", "Raushan Sharma", "store@absstem.com"],
  ["Accounts", "Ritika Yadav", "Accounts.industrial@absstem.com"],
  ["Dispatch", "Ritu", "logistics@absstem.com"],
  ["Service", "Shalini Singh", "service@absstem.com"],
  ["SuperAdmin", "Amit Sahni", "amit.s@absstem.com"],
];

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "_");
}

function rtfEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

function paragraph(text = "", opts = {}) {
  const { bold = false, italic = false, underline = false } = opts;
  const prefix = `${bold ? "\\b " : ""}${italic ? "\\i " : ""}${underline ? "\\ul " : ""}`;
  const suffix = `${underline ? "\\ul0 " : ""}${italic ? "\\i0 " : ""}${bold ? "\\b0 " : ""}`;
  return `${prefix}${rtfEscape(text)}${suffix}\\par\n`;
}

function blankLine() {
  return "\\par\n";
}

function buildVolunteerDoc([desk, fullName, email]) {
  const lines = [];
  lines.push("{\\rtf1\\ansi\\deff0");
  lines.push(paragraph("JOSH Pilot Feedback Note", { bold: true }));
  lines.push(paragraph(`Desk: ${desk}`));
  lines.push(paragraph(`Volunteer: ${fullName}`));
  lines.push(paragraph(`Email: ${email}`));
  lines.push(paragraph("Purpose: Please capture issues found in Clan and suggestions for the new system Josh."));
  lines.push(blankLine());
  lines.push(paragraph("How To Fill", { bold: true }));
  lines.push(paragraph("1. Use this same document only."));
  lines.push(paragraph("2. For each point, mention the current problem in Clan first, then what Josh should do better."));
  lines.push(paragraph("3. Prefer real workflow examples over generic comments."));
  lines.push(paragraph("4. Mention screen name / process / transaction wherever possible."));
  lines.push(paragraph("5. Add screenshots separately in the same Suggestions folder if required."));
  lines.push(blankLine());
  lines.push(paragraph("Section A: Clan Issues Found", { bold: true }));
  lines.push(paragraph("Issue 1: "));
  lines.push(paragraph("Where seen: "));
  lines.push(paragraph("What is happening in Clan: "));
  lines.push(paragraph("Why this is a problem: "));
  lines.push(paragraph("How often this happens: Daily / Weekly / Rare"));
  lines.push(paragraph("Business impact: High / Medium / Low"));
  lines.push(blankLine());
  lines.push(paragraph("Issue 2: "));
  lines.push(paragraph("Where seen: "));
  lines.push(paragraph("What is happening in Clan: "));
  lines.push(paragraph("Why this is a problem: "));
  lines.push(paragraph("How often this happens: Daily / Weekly / Rare"));
  lines.push(paragraph("Business impact: High / Medium / Low"));
  lines.push(blankLine());
  lines.push(paragraph("Section B: Suggestions For Josh", { bold: true }));
  lines.push(paragraph("Suggestion 1: "));
  lines.push(paragraph("Related process / screen: "));
  lines.push(paragraph("What Josh should do: "));
  lines.push(paragraph("Expected benefit: "));
  lines.push(paragraph("Priority: High / Medium / Low"));
  lines.push(blankLine());
  lines.push(paragraph("Suggestion 2: "));
  lines.push(paragraph("Related process / screen: "));
  lines.push(paragraph("What Josh should do: "));
  lines.push(paragraph("Expected benefit: "));
  lines.push(paragraph("Priority: High / Medium / Low"));
  lines.push(blankLine());
  lines.push(paragraph("Section C: Pilot Readiness", { bold: true }));
  lines.push(paragraph("What is already good in Josh for my desk: "));
  lines.push(paragraph("What is still missing before broader team rollout: "));
  lines.push(paragraph("Would I recommend pilot use for my desk now? Yes / No / With caution"));
  lines.push(paragraph("If with caution, what must be fixed first: "));
  lines.push(blankLine());
  lines.push(paragraph("Section D: Final Note", { bold: true }));
  lines.push(paragraph("Any additional comments: "));
  lines.push("}");
  return lines.join("");
}

function buildIndexDoc() {
  const lines = [];
  lines.push("{\\rtf1\\ansi\\deff0");
  lines.push(paragraph("JOSH Pilot Suggestions Pack", { bold: true }));
  lines.push(paragraph("Folder purpose: each volunteer should open only their own document, add Clan issues and Josh suggestions, and save the same file back in this folder."));
  lines.push(blankLine());
  lines.push(paragraph("Instructions", { bold: true }));
  lines.push(paragraph("1. Share only the relevant file with each volunteer."));
  lines.push(paragraph("2. Ask them to fill issues found in Clan and suggestions for Josh."));
  lines.push(paragraph("3. Ask them to focus on their own desk workflows only."));
  lines.push(paragraph("4. If they attach screenshots, save them in the same Suggestions folder with their name in the filename."));
  lines.push(blankLine());
  lines.push(paragraph("Volunteer List", { bold: true }));
  VOLUNTEERS.forEach(([desk, fullName, email]) => {
    lines.push(paragraph(`${desk} - ${fullName} - ${email}`));
  });
  lines.push(blankLine());
  lines.push(paragraph("Suggested Review Lens", { bold: true }));
  lines.push(paragraph("Clan issues: delays, duplication, unclear approvals, missing visibility, wrong masters, wrong reports, extra manual work."));
  lines.push(paragraph("Josh suggestions: what should be simpler, faster, clearer, or better controlled for the same desk."));
  lines.push(paragraph("Please ask each volunteer to keep suggestions practical and workflow-based, not generic."));
  lines.push("}");
  return lines.join("");
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const indexPath = path.join(OUTPUT_DIR, "00_JOSH_Pilot_Suggestions_Guide.rtf");
  fs.writeFileSync(indexPath, buildIndexDoc(), "utf8");

  for (const volunteer of VOLUNTEERS) {
    const [desk, fullName] = volunteer;
    const fileName = `${sanitizeFileName(desk)}__${sanitizeFileName(fullName)}.rtf`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(filePath, buildVolunteerDoc(volunteer), "utf8");
  }

  console.log(`Suggestion feedback pack written to ${OUTPUT_DIR}`);
}

main();
