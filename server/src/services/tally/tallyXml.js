const { money2 } = require("./money");

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatTallyDate(value) {
  if (!value) return "";
  const text = String(value).slice(0, 10).replace(/-/g, "");
  return /^\d{8}$/.test(text) ? text : "";
}

function formatAmount(value) {
  return money2(value).toFixed(2);
}

function ledgerEntry({ ledgerName, amount, isDebit = false, billAllocations = null }) {
  const deemed = isDebit ? "Yes" : "No";
  const signed = isDebit ? -Math.abs(Number(amount)) : Math.abs(Number(amount));
  let billXml = "";
  if (Array.isArray(billAllocations) && billAllocations.length) {
    billXml = billAllocations
      .map(
        (row) => `
        <BILLALLOCATIONS.LIST>
          <NAME>${escapeXml(row.name)}</NAME>
          <BILLTYPE>${escapeXml(row.billType || "Agst Ref")}</BILLTYPE>
          <AMOUNT>${formatAmount(row.amount)}</AMOUNT>
        </BILLALLOCATIONS.LIST>`
      )
      .join("");
  }
  return `
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>
        <AMOUNT>${formatAmount(signed)}</AMOUNT>${billXml}
      </ALLLEDGERENTRIES.LIST>`;
}

function voucherBlock({ vchType, date, voucherNumber, partyLedgerName, narration, entries }) {
  const tallyDate = formatTallyDate(date);
  const entryXml = (Array.isArray(entries) ? entries : []).join("");
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="${escapeXml(vchType)}" ACTION="Create">
        <DATE>${tallyDate}</DATE>
        <EFFECTIVEDATE>${tallyDate}</EFFECTIVEDATE>
        <VOUCHERTYPENAME>${escapeXml(vchType)}</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${escapeXml(voucherNumber)}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>${escapeXml(partyLedgerName)}</PARTYLEDGERNAME>
        <NARRATION>${escapeXml(narration || "")}</NARRATION>${entryXml}
      </VOUCHER>
    </TALLYMESSAGE>`;
}

function buildEnvelope({ companyName, vouchers }) {
  const body = (Array.isArray(vouchers) ? vouchers : []).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${body}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function voucherBalance(entries) {
  return (Array.isArray(entries) ? entries : []).reduce((sum, row) => {
    const n = Number(row?.signedAmount ?? row?.amount ?? 0);
    return money2(sum + (Number.isFinite(n) ? money2(n) : 0));
  }, 0);
}

module.exports = {
  escapeXml,
  formatTallyDate,
  formatAmount,
  ledgerEntry,
  voucherBlock,
  buildEnvelope,
  voucherBalance,
};
