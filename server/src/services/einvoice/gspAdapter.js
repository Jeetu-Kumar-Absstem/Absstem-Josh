/**
 * GSP adapter — MasterGST e-way + IRN + Part B vehicle update.
 *
 * Credentials are NEVER stored in the DB. `company_einvoice_settings.credential_env_key`
 * names an environment variable whose value is JSON:
 * {
 *   "email": "...",
 *   "client_id": "...",
 *   "client_secret": "...",
 *   "username": "...",
 *   "password": "...",
 *   "ip_address": "127.0.0.1",
 *   "mock": true   // optional — forces deterministic sandbox responses for QA
 * }
 *
 * MasterGST paths used:
 *   E-way auth:     GET  /ewaybillapi/v1.03/authenticate
 *   E-way API:      POST /ewaybillapi/v1.03/ewayapi?action=GENEWAYBILL|CANEWB|VEHEWB
 *   E-invoice auth: GET  /einvoice/authenticate
 *   IRN generate:   POST /einvoice/type/GENERATE/version/V1_03
 *   IRN cancel:     POST /einvoice/type/CANCEL/version/V1_03
 *   IRN by doc:     GET  /einvoice/type/GETIRNBYDOCDETAILS/version/V1_03
 *
 * Default sandbox base URL: https://apisandbox.mastergst.com
 * Production base URL:      https://api.mastergst.com
 */

const DEFAULT_SANDBOX_BASE = "https://apisandbox.mastergst.com";
const DEFAULT_PRODUCTION_BASE = "https://api.mastergst.com";

class EinvoiceNotConfiguredError extends Error {
  constructor(message = "E-invoice / e-way GSP integration is not configured for this company.") {
    super(message);
    this.name = "EinvoiceNotConfiguredError";
    this.code = "NOT_CONFIGURED";
    this.status = 501;
  }
}

