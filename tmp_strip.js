const fs = require("fs");
const file = "server/src/services/commercialSales.js";
let src = fs.readFileSync(file, "utf8");
const start = src.indexOf("/**\n * Converts an approved/issued quote");
const end = src.indexOf("/**\n * Creates and confirms an Outbound Dispatch");
if (start < 0 || end < 0 || end < start) throw new Error("markers not found " + start + " " + end);
src = src.slice(0, start) + src.slice(end);
src = src.replace("module.exports = {\n  convertQuoteToSalesOrder,\n  processSalesDispatch,\n};", "module.exports = {\n  processSalesDispatch,\n};");
for (const name of ["explodeWorkOrderBom", "syncLegacySoNumberSequence", "money"]) {
  const uses = src.split(name).length - 1;
  console.log(name, "remaining references:", uses);
}
fs.writeFileSync(file, src);
