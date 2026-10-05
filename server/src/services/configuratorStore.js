const fs = require("fs");
const path = require("path");

const DATASET_KEYS = ["nitrogen", "oxygen", "compressor"];

function normalizeJsonText(text) {
  const str = String(text || "");
  if (str.charCodeAt(0) === 0xfeff) return str.slice(1).trim();
  return str.trim();
}

function removeTrailingCommas(text) {
  return String(text || "").replace(/,\s*([}\]])/g, "$1");
}

function parseDatasetJson(raw) {
  const normalized = normalizeJsonText(raw);
  try {
    return JSON.parse(normalized);
  } catch (err) {
    try {
      return JSON.parse(removeTrailingCommas(normalized));
    } catch (_err2) {
      const e = new Error("INVALID_JSON");
      e.code = "INVALID_JSON";
      throw e;
    }
  }
}

function ensureDatasetKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  if (!DATASET_KEYS.includes(normalized)) {
    const err = new Error("INVALID_DATASET");
    err.status = 400;
    throw err;
  }
  return normalized;
}

function getStorageBase() {
  return path.resolve(__dirname, "..", "..", "storage", "configurator");
}

function readJsonIfExists(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  const raw = fs.readFileSync(absPath, "utf8");
  try {
    return parseDatasetJson(raw);
  } catch (err) {
    if (err?.code === "INVALID_JSON") {
      const e = new Error("INVALID_JSON");
      e.code = "INVALID_JSON";
      e.file_name = path.basename(absPath);
      throw e;
    }
    throw err;
  }
}

function getFileCandidates(key) {
  const base = getStorageBase();
  const normalized = ensureDatasetKey(key);

  const mapping = {
    nitrogen: ["nitrogen_data.json", "_MConverter.eu_Nitrogen Data.json", "Nitrogen Data.json", "Nitrogen Data.txt"],
    oxygen: ["oxygen_data.json", "_MConverter.eu_Oxygen Data.json", "Oxygen Data.json", "Oxygen Data.txt"],
    compressor: ["compressor_data.json", "_MConverter.eu_Compressor Data.json", "Compressor Data.json", "Compressor Data.txt"],
  };

  return (mapping[normalized] || []).map((name) => path.join(base, name));
}

function loadDatasetFromFiles(key) {
  const normalized = ensureDatasetKey(key);
  const candidates = getFileCandidates(normalized);

  for (const absPath of candidates) {
    const json = readJsonIfExists(absPath);
    if (Array.isArray(json)) return { rows: json, file_name: path.basename(absPath) };
  }

  return { rows: [], file_name: null };
}

async function ensureDatasetRow(client, datasetKey) {
  const key = ensureDatasetKey(datasetKey);
  const datasetName =
    key === "nitrogen" ? "Nitrogen PSA" : key === "oxygen" ? "Oxygen PSA" : "Air Compressor";

  const upsertRes = await client.query(
    `
      insert into configurator_datasets (dataset_key, dataset_name, is_active, updated_at)
      values ($1, $2, true, now())
      on conflict (dataset_key) do update set
        dataset_name = excluded.dataset_name,
        updated_at = now()
      returning id, current_version_id
    `,
    [key, datasetName]
  );

  return upsertRes.rows[0];
}

async function getDatasetStatus(client) {
  const res = await client.query(
    `
      select
        d.dataset_key,
        d.dataset_name,
        d.current_version_id,
        v.version_no as current_version_no,
        v.file_name as current_file_name,
        v.row_count as current_row_count,
        v.created_at as current_created_at
      from configurator_datasets d
      left join configurator_dataset_versions v on v.id = d.current_version_id
      where d.is_active = true
      order by d.dataset_key asc
    `
  );
  return res.rows;
}

async function getDatasetRows(client, datasetKey) {
  const key = ensureDatasetKey(datasetKey);
  const res = await client.query(
    `
      select v.content_json
      from configurator_datasets d
      join configurator_dataset_versions v on v.id = d.current_version_id
      where d.dataset_key = $1 and d.is_active = true
      limit 1
    `,
    [key]
  );
  const content = res.rows[0]?.content_json;
  return Array.isArray(content) ? content : [];
}

function requiredFieldsFor(key) {
  const normalized = ensureDatasetKey(key);
  if (normalized === "compressor") {
    return ["CompressorModel", "KW", "AIRFLOW"];
  }
  return ["Purity", "Flow", "AirRequirement", "StorageVolume", "AirVesselVolume", "Model"];
}

function validateDatasetRows(key, rows) {
  const required = requiredFieldsFor(key);
  const issues = [];
  if (!Array.isArray(rows) || !rows.length) {
    issues.push("EMPTY_DATASET");
    return { ok: false, issues, required_fields: required };
  }

  const sample = rows.slice(0, 5);
  for (let i = 0; i < sample.length; i += 1) {
    const row = sample[i];
    for (const field of required) {
      if (row?.[field] === undefined || row?.[field] === null || String(row[field]).trim() === "") {
        issues.push(`MISSING_${field}`);
      }
    }
  }

  return { ok: issues.length === 0, issues: Array.from(new Set(issues)), required_fields: required };
}

function buildPreview(key, rows) {
  const normalized = ensureDatasetKey(key);
  const required = requiredFieldsFor(normalized);
  const sample = Array.isArray(rows) ? rows.slice(0, 8) : [];
  const columns = Array.from(
    new Set(
      sample
        .flatMap((r) => Object.keys(r || {}))
        .filter(Boolean)
    )
  ).slice(0, 20);

  return {
    dataset_key: normalized,
    row_count: Array.isArray(rows) ? rows.length : 0,
    required_fields: required,
    sample_rows: sample,
    sample_columns: columns,
  };
}

async function applyDatasetVersion(client, datasetKey, { rows, fileName, actorUserId }) {
  const key = ensureDatasetKey(datasetKey);
  const dataset = await ensureDatasetRow(client, key);

  const versionRes = await client.query(
    `select coalesce(max(version_no), 0)::int as max_version from configurator_dataset_versions where dataset_id = $1`,
    [dataset.id]
  );
  const nextVersion = Number(versionRes.rows[0]?.max_version || 0) + 1;

  const insertRes = await client.query(
    `
      insert into configurator_dataset_versions (dataset_id, version_no, file_name, row_count, content_json, created_by)
      values ($1, $2, $3, $4, $5, $6)
      returning id
    `,
    [dataset.id, nextVersion, fileName || null, Array.isArray(rows) ? rows.length : 0, JSON.stringify(rows || []), actorUserId || null]
  );

  const versionId = insertRes.rows[0].id;
  await client.query(`update configurator_datasets set current_version_id = $2, updated_at = now() where id = $1`, [
    dataset.id,
    versionId,
  ]);

  return { dataset_id: dataset.id, version_id: versionId, version_no: nextVersion };
}

module.exports = {
  DATASET_KEYS,
  applyDatasetVersion,
  buildPreview,
  ensureDatasetKey,
  getDatasetRows,
  getDatasetStatus,
  loadDatasetFromFiles,
  parseDatasetJson,
  validateDatasetRows,
};
