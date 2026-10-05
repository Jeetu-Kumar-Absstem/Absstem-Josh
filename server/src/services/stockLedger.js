function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isIntLike(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.floor(n) === n;
}

async function recalcStockBalances(client, companyId, productIds) {
  const cid = Number(companyId);
  const ids = (productIds || []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
  if (!Number.isFinite(cid) || cid <= 0) return;
  if (!ids.length) return;

  await client.query(
    `
      with recursive target as (
        select $1::int as company_id, unnest($2::int[]) as product_id
      ),
      ranked as (
        select
          sm.company_id,
          sm.product_id,
          sm.qty_signed,
          sm.unit_cost_base,
          row_number() over (
            partition by sm.company_id, sm.product_id
            order by sm.movement_date asc nulls first, sm.id asc
          ) as movement_no
        from stock_movements sm
        join target t on t.company_id = sm.company_id and t.product_id = sm.product_id
      ),
      valuation(company_id, product_id, movement_no, stock_qty, stock_value_base) as (
        select
          r.company_id,
          r.product_id,
          r.movement_no,
          r.qty_signed::numeric,
          case
            when r.qty_signed > 0 then r.qty_signed * coalesce(r.unit_cost_base, 0)
            else 0
          end::numeric
        from ranked r
        where r.movement_no = 1
        union all
        select
          r.company_id,
          r.product_id,
          r.movement_no,
          (v.stock_qty + r.qty_signed)::numeric,
          (
            case
            when r.qty_signed >= 0 then
              v.stock_value_base + (
                r.qty_signed * coalesce(
                  r.unit_cost_base,
                  case when v.stock_qty > 0 then v.stock_value_base / v.stock_qty else 0 end
                )
              )
            else
              v.stock_value_base + (
                r.qty_signed * case
                  when v.stock_qty > 0 then v.stock_value_base / v.stock_qty
                  else 0
                end
              )
            end
          )::numeric
        from valuation v
        join ranked r
          on r.company_id = v.company_id
         and r.product_id = v.product_id
         and r.movement_no = v.movement_no + 1
      ),
      latest as (
        select distinct on (company_id, product_id)
          company_id,
          product_id,
          stock_qty,
          stock_value_base,
          case when stock_qty > 0 then stock_value_base / stock_qty else 0 end as average_unit_cost_base
        from valuation
        order by company_id, product_id, movement_no desc
      ),
      agg as (
        select
          t.company_id,
          t.product_id,
          coalesce(l.stock_qty, 0) as stock_qty,
          coalesce(l.stock_value_base, 0) as stock_value_base,
          coalesce(l.average_unit_cost_base, 0) as average_unit_cost_base
        from target t
        left join latest l on l.company_id = t.company_id and l.product_id = t.product_id
      )
      insert into stock_balances (
        company_id,
        product_id,
        stock_qty,
        stock_value_base,
        average_unit_cost_base,
        valuation_updated_at,
        updated_at
      )
      select
        company_id,
        product_id,
        stock_qty,
        stock_value_base,
        average_unit_cost_base,
        now(),
        now()
      from agg
      on conflict (company_id, product_id) do update
      set stock_qty = excluded.stock_qty,
          stock_value_base = excluded.stock_value_base,
          average_unit_cost_base = excluded.average_unit_cost_base,
          valuation_updated_at = excluded.valuation_updated_at,
          updated_at = excluded.updated_at
    `,
    [cid, ids]
  );
}

async function validateGoodsReceiptSerials(client, goodsReceiptId) {
  const linesRes = await client.query(
    `
      select
        l.id,
        l.qty_received,
        p.serial_no_required
      from goods_receipt_lines l
      left join products p on p.id = l.product_id
      where l.goods_receipt_id = $1
      order by l.line_no asc
    `,
    [goodsReceiptId]
  );

  const serialRes = await client.query(
    `
      select goods_receipt_line_id, serial_no
      from goods_receipt_serials
      where goods_receipt_line_id = any(
        select id from goods_receipt_lines where goods_receipt_id = $1
      )
    `,
    [goodsReceiptId]
  );

  const serialsByLine = new Map();
  for (const row of serialRes.rows) {
    const key = Number(row.goods_receipt_line_id);
    if (!serialsByLine.has(key)) serialsByLine.set(key, []);
    serialsByLine.get(key).push(String(row.serial_no || ""));
  }

  for (const line of linesRes.rows) {
    if (line.serial_no_required !== true) continue;
    const q = qty(line.qty_received);
    if (!isIntLike(q)) return { ok: false, error: "SERIAL_QTY_NOT_INTEGER" };
    const serials = serialsByLine.get(Number(line.id)) || [];
    if (serials.length !== Number(q)) return { ok: false, error: "SERIAL_COUNT_MISMATCH" };
  }

  return { ok: true };
}

async function validatePurchaseReturnSerials(client, purchaseReturnId) {
  const linesRes = await client.query(
    `
      select
        l.id,
        l.qty_return,
        p.serial_no_required
      from purchase_return_lines l
      left join products p on p.id = l.product_id
      where l.purchase_return_id = $1
      order by l.line_no asc
    `,
    [purchaseReturnId]
  );

  const serialRes = await client.query(
    `
      select purchase_return_line_id, serial_no
      from purchase_return_serials
      where purchase_return_line_id = any(
        select id from purchase_return_lines where purchase_return_id = $1
      )
    `,
    [purchaseReturnId]
  );

  const serialsByLine = new Map();
  for (const row of serialRes.rows) {
    const key = Number(row.purchase_return_line_id);
    if (!serialsByLine.has(key)) serialsByLine.set(key, []);
    serialsByLine.get(key).push(String(row.serial_no || ""));
  }

  for (const line of linesRes.rows) {
    if (line.serial_no_required !== true) continue;
    const q = qty(line.qty_return);
    if (!isIntLike(q)) return { ok: false, error: "SERIAL_QTY_NOT_INTEGER" };
    const serials = serialsByLine.get(Number(line.id)) || [];
    if (serials.length !== Number(q)) return { ok: false, error: "SERIAL_COUNT_MISMATCH" };
  }

  return { ok: true };
}

async function validateServiceWarrantySerials(client, serviceCaseId) {
  const linesRes = await client.query(
    `
      select
        swm.id,
        swm.qty,
        swcl.serial_no_required
      from service_warranty_movements swm
      join service_warranty_case_lines swcl on swcl.id = swm.service_warranty_case_line_id
      where swm.service_warranty_case_id = $1
      order by swm.id asc
    `,
    [serviceCaseId]
  );

  const serialRes = await client.query(
    `
      select service_warranty_movement_id, serial_no
      from service_warranty_movement_serials
      where service_warranty_movement_id = any(
        select id from service_warranty_movements where service_warranty_case_id = $1
      )
    `,
    [serviceCaseId]
  );

  const serialsByMove = new Map();
  for (const row of serialRes.rows) {
    const key = Number(row.service_warranty_movement_id);
    if (!serialsByMove.has(key)) serialsByMove.set(key, []);
    serialsByMove.get(key).push(String(row.serial_no || ""));
  }

  for (const line of linesRes.rows) {
    if (line.serial_no_required !== true) continue;
    const q = qty(line.qty);
    if (!isIntLike(q)) return { ok: false, error: "SERIAL_QTY_NOT_INTEGER" };
    const serials = serialsByMove.get(Number(line.id)) || [];
    if (serials.length !== Number(q)) return { ok: false, error: "SERIAL_COUNT_MISMATCH" };
  }

  return { ok: true };
}

async function validateStockAdjustmentSerials(client, adjustmentId) {
  const linesRes = await client.query(
    `
      select
        sal.id,
        sal.adjustment_qty,
        sal.serial_no_required
      from stock_adjustment_lines sal
      where sal.stock_adjustment_id = $1
      order by sal.line_no asc
    `,
    [adjustmentId]
  );

  const serialRes = await client.query(
    `
      select stock_adjustment_line_id, serial_no
      from stock_adjustment_line_serials
      where stock_adjustment_line_id = any(
        select id from stock_adjustment_lines where stock_adjustment_id = $1
      )
    `,
    [adjustmentId]
  );

  const serialsByLine = new Map();
  for (const row of serialRes.rows) {
    const key = Number(row.stock_adjustment_line_id);
    if (!serialsByLine.has(key)) serialsByLine.set(key, []);
    serialsByLine.get(key).push(String(row.serial_no || ""));
  }

  for (const line of linesRes.rows) {
    if (line.serial_no_required !== true) continue;
    const q = Math.abs(qty(line.adjustment_qty));
    if (q <= 0) continue;
    if (!isIntLike(q)) return { ok: false, error: "SERIAL_QTY_NOT_INTEGER" };
    const serials = serialsByLine.get(Number(line.id)) || [];
    if (serials.length !== Number(q)) return { ok: false, error: "SERIAL_COUNT_MISMATCH" };
  }

  return { ok: true };
}

async function validateJobCardSerials(client, jobCardId) {
  const linesRes = await client.query(
    `
      select
        jcm.id,
        jcm.qty,
        jcl.serial_no_required
      from job_card_movements jcm
      join job_card_lines jcl on jcl.id = jcm.job_card_line_id
      where jcm.job_card_id = $1
      order by jcm.id asc
    `,
    [jobCardId]
  );
  const serialRes = await client.query(
    `
      select job_card_movement_id, serial_no
      from job_card_movement_serials
      where job_card_movement_id = any(select id from job_card_movements where job_card_id = $1)
    `,
    [jobCardId]
  );
  const serialsByMove = new Map();
  for (const row of serialRes.rows) {
    const key = Number(row.job_card_movement_id);
    if (!serialsByMove.has(key)) serialsByMove.set(key, []);
    serialsByMove.get(key).push(String(row.serial_no || ""));
  }
  for (const line of linesRes.rows) {
    if (line.serial_no_required !== true) continue;
    const q = qty(line.qty);
    if (!isIntLike(q)) return { ok: false, error: "SERIAL_QTY_NOT_INTEGER" };
    const serials = serialsByMove.get(Number(line.id)) || [];
    if (serials.length !== Number(q)) return { ok: false, error: "SERIAL_COUNT_MISMATCH" };
  }
  return { ok: true };
}

async function validateStockTransferSerials(client, transferId) {
  const linesRes = await client.query(
    `
      select id, qty, serial_no_required
      from stock_transfer_lines
      where stock_transfer_id = $1
      order by line_no asc
    `,
    [transferId]
  );
  const serialRes = await client.query(
    `
      select stock_transfer_line_id, serial_no
      from stock_transfer_line_serials
      where stock_transfer_line_id = any(select id from stock_transfer_lines where stock_transfer_id = $1)
    `,
    [transferId]
  );
  const serialsByLine = new Map();
  for (const row of serialRes.rows) {
    const key = Number(row.stock_transfer_line_id);
    if (!serialsByLine.has(key)) serialsByLine.set(key, []);
    serialsByLine.get(key).push(String(row.serial_no || ""));
  }
  for (const line of linesRes.rows) {
    if (line.serial_no_required !== true) continue;
    const q = qty(line.qty);
    if (!isIntLike(q)) return { ok: false, error: "SERIAL_QTY_NOT_INTEGER" };
    const serials = serialsByLine.get(Number(line.id)) || [];
    if (serials.length !== Number(q)) return { ok: false, error: "SERIAL_COUNT_MISMATCH" };
  }
  return { ok: true };
}

async function validateSalesReturnSerials(client, salesReturnId) {
  const linesRes = await client.query(
    `
      select
        srl.id,
        srl.qty_return,
        coalesce(p.serial_no_required, false) as serial_no_required
      from sales_return_lines srl
      left join products p on p.id = srl.product_id
      where srl.sales_return_id = $1
      order by srl.line_no asc
    `,
    [salesReturnId]
  );
  const serialRes = await client.query(
    `
      select sales_return_line_id, serial_no
      from sales_return_serials
      where sales_return_line_id = any(select id from sales_return_lines where sales_return_id = $1)
    `,
    [salesReturnId]
  );
  const serialsByLine = new Map();
  for (const row of serialRes.rows) {
    const key = Number(row.sales_return_line_id);
    if (!serialsByLine.has(key)) serialsByLine.set(key, []);
    serialsByLine.get(key).push(String(row.serial_no || ""));
  }
  for (const line of linesRes.rows) {
    if (line.serial_no_required !== true) continue;
    const q = qty(line.qty_return);
    if (!isIntLike(q)) return { ok: false, error: "SERIAL_QTY_NOT_INTEGER" };
    const serials = serialsByLine.get(Number(line.id)) || [];
    if (serials.length !== Number(q)) return { ok: false, error: "SERIAL_COUNT_MISMATCH" };
  }
  return { ok: true };
}

async function syncStockForGoodsReceipt(client, companyId, goodsReceiptId) {
  const headerRes = await client.query(
    `select id, receipt_status, receipt_date, created_by from goods_receipts where id = $1 limit 1`,
    [goodsReceiptId]
  );
  const header = headerRes.rows[0] || null;
  if (!header) return;

  const existingRes = await client.query(
    `select distinct product_id from stock_movements where company_id = $1 and ref_type = 'GRN' and ref_id = $2`,
    [companyId, goodsReceiptId]
  );
  const affected = new Set(existingRes.rows.map((row) => Number(row.product_id)).filter((v) => Number.isFinite(v) && v > 0));

  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'GRN' and ref_id = $2`, [companyId, goodsReceiptId]);

  if (String(header.receipt_status || "").trim().toLowerCase() !== "posted") {
    const lineProducts = await client.query(
      `select distinct product_id from goods_receipt_lines where goods_receipt_id = $1 and product_id is not null`,
      [goodsReceiptId]
    );
    for (const row of lineProducts.rows) {
      const id = Number(row.product_id);
      if (Number.isFinite(id) && id > 0) affected.add(id);
    }
    await recalcStockBalances(client, companyId, Array.from(affected));
    return;
  }

  const serialCheck = await validateGoodsReceiptSerials(client, goodsReceiptId);
  if (!serialCheck.ok) {
    const err = new Error(serialCheck.error);
    err.status = 400;
    err.code = serialCheck.error;
    throw err;
  }

  const linesRes = await client.query(
    `
      select
        grl.id,
        grl.product_id,
        grl.qty_received,
        grl.location_id,
        coalesce(pol.landed_cost_unit_base, pol.unit_price_base, pol.unit_price_order, 0) as unit_cost_base
      from goods_receipt_lines grl
      left join purchase_order_lines pol on pol.id = grl.purchase_order_line_id
      where grl.goods_receipt_id = $1 and grl.product_id is not null
      order by grl.line_no asc
    `,
    [goodsReceiptId]
  );

  const productIds = [];
  for (const line of linesRes.rows) {
    const refLineId = Number(line.id);
    const productId = Number(line.product_id);
    const locationId = Number(line.location_id);
    const q = qty(line.qty_received);
    if (!Number.isFinite(refLineId) || refLineId <= 0) continue;
    if (!Number.isFinite(productId) || productId <= 0) continue;
    if (q <= 0) continue;
    affected.add(productId);
    productIds.push(productId);
    await client.query(
      `
        insert into stock_movements (
          company_id, product_id, qty_signed, unit_cost_base, value_signed_base,
          movement_date, ref_type, ref_id, ref_line_id, created_by, location_id
        )
        values ($1,$2,$3,$4,$5,$6,'GRN',$7,$8,$9,$10)
      `,
      [
        companyId,
        productId,
        q,
        qty(line.unit_cost_base),
        q * qty(line.unit_cost_base),
        header.receipt_date,
        goodsReceiptId,
        refLineId,
        header.created_by || null,
        Number.isFinite(locationId) && locationId > 0 ? locationId : null,
      ]
    );
  }

  await recalcStockBalances(client, companyId, Array.from(affected));
}

async function syncStockForPurchaseReturn(client, companyId, purchaseReturnId) {
  const headerRes = await client.query(
    `select id, return_status, return_date, created_by from purchase_returns where id = $1 limit 1`,
    [purchaseReturnId]
  );
  const header = headerRes.rows[0] || null;
  if (!header) return;

  const existingRes = await client.query(
    `select distinct product_id from stock_movements where company_id = $1 and ref_type = 'PURCHASE_RETURN' and ref_id = $2`,
    [companyId, purchaseReturnId]
  );
  const affected = new Set(existingRes.rows.map((row) => Number(row.product_id)).filter((v) => Number.isFinite(v) && v > 0));

  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'PURCHASE_RETURN' and ref_id = $2`, [companyId, purchaseReturnId]);

  if (String(header.return_status || "").trim().toLowerCase() !== "posted") {
    const lineProducts = await client.query(
      `select distinct product_id from purchase_return_lines where purchase_return_id = $1 and product_id is not null`,
      [purchaseReturnId]
    );
    for (const row of lineProducts.rows) {
      const id = Number(row.product_id);
      if (Number.isFinite(id) && id > 0) affected.add(id);
    }
    await recalcStockBalances(client, companyId, Array.from(affected));
    return;
  }

  const serialCheck = await validatePurchaseReturnSerials(client, purchaseReturnId);
  if (!serialCheck.ok) {
    const err = new Error(serialCheck.error);
    err.status = 400;
    err.code = serialCheck.error;
    throw err;
  }

  const linesRes = await client.query(
    `
      select id, product_id, qty_return
      from purchase_return_lines
      where purchase_return_id = $1 and product_id is not null
      order by line_no asc
    `,
    [purchaseReturnId]
  );

  for (const line of linesRes.rows) {
    const refLineId = Number(line.id);
    const productId = Number(line.product_id);
    const q = qty(line.qty_return);
    if (!Number.isFinite(refLineId) || refLineId <= 0) continue;
    if (!Number.isFinite(productId) || productId <= 0) continue;
    if (q <= 0) continue;
    affected.add(productId);
    await client.query(
      `
        insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
        values ($1,$2,$3,$4,'PURCHASE_RETURN',$5,$6,$7)
      `,
      [companyId, productId, -q, header.return_date, purchaseReturnId, refLineId, header.created_by || null]
    );
  }

  await recalcStockBalances(client, companyId, Array.from(affected));
}

