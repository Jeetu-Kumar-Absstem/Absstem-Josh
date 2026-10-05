/**
 * Legacy commercial SO numbers: S26000073 (S + FY-start-YY + 6-digit serial).
 */

async function syncLegacySoNumberSequence(client, companyId) {
  const id = Number(companyId);
  if (!Number.isFinite(id) || id <= 0) return;

  await client.query(
    `
      with fy as (
        select * from indian_financial_year_bounds(current_date)
      ),
      live_max as (
        select coalesce(
          max(
            case
              when so.so_number ~ ('^S' || left(fy.fy_key, 2) || '[0-9]{6}$')
                then right(so.so_number, 6)::int
              else 0
            end
          ),
          0
        ) as max_no
        from fy
        left join sales_orders so on so.company_id = $1
      ),
      staging_max as (
        select coalesce(
          max(
            case
              when l.so_no ~ ('^S' || left(fy.fy_key, 2) || '[0-9]{6}$')
                then right(l.so_no, 6)::int
              else 0
            end
          ),
          0
        ) as max_no
        from fy
        left join legacy_sales_orders_staging l on true
      ),
      seq as (
        select
          $1::int as company_id,
          'SO'::text as document_type,
          fy.fy_key as year_2,
          greatest(live_max.max_no, staging_max.max_no) as max_no
        from fy, live_max, staging_max
      )
      insert into document_sequences_company (company_id, document_type, year_2, current_number)
      select company_id, document_type, year_2, max_no
      from seq
      on conflict (company_id, document_type, year_2) do update
      set current_number = greatest(document_sequences_company.current_number, excluded.current_number)
    `,
    [id]
  );
}

module.exports = {
  syncLegacySoNumberSequence,
};
