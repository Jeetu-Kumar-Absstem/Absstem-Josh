const fs = require("fs");
const readline = require("readline");
const path = "Transactions (1).xml";
const rl = readline.createInterface({
  input: fs.createReadStream(path, { encoding: "utf16le" }),
  crlfDelay: Infinity,
});
let inV = false;
let t = "";
let n = "";
const sales = [];
rl.on("line", (line) => {
  if (/<VOUCHER[\s>]/.test(line)) {
    inV = true;
    const m = line.match(/VCHTYPE="([^"]+)"/);
    t = m ? m[1] : "";
    n = "";
  }
  if (!inV) return;
  const m = line.match(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/);
  if (m) n = m[1];
  if (/<\/VOUCHER>/.test(line)) {
    inV = false;
    if (/sales/i.test(t)) sales.push(n);
  }
});
rl.on("close", () => {
  const prefs = {};
  for (const num of sales) {
    let p = "(blank)";
    if (!num) p = "(blank)";
    else if (/^INV-AI/i.test(num)) p = "INV-AI/...";
    else if (/^TI-/i.test(num)) p = "TI-...";
    else if (/^INV/i.test(num)) p = "INV* other";
    else p = String(num).slice(0, 16);
    prefs[p] = (prefs[p] || 0) + 1;
  }
  console.log(JSON.stringify({ count: sales.length, prefs, head: sales.slice(0, 25), tail: sales.slice(-20) }, null, 2));
});