async function syncStockForDispatch(client, companyId, dispatchId, dispatchStatus) {
  const status = String(dispatchStatus || "").trim().toLowerCase();
  const existingRes = await client.query(
    `select distinct product_id from stock_movements where company_id = $1 and ref_type = 'DISPATCH' and ref_id = $2`,
    [companyId, dispatchId]
  );
  const affected = new Set(existingRes.rows.map((row) => Number(row.product_id)).filter((v) => Number.isFinite(v) && v > 0));
  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'DISPATCH' and ref_id = $2`, [companyId, dispatchId]);

  if (!["dispatched", "delivered"].includes(status)) {
    await recalcStockBalances(client, companyId, Array.from(affected));
    return;
  }

  const headerRes = await client.query(`select dispatch_date, created_by from dispatches where id = $1 limit 1`, [dispatchId]);
  const header = headerRes.rows[0] || null;
  if (!header) return;

  const linesRes = await client.query(
    `
      select dl.id as ref_line_id, sol.product_id, dl.qty_dispatch
      from dispatch_lines dl
      join sales_order_lines sol on sol.id = dl.sales_order_line_id
      where dl.dispatch_id = $1 and sol.product_id is not null
      order by dl.line_no asc
    `,
    [dispatchId]
  );

  const productIds = [];
  for (const line of linesRes.rows) {
    const refLineId = Number(line.ref_line_id);
    const productId = Number(line.product_id);
    const q = qty(line.qty_dispatch);
    if (!Number.isFinite(refLineId) || refLineId <= 0) continue;
    if (!Number.isFinite(productId) || productId <= 0) continue;
    if (q <= 0) continue;
    affected.add(productId);
    productIds.push(productId);
    await client.query(
      `
        insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
        values ($1,$2,$3,$4,'DISPATCH',$5,$6,$7)
      `,
      [companyId, productId, -q, header.dispatch_date, dispatchId, refLineId, header.created_by || null]
    );
  }

  await recalcStockBalances(client, companyId, Array.from(affected));
}

async function syncStockForServiceWarrantyCase(client, companyId, serviceCaseId) {
  const headerRes = await client.query(
    `select id, case_status from service_warranty_cases where id = $1 limit 1`,
    [serviceCaseId]
  );
  const header = headerRes.rows[0] || null;
  if (!header) return;

  const existingRes = await client.query(
    `
      select distinct product_id
      from stock_movements
      where company_id = $1
        and (ref_type = 'FIELD_RETURN' or ref_type = 'SERVICE_REPLACEMENT')
        and ref_id = $2
    `,
    [companyId, serviceCaseId]
  );
  const affected = new Set(existingRes.rows.map((row) => Number(row.product_id)).filter((v) => Number.isFinite(v) && v > 0));

  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'FIELD_RETURN' and ref_id = $2`, [companyId, serviceCaseId]);
  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'SERVICE_REPLACEMENT' and ref_id = $2`, [companyId, serviceCaseId]);

  if (String(header.case_status || "").trim().toLowerCase() === "cancelled") {
    const lineProducts = await client.query(
      `select distinct product_id from service_warranty_case_lines where service_warranty_case_id = $1 and product_id is not null`,
      [serviceCaseId]
    );
    for (const row of lineProducts.rows) {
      const id = Number(row.product_id);
      if (Number.isFinite(id) && id > 0) affected.add(id);
    }
    await recalcStockBalances(client, companyId, Array.from(affected));
    return;
  }

  const serialCheck = await validateServiceWarrantySerials(client, serviceCaseId);
  if (!serialCheck.ok) {
    const err = new Error(serialCheck.error);
    err.status = 400;
    err.code = serialCheck.error;
    throw err;
  }

  const moveRes = await client.query(
    `
      select
        swm.id as ref_line_id,
        swm.movement_type,
        swm.movement_date,
        swm.qty,
        swm.created_by,
        swcl.product_id
      from service_warranty_movements swm
      join service_warranty_case_lines swcl on swcl.id = swm.service_warranty_case_line_id
      where swm.service_warranty_case_id = $1
        and swcl.product_id is not null
      order by swm.id asc
    `,
    [serviceCaseId]
  );

  for (const line of moveRes.rows) {
    const refLineId = Number(line.ref_line_id);
    const productId = Number(line.product_id);
    const q = qty(line.qty);
    if (!Number.isFinite(refLineId) || refLineId <= 0) continue;
    if (!Number.isFinite(productId) || productId <= 0) continue;
    if (q <= 0) continue;
    affected.add(productId);
    const refType = String(line.movement_type || "").toLowerCase() === "field_return" ? "FIELD_RETURN" : "SERVICE_REPLACEMENT";
    const signedQty = refType === "FIELD_RETURN" ? q : -q;
    await client.query(
      `
        insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [companyId, productId, signedQty, line.movement_date, refType, serviceCaseId, refLineId, line.created_by || null]
    );
  }

  await recalcStockBalances(client, companyId, Array.from(affected));
}

