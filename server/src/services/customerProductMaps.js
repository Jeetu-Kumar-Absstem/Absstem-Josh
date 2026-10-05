async function lookupCustomerProductMap(client, { companyId, customerId, productId }) {
  const company = Number(companyId);
  const customer = Number(customerId);
  const product = Number(productId);
  if (!Number.isFinite(company) || company <= 0) return null;
  if (!Number.isFinite(customer) || customer <= 0) return null;
  if (!Number.isFinite(product) || product <= 0) return null;
  const r = await client.query(
    `
      select
        id,
        company_id,
        customer_id,
        product_id,
        customer_item_code,
        customer_item_description,
        customer_uom,
        is_active
      from customer_product_maps
      where company_id = $1
        and customer_id = $2
        and product_id = $3
        and is_active = true
      limit 1
    `,
    [company, customer, product]
  );
  return r.rows[0] || null;
}

async function resolveCustomerItemFields(client, { companyId, customerId, productId, customerItemCode, customerItemDescription }) {
  const explicitCode = String(customerItemCode || "").trim();
  const explicitDesc = String(customerItemDescription || "").trim();
  if (explicitCode || explicitDesc) {
    return {
      customer_item_code: explicitCode || null,
      customer_item_description: explicitDesc || null,
    };
  }
  const mapped = await lookupCustomerProductMap(client, { companyId, customerId, productId });
  if (!mapped) {
    return { customer_item_code: null, customer_item_description: null };
  }
  return {
    customer_item_code: String(mapped.customer_item_code || "").trim() || null,
    customer_item_description: String(mapped.customer_item_description || "").trim() || null,
  };
}

function normalizeCustomerPoFields(body = {}, fallback = {}) {
  const number =
    String(body.customer_po_number ?? body.buyer_po_number ?? fallback.customer_po_number ?? fallback.buyer_po_number ?? "").trim() ||
    null;
  const rawDate = body.customer_po_date ?? body.buyer_po_date ?? fallback.customer_po_date ?? fallback.buyer_po_date ?? null;
  let date = null;
  if (rawDate) {
    const text = String(rawDate).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) date = text.slice(0, 10);
  }
  return { customer_po_number: number, customer_po_date: date };
}

module.exports = {
  lookupCustomerProductMap,
  resolveCustomerItemFields,
  normalizeCustomerPoFields,
};
