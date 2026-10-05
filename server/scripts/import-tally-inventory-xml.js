const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const { saveProduct } = require("../src/services/productMaster");
const { recalcStockBalances } = require("../src/services/stockLedger");
const {
  computeTallyInventoryClosings,
  inferCatalogGroup,
  movementRefType,
  nameKey,
  parseInventoryXml,
  readInventoryXml,
} = require("../src/services/tallyInventoryXml");

const TALLY_REF_TYPES = [
  "TALLY_PURCHASE",
  "TALLY_SALE",
  "TALLY_STOCK_JOURNAL",
  "TALLY_OPENING",
  "TALLY_CREDIT_NOTE",
  "TALLY_DEBIT_NOTE",
  "TALLY_STOCK",
  "TALLY_STOCK_CLOSE",
];

function parseArgs(argv) {
  const out = {
    xml: path.resolve(process.cwd(), "Inventory.xml"),
    company: "AI",
    batch: "inventory.xml.v1",
    apply: false,
    replace: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    else if (token === "--dry-run") out.apply = false;
    else if (token === "--keep-existing") out.replace = false;
    else if (token.startsWith("--xml=")) out.xml = path.resolve(token.slice("--xml=".length));
    else if (token === "--xml" && argv[i + 1]) {
      out.xml = path.resolve(argv[++i]);
    } else if (token.startsWith("--company=")) out.company = token.slice("--company=".length);
    else if (token === "--company" && argv[i + 1]) out.company = argv[++i];
    else if (token.startsWith("--batch=")) out.batch = token.slice("--batch=".length);
  }
  return out;
}

function uniquifyFingerprints(rows) {
  const seen = new Set();
  for (const row of rows) {
    let fp = row.source_fingerprint;
    let n = 2;
    while (seen.has(fp)) {
      fp = `${row.source_fingerprint}|${n}`;
      n += 1;
    }
    seen.add(fp);
    row.source_fingerprint = fp;
  }
}

