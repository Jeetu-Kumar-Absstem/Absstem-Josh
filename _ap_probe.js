const fs = require("fs");
const { parseTallyData } = require("./server/src/services/tallyEngine.js");
const b = fs.readFileSync("tally-transactions-billwise.xml");
const t = b.toString("utf16le");
console.log("=== TAG COUNTS ===");
for (const tag of ["VOUCHER","BILLALLOCATIONS","BILLCL","BILLOPENDUE","LEDGER","BILLFIXED","NAME","BILLTYPE","AMOUNT","PURCHASE","PAYMENT"]) {
  console.log(tag, (t.match(new RegExp("<" + tag + "\\b", "gi")) || []).length);
}
console.log("BILLALLOCATIONS.LIST", (t.match(/<BILLALLOCATIONS,\.LIST\b/gi) || []).length);
console.log("BILLTYPE Agst Ref", (t.match(/<BILLTYPE>Agst Ref<\/BILLTYPE>/gi) || []).length);
console.log("BILLTYPE New Ref", (t.match(/<BILLTYPE>New Ref<\/BILLTYPE>/gi) || []).length);
console.log("BILLTYPE On Account", (t.match(/<BILLTYPE>On Account<\/BILLTYPE>/gi) || []).length);
const data = parseTallyData(b, "tally-transactions-billwise.xml");
let totalBA = 0, payBA = 0, purchBA = 0, byType = {};
for (const v of data.vouchers) {
  for (const e of v.entries || []) {
    for (const bill of e.bill_allocations || []) {
      totalBA++;
      const k = bill.bill_type || "(blank)";
      byType[k] = (byType[k] || 0) + 1;
      const vt = String(v.voucher_type || "").toLowerCase();
      if (vt.includes("payment")) payBA++;
      if (vt.includes("purchase")) purchBA++;
    }
  }
}
console.log("PARSED", JSON.stringify(y totalBA, payBA, purchBA, byType }));
let paymentsWithBA = 0, shown = 0;
const voucherRe = /<VOUCHER\b([^>*])>([\r\s\S]*?)<\/VOUCHER>/gi;
let m;
while ((m = voucherRe.exec(t))) {
  const body = m[2];
  if (!/<VOUCHERTYPENAME>Payment<\/VOUCHERTYPENAME>/i.test(body)) continue;
  if (!/BILLALLOCATIONS/i.test(body)) continue;
  paymentsWithBA++;
  if (shown < 1) {
    const i = body.indexOf("BILLALLOCATIONS");
    console.log(body.slice(Math.max(0, i - 200), i + 700));
    shown++;
  }
}
console.log("payments_with_BILLALLOCATIONS_text", paymentsWithBA);
