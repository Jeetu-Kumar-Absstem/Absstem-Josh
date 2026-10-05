const fs = require("fs");
const path = require("path");

const { pool } = require("../src/db/pool");

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }
  out.push(cur);
  return out;
}

function toNum(v) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function toBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}

function norm(s) {
  const v = String(s ?? "").trim();
  return v || null;
}

async function upsertCategory(client, categoryName) {
  const name = norm(categoryName) || "General";
  const r = await client.query(
    `
      insert into product_categories (category_name, is_active)
      values ($1, true)
      on conflict (category_name) do update set updated_at = now(), is_active = true
      returning id
    `,
    [name]
  );
  return r.rows[0].id;
}

async function upsertGroup(client, categoryId, groupName) {
  const name = norm(groupName) || "General";
  const r = await client.query(
    `
      insert into product_groups (category_id, group_name, is_active)
      values ($1, $2, true)
      on conflict (category_id, group_name) do update set updated_at = now(), is_active = true
      returning id
    `,
    [categoryId, name]
  );
  return r.rows[0].id;
}

async function upsertProduct(client, row) {
  const itemCode = norm(row.ItemCode) || norm(row.item_code) || norm(row.Item_Code);
  if (!itemCode) return null;

  const itemName = norm(row.ItemName) || itemCode;
  const brand = norm(row.Brand);
  const itemType = norm(row.ItemType);
  const uom = norm(row.UOM);
  const hsnNo = norm(row.HSNNO);
  const listPrice = toNum(row.ListPrice) ?? 0;
  const gst = toNum(row.GSTPer) ?? 0;
  const variance = toNum(row.VariancePer);
  const lastPurchasePrice = toNum(row.LastPurchasePrice);
  const lastPurchaseDate = norm(row.LastPurchaseDate);
  const description = norm(row.Description);
  const serialNoRequired = toBool(row.SerialNoRequired) ?? false;
  const active = toBool(row.Active);

  const categoryId = await upsertCategory(client, row.Category);
  const groupId = await upsertGroup(client, categoryId, row.Group);

  const r = await client.query(
    `
      insert into products (
        category_id, group_id, brand, item_code, item_name, item_type, uom, hsn_no,
        list_price, gst_pct, variance_pct, last_purchase_price, last_purchase_date,
        description, serial_no_required, is_active, updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
      on conflict (item_code) do update set
        category_id = excluded.category_id,
        group_id = excluded.group_id,
        brand = excluded.brand,
        item_name = excluded.item_name,
        item_type = excluded.item_type,
        uom = excluded.uom,
        hsn_no = excluded.hsn_no,
        list_price = excluded.list_price,
        gst_pct = excluded.gst_pct,
        variance_pct = excluded.variance_pct,
        last_purchase_price = excluded.last_purchase_price,
        last_purchase_date = excluded.last_purchase_date,
        description = excluded.description,
        serial_no_required = excluded.serial_no_required,
        is_active = coalesce($16, excluded.is_active),
        updated_at = now()
      returning id, item_code
    `,
    [
      categoryId,
      groupId,
      brand,
      itemCode,
      itemName,
      itemType,
      uom,
      hsnNo,
      listPrice,
      gst,
      variance,
      lastPurchasePrice,
      lastPurchaseDate,
      description,
      serialNoRequired,
      active,
    ]
  );

  return r.rows[0];
}

async function replaceAttributes(client, productId, row) {
  const attrs = [];
  for (let i = 1; i <= 20; i += 1) {
    const cap = norm(row[`Caption${i}`]);
    const val = norm(row[`Description${i}`]);
    if (!cap && !val) continue;
    attrs.push({ sort_order: i, caption: cap, spec_value: val });
  }

  await client.query(`delete from product_attributes where product_id = $1`, [productId]);

  for (const a of attrs) {
    await client.query(
      `insert into product_attributes (product_id, sort_order, caption, spec_value) values ($1,$2,$3,$4)`,
      [productId, a.sort_order, a.caption, a.spec_value]
    );
  }
}

async function importCsv(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw new Error("Empty CSV");

  const header = parseCsvLine(lines[0]).map((h) => h.replace(/^\uFEFF/, "").trim());

  const idx = new Map(header.map((h, i) => [h, i]));
  const get = (arr, key) => {
    const i = idx.get(key);
    return i === undefined ? "" : arr[i] ?? "";
  };

  const client = await pool.connect();
  try {
    await client.query("begin");

    let imported = 0;
    let skipped = 0;

    for (let r = 1; r < lines.length; r += 1) {
      const cols = parseCsvLine(lines[r]);
      const row = {};

      for (const h of header) row[h] = get(cols, h);

      const mapped = {
        Category: row.Category,
        Group: row.Group,
        Brand: row.Brand,
        ItemCode: row.ItemCode,
        ItemName: row.ItemName,
        ItemType: row.ItemType,
        UOM: row.UOM,
        HSNNO: row.HSNNO,
        ListPrice: row.ListPrice,
        GSTPer: row.GSTPer,
        VariancePer: row.VariancePer,
        LastPurchasePrice: row.LastPurchasePrice,
        LastPurchaseDate: row.LastPurchaseDate,
        Description: row.Description,
        SerialNoRequired: row.SerialNoRequired,
        Active: row.Active,
      };

      for (let i = 1; i <= 20; i += 1) {
        mapped[`Caption${i}`] = row[`Caption${i}`];
        mapped[`Description${i}`] = row[`Description${i}`];
      }

      const prod = await upsertProduct(client, mapped);
      if (!prod) {
        skipped += 1;
        continue;
      }

      await replaceAttributes(client, prod.id, mapped);
      imported += 1;
    }

    await client.query("commit");
    return { imported, skipped };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    process.stderr.write("Usage: node scripts/import_equipment_master.js <csv-path>\n");
    process.exit(1);
  }

  const abs = path.isAbsolute(fileArg) ? fileArg : path.resolve(process.cwd(), fileArg);
  const r = await importCsv(abs);
  process.stdout.write(JSON.stringify({ ok: true, file: abs, ...r }, null, 2));
  process.stdout.write("\n");
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e));
  process.stderr.write("\n");
  process.exit(1);
});