function makeItemCode(itemName, used) {
  const slug = String(itemName || "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, 18)
    .toUpperCase() || "ITEM";
  let code = `TLY-${slug}`;
  let n = 2;
  while (used.has(code.toUpperCase())) {
    code = `TLY-${slug}-${n}`;
    n += 1;
  }
  used.add(code.toUpperCase());
  return code;
}

function pickProduct(candidates, companyId) {
  if (!candidates.length) return null;
  const withPolicy = candidates.find((row) => Number(row.policy_company_id) === Number(companyId));
  return withPolicy || candidates[0];
}

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.xml)) {
    throw new Error(`XML not found: ${args.xml}`);
  }

  const parsed = parseInventoryXml(readInventoryXml(args.xml));
  uniquifyFingerprints(parsed.rows);

  const companyRes = await pool.query(
    `select id, company_code, display_name from companies where upper(company_code) = upper($1) limit 1`,
    [args.company]
  );
  const company = companyRes.rows[0];
  if (!company) throw new Error(`Company not found: ${args.company}`);

  const productsRes = await pool.query(
    `
      select
        p.id,
        p.item_code,
        p.item_name,
        p.uom,
        cpp.company_id as policy_company_id
      from products p
      left join company_product_policies cpp
        on cpp.product_id = p.id and cpp.company_id = $1
      where p.is_active = true
    `,
    [company.id]
  );

  const byName = new Map();
  const usedCodes = new Set();
  for (const row of productsRes.rows) {
    usedCodes.add(String(row.item_code || "").toUpperCase());
    const keys = [nameKey(row.item_name), nameKey(row.item_code)].filter(Boolean);
    for (const key of keys) {
      const list = byName.get(key) || [];
      list.push(row);
      byName.set(key, list);
    }
  }

  const itemMap = new Map();
  const createdItems = [];
  const matchedItems = [];
  for (const item of parsed.items) {
    const key = nameKey(item.item_title);
    const existing = pickProduct(byName.get(key) || [], company.id);
    if (existing) {
      itemMap.set(key, { product: existing, created: false, uom: item.uom || existing.uom });
      matchedItems.push({ title: item.item_title, item_code: existing.item_code, product_id: existing.id });
    } else {
      itemMap.set(key, { product: null, created: true, item, uom: item.uom || "Nos" });
    }
  }

  const summary = {
    company: company.company_code,
    company_id: company.id,
    xml: args.xml,
    items: parsed.items.length,
    movements: parsed.rows.length,
    typeCounts: parsed.typeCounts,
    matched_existing: matchedItems.length,
    to_create: parsed.items.length - matchedItems.length,
    apply: args.apply,
    replace: args.replace,
  };

  if (!args.apply) {
    console.log(JSON.stringify({ ...summary, sample_new: [...itemMap.values()].filter((v) => v.created).slice(0, 12).map((v) => v.item.item_title) }, null, 2));
    await pool.end();
    return;
  }

  const client = await pool.connect();
  const createdProductIds = [];
  const affectedProductIds = new Set();
  try {
    await client.query("begin");

    if (args.replace) {
      const existingIds = await client.query(
        `select id, product_id from tally_inventory_vouchers where company_id = $1 and import_batch_code = $2`,
        [company.id, args.batch]
      );
      for (const row of existingIds.rows) affectedProductIds.add(Number(row.product_id));
      if (existingIds.rows.length) {
        const voucherIds = existingIds.rows.map((row) => Number(row.id));
        await client.query(
          `
            delete from stock_movements
            where company_id = $1
              and ref_type = any($2::text[])
              and ref_id = any($3::int[])
          `,
          [company.id, TALLY_REF_TYPES, voucherIds]
        );
        await client.query(
          `delete from tally_inventory_vouchers where company_id = $1 and import_batch_code = $2`,
          [company.id, args.batch]
        );
      }
    }

    for (const [key, entry] of itemMap.entries()) {
      if (!entry.created) {
        affectedProductIds.add(Number(entry.product.id));
        await client.query(
          `
            insert into company_product_policies (
              company_id, product_id, sourcing_mode, is_saleable, is_purchaseable, is_stocked, remarks, updated_at
            )
            values ($1,$2,'buy_external', true, true, true, 'Tally inventory.xml ingest', now())
            on conflict (company_id, product_id) do update set
              is_stocked = true,
              updated_at = now()
          `,
          [company.id, entry.product.id]
        );
        continue;
      }

      const itemCode = makeItemCode(entry.item.item_title, usedCodes);
      const productId = Number(
        await saveProduct(
          client,
          {
            item_code: itemCode,
            item_name: entry.item.item_title,
            uom: entry.uom || "Nos",
            category_name: "Tally Inventory",
            group_name: inferCatalogGroup(entry.item.item_title),
            item_type: "component",
            description: `Imported from Inventory.xml for ${company.company_code}`,
            is_stocked: true,
            is_saleable: true,
            is_purchaseable: true,
            sourcing_mode: "buy_external",
          },
          { companyId: company.id, updateCompanyPolicy: true }
        )
      );
      if (!Number.isFinite(productId) || productId <= 0) {
        throw new Error(`Failed to create product for ${entry.item.item_title}`);
      }
      entry.product = { id: productId, item_code: itemCode, item_name: entry.item.item_title };
      createdProductIds.push(productId);
      createdItems.push({ title: entry.item.item_title, item_code: itemCode, product_id: productId });
      affectedProductIds.add(productId);
      const list = byName.get(key) || [];
      list.push(entry.product);
      byName.set(key, list);
    }

    let inserted = 0;
    for (const row of parsed.rows) {
      const entry = itemMap.get(nameKey(row.item_title));
      const productId = Number(entry?.product?.id);
      if (!Number.isFinite(productId) || productId <= 0) {
        throw new Error(`Unmapped item ${row.item_title}`);
      }
      affectedProductIds.add(productId);
      const voucherRes = await client.query(
        `
          insert into tally_inventory_vouchers (
            company_id, import_batch_code, product_id, item_title, voucher_number, voucher_type,
            voucher_date, qty_in, qty_out, qty_signed, unit_cost_base, value_signed_base,
            closing_qty, uom, narration, source_fingerprint
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          returning id
        `,
        [
          company.id,
          args.batch,
          productId,
          row.item_title,
          row.voucher_number,
          row.voucher_type,
          row.voucher_date,
          row.qty_in,
          row.qty_out,
          row.qty_signed,
          row.unit_cost_base,
          row.value_signed_base,
          row.closing_qty,
          row.uom,
          row.narration,
          row.source_fingerprint,
        ]
      );
      const voucherId = Number(voucherRes.rows[0].id);
      const refType = movementRefType(row.voucher_type);
      await client.query(
        `
          insert into stock_movements (
            company_id, product_id, qty_signed, unit_cost_base, value_signed_base,
            movement_date, ref_type, ref_id, ref_line_id
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,1)
        `,
        [
          company.id,
          productId,
          row.qty_signed,
          row.unit_cost_base,
          row.value_signed_base,
          row.voucher_date,
          refType,
          voucherId,
        ]
      );
      inserted += 1;
    }

    await client.query(
      `
        update products p
        set
          last_purchase_price = x.unit_cost_base,
          last_purchase_date = x.voucher_date,
          updated_at = now()
        from (
          select distinct on (product_id)
            product_id, unit_cost_base, voucher_date
          from tally_inventory_vouchers
          where company_id = $1
            and import_batch_code = $2
            and voucher_type = 'Purc'
            and unit_cost_base > 0
          order by product_id, voucher_date desc, id desc
        ) x
        where p.id = x.product_id
      `,
      [company.id, args.batch]
    );

    await recalcStockBalances(client, company.id, Array.from(affectedProductIds));

    const closingSnap = computeTallyInventoryClosings(parsed);
    let closingsApplied = 0;
    let closingAdjustments = 0;
    let closingValue = 0;
    let closingQty = 0;
    for (const close of closingSnap.closings) {
      const entry = itemMap.get(close.key);
      const productId = Number(entry?.product?.id);
      if (!Number.isFinite(productId) || productId <= 0) continue;

      const current = await client.query(
        `
          select coalesce(stock_qty, 0) as stock_qty, coalesce(stock_value_base, 0) as stock_value_base
          from stock_balances
          where company_id = $1 and product_id = $2
          limit 1
        `,
        [company.id, productId]
      );
      const curQty = Number(current.rows[0]?.stock_qty || 0);
      const curVal = Number(current.rows[0]?.stock_value_base || 0);
      const targetQty = Number(close.qty || 0);
      const targetVal = Math.max(0, Number(close.value || 0));
      const qtyDelta = Number((targetQty - curQty).toFixed(4));
      const valDelta = Number((targetVal - curVal).toFixed(2));

      if (Math.abs(qtyDelta) > 0.0001 || Math.abs(valDelta) > 0.01) {
        await client.query(
          `
            delete from stock_movements
            where company_id = $1
              and product_id = $2
              and ref_type = 'TALLY_STOCK_CLOSE'
          `,
          [company.id, productId]
        );
        await client.query(
          `
            delete from tally_inventory_vouchers
            where company_id = $1
              and product_id = $2
              and import_batch_code = $3
              and voucher_type = 'Close'
          `,
          [company.id, productId, args.batch]
        );
        const unit =
          Math.abs(qtyDelta) > 0.0001
            ? Number((valDelta / qtyDelta).toFixed(4))
            : Number(close.rate || 0);
        const voucherRes = await client.query(
          `
            insert into tally_inventory_vouchers (
              company_id, import_batch_code, product_id, item_title, voucher_number, voucher_type,
              voucher_date, qty_in, qty_out, qty_signed, unit_cost_base, value_signed_base,
              closing_qty, uom, narration, source_fingerprint
            )
            values (
              $1,$2,$3,$4,$5,'Close',$6,
              $7,$8,$9,$10,$11,
              $12,$13,$14,$15
            )
            returning id
          `,
          [
            company.id,
            args.batch,
            productId,
            close.item_title,
            `CLOSE-${productId}`,
            close.as_of || new Date().toISOString().slice(0, 10),
            qtyDelta > 0 ? qtyDelta : 0,
            qtyDelta < 0 ? Math.abs(qtyDelta) : 0,
            qtyDelta,
            Math.abs(unit),
            valDelta,
            targetQty,
            close.uom || "Nos",
            "Tally inventory closing reconcile",
            `close|${close.key}|${targetQty}|${targetVal}`,
          ]
        );
        const voucherId = Number(voucherRes.rows[0].id);
        await client.query(
          `
            insert into stock_movements (
              company_id, product_id, qty_signed, unit_cost_base, value_signed_base,
              movement_date, ref_type, ref_id, ref_line_id
            )
            values ($1,$2,$3,$4,$5,$6,'TALLY_STOCK_CLOSE',$7,1)
          `,
          [
            company.id,
            productId,
            qtyDelta,
            Math.abs(unit),
            valDelta,
            close.as_of || new Date().toISOString().slice(0, 10),
            voucherId,
          ]
        );
        closingAdjustments += 1;
      }

      const avg = Math.abs(targetQty) > 0.0001 ? Number((targetVal / targetQty).toFixed(4)) : 0;
      await client.query(
        `
          insert into stock_balances (
            company_id, product_id, stock_qty, stock_value_base, average_unit_cost_base, updated_at, valuation_updated_at
          )
          values ($1,$2,$3,$4,$5, now(), now())
          on conflict (company_id, product_id) do update set
            stock_qty = excluded.stock_qty,
            stock_value_base = excluded.stock_value_base,
            average_unit_cost_base = excluded.average_unit_cost_base,
            updated_at = now(),
            valuation_updated_at = now()
        `,
        [company.id, productId, targetQty, targetVal, avg]
      );
      closingsApplied += 1;
      closingQty += targetQty;
      closingValue += targetVal;
    }

    await client.query("commit");

    const balanceRes = await pool.query(
      `
        select
          count(*) filter (where abs(coalesce(stock_qty,0)) > 0.0001)::int as products_with_stock,
          coalesce(sum(stock_qty), 0) as total_qty,
          coalesce(sum(stock_value_base), 0) as total_value
        from stock_balances
        where company_id = $1
          and product_id = any($2::int[])
      `,
      [company.id, Array.from(affectedProductIds)]
    );

    console.log(
      JSON.stringify(
        {
          ...summary,
          inserted_movements: inserted,
          created_products: createdItems.length,
          created_sample: createdItems.slice(0, 15),
          tally_closings: {
            items: closingSnap.item_count,
            open_items: closingSnap.open_items,
            total_qty: closingSnap.total_qty,
            total_value: closingSnap.total_value,
            applied: closingsApplied,
            adjustments: closingAdjustments,
            applied_qty: Number(closingQty.toFixed(4)),
            applied_value: Number(closingValue.toFixed(2)),
            top: closingSnap.closings.slice(0, 10).map((r) => ({
              item: r.item_title,
              qty: r.qty,
              value: r.value,
              source: r.source,
            })),
          },
          balances: balanceRes.rows[0],
        },
        null,
        2
      )
    );
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
