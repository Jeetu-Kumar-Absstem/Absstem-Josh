const DEFAULT_SCOPES = Object.freeze({
  sales: { tally_ledger_name: "Sales Account", tally_parent_group: "Sales Accounts" },
  output_cgst: { tally_ledger_name: "Output CGST", tally_parent_group: "Duties & Taxes" },
  output_sgst: { tally_ledger_name: "Output SGST", tally_parent_group: "Duties & Taxes" },
  output_igst: { tally_ledger_name: "Output IGST", tally_parent_group: "Duties & Taxes" },
  round_off: { tally_ledger_name: "Round Off", tally_parent_group: "Indirect Expenses" },
  bank: { tally_ledger_name: "Bank Account", tally_parent_group: "Bank Accounts" },
  cash: { tally_ledger_name: "Cash", tally_parent_group: "Cash-in-Hand" },
  freight: { tally_ledger_name: "Freight Outward", tally_parent_group: "Sales Accounts" },
  packing_forwarding: { tally_ledger_name: "Packing & Forwarding", tally_parent_group: "Sales Accounts" },
});

const VALID_SCOPES = new Set(["party", ...Object.keys(DEFAULT_SCOPES)]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeMatchKey(value) {
  const text = cleanText(value);
  return text || null;
}

async function loadLedgerMaps(client, companyId) {
  const r = await client.query(
    `
      select id, map_scope, match_key, tally_ledger_name, tally_parent_group, is_active
      from tally_ledger_maps
      where company_id = $1 and is_active = true
      order by map_scope asc, match_key asc nulls first
    `,
    [Number(companyId)]
  );
  return r.rows;
}

function buildLookup(rows) {
  const byScope = new Map();
  const partyByCustomer = new Map();

  for (const row of rows) {
    const scope = cleanText(row.map_scope);
    const key = normalizeMatchKey(row.match_key) || "";
    if (scope === "party") {
      if (key) partyByCustomer.set(key, row);
      continue;
    }
    if (!byScope.has(scope)) byScope.set(scope, new Map());
    byScope.get(scope).set(key, row);
  }

  return { byScope, partyByCustomer };
}

function resolveScopeName(lookup, scope, matchKey = null) {
  const fallback = DEFAULT_SCOPES[scope]?.tally_ledger_name || null;
  const scopeMap = lookup.byScope.get(scope);
  const key = normalizeMatchKey(matchKey) || "";
  const row = scopeMap?.get(key) || scopeMap?.get("") || null;
  return cleanText(row?.tally_ledger_name) || fallback;
}

function resolvePartyName(lookup, customerId, customerName) {
  const idKey = customerId != null ? String(Number(customerId)) : "";
  const row = lookup.partyByCustomer.get(idKey);
  if (row?.tally_ledger_name) return cleanText(row.tally_ledger_name);
  return cleanText(customerName) || `Customer ${idKey || "Unknown"}`;
}

function resolvePaymentLedger(lookup, paymentMode, bankName) {
  const mode = cleanText(paymentMode).toLowerCase();
  if (mode.includes("cash")) return resolveScopeName(lookup, "cash");
  if (mode.includes("bank") || cleanText(bankName)) {
    const bankKey = cleanText(bankName).toLowerCase();
    const scoped = resolveScopeName(lookup, "bank", bankKey);
    if (scoped) return scoped;
    return resolveScopeName(lookup, "bank");
  }
  return resolveScopeName(lookup, "bank");
}

async function resolveLedgers(client, companyId) {
  const rows = await loadLedgerMaps(client, companyId);
  const lookup = buildLookup(rows);

  return {
    rows,
    lookup,
    getParty(customerId, customerName) {
      return resolvePartyName(lookup, customerId, customerName);
    },
    getScope(scope, matchKey = null) {
      return resolveScopeName(lookup, scope, matchKey);
    },
    getPaymentLedger(paymentMode, bankName) {
      return resolvePaymentLedger(lookup, paymentMode, bankName);
    },
    listEffectiveDefaults() {
      return Object.entries(DEFAULT_SCOPES).map(([scope, def]) => ({
        map_scope: scope,
        match_key: null,
        tally_ledger_name: def.tally_ledger_name,
        tally_parent_group: def.tally_parent_group,
        is_default: true,
      }));
    },
  };
}

function pushUnmapped(bucket, key, detail) {
  if (!bucket.has(key)) bucket.set(key, detail);
}

function findUnmappedSales(invoices, ledgers) {
  const unmapped = new Map();
  for (const inv of invoices) {
    const party = ledgers.getParty(inv.customer_id, inv.customer_name);
    if (!party) {
      pushUnmapped(unmapped, `party:${inv.customer_id}`, {
        map_scope: "party",
        match_key: String(inv.customer_id),
        label: inv.customer_name || `Customer ${inv.customer_id}`,
        reason: "Missing party ledger mapping",
      });
    }
    for (const scope of ["sales", "output_cgst", "output_sgst", "output_igst", "round_off", "freight", "packing_forwarding"]) {
      const name = ledgers.getScope(scope);
      if (!name) {
        pushUnmapped(unmapped, scope, {
          map_scope: scope,
          match_key: null,
          label: scope,
          reason: "Missing scope ledger mapping",
        });
      }
    }
  }
  return [...unmapped.values()];
}

function findUnmappedReceipts(receipts, ledgers) {
  const unmapped = new Map();
  for (const row of receipts) {
    const party = ledgers.getParty(row.customer_id, row.customer_name);
    if (!party) {
      pushUnmapped(unmapped, `party:${row.customer_id}`, {
        map_scope: "party",
        match_key: String(row.customer_id),
        label: row.customer_name || `Customer ${row.customer_id}`,
        reason: "Missing party ledger mapping",
      });
    }
    const payLedger = ledgers.getPaymentLedger(row.payment_mode, row.bank_name);
    if (!payLedger) {
      pushUnmapped(unmapped, `payment:${row.payment_mode || "bank"}`, {
        map_scope: row.payment_mode?.toLowerCase?.().includes("cash") ? "cash" : "bank",
        match_key: cleanText(row.bank_name) || null,
        label: row.payment_mode || row.bank_name || "Payment ledger",
        reason: "Missing bank/cash ledger mapping",
      });
    }
  }
  return [...unmapped.values()];
}

async function upsertLedgerMaps(client, companyId, mappings) {
  const list = Array.isArray(mappings) ? mappings : [];
  const saved = [];
  for (const row of list) {
    const scope = cleanText(row.map_scope);
    if (!VALID_SCOPES.has(scope)) continue;
    const matchKey = normalizeMatchKey(row.match_key);
    const ledgerName = cleanText(row.tally_ledger_name);
    if (!ledgerName) continue;
    const parentGroup = cleanText(row.tally_parent_group) || DEFAULT_SCOPES[scope]?.tally_parent_group || null;
    const isActive = row.is_active !== false;
    const existing = await client.query(
      `
        select id
        from tally_ledger_maps
        where company_id = $1
          and map_scope = $2
          and coalesce(match_key, '') = coalesce($3::text, '')
        limit 1
      `,
      [Number(companyId), scope, matchKey]
    );
    let r;
    if (existing.rows[0]?.id) {
      r = await client.query(
        `
          update tally_ledger_maps
          set
            tally_ledger_name = $4,
            tally_parent_group = $5,
            is_active = $6,
            updated_at = now()
          where id = $7
          returning *
        `,
        [ledgerName, parentGroup, isActive, Number(existing.rows[0].id)]
      );
    } else {
      r = await client.query(
        `
          insert into tally_ledger_maps (
            company_id, map_scope, match_key, tally_ledger_name, tally_parent_group, is_active, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, now())
          returning *
        `,
        [Number(companyId), scope, matchKey, ledgerName, parentGroup, isActive]
      );
    }
    if (r.rows[0]) saved.push(r.rows[0]);
  }
  return saved;
}

module.exports = {
  DEFAULT_SCOPES,
  VALID_SCOPES,
  loadLedgerMaps,
  resolveLedgers,
  findUnmappedSales,
  findUnmappedReceipts,
  upsertLedgerMaps,
};
