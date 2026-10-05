async function lookupPincode(client, pincode) {
  const code = String(pincode || "").replace(/\D+/g, "").slice(0, 6);
  if (!/^\d{6}$/.test(code)) return null;
  const { rows } = await client.query(
    `
      select pincode, city_name, state_name, state_code, country_code, district
      from india_pincodes
      where pincode = $1 and is_active = true
      limit 1
    `,
    [code]
  );
  return rows[0] || null;
}

async function resolveTerritoryAgent(client, { companyId, pincode, city, state }) {
  const code = String(pincode || "").replace(/\D+/g, "").slice(0, 6);
  const cityNorm = String(city || "").trim().toLowerCase();
  const stateNorm = String(state || "").trim().toLowerCase();

  const { rows } = await client.query(
    `
      select
        t.id,
        t.name,
        t.match_type,
        t.match_value,
        t.priority,
        a.user_id
      from sales_territories t
      join sales_territory_agents a
        on a.territory_id = t.id
       and a.is_default = true
       and (a.effective_from is null or a.effective_from <= current_date)
       and (a.effective_to is null or a.effective_to >= current_date)
      where t.company_id = $1
        and t.is_active = true
      order by t.priority asc, t.id asc
    `,
    [companyId]
  );

  for (const row of rows) {
    const value = String(row.match_value || "").trim().toLowerCase();
    if (row.match_type === "pincode" && code && value === code) return row;
    if (row.match_type === "pincode_prefix" && code && code.startsWith(String(row.match_value || "").trim())) return row;
    if (row.match_type === "city" && cityNorm && value === cityNorm) return row;
    if (row.match_type === "state" && stateNorm && (value === stateNorm || value === String(row.match_value || "").trim().toLowerCase())) {
      return row;
    }
  }
  return null;
}

async function maybeAutoAssignTerritory(client, { leadId, companyId, pincode, city, state, actorId, reassign = false }) {
  const leadRes = await client.query(
    `select id, assigned_to from leads where id = $1 and company_id = $2 limit 1`,
    [leadId, companyId]
  );
  const lead = leadRes.rows[0];
  if (!lead) return null;
  if (lead.assigned_to && !reassign) return null;

  const match = await resolveTerritoryAgent(client, { companyId, pincode, city, state });
  if (!match?.user_id) return null;

  await client.query(
    `
      update leads
      set assigned_to = $2, assigned_at = coalesce(assigned_at, now()), updated_at = now()
      where id = $1
    `,
    [leadId, match.user_id]
  );
  await client.query(
    `
      insert into lead_assignments (lead_id, assigned_to, assigned_by, assignment_reason)
      values ($1,$2,$3,$4)
    `,
    [leadId, match.user_id, actorId || match.user_id, `geo_circle_default:${match.name || match.id}`]
  );
  return match;
}

module.exports = {
  lookupPincode,
  resolveTerritoryAgent,
  maybeAutoAssignTerritory,
};