async function syncStockForStockAdjustment(client, companyId, adjustmentId) {
  const headerRes = await client.query(
    `select id, adjustment_status, adjustment_date, created_by from stock_adjustments where id = $1 limit 1`,
    [adjustmentId]
  );
  const header = headerRes.rows[0] || null;
  if (!header) return;

  const existingRes = await client.query(
    `select distinct product_id from stock_movements where company_id = $1 and ref_type = 'STOCK_ADJUSTMENT' and ref_id = $2`,
    [companyId, adjustmentId]
  );
  const affected = new Set(existingRes.rows.map((row) => Number(row.product_id)).filter((v) => Number.isFinite(v) && v > 0));

  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'STOCK_ADJUSTMENT' and ref_id = $2`, [companyId, adjustmentId]);

  if (String(header.adjustment_status || "").trim().toLowerCase() !== "posted") {
    const lineProducts = await client.query(
      `select distinct product_id from stock_adjustment_lines where stock_adjustment_id = $1 and product_id is not null`,
      [adjustmentId]
    );
    for (const row of lineProducts.rows) {
      const id = Number(row.product_id);
      if (Number.isFinite(id) && id > 0) affected.add(id);
    }
    await recalcStockBalances(client, companyId, Array.from(affected));
    return;
  }

  const serialCheck = await validateStockAdjustmentSerials(client, adjustmentId);
  if (!serialCheck.ok) {
    const err = new Error(serialCheck.error);
    err.status = 400;
    err.code = serialCheck.error;
    throw err;
  }

  const linesRes = await client.query(
    `
      select id, product_id, adjustment_qty
      from stock_adjustment_lines
      where stock_adjustment_id = $1 and product_id is not null
      order by line_no asc
    `,
    [adjustmentId]
  );

  for (const line of linesRes.rows) {
    const refLineId = Number(line.id);
    const productId = Number(line.product_id);
    const q = qty(line.adjustment_qty);
    if (!Number.isFinite(refLineId) || refLineId <= 0) continue;
    if (!Number.isFinite(productId) || productId <= 0) continue;
    if (q === 0) continue;
    affected.add(productId);
    await client.query(
      `
        insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
        values ($1,$2,$3,$4,'STOCK_ADJUSTMENT',$5,$6,$7)
      `,
      [companyId, productId, q, header.adjustment_date, adjustmentId, refLineId, header.created_by || null]
    );
  }

  await recalcStockBalances(client, companyId, Array.from(affected));
}

async function syncStockForJobCard(client, companyId, jobCardId) {
  const headerRes = await client.query(
    `
      select id, job_status, job_type, finished_good_product_id, actual_output_qty, finished_good_receipt_date, job_date, created_by
      from job_cards
      where id = $1
      limit 1
    `,
    [jobCardId]
  );
  const header = headerRes.rows[0] || null;
  if (!header) return;

  const existingRes = await client.query(
    `
      select distinct product_id
      from stock_movements
      where company_id = $1
        and (ref_type = 'MATERIAL_ISSUE' or ref_type = 'MATERIAL_RETURN' or ref_type = 'MANUFACTURING_RECEIPT')
        and ref_id = $2
    `,
    [companyId, jobCardId]
  );
  const affected = new Set(existingRes.rows.map((row) => Number(row.product_id)).filter((v) => Number.isFinite(v) && v > 0));

  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'MATERIAL_ISSUE' and ref_id = $2`, [companyId, jobCardId]);
  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'MATERIAL_RETURN' and ref_id = $2`, [companyId, jobCardId]);
  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'MANUFACTURING_RECEIPT' and ref_id = $2`, [companyId, jobCardId]);

  if (String(header.job_status || "").trim().toLowerCase() === "cancelled") {
    const lineProducts = await client.query(`select distinct product_id from job_card_lines where job_card_id = $1 and product_id is not null`, [jobCardId]);
    for (const row of lineProducts.rows) {
      const id = Number(row.product_id);
      if (Number.isFinite(id) && id > 0) affected.add(id);
    }
    await recalcStockBalances(client, companyId, Array.from(affected));
    return;
  }

  const serialCheck = await validateJobCardSerials(client, jobCardId);
  if (!serialCheck.ok) {
    const err = new Error(serialCheck.error);
    err.status = 400;
    err.code = serialCheck.error;
    throw err;
  }

  const moveRes = await client.query(
    `
      select
        jcm.id as ref_line_id,
        jcm.movement_type,
        jcm.movement_date,
        jcm.qty,
        jcm.created_by,
        jcl.product_id
      from job_card_movements jcm
      join job_card_lines jcl on jcl.id = jcm.job_card_line_id
      where jcm.job_card_id = $1
        and jcl.product_id is not null
      order by jcm.id asc
    `,
    [jobCardId]
  );

  for (const line of moveRes.rows) {
    const refLineId = Number(line.ref_line_id);
    const productId = Number(line.product_id);
    const q = qty(line.qty);
    if (!Number.isFinite(refLineId) || refLineId <= 0) continue;
    if (!Number.isFinite(productId) || productId <= 0) continue;
    if (q <= 0) continue;
    affected.add(productId);
    const refType = String(line.movement_type || "").toLowerCase() === "return" ? "MATERIAL_RETURN" : "MATERIAL_ISSUE";
    const signedQty = refType === "MATERIAL_RETURN" ? q : -q;
    await client.query(
      `
        insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [companyId, productId, signedQty, line.movement_date, refType, jobCardId, refLineId, line.created_by || null]
    );
  }

  if (String(header.job_type || "").trim().toLowerCase() === "manufacturing") {
    const receiptQty = qty(header.actual_output_qty);
    const fgProductId = Number(header.finished_good_product_id);
    const finalStatus = String(header.job_status || "").trim().toLowerCase();
    if (Number.isFinite(fgProductId) && fgProductId > 0) affected.add(fgProductId);

    if (Number.isFinite(fgProductId) && fgProductId > 0 && receiptQty > 0 && ["closed", "posted"].includes(finalStatus)) {
      await client.query(
        `
          insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
          values ($1,$2,$3,$4,'MANUFACTURING_RECEIPT',$5,null,$6)
        `,
        [companyId, fgProductId, receiptQty, header.finished_good_receipt_date || header.job_date || new Date(), jobCardId, header.created_by || null]
      );
    }
  }

  await recalcStockBalances(client, companyId, Array.from(affected));
}

async function syncStockForStockTransfer(client, companyId, transferId) {
  const headerRes = await client.query(
    `select id, transfer_status, transfer_date, created_by from stock_transfers where id = $1 limit 1`,
    [transferId]
  );
  const header = headerRes.rows[0] || null;
  if (!header) return;

  const existingRes = await client.query(
    `
      select distinct product_id
      from stock_movements
      where company_id = $1
        and (ref_type = 'LOCATION_TRANSFER_OUT' or ref_type = 'LOCATION_TRANSFER_IN')
        and ref_id = $2
    `,
    [companyId, transferId]
  );
  const affected = new Set(existingRes.rows.map((row) => Number(row.product_id)).filter((v) => Number.isFinite(v) && v > 0));

  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'LOCATION_TRANSFER_OUT' and ref_id = $2`, [companyId, transferId]);
  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'LOCATION_TRANSFER_IN' and ref_id = $2`, [companyId, transferId]);

  if (String(header.transfer_status || "").trim().toLowerCase() !== "posted") {
    const lineProducts = await client.query(`select distinct product_id from stock_transfer_lines where stock_transfer_id = $1 and product_id is not null`, [transferId]);
    for (const row of lineProducts.rows) {
      const id = Number(row.product_id);
      if (Number.isFinite(id) && id > 0) affected.add(id);
    }
    await recalcStockBalances(client, companyId, Array.from(affected));
    return;
  }

  const serialCheck = await validateStockTransferSerials(client, transferId);
  if (!serialCheck.ok) {
    const err = new Error(serialCheck.error);
    err.status = 400;
    err.code = serialCheck.error;
    throw err;
  }

  const linesRes = await client.query(
    `
      select id, product_id, qty
      from stock_transfer_lines
      where stock_transfer_id = $1 and product_id is not null
      order by line_no asc
    `,
    [transferId]
  );

  for (const line of linesRes.rows) {
    const refLineId = Number(line.id);
    const productId = Number(line.product_id);
    const q = qty(line.qty);
    if (!Number.isFinite(refLineId) || refLineId <= 0) continue;
    if (!Number.isFinite(productId) || productId <= 0) continue;
    if (q <= 0) continue;
    affected.add(productId);
    await client.query(
      `
        insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
        values ($1,$2,$3,$4,'LOCATION_TRANSFER_OUT',$5,$6,$7)
      `,
      [companyId, productId, -q, header.transfer_date, transferId, refLineId, header.created_by || null]
    );
    await client.query(
      `
        insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
        values ($1,$2,$3,$4,'LOCATION_TRANSFER_IN',$5,$6,$7)
      `,
      [companyId, productId, q, header.transfer_date, transferId, refLineId, header.created_by || null]
    );
  }

  await recalcStockBalances(client, companyId, Array.from(affected));
}

async function syncStockForSalesReturn(client, companyId, salesReturnId) {
  const headerRes = await client.query(
    `select id, return_status, return_date, created_by from sales_returns where id = $1 limit 1`,
    [salesReturnId]
  );
  const header = headerRes.rows[0] || null;
  if (!header) return;

  const existingRes = await client.query(
    `select distinct product_id from stock_movements where company_id = $1 and ref_type = 'SALES_RETURN' and ref_id = $2`,
    [companyId, salesReturnId]
  );
  const affected = new Set(existingRes.rows.map((row) => Number(row.product_id)).filter((v) => Number.isFinite(v) && v > 0));

  await client.query(`delete from stock_movements where company_id = $1 and ref_type = 'SALES_RETURN' and ref_id = $2`, [companyId, salesReturnId]);

  if (String(header.return_status || "").trim().toLowerCase() !== "posted") {
    const lineProducts = await client.query(`select distinct product_id from sales_return_lines where sales_return_id = $1 and product_id is not null`, [salesReturnId]);
    for (const row of lineProducts.rows) {
      const id = Number(row.product_id);
      if (Number.isFinite(id) && id > 0) affected.add(id);
    }
    await recalcStockBalances(client, companyId, Array.from(affected));
    return;
  }

  const serialCheck = await validateSalesReturnSerials(client, salesReturnId);
  if (!serialCheck.ok) {
    const err = new Error(serialCheck.error);
    err.status = 400;
    err.code = serialCheck.error;
    throw err;
  }

  const linesRes = await client.query(
    `
      select id, product_id, qty_return
      from sales_return_lines
      where sales_return_id = $1 and product_id is not null
      order by line_no asc
    `,
    [salesReturnId]
  );

  for (const line of linesRes.rows) {
    const refLineId = Number(line.id);
    const productId = Number(line.product_id);
    const q = qty(line.qty_return);
    if (!Number.isFinite(refLineId) || refLineId <= 0) continue;
    if (!Number.isFinite(productId) || productId <= 0) continue;
    if (q <= 0) continue;
    affected.add(productId);
    await client.query(
      `
        insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
        values ($1,$2,$3,$4,'SALES_RETURN',$5,$6,$7)
      `,
      [companyId, productId, q, header.return_date, salesReturnId, refLineId, header.created_by || null]
    );
  }

  await recalcStockBalances(client, companyId, Array.from(affected));
}

module.exports = {
  recalcStockBalances,
  syncStockForGoodsReceipt,
  syncStockForPurchaseReturn,
  syncStockForDispatch,
  syncStockForServiceWarrantyCase,
  syncStockForStockAdjustment,
  syncStockForJobCard,
  syncStockForStockTransfer,
  syncStockForSalesReturn,
};