class GspTransportError extends Error {
  constructor(message, { status = 502, code = "GSP_ERROR", details = null } = {}) {
    super(message);
    this.name = "GspTransportError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function cleanText(value) {
  return String(value ?? "").trim();
}

async function getCompanyEinvoiceSettings(client, companyId) {
  const cid = Number(companyId);
  if (!Number.isFinite(cid) || cid <= 0) return null;
  const r = await client.query(
    `select * from company_einvoice_settings where company_id = $1 limit 1`,
    [cid]
  );
  return r.rows[0] || null;
}

function resolveBaseUrl(settings) {
  const configured = cleanText(settings?.base_url);
  if (configured) return configured.replace(/\/$/, "");
  const env = cleanText(settings?.environment).toLowerCase() === "production" ? "production" : "sandbox";
  return env === "production" ? DEFAULT_PRODUCTION_BASE : DEFAULT_SANDBOX_BASE;
}

function loadCredentials(settings) {
  const key = cleanText(settings?.credential_env_key);
  if (!key) {
    throw new EinvoiceNotConfiguredError(
      "GSP credential_env_key is not set on company_einvoice_settings."
    );
  }
  const raw = process.env[key];
  if (!raw) {
    throw new EinvoiceNotConfiguredError(
      `Environment variable ${key} is not set. Add MasterGST credentials JSON there.`
    );
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch {
    throw new EinvoiceNotConfiguredError(
      `Environment variable ${key} must contain valid JSON credentials.`
    );
  }
}

function assertMastergstSettings(settings) {
  if (!settings || !settings.is_enabled) {
    throw new EinvoiceNotConfiguredError();
  }
  const provider = cleanText(settings.provider).toLowerCase();
  if (provider && provider !== "mastergst") {
    throw new EinvoiceNotConfiguredError(
      `GSP provider "${provider}" is not supported yet. Configure provider=mastergst.`
    );
  }
  if (!cleanText(settings.seller_gstin)) {
    throw new EinvoiceNotConfiguredError("seller_gstin is required on company_einvoice_settings.");
  }
}

function isMock(credentials) {
  if (credentials?.mock === true || credentials?.mock === "true") return true;
  if (cleanText(process.env.MASTERGST_MOCK).toLowerCase() === "1") return true;
  if (cleanText(process.env.MASTERGST_MOCK).toLowerCase() === "true") return true;
  return false;
}

/** In-memory token cache keyed by apiKind + company + gstin. */
const tokenCache = new Map();

function cacheKey(apiKind, companyId, gstin) {
  return `${cleanText(apiKind) || "eway"}:${Number(companyId)}:${cleanText(gstin).toUpperCase()}`;
}

async function httpJson(url, { method = "GET", headers = {}, body = null } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Authenticate against MasterGST.
 * @param {"eway"|"einvoice"} apiKind
 */
async function authenticateMastergst({ settings, credentials, force = false, apiKind = "eway" }) {
  const gstin = cleanText(settings.seller_gstin);
  const companyId = Number(settings.company_id);
  const kind = apiKind === "einvoice" ? "einvoice" : "eway";
  const key = cacheKey(kind, companyId, gstin);
  const cached = tokenCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  if (isMock(credentials)) {
    const token = `MOCK-${kind.toUpperCase()}-${gstin || "GSTIN"}`;
    tokenCache.set(key, { token, expiresAt: Date.now() + 5 * 60 * 60 * 1000 });
    return token;
  }

  const email = cleanText(credentials.email);
  const base = resolveBaseUrl(settings);
  const authPath =
    kind === "einvoice" ? "/einvoice/authenticate" : "/ewaybillapi/v1.03/authenticate";
  const url = `${base}${authPath}?email=${encodeURIComponent(email)}`;
  const { ok, status, data } = await httpJson(url, {
    method: "GET",
    headers: {
      username: cleanText(credentials.username),
      password: cleanText(credentials.password),
      ip_address: cleanText(credentials.ip_address) || "127.0.0.1",
      client_id: cleanText(credentials.client_id),
      client_secret: cleanText(credentials.client_secret),
      gstin,
    },
  });

  const token =
    cleanText(data?.data?.AuthToken) ||
    cleanText(data?.data?.authtoken) ||
    cleanText(data?.AuthToken) ||
    cleanText(data?.authtoken);

  if (!ok || !token) {
    throw new GspTransportError(`MasterGST ${kind} authentication failed.`, {
      status: status >= 400 ? status : 502,
      code: "GSP_AUTH_FAILED",
      details: data,
    });
  }

  tokenCache.set(key, { token, expiresAt: Date.now() + 5 * 60 * 60 * 1000 });
  return token;
}

function mastergstHeaders({ credentials, settings, token }) {
  return {
    username: cleanText(credentials.username),
    password: cleanText(credentials.password),
    ip_address: cleanText(credentials.ip_address) || "127.0.0.1",
    client_id: cleanText(credentials.client_id),
    client_secret: cleanText(credentials.client_secret),
    gstin: cleanText(settings.seller_gstin),
    authtoken: token,
  };
}

function parseEwaySuccess(data) {
  const body = data?.data || data || {};
  const ewayBillNo =
    cleanText(body.ewayBillNo) ||
    cleanText(body.EwbNo) ||
    cleanText(body.ewbNo) ||
    cleanText(body.ewaybillNo);
  const ewayBillDate =
    cleanText(body.ewayBillDate) ||
    cleanText(body.EwbDt) ||
    cleanText(body.ewbDate) ||
    null;
  const validTill =
    cleanText(body.validUpto) ||
    cleanText(body.ValidUpto) ||
    cleanText(body.validTill) ||
    null;
  return { ewayBillNo, ewayBillDate, validTill, raw: data };
}

function mockGenerateResponse({ mode, payload }) {
  const now = new Date();
  const valid = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const ewayBillNo = "9910" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  return {
    status_cd: "1",
    data: {
      ewayBillNo,
      ewayBillDate: now.toISOString(),
      validUpto: valid.toISOString(),
      mode,
      mock: true,
      requestEcho: payload,
    },
  };
}

function mockCancelResponse({ ewayBillNo }) {
  return {
    status_cd: "1",
    data: {
      ewayBillNo,
      cancelDate: new Date().toISOString(),
      mock: true,
    },
  };
}

function parseIrnSuccess(data) {
  const body = data?.data || data || {};
  const irn = cleanText(body.Irn) || cleanText(body.irn);
  const ackNo = cleanText(body.AckNo) || cleanText(body.ackNo) || cleanText(body.Ack_No);
  const ackDate = cleanText(body.AckDt) || cleanText(body.ackDt) || cleanText(body.AckDate) || null;
  const signedQr = cleanText(body.SignedQRCode) || cleanText(body.signedQRCode) || cleanText(body.SignedQrCode);
  const signedPayload = cleanText(body.SignedInvoice) || cleanText(body.signedInvoice);
  const ewayBillNo =
    cleanText(body.EwbNo) || cleanText(body.ewayBillNo) || cleanText(body.ewbNo) || null;
  const ewayBillDate =
    cleanText(body.EwbDt) || cleanText(body.ewayBillDate) || cleanText(body.ewbDate) || null;
  const ewayValidTill =
    cleanText(body.EwbValidTill) || cleanText(body.validUpto) || cleanText(body.validTill) || null;
  return {
    irn,
    ackNo,
    ackDate,
    signedQr,
    signedPayload,
    ewayBillNo,
    ewayBillDate,
    ewayValidTill,
    raw: data,
  };
}

function mockIrnGenerateResponse({ payload }) {
  const now = new Date();
  const irn = Array.from({ length: 64 }, (_, i) => ((i * 7 + 3) % 16).toString(16)).join("");
  return {
    status_cd: "1",
    data: {
      Irn: irn,
      AckNo: String(910000000000 + Math.floor(Math.random() * 1e6)),
      AckDt: now.toISOString().replace("T", " ").slice(0, 19),
      SignedQRCode: `MOCK-SIGNED-QR:${irn.slice(0, 16)}`,
      SignedInvoice: `MOCK-SIGNED-INV:${irn.slice(0, 16)}`,
      Status: "ACT",
      mock: true,
      requestEcho: payload ? { DocDtls: payload.DocDtls || null } : null,
    },
  };
}

function mockIrnCancelResponse({ irn }) {
  return {
    status_cd: "1",
    data: {
      Irn: irn,
      CancelDate: new Date().toISOString(),
      mock: true,
    },
  };
}

function mockVehicleUpdateResponse({ ewayBillNo }) {
  const valid = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return {
    status_cd: "1",
    data: {
      ewayBillNo,
      vehUpdDate: new Date().toISOString(),
      validUpto: valid.toISOString(),
      mock: true,
    },
  };
}

async function withConfiguredContext(client, companyId) {
  const settings = await getCompanyEinvoiceSettings(client, companyId);
  assertMastergstSettings(settings);
  const credentials = loadCredentials(settings);
  return { settings, credentials, baseUrl: resolveBaseUrl(settings) };
}

/**
 * Generate an e-way bill via MasterGST.
 * @returns {{ ewayBillNo, ewayBillDate, validTill, mode, raw }}
 */
async function generateEwayBill(client, { companyId, mode, payload } = {}) {
  const { settings, credentials, baseUrl } = await withConfiguredContext(client, companyId);
  if (!payload || typeof payload !== "object") {
    throw new GspTransportError("E-way payload is required.", { status: 400, code: "EWAY_PAYLOAD_REQUIRED" });
  }

  if (isMock(credentials)) {
    const data = mockGenerateResponse({ mode, payload });
    const parsed = parseEwaySuccess(data);
    if (!parsed.ewayBillNo) {
      throw new GspTransportError("Mock GSP did not return an e-way bill number.", { code: "GSP_BAD_RESPONSE" });
    }
    return { ...parsed, mode: mode || "mock", provider: "mastergst", mocked: true, raw: data };
  }

  const token = await authenticateMastergst({ settings, credentials, apiKind: "eway" });
  const email = encodeURIComponent(cleanText(credentials.email));
  const url = `${baseUrl}/ewaybillapi/v1.03/ewayapi?action=GENEWAYBILL&email=${email}`;
  const { ok, status, data } = await httpJson(url, {
    method: "POST",
    headers: mastergstHeaders({ credentials, settings, token }),
    body: payload,
  });

  const statusCd = cleanText(data?.status_cd || data?.status);
  const parsed = parseEwaySuccess(data);
  if (!ok || statusCd === "0" || !parsed.ewayBillNo) {
    throw new GspTransportError(
      cleanText(data?.error?.message) ||
        cleanText(data?.status_desc) ||
        cleanText(data?.message) ||
        "MasterGST e-way generate failed.",
      { status: status >= 400 ? status : 502, code: "GSP_EWAY_GENERATE_FAILED", details: data }
    );
  }

  return { ...parsed, mode: mode || "full", provider: "mastergst", mocked: false, raw: data };
}

/**
 * Cancel an e-way bill via MasterGST.
 */
async function cancelEwayBill(client, { companyId, payload } = {}) {
  const { settings, credentials, baseUrl } = await withConfiguredContext(client, companyId);
  if (!payload || typeof payload !== "object") {
    throw new GspTransportError("E-way cancel payload is required.", { status: 400, code: "EWAY_CANCEL_PAYLOAD_REQUIRED" });
  }

  const ewayBillNo = cleanText(payload.ewbNo || payload.ewayBillNo);
  if (isMock(credentials)) {
    const data = mockCancelResponse({ ewayBillNo });
    return { ewayBillNo, cancelledAt: new Date().toISOString(), provider: "mastergst", mocked: true, raw: data };
  }

  const token = await authenticateMastergst({ settings, credentials, apiKind: "eway" });
  const email = encodeURIComponent(cleanText(credentials.email));
  const url = `${baseUrl}/ewaybillapi/v1.03/ewayapi?action=CANEWB&email=${email}`;
  const { ok, status, data } = await httpJson(url, {
    method: "POST",
    headers: mastergstHeaders({ credentials, settings, token }),
    body: payload,
  });

  const statusCd = cleanText(data?.status_cd || data?.status);
  if (!ok || statusCd === "0") {
    throw new GspTransportError(
      cleanText(data?.error?.message) ||
        cleanText(data?.status_desc) ||
        cleanText(data?.message) ||
        "MasterGST e-way cancel failed.",
      { status: status >= 400 ? status : 502, code: "GSP_EWAY_CANCEL_FAILED", details: data }
    );
  }

  return {
    ewayBillNo,
    cancelledAt: cleanText(data?.data?.cancelDate) || new Date().toISOString(),
    provider: "mastergst",
    mocked: false,
    raw: data,
  };
}

/**
 * Part B vehicle update (VEHEWB) after truck change post-EBN.
 */
async function updateEwayVehicle(client, { companyId, payload } = {}) {
  const { settings, credentials, baseUrl } = await withConfiguredContext(client, companyId);
  if (!payload || typeof payload !== "object") {
    throw new GspTransportError("Vehicle update payload is required.", {
      status: 400,
      code: "EWAY_VEHICLE_PAYLOAD_REQUIRED",
    });
  }

  const ewayBillNo = cleanText(payload.ewbNo || payload.ewayBillNo);
  if (!ewayBillNo) {
    throw new GspTransportError("ewayBillNo is required for vehicle update.", {
      status: 400,
      code: "EWAY_NO_REQUIRED",
    });
  }

  if (isMock(credentials)) {
    const data = mockVehicleUpdateResponse({ ewayBillNo });
    const parsed = parseEwaySuccess(data);
    return {
      ewayBillNo,
      validTill: parsed.validTill,
      vehicleUpdatedAt: cleanText(data?.data?.vehUpdDate) || new Date().toISOString(),
      provider: "mastergst",
      mocked: true,
      raw: data,
    };
  }

  const token = await authenticateMastergst({ settings, credentials, apiKind: "eway" });
  const email = encodeURIComponent(cleanText(credentials.email));
  const url = `${baseUrl}/ewaybillapi/v1.03/ewayapi?action=VEHEWB&email=${email}`;
  const { ok, status, data } = await httpJson(url, {
    method: "POST",
    headers: mastergstHeaders({ credentials, settings, token }),
    body: payload,
  });

  const statusCd = cleanText(data?.status_cd || data?.status);
  const parsed = parseEwaySuccess(data);
  if (!ok || statusCd === "0") {
    throw new GspTransportError(
      cleanText(data?.error?.message) ||
        cleanText(data?.status_desc) ||
        cleanText(data?.message) ||
        "MasterGST vehicle update failed.",
      { status: status >= 400 ? status : 502, code: "GSP_EWAY_VEHICLE_UPDATE_FAILED", details: data }
    );
  }

  return {
    ewayBillNo,
    validTill: parsed.validTill,
    vehicleUpdatedAt: cleanText(data?.data?.vehUpdDate) || new Date().toISOString(),
    provider: "mastergst",
    mocked: false,
    raw: data,
  };
}

/**
 * Generate IRN via MasterGST e-invoice API.
 * @returns {{ irn, ackNo, ackDate, signedQr, signedPayload, ewayBillNo?, ... }}
 */
async function generateIrn(client, { companyId, payload } = {}) {
  const { settings, credentials, baseUrl } = await withConfiguredContext(client, companyId);
  if (!payload || typeof payload !== "object") {
    throw new GspTransportError("E-invoice payload is required.", { status: 400, code: "IRN_PAYLOAD_REQUIRED" });
  }

  if (isMock(credentials)) {
    const data = mockIrnGenerateResponse({ payload });
    const parsed = parseIrnSuccess(data);
    if (!parsed.irn) {
      throw new GspTransportError("Mock GSP did not return an IRN.", { code: "GSP_BAD_RESPONSE" });
    }
    return { ...parsed, provider: "mastergst", mocked: true, raw: data };
  }

  const token = await authenticateMastergst({ settings, credentials, apiKind: "einvoice" });
  const email = encodeURIComponent(cleanText(credentials.email));
  const url = `${baseUrl}/einvoice/type/GENERATE/version/V1_03?email=${email}`;
  const { ok, status, data } = await httpJson(url, {
    method: "POST",
    headers: mastergstHeaders({ credentials, settings, token }),
    body: payload,
  });

  const statusCd = cleanText(data?.status_cd || data?.status);
  const parsed = parseIrnSuccess(data);
  if (!ok || statusCd === "0" || !parsed.irn) {
    throw new GspTransportError(
      cleanText(data?.error?.message) ||
        cleanText(data?.status_desc) ||
        cleanText(data?.message) ||
        "MasterGST IRN generate failed.",
      { status: status >= 400 ? status : 502, code: "GSP_IRN_GENERATE_FAILED", details: data }
    );
  }

  return { ...parsed, provider: "mastergst", mocked: false, raw: data };
}

/**
 * Cancel IRN via MasterGST. Does not touch e-way fields — caller must use clearIrnMetadata only.
 */
async function cancelIrn(client, { companyId, payload } = {}) {
  const { settings, credentials, baseUrl } = await withConfiguredContext(client, companyId);
  if (!payload || typeof payload !== "object") {
    throw new GspTransportError("IRN cancel payload is required.", { status: 400, code: "IRN_CANCEL_PAYLOAD_REQUIRED" });
  }

  const irn = cleanText(payload.Irn || payload.irn);
  if (!irn) {
    throw new GspTransportError("IRN is required to cancel.", { status: 400, code: "IRN_REQUIRED" });
  }

  if (isMock(credentials)) {
    const data = mockIrnCancelResponse({ irn });
    return { irn, cancelledAt: new Date().toISOString(), provider: "mastergst", mocked: true, raw: data };
  }

  const token = await authenticateMastergst({ settings, credentials, apiKind: "einvoice" });
  const email = encodeURIComponent(cleanText(credentials.email));
  const url = `${baseUrl}/einvoice/type/CANCEL/version/V1_03?email=${email}`;
  const body = {
    Irn: irn,
    CnlRsn: cleanText(payload.CnlRsn || payload.cancel_reason_code || "1") || "1",
    CnlRem: cleanText(payload.CnlRem || payload.remark || "Cancelled from Josh ERP").slice(0, 100) || "Cancelled",
  };
  const { ok, status, data } = await httpJson(url, {
    method: "POST",
    headers: mastergstHeaders({ credentials, settings, token }),
    body,
  });

  const statusCd = cleanText(data?.status_cd || data?.status);
  if (!ok || statusCd === "0") {
    throw new GspTransportError(
      cleanText(data?.error?.message) ||
        cleanText(data?.status_desc) ||
        cleanText(data?.message) ||
        "MasterGST IRN cancel failed.",
      { status: status >= 400 ? status : 502, code: "GSP_IRN_CANCEL_FAILED", details: data }
    );
  }

  return {
    irn,
    cancelledAt: cleanText(data?.data?.CancelDate) || new Date().toISOString(),
    provider: "mastergst",
    mocked: false,
    raw: data,
  };
}

/**
 * Fetch IRN details by document number/date (MasterGST GETIRNBYDOCDETAILS).
 */
async function getIrnByDocNumber(client, { companyId, docNo, docType = "INV", docDate } = {}) {
  const { settings, credentials, baseUrl } = await withConfiguredContext(client, companyId);
  const number = cleanText(docNo);
  if (!number) {
    throw new GspTransportError("docNo is required.", { status: 400, code: "DOC_NO_REQUIRED" });
  }

  if (isMock(credentials)) {
    const data = mockIrnGenerateResponse({ payload: { DocDtls: { No: number, Typ: docType, Dt: docDate } } });
    const parsed = parseIrnSuccess(data);
    return { ...parsed, provider: "mastergst", mocked: true, raw: data };
  }

  const token = await authenticateMastergst({ settings, credentials, apiKind: "einvoice" });
  const email = encodeURIComponent(cleanText(credentials.email));
  const qs = new URLSearchParams({
    email: cleanText(credentials.email),
    docnum: number,
    doctype: cleanText(docType) || "INV",
    docdate: cleanText(docDate) || "",
  });
  const url = `${baseUrl}/einvoice/type/GETIRNBYDOCDETAILS/version/V1_03?${qs.toString()}`;
  const { ok, status, data } = await httpJson(url, {
    method: "GET",
    headers: mastergstHeaders({ credentials, settings, token }),
  });

  const statusCd = cleanText(data?.status_cd || data?.status);
  const parsed = parseIrnSuccess(data);
  if (!ok || statusCd === "0" || !parsed.irn) {
    throw new GspTransportError(
      cleanText(data?.error?.message) ||
        cleanText(data?.status_desc) ||
        cleanText(data?.message) ||
        "MasterGST get IRN by doc failed.",
      { status: status >= 400 ? status : 502, code: "GSP_IRN_GET_FAILED", details: data }
    );
  }

  return { ...parsed, provider: "mastergst", mocked: false, raw: data };
}

module.exports = {
  EinvoiceNotConfiguredError,
  GspTransportError,
  DEFAULT_SANDBOX_BASE,
  DEFAULT_PRODUCTION_BASE,
  getCompanyEinvoiceSettings,
  loadCredentials,
  resolveBaseUrl,
  authenticateMastergst,
  generateEwayBill,
  cancelEwayBill,
  updateEwayVehicle,
  generateIrn,
  cancelIrn,
  getIrnByDocNumber,
  // test helpers
  _tokenCache: tokenCache,
  parseEwaySuccess,
  parseIrnSuccess,
};
