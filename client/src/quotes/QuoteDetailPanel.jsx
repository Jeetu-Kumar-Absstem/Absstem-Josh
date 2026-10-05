import { useEffect, useMemo, useState } from "react";
import { PressFitLinker, toast } from "../shared/joshUi";
import BlockerRibbon from "../shared/BlockerRibbon";
import {
  EMPTY_APPROVAL,
  EMPTY_MAIL_BOOTSTRAP,
  apiFetch,
  formatAmount,
  formatScopeLabel,
  getApiErrorMessage,
  getCustomerInitials,
  getPriceListMultiplier,
  looksLikeHtml,
  normalizePriceTypes,
  resolvePriceTypeKey,
  runQuietly,
  statusColor,
  statusTone,
  validateDraftLines,
} from "./quoteShared";

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 11,
          opacity: 0.58,
          marginBottom: 6,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function CustomerChip({ label, tone = "#eef4ff", color = "#2354d5", borderColor = "rgba(35,84,213,0.14)" }) {
  if (!label) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderRadius: 999,
        background: tone,
        color,
        border: `1px solid ${borderColor}`,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.01em",
      }}
    >
      {label}
    </span>
  );
}

function CustomerStatCard({ label, value, accent = "#2354d5" }) {
  const isAffirmative = String(value).toLowerCase() === "yes";
  return (
    <div
      style={{
        border: "1px solid rgba(152,174,219,0.28)",
        borderRadius: 14,
        padding: 12,
        background: "linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(245,248,255,0.94) 100%)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.82)",
        transition: "transform 160ms ease, box-shadow 160ms ease",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ marginTop: 8, fontSize: 20, fontWeight: 800, color: accent }}>{value}</div>
      {label === "Mail Ready" ? (
        <div style={{ marginTop: 6, fontSize: 11, opacity: 0.64 }}>{isAffirmative ? "Recipient flow looks ready" : "Recipient email still needed"}</div>
      ) : null}
    </div>
  );
}

function CustomerResultCard({ customer, active, onClick, helperText }) {
  const initials = getCustomerInitials(customer?.customer_name);
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        all: "unset",
        cursor: "pointer",
        border: active ? "1px solid #2354d5" : hovered ? "1px solid rgba(94,133,225,0.7)" : "1px solid rgba(214,224,244,0.92)",
        background: active
          ? "linear-gradient(135deg, rgba(235,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
        borderRadius: 18,
        padding: 16,
        display: "block",
        boxShadow: active ? "0 18px 36px rgba(35,84,213,0.16)" : hovered ? "0 18px 32px rgba(61,88,142,0.1)" : "0 10px 24px rgba(31,41,55,0.05)",
        transform: hovered && !active ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", gap: 14, alignItems: "start" }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 14,
            display: "grid",
            placeItems: "center",
            background: active ? "linear-gradient(135deg, #2354d5 0%, #6f93ff 100%)" : "linear-gradient(135deg, #e9f0ff 0%, #f6f9ff 100%)",
            color: active ? "#fff" : "#1a3f8a",
            fontWeight: 800,
            letterSpacing: "0.06em",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4)",
          }}
        >
          {initials}
        </div>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 800, fontSize: 15, lineHeight: 1.35 }}>{customer?.customer_name}</div>
            {active ? <CustomerChip label="Selected" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" /> : null}
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <CustomerChip label={customer?.customer_code || "No code"} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" />
            {(customer?.city || customer?.state) ? (
              <CustomerChip
                label={[customer?.city, customer?.state].filter(Boolean).join(", ")}
                tone="#f7f9fd"
                color="#46536b"
                borderColor="rgba(70,83,107,0.12)"
              />
            ) : null}
            {customer?.gstin ? <CustomerChip label={customer.gstin} tone="#f3fbf5" color="#1a7f47" borderColor="rgba(26,127,71,0.14)" /> : null}
          </div>
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.76, lineHeight: 1.7 }}>
            {[customer?.primary_contact_name, customer?.primary_contact_designation, customer?.address_line1].filter(Boolean).join(" • ") ||
              helperText ||
              "Customer exists in master. Click to use it for this quote."}
          </div>
        </div>
        <div
          style={{
            minWidth: 200,
            border: "1px solid rgba(219,228,244,0.9)",
            borderRadius: 14,
            padding: "10px 12px",
            background: "rgba(255,255,255,0.82)",
            fontSize: 12,
            lineHeight: 1.8,
            textAlign: "right",
            color: "#56657f",
          }}
        >
          <div>{customer?.primary_contact_phone || customer?.phone || "No phone"}</div>
          <div>{customer?.primary_contact_email || customer?.email || "No email"}</div>
          <div>{customer?.gstin || "No GST yet"}</div>
        </div>
      </div>
    </button>
  );
}

function DeliveryCheckCard({ label, value, note, tone = "neutral" }) {
  const appearance = {
    success: {
      color: "#0b6b38",
      borderColor: "rgba(11,107,56,0.16)",
      background: "linear-gradient(180deg, rgba(244,252,247,0.98) 0%, rgba(255,255,255,0.98) 100%)",
    },
    warning: {
      color: "#8a5a00",
      borderColor: "rgba(138,90,0,0.16)",
      background: "linear-gradient(180deg, rgba(255,249,239,0.98) 0%, rgba(255,255,255,0.98) 100%)",
    },
    danger: {
      color: "#b4234d",
      borderColor: "rgba(180,35,77,0.16)",
      background: "linear-gradient(180deg, rgba(254,244,247,0.98) 0%, rgba(255,255,255,0.98) 100%)",
    },
    neutral: {
      color: "#2354d5",
      borderColor: "rgba(35,84,213,0.14)",
      background: "linear-gradient(180deg, rgba(239,245,255,0.98) 0%, rgba(255,255,255,0.98) 100%)",
    },
  }[tone] || {
    color: "#2354d5",
    borderColor: "rgba(35,84,213,0.14)",
    background: "linear-gradient(180deg, rgba(239,245,255,0.98) 0%, rgba(255,255,255,0.98) 100%)",
  };

  return (
    <div
      style={{
        border: `1px solid ${appearance.borderColor}`,
        borderRadius: 14,
        padding: 12,
        background: appearance.background,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.62, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 14, fontWeight: 800, color: appearance.color }}>{value}</div>
      {note ? <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.6 }}>{note}</div> : null}
    </div>
  );
}

export default function QuoteDetail({
  id,
  onBack,
  onOpenBuilder,
  onOpenSalesOrder,
  onOpenLead,
  onOpenProforma,
  onQuoteChanged,
  me,
  mailConnectStatus,
  mailConnectReason,
  embedded = false,
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [quote, setQuote] = useState(null);
  const [revision, setRevision] = useState(null);
  const [lines, setLines] = useState([]);
  const [salesOrderId, setSalesOrderId] = useState(null);
  const [salesOrder, setSalesOrder] = useState(null);
  const [pdfMeta, setPdfMeta] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draftLines, setDraftLines] = useState([]);
  const [saving, setSaving] = useState(false);
  const [termsLoading, setTermsLoading] = useState(false);
  const [termsSaving, setTermsSaving] = useState(false);
  const [terms, setTerms] = useState([]);
  const [nitroPurity, setNitroPurity] = useState("99.99");
  const [nitroFlow, setNitroFlow] = useState("");
  const [nitroRec, setNitroRec] = useState(null);
  const [nitroModel, setNitroModel] = useState("");
  const [nitroWorking, setNitroWorking] = useState(false);
  const [nitroPurities, setNitroPurities] = useState(["99.99", "99.995", "99.999"]);
  const [oxygenPurity, setOxygenPurity] = useState("95");
  const [oxygenFlow, setOxygenFlow] = useState("");
  const [oxygenRec, setOxygenRec] = useState(null);
  const [oxygenModel, setOxygenModel] = useState("");
  const [oxygenWorking, setOxygenWorking] = useState(false);
  const [productCategories, setProductCategories] = useState([]);
  const [productGroups, setProductGroups] = useState([]);
  const [addCategoryId, setAddCategoryId] = useState("");
  const [addGroupId, setAddGroupId] = useState("");
  const [addProductQ, setAddProductQ] = useState("");
  const [addProductResults, setAddProductResults] = useState([]);
  const [addSelectedProduct, setAddSelectedProduct] = useState(null);
  const [addPriceList, setAddPriceList] = useState("list");
  const [addQty, setAddQty] = useState("1");
  const [addGrossUnit, setAddGrossUnit] = useState("");
  const [addDiscPct, setAddDiscPct] = useState("");
  const [addDiscAmt, setAddDiscAmt] = useState("");
  const [addRemarks, setAddRemarks] = useState("");
  const [quoteBootstrap, setQuoteBootstrap] = useState({
    pricing_modes: [],
    allow_manual_line_entry: false,
    require_catalog_products_for_lines: true,
    allow_distributor_external_items: false,
    distributor_item_sourcing_mode: "",
    price_types: [],
    currencies: [],
    incoterms: [],
    payment_terms: [],
    freight_terms: [],
    quote_closure_reasons: [],
  });
  const priceTypeOptions = normalizePriceTypes(quoteBootstrap.price_types);
  const [commercialForm, setCommercialForm] = useState({
    attention_to: "",
    pricing_display_mode: "detailed",
    is_export: false,
    incoterm_id: "",
    base_currency_id: "",
    quote_currency_id: "",
    payment_term_id: "",
    freight_term_id: "",
    delivery_lead_time_days: "",
    warranty_months: "",
  });
  const [commercialSaving, setCommercialSaving] = useState(false);
  const [mailBootstrap, setMailBootstrap] = useState(EMPTY_MAIL_BOOTSTRAP);
  const [mailForm, setMailForm] = useState({
    to: "",
    cc: "",
    bcc: "",
    preset_key: "",
    subject: "",
    body: "",
    clubbed: false,
  });
  const [mailLoading, setMailLoading] = useState(false);
  const [mailSending, setMailSending] = useState(false);
  const [mailNotice, setMailNotice] = useState("");
  const [showMailComposer, setShowMailComposer] = useState(false);
  const [showMailSetup, setShowMailSetup] = useState(false);
  const [showMailHistory, setShowMailHistory] = useState(false);
  const [approval, setApproval] = useState(EMPTY_APPROVAL);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [showApprovalHistory, setShowApprovalHistory] = useState(false);
  const [creatingSalesOrder, setCreatingSalesOrder] = useState(false);
  const [creatingProforma, setCreatingProforma] = useState(false);
  const [savingCadence, setSavingCadence] = useState(false);
  const [cadenceValidTill, setCadenceValidTill] = useState("");
  const [cadenceFollowUp, setCadenceFollowUp] = useState("");
  const [cadenceKind, setCadenceKind] = useState("firm");
  const [showConfiguratorTools, setShowConfiguratorTools] = useState(false);
  const [showTermsPanel, setShowTermsPanel] = useState(false);
  const [showAddItemComposer, setShowAddItemComposer] = useState(true);
  const [showClosePanel, setShowClosePanel] = useState(false);
  const [closeReasonId, setCloseReasonId] = useState("");
  const [closeRemarks, setCloseRemarks] = useState("");
  const [closeCustomerPo, setCloseCustomerPo] = useState("");
  const [closeBusy, setCloseBusy] = useState(false);
  const [revisionCompare, setRevisionCompare] = useState(null);
  const [revisionCompareLoading, setRevisionCompareLoading] = useState(false);
  const [reviveBusy, setReviveBusy] = useState(false);
  const [showEngRequestPanel, setShowEngRequestPanel] = useState(false);
  const [engNotes, setEngNotes] = useState("");
  const [engFile, setEngFile] = useState(null);
  const [engBusy, setEngBusy] = useState(false);
  const [engineeringRequests, setEngineeringRequests] = useState([]);
  const [engReplyDrafts, setEngReplyDrafts] = useState({});
  const [engReplyFiles, setEngReplyFiles] = useState({});
  const [engReplyBusyId, setEngReplyBusyId] = useState(null);

  const quoteChangeSignature = [
    quote?.quote_status || "",
    quote?.updated_at || "",
    quote?.quote_valid_till || "",
    quote?.next_follow_up_at || "",
    revision?.revision_no || "",
    revision?.revision_status || "",
  ].join("|");
  useEffect(() => {
    if (!quote || typeof onQuoteChanged !== "function") return;
    onQuoteChanged();
  }, [quoteChangeSignature]);

  useEffect(() => {
    setLoading(true);
    setError("");
    setEditing(false);
    setPdfMeta(null);
    setTerms([]);
    setNitroRec(null);
    setNitroModel("");
    setNitroPurities(["99.99", "99.995", "99.999"]);
    setOxygenRec(null);
    setOxygenModel("");
    setMailBootstrap(EMPTY_MAIL_BOOTSTRAP);
    setMailForm({ to: "", cc: "", bcc: "", preset_key: "", subject: "", body: "", clubbed: false });
    setMailNotice("");
    setShowMailSetup(false);
    setShowMailHistory(false);
    setApproval(EMPTY_APPROVAL);
    setShowApprovalHistory(false);
    setShowConfiguratorTools(false);
    setShowTermsPanel(false);
    setShowAddItemComposer(true);
    setShowClosePanel(false);
    setShowEngRequestPanel(false);
    setEngNotes("");
    setEngFile(null);
    setCloseRemarks("");
    setSalesOrderId(null);
    setSalesOrder(null);
    apiFetch(`/quotes/${id}`)
      .then((data) => {
        setQuote(data?.quote || null);
        setRevision(data?.revision || null);
        setLines(Array.isArray(data?.lines) ? data.lines : []);
        const soId = Number(data?.sales_order_id || data?.sales_order?.id);
        setSalesOrderId(Number.isFinite(soId) && soId > 0 ? soId : null);
        setSalesOrder(data?.sales_order || null);
        const validTill = data?.quote?.quote_valid_till ? String(data.quote.quote_valid_till).slice(0, 10) : "";
        setCadenceValidTill(validTill);
        if (data?.quote?.next_follow_up_at) {
          const d = new Date(data.quote.next_follow_up_at);
          if (!Number.isNaN(d.getTime())) {
            const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
            setCadenceFollowUp(local);
          } else {
            setCadenceFollowUp("");
          }
        } else {
          setCadenceFollowUp("");
        }
        setCadenceKind(data?.quote?.quote_kind || "firm");
      })
      .catch(() => setError("Failed to load quote."))
      .finally(() => setLoading(false));

    apiFetch(`/quotes/${id}/engineering-requests`)
      .then((data) => setEngineeringRequests(Array.isArray(data?.requests) ? data.requests : []))
      .catch(() => setEngineeringRequests([]));

    apiFetch(`/quotes/configurator/nitrogen/purities`)
      .then((data) => {
        const purities = Array.isArray(data?.purities) ? data.purities.map((x) => String(x)) : [];
        if (!purities.length) return;
        setNitroPurities(purities);
        if (!purities.includes(String(nitroPurity))) {
          setNitroPurity(purities[purities.length - 1]);
        }
      })
      .catch(() => {});

    apiFetch(`/quotes/${id}/pdf-meta`)
      .then((data) => setPdfMeta(data || null))
      .catch(() => setPdfMeta(null));

    setApprovalLoading(true);
    apiFetch(`/quotes/${id}/approval-status`)
      .then((data) => setApproval(data?.approval || EMPTY_APPROVAL))
      .catch(() => setApproval(EMPTY_APPROVAL))
      .finally(() => setApprovalLoading(false));

    setTermsLoading(true);
    apiFetch(`/quotes/${id}/terms`)
      .then((data) => setTerms(Array.isArray(data?.terms) ? data.terms : []))
      .catch(() => setTerms([]))
      .finally(() => setTermsLoading(false));

    apiFetch(`/products/categories`)
      .then((data) => setProductCategories(Array.isArray(data?.categories) ? data.categories : []))
      .catch(() => setProductCategories([]));

    apiFetch(`/products/groups`)
      .then((data) => setProductGroups(Array.isArray(data?.groups) ? data.groups : []))
      .catch(() => setProductGroups([]));

    apiFetch(`/quotes/bootstrap`)
      .then((data) =>
        setQuoteBootstrap({
          pricing_modes: Array.isArray(data?.pricing_modes) ? data.pricing_modes : [],
          allow_manual_line_entry: data?.allow_manual_line_entry === true,
          require_catalog_products_for_lines: data?.require_catalog_products_for_lines !== false,
          allow_distributor_external_items: data?.allow_distributor_external_items === true,
          distributor_item_sourcing_mode: data?.distributor_item_sourcing_mode || "",
          price_types: Array.isArray(data?.price_types) ? data.price_types : [],
          currencies: Array.isArray(data?.currencies) ? data.currencies : [],
          incoterms: Array.isArray(data?.incoterms) ? data.incoterms : [],
          payment_terms: Array.isArray(data?.payment_terms) ? data.payment_terms : [],
          freight_terms: Array.isArray(data?.freight_terms) ? data.freight_terms : [],
          quote_closure_reasons: Array.isArray(data?.quote_closure_reasons) ? data.quote_closure_reasons : [],
        })
      )
      .catch(() =>
        setQuoteBootstrap({
          pricing_modes: [],
          allow_manual_line_entry: false,
          require_catalog_products_for_lines: true,
          allow_distributor_external_items: false,
          distributor_item_sourcing_mode: "",
          price_types: [],
          currencies: [],
          incoterms: [],
          payment_terms: [],
          freight_terms: [],
          quote_closure_reasons: [],
        })
      );

    setMailLoading(true);
    apiFetch(`/quotes/${id}/mail-bootstrap`)
      .then((data) => {
        setMailBootstrap({
          mail_enabled: Boolean(data?.mail_enabled),
          group_names: Array.isArray(data?.group_names) ? data.group_names : [],
          sender: data?.sender || null,
          cc_users: Array.isArray(data?.cc_users) ? data.cc_users : [],
          default_to: data?.default_to || "",
          default_cc: data?.default_cc || "",
          default_subject: data?.default_subject || "",
          default_body: data?.default_body || "",
          default_preset_key: data?.default_preset_key || "",
          mail_presets: Array.isArray(data?.mail_presets) ? data.mail_presets : [],
          history: Array.isArray(data?.history) ? data.history : [],
          mail_source: data?.mail_source || EMPTY_MAIL_BOOTSTRAP.mail_source,
        });
        setMailForm({
          to: data?.default_to || "",
          cc: data?.default_cc || "",
          bcc: "",
          preset_key: data?.default_preset_key || "",
          subject: data?.default_subject || "",
          body: data?.default_body || "",
          clubbed: false,
        });
      })
      .catch(() => setMailBootstrap(EMPTY_MAIL_BOOTSTRAP))
      .finally(() => setMailLoading(false));
  }, [id]);

  useEffect(() => {
    if (!quote || !revision) return;
    setCommercialForm({
      attention_to: quote.attention_to || "",
      pricing_display_mode: revision.pricing_display_mode || "detailed",
      is_export: Boolean(revision.is_export),
      incoterm_id: revision.incoterm_id ? String(revision.incoterm_id) : "",
      base_currency_id: revision.base_currency_id ? String(revision.base_currency_id) : "",
      quote_currency_id: revision.quote_currency_id ? String(revision.quote_currency_id) : "",
      payment_term_id: revision.payment_term_id ? String(revision.payment_term_id) : "",
      freight_term_id: revision.freight_term_id ? String(revision.freight_term_id) : "",
      delivery_lead_time_days:
        revision.delivery_lead_time_days === null || revision.delivery_lead_time_days === undefined
          ? ""
          : String(revision.delivery_lead_time_days),
      warranty_months:
        revision.warranty_months === null || revision.warranty_months === undefined ? "" : String(revision.warranty_months),
    });
  }, [quote, revision]);

  async function refreshTermsAndMeta() {
    setTermsLoading(true);
    apiFetch(`/quotes/${id}/terms`)
      .then((data) => setTerms(Array.isArray(data?.terms) ? data.terms : []))
      .catch(() => setTerms([]))
      .finally(() => setTermsLoading(false));

    apiFetch(`/quotes/${id}/pdf-meta`)
      .then((data) => setPdfMeta(data || null))
      .catch(() => setPdfMeta(null));
  }

  async function refreshMailBootstrap() {
    setMailLoading(true);
    try {
      const data = await apiFetch(`/quotes/${id}/mail-bootstrap`);
      setMailBootstrap({
        mail_enabled: Boolean(data?.mail_enabled),
        group_names: Array.isArray(data?.group_names) ? data.group_names : [],
        sender: data?.sender || null,
        cc_users: Array.isArray(data?.cc_users) ? data.cc_users : [],
        default_to: data?.default_to || "",
        default_cc: data?.default_cc || "",
        default_subject: data?.default_subject || "",
        default_body: data?.default_body || "",
        default_preset_key: data?.default_preset_key || "",
        mail_presets: Array.isArray(data?.mail_presets) ? data.mail_presets : [],
        history: Array.isArray(data?.history) ? data.history : [],
        mail_source: data?.mail_source || EMPTY_MAIL_BOOTSTRAP.mail_source,
      });
      setMailForm((prev) => ({
        ...prev,
        to: prev.to || data?.default_to || "",
        cc: prev.cc || data?.default_cc || "",
        preset_key: prev.preset_key || data?.default_preset_key || "",
        subject: prev.subject || data?.default_subject || "",
        body: prev.body || data?.default_body || "",
      }));
    } catch {
      setMailBootstrap(EMPTY_MAIL_BOOTSTRAP);
    } finally {
      setMailLoading(false);
    }
  }

  function restoreMailPrefill() {
    setMailForm((prev) => ({
      ...prev,
      to: mailBootstrap.default_to || "",
      cc: mailBootstrap.default_cc || "",
      bcc: "",
      preset_key: mailBootstrap.default_preset_key || "",
      subject: mailBootstrap.default_subject || "",
      body: mailBootstrap.default_body || "",
    }));
    setMailNotice("Delivery fields restored from quote defaults.");
    setError("");
  }

  function resolveMailPreset(presetKey) {
    const presets = Array.isArray(mailBootstrap.mail_presets) ? mailBootstrap.mail_presets : [];
    const key = String(presetKey || "").trim();
    return presets.find((preset) => String(preset?.key || "").trim() === key) || null;
  }

  function applyMailPreset(presetKey) {
    const preset = resolveMailPreset(presetKey);
    if (!preset) return;
    setMailForm((prev) => ({
      ...prev,
      preset_key: preset.key || "",
      subject: preset.subject || "",
      body: preset.body || "",
    }));
    setMailNotice(`Mail style set to ${preset.label || "selected preset"}.`);
    setError("");
  }

  async function refreshApprovalStatus() {
    setApprovalLoading(true);
    try {
      const data = await apiFetch(`/quotes/${id}/approval-status`);
      setApproval(data?.approval || EMPTY_APPROVAL);
    } catch {
      setApproval(EMPTY_APPROVAL);
    } finally {
      setApprovalLoading(false);
    }
  }

  async function recommendNitrogen() {
    setNitroWorking(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/recommend/nitrogen`, {
        method: "POST",
        body: JSON.stringify({ purity: nitroPurity, flow: Number(nitroFlow) }),
      });
      setNitroRec(data || null);
      setNitroModel(data?.recommended?.model || "");
    } catch (e) {
      setNitroRec(null);
      setNitroModel("");
      setError(e?.data?.error === "NO_DATA" ? "Nitrogen data not configured on server." : "Failed to recommend model.");
    } finally {
      setNitroWorking(false);
    }
  }

  async function applyNitrogen() {
    if (!nitroRec) return;
    setNitroWorking(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/apply/nitrogen`, {
        method: "POST",
        body: JSON.stringify({
          purity: nitroPurity,
          flow: Number(nitroFlow),
          model: nitroModel || null,
          replace: true,
        }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      await refreshTermsAndMeta();
      runQuietly(() => refreshMailBootstrap());
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to apply selection."));
    } finally {
      setNitroWorking(false);
    }
  }

  async function recommendOxygen() {
    setOxygenWorking(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/recommend/oxygen`, {
        method: "POST",
        body: JSON.stringify({ purity: oxygenPurity, flow: Number(oxygenFlow) }),
      });
      setOxygenRec(data || null);
      setOxygenModel(data?.recommended?.model || "");
    } catch (e) {
      setOxygenRec(null);
      setOxygenModel("");
      setError(e?.data?.error === "NO_DATA" ? "Oxygen data not configured on server." : "Failed to recommend oxygen model.");
    } finally {
      setOxygenWorking(false);
    }
  }

  async function applyOxygen() {
    if (!oxygenRec) return;
    setOxygenWorking(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/apply/oxygen`, {
        method: "POST",
        body: JSON.stringify({
          purity: oxygenPurity,
          flow: Number(oxygenFlow),
          model: oxygenModel || null,
          replace: true,
        }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      await refreshTermsAndMeta();
      runQuietly(() => refreshMailBootstrap());
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to apply oxygen selection."));
    } finally {
      setOxygenWorking(false);
    }
  }

  function fmt(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : String(v ?? "");
  }

  function fmtDateTime(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }

  function getMailStatusMeta(entry) {
    if (!entry) return { label: "Not sent", tone: "neutral", note: "" };
    if (entry.send_status === "failed") {
      return { label: "Failed", tone: "warning", note: entry.error_text || "Delivery failed." };
    }
    if (entry.opened_at) {
      const openCount = Number(entry.open_count || 0) || 0;
      return {
        label: openCount > 1 ? `Opened ${openCount}x` : "Opened",
        tone: "success",
        note: `Opened ${fmtDateTime(entry.last_opened_at || entry.opened_at)}`,
      };
    }
    return { label: "Sent", tone: "neutral", note: `Sent ${fmtDateTime(entry.sent_at)}` };
  }

  useEffect(() => {
    if (!mailConnectStatus) return;
    if (mailConnectStatus === "success") {
      setMailNotice("Mailbox connected successfully.");
      setShowMailComposer(true);
      refreshMailBootstrap().catch(() => {});
    } else if (mailConnectStatus === "refresh_required") {
      setError("Google did not return offline access. Please reconnect and allow consent.");
      setShowMailComposer(true);
    } else if (mailConnectStatus === "failed") {
      setError(`Mailbox connection failed.${mailConnectReason ? ` (${String(mailConnectReason).replaceAll("_", " ")})` : ""}`);
      setShowMailComposer(true);
    }
  }, [mailConnectStatus, mailConnectReason]);

  function toNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function safeParseMeta(desc) {
    if (typeof desc !== "string" || !desc.trim().length) return null;
    try {
      const obj = JSON.parse(desc);
      return obj && typeof obj === "object" ? obj : null;
    } catch {
      return null;
    }
  }

  function normalizePricingFields({ qty, grossUnit, discPct, discAmt, netUnit, changed }) {
    const q = Math.max(0, toNumber(qty, 0));
    const gross = Math.max(0, toNumber(grossUnit, 0));
    const grossTotal = gross * q;
    let pct = Math.max(0, toNumber(discPct, 0));
    let amt = Math.max(0, toNumber(discAmt, 0));
    let net = Math.max(0, toNumber(netUnit, 0));

    if (changed === "disc_pct") {
      amt = grossTotal > 0 ? (grossTotal * pct) / 100 : 0;
    } else if (changed === "disc_amt") {
      pct = grossTotal > 0 ? (amt / grossTotal) * 100 : 0;
    } else if (changed === "net_unit") {
      amt = Math.max(0, grossTotal - net * q);
      pct = grossTotal > 0 ? (amt / grossTotal) * 100 : 0;
    }

    if (grossTotal > 0 && amt > grossTotal) amt = grossTotal;
    const netTotal = Math.max(0, grossTotal - amt);
    net = q > 0 ? netTotal / q : 0;
    pct = grossTotal > 0 ? (amt / grossTotal) * 100 : 0;

    return {
      qty: q,
      grossUnit: gross,
      discPct: pct,
      discAmt: amt,
      netUnit: net,
      netTotal,
    };
  }

  function calcLineTotal(l) {
    return toNumber(l.qty, 0) * toNumber(l.unit_price_quote, 0);
  }

  const canEdit = revision?.revision_status === "draft";
  const revisionStateLabel = String(revision?.revision_status || "draft").replaceAll("_", " ");
  const canApproveQuotes = Boolean(
    me?.group_name === "SuperAdmin" || me?.permissions?.screens?.quotes?.can_approve || me?.permissions?.modules?.quotes?.can_approve
  );
  const uiLines = editing ? draftLines : lines;
  const uiSubtotal = editing
    ? uiLines.reduce((sum, l) => sum + calcLineTotal(l), 0)
    : toNumber(revision?.subtotal_quote, 0);
  const uiTax = editing
    ? uiLines.reduce((sum, l) => sum + (calcLineTotal(l) * toNumber(l.gst_pct, 0)) / 100, 0)
    : toNumber(revision?.tax_total_quote, 0);
  const uiGrand = editing ? uiSubtotal + uiTax : toNumber(revision?.grand_total_quote, 0);
  const filteredGroups = useMemo(() => {
    const cid = addCategoryId ? Number(addCategoryId) : null;
    if (!Number.isFinite(cid)) return productGroups;
    return productGroups.filter((g) => Number(g.category_id) === cid);
  }, [addCategoryId, productGroups]);

  useEffect(() => {
    if (!editing) return;
    const q = addProductQ.trim();
    if (!q.length) {
      setAddProductResults([]);
      return;
    }
    const t = setTimeout(() => {
      const params = new URLSearchParams();
      params.set("q", q);
      if (addCategoryId) params.set("category_id", addCategoryId);
      if (addGroupId) params.set("group_id", addGroupId);
      apiFetch(`/products?${params.toString()}`)
        .then((data) => setAddProductResults(Array.isArray(data?.products) ? data.products : []))
        .catch(() => setAddProductResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [editing, addProductQ, addCategoryId, addGroupId]);

  useEffect(() => {
    const p = addSelectedProduct;
    if (!p) return;
    const listPrice = toNumber(p.list_price, 0);
    const gross = listPrice * getPriceListMultiplier(priceTypeOptions, addPriceList);
    setAddGrossUnit(String(gross));
    setAddDiscPct("");
    setAddDiscAmt("");
  }, [addSelectedProduct, addPriceList, priceTypeOptions]);

  useEffect(() => {
    setAddPriceList((prev) => resolvePriceTypeKey(priceTypeOptions, prev));
  }, [quoteBootstrap.price_types]);

  function startEdit() {
    setError("");
    setShowAddItemComposer(true);
    setDraftLines(
      lines.map((l) => ({
        key: `id:${l.id}`,
        id: l.id,
        product_id: l.product_id ?? null,
        item_code: l.item_code || "",
        item_name: l.item_name || "",
        qty: String(l.qty ?? 1),
        gross_unit_price_quote: (() => {
          const meta = safeParseMeta(l.line_description);
          const v = meta && typeof meta.gross_unit_price_quote !== "undefined" ? meta.gross_unit_price_quote : null;
          return String(toNumber(v, toNumber(l.unit_price_quote, 0)));
        })(),
        discount_pct: (() => {
          const meta = safeParseMeta(l.line_description);
          return String(toNumber(meta?.discount_pct, 0));
        })(),
        discount_amt: (() => {
          const meta = safeParseMeta(l.line_description);
          return String(toNumber(meta?.discount_amt, 0));
        })(),
        price_list: (() => {
          const meta = safeParseMeta(l.line_description);
          return typeof meta?.price_list === "string" ? meta.price_list : "list";
        })(),
        source_list_price: (() => {
          const meta = safeParseMeta(l.line_description);
          return String(toNumber(meta?.source_list_price, 0));
        })(),
        remarks: (() => {
          const meta = safeParseMeta(l.line_description);
          return typeof meta?.remarks === "string" ? meta.remarks : "";
        })(),
        unit_price_quote: String(l.unit_price_quote ?? 0),
        gst_pct: String(l.gst_pct ?? 0),
        scope_type: l.scope_type || "included",
        line_description: typeof l.line_description === "string" ? l.line_description : "",
      }))
    );
    setEditing(true);
  }

  function setDraftLine(lineKey, patch, pricingChanged) {
    setDraftLines((prev) =>
      prev.map((l) => {
        if (l.key !== lineKey) return l;
        const merged = { ...l, ...patch };
        const priceListChanged = Object.prototype.hasOwnProperty.call(patch || {}, "price_list");
        if (priceListChanged) {
          merged.price_list = resolvePriceTypeKey(priceTypeOptions, merged.price_list);
          const sourceListPrice = toNumber(merged.source_list_price, 0);
          if (sourceListPrice > 0) {
            merged.gross_unit_price_quote = String(sourceListPrice * getPriceListMultiplier(priceTypeOptions, merged.price_list));
            pricingChanged = String(merged.discount_amt || "").trim() && toNumber(merged.discount_amt, 0) > 0 ? "disc_amt" : "disc_pct";
          }
        }

        const norm = normalizePricingFields({
          qty: merged.qty,
          grossUnit: merged.gross_unit_price_quote,
          discPct: merged.discount_pct,
          discAmt: merged.discount_amt,
          netUnit: merged.unit_price_quote,
          changed: pricingChanged || null,
        });

        const next = {
          ...merged,
          qty: String(norm.qty || 0),
          gross_unit_price_quote: String(norm.grossUnit || 0),
          discount_pct: String(norm.discPct || 0),
          discount_amt: String(norm.discAmt || 0),
          unit_price_quote: String(norm.netUnit || 0),
        };

        const meta = {
          ...(safeParseMeta(l.line_description) || {}),
          price_list: next.price_list || "list",
          source_list_price: toNumber(next.source_list_price, 0),
          gross_unit_price_quote: toNumber(next.gross_unit_price_quote, 0),
          discount_pct: toNumber(next.discount_pct, 0),
          discount_amt: toNumber(next.discount_amt, 0),
          remarks: next.remarks || "",
        };
        next.line_description = JSON.stringify(meta);
        return next;
      })
    );
  }

  function removeDraftLine(lineKey) {
    setDraftLines((prev) => prev.filter((l) => l.key !== lineKey));
  }

  async function saveEdits() {
    setSaving(true);
    setError("");
    try {
      const validation = validateDraftLines(draftLines, { requireAtLeastOne: true });
      if (!validation.ok) {
        setError(validation.message);
        return;
      }
      const payload = {
        lines: validation.actionable
          .map(({ line: l }) => ({
            id: l.id,
            product_id: l.product_id === null || l.product_id === undefined ? null : Number(l.product_id),
            item_name: l.item_name || null,
            qty: toNumber(l.qty, 0),
            unit_price_quote: toNumber(l.unit_price_quote, 0),
            gst_pct: toNumber(l.gst_pct, 0),
            scope_type: l.scope_type,
            line_description: typeof l.line_description === "string" ? l.line_description : null,
          })),
      };

      const data = await apiFetch(`/quotes/${id}/lines`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });

      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setEditing(false);
      runQuietly(() => refreshMailBootstrap());
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save changes."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ paddingTop: 12 }}>Loading…</div>;
  if (error && !quote) return <div style={{ paddingTop: 12, color: "#b00020" }}>{error}</div>;
  if (!quote) return <div style={{ paddingTop: 12 }}>Not found.</div>;

  const missingScopeGroups = Array.isArray(pdfMeta?.scope_groups)
    ? pdfMeta.scope_groups.filter((g) => !g.has_scope_pdf)
    : [];
  const pdfWarnings = [];
  if (missingScopeGroups.length) pdfWarnings.push(`${missingScopeGroups.length} scope PDF(s) missing`);
  if (pdfMeta && !pdfMeta.has_terms) pdfWarnings.push("Terms template not set");
  if (pdfMeta && !pdfMeta.has_letterhead) pdfWarnings.push("Letterhead template not set");

  const canEditTerms = revision?.revision_status === "draft";
  const activeStatus = revision?.revision_status || quote?.quote_status || "draft";
  const stageTone = statusTone(activeStatus);
  const stageColor = statusColor(activeStatus);
  const baseCurrencyCode =
    (quoteBootstrap.currencies || []).find((item) => String(item.id) === String(commercialForm.base_currency_id || revision?.base_currency_id || ""))
      ?.currency_code || "—";
  const quoteCurrencyCode =
    (quoteBootstrap.currencies || []).find((item) => String(item.id) === String(commercialForm.quote_currency_id || revision?.quote_currency_id || ""))
      ?.currency_code || "—";
  const effectiveMailSource = mailBootstrap.mail_source?.effective_sender || EMPTY_MAIL_BOOTSTRAP.mail_source.effective_sender;
  const lastMailEntry = Array.isArray(mailBootstrap.history) && mailBootstrap.history.length ? mailBootstrap.history[0] : null;
  const lastMailStatus = getMailStatusMeta(lastMailEntry);
  const selectedMailPreset = resolveMailPreset(mailForm.preset_key) || resolveMailPreset(mailBootstrap.default_preset_key);
  const mailRecipientValue = String(mailForm.to || "").trim();
  const subjectValue = String(mailForm.subject || "").trim();
  const mailReady = revision?.revision_status === "issued" && mailRecipientValue.length > 0;
  const canSendQuoteNow =
    !mailSending && !mailLoading && revision?.revision_status === "issued" && mailRecipientValue.length > 0 && subjectValue.length > 0;
  const deliveryChecklist = [
    {
      label: "Recipient",
      value: mailRecipientValue || "Recipient needed",
      note: mailRecipientValue ? "Customer-facing address is ready." : "Add a customer email before sending.",
      tone: mailRecipientValue ? "success" : "warning",
    },
    {
      label: "Mailbox",
      value: effectiveMailSource?.connected ? effectiveMailSource.email || "Mailbox ready" : "Mailbox setup needed",
      note: effectiveMailSource?.connected
        ? `${effectiveMailSource.source || "Active sender"} will be used for this delivery.`
        : "Connect your mailbox or use the configured fallback.",
      tone: effectiveMailSource?.connected ? "success" : "danger",
    },
    {
      label: "Proposal Pack",
      value: pdfWarnings.length ? `${pdfWarnings.length} warning${pdfWarnings.length > 1 ? "s" : ""}` : "Ready",
      note: pdfWarnings.length ? pdfWarnings.join(" • ") : "PDF setup, terms, and scope pack are aligned.",
      tone: pdfWarnings.length ? "warning" : "success",
    },
    {
      label: "Last Engagement",
      value: lastMailEntry ? fmtDateTime(lastMailEntry.opened_at || lastMailEntry.sent_at) : "Not sent yet",
      note: lastMailEntry
        ? `${lastMailEntry.recipient_to || "No recipient"} • ${lastMailStatus.label}${lastMailStatus.note ? ` • ${lastMailStatus.note}` : ""}`
        : "First customer dispatch from this revision.",
      tone: lastMailEntry ? lastMailStatus.tone : "neutral",
    },
  ];
  const selectedTermsCount = terms.filter((term) => Boolean(term.is_selected)).length;
  const handoffChecks = [
    { label: "Letterhead", value: pdfMeta?.has_letterhead ? "Ready" : "Missing", ok: Boolean(pdfMeta?.has_letterhead) },
    { label: "Terms Template", value: pdfMeta?.has_terms ? "Ready" : "Missing", ok: Boolean(pdfMeta?.has_terms) },
    {
      label: "Scope PDFs",
      value: missingScopeGroups.length ? `${missingScopeGroups.length} missing` : "Ready",
      ok: missingScopeGroups.length === 0,
    },
    { label: "Customer Mail", value: mailReady ? "Ready" : "Locked", ok: mailReady },
  ];
  const resolvedSalesOrderId = Number(salesOrderId || salesOrder?.id || 0);
  const hasLinkedSalesOrder = Number.isFinite(resolvedSalesOrderId) && resolvedSalesOrderId > 0;
  const quoteAlreadyConverted =
    hasLinkedSalesOrder || String(quote?.quote_status || "").toLowerCase() === "converted";
  const openLeadAction =
    quote?.lead_id && typeof onOpenLead === "function"
      ? {
          label: "Open Lead",
          onClick: () => onOpenLead(Number(quote.lead_id)),
          disabled: false,
          tone: "neutral",
        }
      : null;
  const openSalesOrderAction =
    hasLinkedSalesOrder && typeof onOpenSalesOrder === "function"
      ? {
          label: "Open Sales Order",
          onClick: () => onOpenSalesOrder(resolvedSalesOrderId),
          disabled: false,
          tone: "primary",
        }
      : null;
  const quoteBlockers = [];
  if (!quoteAlreadyConverted && !["closed", "lost", "cancelled"].includes(String(quote?.quote_status || "").toLowerCase())) {
    const revState = String(revision?.revision_status || "").toLowerCase();
    const scrollToId = (elementId) => () =>
      document.getElementById(elementId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (revState === "pending_approval") {
      const approverName = approval.current_approver?.full_name || approval.current_approver?.email || "the assigned approver";
      const canAct = approval.can_actor_approve && canApproveQuotes;
      quoteBlockers.push({
        id: "quote-approval-pending",
        severity: "med",
        reason: canAct ? "This revision is waiting on your approval." : `Waiting on approval from ${approverName}.`,
        explain: `Max discount ${toNumber(approval.max_discount_pct, 0).toFixed(2)}% vs autonomous ${toNumber(approval.autonomous_discount_pct, 0).toFixed(2)}%.`,
        ownerDesk: "Commercial approval",
        ctaLabel: canAct ? "Approve revision" : undefined,
        onCta: canAct ? () => approveRevision(false) : undefined,
      });
    } else if (revState === "draft" && approval.approval_required) {
      const reasons = Array.isArray(approval.approval_reasons) ? approval.approval_reasons : [];
      const bandLines = Array.isArray(approval.price_band_lines) ? approval.price_band_lines : [];
      const priceBandOnly = reasons.length === 1 && reasons[0] === "price_below_approval_band";
      const explainParts = [];
      if (!priceBandOnly) {
        explainParts.push(`Max discount ${toNumber(approval.max_discount_pct, 0).toFixed(2)}% vs autonomous ${toNumber(approval.autonomous_discount_pct, 0).toFixed(2)}%.`);
      }
      if (bandLines.length) {
        explainParts.push(
          `Below approval band: ${bandLines
            .slice(0, 3)
            .map((line) => `${line.item_name || `Line ${line.line_no}`} at ${toNumber(line.net_pct_of_list, 0).toFixed(1)}% of list (band ${toNumber(line.threshold_pct, 0).toFixed(0)}%)`)
            .join("; ")}${bandLines.length > 3 ? ` +${bandLines.length - 3} more` : ""}.`
        );
      }
      quoteBlockers.push({
        id: "quote-approval-required",
        severity: "med",
        reason: priceBandOnly
          ? "Net price is below the approval band on some lines — the quote cannot be issued until approved."
          : "Discount is above your autonomous limit — the quote cannot be issued until approved.",
        explain: explainParts.join(" "),
        ownerDesk: "Sales",
        ctaLabel: "Submit for approval",
        onCta: submitForApproval,
      });
    }
    const openEng = engineeringRequests.filter((req) => !["closed", "cancelled", "rejected"].includes(String(req.request_status || "").toLowerCase()));
    const waitingInput = openEng.filter((req) => String(req.request_status || "").toLowerCase() === "waiting_input");
    const readyEng = openEng.filter((req) => String(req.request_status || "").toLowerCase() === "ready");
    const inReview = openEng.length - waitingInput.length - readyEng.length;
    if (waitingInput.length) {
      quoteBlockers.push({
        id: "eng-waiting-input",
        severity: "high",
        reason: `Engineering is waiting on your input for ${waitingInput.length} request${waitingInput.length === 1 ? "" : "s"}.`,
        explain: waitingInput.map((req) => req.request_title || `Request #${req.id}`).slice(0, 2).join(", "),
        ownerDesk: "Sales",
        ctaLabel: "Reply to Engineering",
        onCta: scrollToId("quote-eng-responses"),
      });
    }
    if (readyEng.length) {
      quoteBlockers.push({
        id: "eng-ready",
        severity: "soft",
        reason: `Engineering returned ${readyEng.length} datasheet${readyEng.length === 1 ? "" : "s"} — review and accept to close the loop.`,
        ownerDesk: "Sales",
        ctaLabel: "Review response",
        onCta: scrollToId("quote-eng-responses"),
      });
    }
    if (inReview > 0) {
      quoteBlockers.push({
        id: "eng-in-review",
        severity: "soft",
        reason: `${inReview} engineering request${inReview === 1 ? " is" : "s are"} still with Engineering.`,
        ownerDesk: "Engineering",
      });
    }
    const validTill = quote?.quote_valid_till ? new Date(String(quote.quote_valid_till).slice(0, 10)) : null;
    if (
      validTill &&
      !Number.isNaN(validTill.getTime()) &&
      validTill < new Date(new Date().toDateString()) &&
      ["issued", "sent", "approved", "lapsed"].includes(String(quote?.quote_status || "").toLowerCase())
    ) {
      quoteBlockers.push({
        id: "quote-expired",
        severity: "med",
        reason: `Quote validity lapsed on ${validTill.toLocaleDateString()} — revise or extend before the customer orders.`,
        ownerDesk: "Sales",
      });
    }
    if (pdfWarnings.length && ["draft", "approved"].includes(revState)) {
      quoteBlockers.push({
        id: "quote-pack",
        severity: "soft",
        reason: `Proposal pack incomplete: ${pdfWarnings.join(" • ")}.`,
        ownerDesk: "Admin masters",
      });
    }
  }

  const nextAction = quoteAlreadyConverted && openSalesOrderAction
    ? {
        title: "Sales Order Ready",
        note: salesOrder?.so_number
          ? `This quote already has sales order ${salesOrder.so_number}. Open it to continue confirm → dispatch → invoice.`
          : "This quote is already converted. Open the linked sales order to continue fulfilment.",
        actions: [openSalesOrderAction, ...(openLeadAction ? [openLeadAction] : [])],
      }
    : approval.can_actor_approve && canApproveQuotes
      ? {
          title: "Approval Decision",
          note: "This revision is waiting on your approval action before the sales user can move forward.",
          actions: [
            {
              label: "Approve & Send",
              onClick: () => approveRevision(true),
              disabled: saving || editing,
              tone: "success",
            },
            {
              label: "Approve only",
              onClick: () => approveRevision(false),
              disabled: saving || editing,
            },
            {
              label: "Reject Revision",
              onClick: rejectRevision,
              disabled: saving || editing,
              tone: "danger",
            },
            ...(openLeadAction ? [openLeadAction] : []),
          ],
        }
      : revision?.revision_status === "draft" && approval.approval_required
        ? {
            title: "Submit For Approval",
            note: "Discount thresholds require approval before this quote can be issued to the customer.",
            actions: [
              {
                label: "Submit For Approval",
                onClick: submitForApproval,
                disabled: saving || editing,
                tone: "primary",
              },
              ...(openLeadAction ? [openLeadAction] : []),
            ],
          }
        : ["draft", "approved"].includes(revision?.revision_status || "")
          ? {
              title: "Issue Quote",
              note:
                revision?.revision_status === "approved"
                  ? "The commercial and approval path are ready. Issue the quote to unlock customer-facing delivery."
                  : "Once commercials and required setup are ready, issue the quote so delivery and mail stay aligned.",
              actions: [
                {
                  label: revision?.revision_status === "approved" ? "Issue Approved Quote" : "Issue Quote",
                  onClick: issueRevision,
                  disabled: saving || editing || (revision?.revision_status === "draft" && approval.approval_required),
                  tone: "primary",
                },
                ...(openLeadAction ? [openLeadAction] : []),
              ],
            }
          : revision?.revision_status === "issued"
            ? {
                title: "Send Quote",
                note: "The quote is issued. Open delivery, confirm the recipient, and press-fit into a sales order below when ready.",
                actions: [
                  {
                    label: showMailComposer ? "Hide Delivery Panel" : "Open Delivery Panel",
                    onClick: () => setShowMailComposer((prev) => !prev),
                    disabled: mailLoading,
                    tone: "primary",
                  },
                  ...(openLeadAction ? [openLeadAction] : []),
                ],
              }
            : {
                title: "Continue With This Revision",
                note: "Use a new revision if the customer needs changes, or move into delivery and order handoff from the current state.",
                actions: [
                  {
                    label: "New Revision",
                    onClick: createRevision,
                    disabled: saving || editing || revision?.revision_status === "draft",
                    tone: "neutral",
                  },
                  ...(openLeadAction ? [openLeadAction] : []),
                ],
              };
  const executiveSurfaceStyle = {
    border: "1px solid rgba(188, 202, 230, 0.9)",
    borderRadius: 18,
    padding: 14,
    background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(247,250,255,0.98) 100%)",
    boxShadow: "0 16px 34px rgba(28, 39, 64, 0.06)",
  };
  const sectionSurfaceStyle = {
    border: "1px solid rgba(221, 229, 242, 0.96)",
    borderRadius: 16,
    padding: 14,
    background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,252,255,0.98) 100%)",
    boxShadow: "0 10px 24px rgba(31, 41, 55, 0.04)",
  };
  const subtleSurfaceStyle = {
    border: "1px solid rgba(227, 234, 246, 0.95)",
    borderRadius: 14,
    padding: 12,
    background: "#ffffff",
  };
  const compactMetricStyle = {
    border: "1px solid rgba(217, 226, 243, 0.96)",
    borderRadius: 14,
    padding: "10px 12px",
    background: "#ffffff",
    minWidth: 0,
  };
  const actionClusterStyle = {
    border: "1px solid rgba(214, 224, 244, 0.96)",
    borderRadius: 14,
    padding: 10,
    background: "rgba(255,255,255,0.9)",
    display: "grid",
    gap: 8,
    alignContent: "start",
  };
  const historyTableShellStyle = {
    marginTop: 12,
    border: "1px solid #e6ebf5",
    borderRadius: 12,
    overflow: "hidden",
    background: "#fff",
  };
  const historyTableHeaderStyle = {
    gap: 10,
    padding: "10px 12px",
    fontSize: 12,
    opacity: 0.78,
    background: "linear-gradient(180deg, #fafcff 0%, #f4f7fc 100%)",
    borderBottom: "1px solid #e8edf6",
  };
  const historyTableRowStyle = {
    gap: 10,
    padding: "10px 12px",
    borderBottom: "1px solid #f1f4f8",
    fontSize: 12,
  };
  const helperNoteStyle = {
    marginTop: 12,
    fontSize: 12,
    opacity: 0.72,
    lineHeight: 1.7,
  };
  const softEmptyStateStyle = {
    padding: 12,
    fontSize: 12,
    opacity: 0.7,
    background: "linear-gradient(180deg, rgba(250,252,255,0.98) 0%, rgba(255,255,255,0.98) 100%)",
  };

  function addItemToDraft() {
    if (!editing) return;
    if (!addSelectedProduct) return;
    const qty = Math.max(1, toNumber(addQty, 1));
    const gross = Math.max(
      0,
      toNumber(addSelectedProduct?.list_price, 0) * getPriceListMultiplier(priceTypeOptions, addPriceList)
    );
    const norm = normalizePricingFields({
      qty,
      grossUnit: gross,
      discPct: addDiscPct,
      discAmt: addDiscAmt,
      netUnit: 0,
      changed: addDiscAmt && String(addDiscAmt).trim().length ? "disc_amt" : "disc_pct",
    });

    const meta = {
      price_list: addPriceList || "list",
      source_list_price: toNumber(addSelectedProduct?.list_price, 0),
      gross_unit_price_quote: norm.grossUnit,
      discount_pct: norm.discPct,
      discount_amt: norm.discAmt,
      remarks: addRemarks || "",
    };

    setDraftLines((prev) => [
      ...prev,
      {
        key: `new:${Math.random().toString(16).slice(2)}`,
        id: null,
        product_id: addSelectedProduct.id,
        item_code: addSelectedProduct.item_code || "",
        item_name: addSelectedProduct.item_name || "",
        qty: String(qty),
        source_list_price: String(toNumber(addSelectedProduct.list_price, 0)),
        gross_unit_price_quote: String(norm.grossUnit),
        discount_pct: String(norm.discPct),
        discount_amt: String(norm.discAmt),
        price_list: addPriceList || "list",
        remarks: addRemarks || "",
        unit_price_quote: String(norm.netUnit),
        gst_pct: String(toNumber(addSelectedProduct.gst_pct, 0)),
        scope_type: "included",
        line_description: JSON.stringify(meta),
      },
    ]);

    setAddProductQ("");
    setAddProductResults([]);
    setAddSelectedProduct(null);
    setAddQty("1");
    setAddGrossUnit("");
    setAddDiscPct("");
    setAddDiscAmt("");
    setAddRemarks("");
  }

  function setTerm(termId, patch) {
    setTerms((prev) => prev.map((t) => (t.id === termId ? { ...t, ...patch } : t)));
  }

  function addTerm() {
    setTerms((prev) => [
      ...prev,
      {
        id: `new:${Math.random().toString(16).slice(2)}`,
        caption: "Remarks",
        description: "",
        is_selected: true,
      },
    ]);
  }

  function removeTerm(termId) {
    setTerms((prev) => prev.filter((t) => t.id !== termId));
  }

  async function saveTerms() {
    setTermsSaving(true);
    setError("");
    try {
      const payload = {
        terms: terms.map((t, idx) => ({
          id: typeof t.id === "number" ? t.id : null,
          caption: t.caption || "",
          description: t.description || "",
          is_selected: Boolean(t.is_selected),
          sort_order: idx + 1,
        })),
      };
      const data = await apiFetch(`/quotes/${id}/terms`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setTerms(Array.isArray(data?.terms) ? data.terms : []);
      await refreshTermsAndMeta();
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save Terms."));
    } finally {
      setTermsSaving(false);
    }
  }

  async function createRevision() {
    if (revision?.revision_status === "draft") return;
    const reason = window.prompt("Amendment reason (optional):", "");
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/revisions`, {
        method: "POST",
        body: JSON.stringify({ amendment_reason: reason || null }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setEditing(false);
      setDraftLines([]);
      await refreshTermsAndMeta();
      runQuietly(() => refreshMailBootstrap());
      await refreshApprovalStatus();
    } catch (e) {
      setError(e?.data?.error === "ALREADY_DRAFT" ? "A draft revision already exists." : getApiErrorMessage(e, "Failed to create revision."));
    } finally {
      setSaving(false);
    }
  }

  async function issueRevision() {
    if (!["draft", "approved"].includes(revision?.revision_status || "")) return;
    const ok = window.confirm(
      revision?.revision_status === "approved"
        ? "Issue this approved revision? After issuing, editing will remain disabled."
        : "Issue and lock this revision? After issuing, editing will be disabled."
    );
    if (!ok) return;
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/issue`, { method: "POST" });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setEditing(false);
      setDraftLines([]);
      setApproval(data?.approval || approval);
      await refreshTermsAndMeta();
      runQuietly(() => refreshMailBootstrap());
    } catch (e) {
      if (e?.data?.approval) setApproval(e.data.approval);
      if (e?.data?.error === "APPROVAL_REQUIRED") {
        setError("This revision exceeds the autonomous discount threshold. Submit it for approval first.");
      } else if (e?.data?.error === "ISSUE_READINESS_FAILED" && Array.isArray(e?.data?.blockers) && e.data.blockers.length) {
        setError(`Complete required items before issue: ${e.data.blockers.map((item) => item?.label || "Missing requirement.").join(" ")}`);
      } else if (e?.data?.error === "REVISION_NOT_ISSUABLE") {
        setError("This revision cannot be issued in its current state.");
      } else {
        setError(getApiErrorMessage(e, "Failed to issue revision."));
      }
    } finally {
      setSaving(false);
    }
  }

  async function closeQuoteFromDetail() {
    if (!closeReasonId) {
      setError("Select a closure reason.");
      return;
    }
    const selectedReason = (quoteBootstrap.quote_closure_reasons || []).find((reason) => String(reason.id) === String(closeReasonId));
    const isWon = String(selectedReason?.outcome_kind || "").toLowerCase() === "won";
    if (isWon && !String(closeCustomerPo || "").trim()) {
      setError("Enter the customer PO reference before closing a won quote.");
      return;
    }
    setCloseBusy(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/close`, {
        method: "POST",
        body: JSON.stringify({
          closure_reason_id: Number(closeReasonId),
          closure_remarks: closeRemarks,
          customer_po_ref: closeCustomerPo,
        }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : lines);
      setShowClosePanel(false);
      toast("Quote closed", "success");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to close quote."));
    } finally {
      setCloseBusy(false);
    }
  }

  async function loadRevisionCompare() {
    setRevisionCompareLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/revisions/compare`);
      setRevisionCompare(data);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to compare revisions."));
    } finally {
      setRevisionCompareLoading(false);
    }
  }

  async function reviveQuote() {
    const nextDate = window.prompt("New valid-till date (YYYY-MM-DD). Leave blank for +30 days.", "");
    if (nextDate === null) return;
    setReviveBusy(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/revive`, {
        method: "POST",
        body: JSON.stringify({ quote_valid_till: String(nextDate || "").trim() || null }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      toast("Quote revived", "success");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to revive quote."));
    } finally {
      setReviveBusy(false);
    }
  }

  async function submitEngineeringRequest() {
    if (!String(engNotes || "").trim()) {
      setError("Technical requirements / notes are required.");
      return;
    }
    setEngBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("notes", String(engNotes || "").trim());
      if (engFile) body.append("file", engFile);
      const data = await apiFetch(`/quotes/${id}/engineering-request`, { method: "POST", body });
      setEngineeringRequests(Array.isArray(data?.requests) ? data.requests : engineeringRequests);
      setShowEngRequestPanel(false);
      setEngNotes("");
      setEngFile(null);
      toast("Custom engineering requested", "success");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to request custom engineering."));
    } finally {
      setEngBusy(false);
    }
  }

  async function respondToEngineering(requestId, action) {
    if (engReplyBusyId) return;
    const message = String(engReplyDrafts[requestId] || "").trim();
    const file = engReplyFiles[requestId] || null;
    if (action === "reply" && !message && !file) {
      toast("Write a reply or attach a datasheet for Engineering.", "error");
      return;
    }
    setEngReplyBusyId(requestId);
    try {
      const body = new FormData();
      body.append("action", action);
      if (message) body.append("message", message);
      if (file) body.append("file", file);
      const data = await apiFetch(`/quotes/${id}/engineering-requests/${requestId}/sales-response`, { method: "POST", body });
      setEngineeringRequests(Array.isArray(data?.requests) ? data.requests : engineeringRequests);
      setEngReplyDrafts((prev) => ({ ...prev, [requestId]: "" }));
      setEngReplyFiles((prev) => ({ ...prev, [requestId]: null }));
      toast(action === "accept" ? "Engineering return accepted and closed." : "Reply sent back to Engineering.", "success");
    } catch (e) {
      toast(getApiErrorMessage(e, "Could not send the response to Engineering."), "error");
    } finally {
      setEngReplyBusyId(null);
    }
  }

  async function submitForApproval() {
    if (revision?.revision_status !== "draft") return;
    const ok = window.confirm("Submit this revision for approval?");
    if (!ok) return;
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/submit-approval`, { method: "POST" });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setEditing(false);
      setDraftLines([]);
      setApproval(data?.approval || approval);
      runQuietly(() => refreshMailBootstrap());
      await refreshTermsAndMeta();
    } catch (e) {
      if (e?.data?.approval) setApproval(e.data.approval);
      if (e?.data?.error === "APPROVAL_NOT_REQUIRED") {
        setError("Approval is not required for this revision. You can issue it directly.");
      } else if (e?.data?.error === "APPROVER_NOT_CONFIGURED") {
        setError("Approval chain is not configured. Assign managers with quote approval rights.");
      } else {
        setError(getApiErrorMessage(e, "Failed to submit for approval."));
      }
    } finally {
      setSaving(false);
    }
  }

  async function approveRevision(andSend = false) {
    if (!approval.can_actor_approve || !canApproveQuotes) return;
    const sendAfter = andSend === true;
    const remarks = window.prompt("Approval remarks (optional):", "");
    if (remarks === null) return;
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ remarks: remarks || "", and_issue: sendAfter }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setEditing(false);
      setDraftLines([]);
      setApproval(data?.approval || approval);
      const approverName = approval.current_approver?.full_name || "the assigned approver";
      const authorityNote =
        data?.approval_authority === "cover"
          ? ` You approved as cover for ${approverName}.`
          : data?.approval_authority === "senior"
            ? ` You approved in place of ${approverName} as their senior manager.`
            : "";
      if (sendAfter && data?.issued) {
        toast(`Approved and issued.${authorityNote} Review the mail and send it.`, "success");
        setShowMailComposer(true);
        runQuietly(() => refreshMailBootstrap());
        setTimeout(() => document.getElementById("quote-send-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
      } else if (sendAfter) {
        const blockers = Array.isArray(data?.issue_blockers) ? data.issue_blockers : [];
        const still = data?.revision?.revision_status === "pending_approval";
        setError(
          still
            ? `Approved your step.${authorityNote} The next approver still has to approve before it can be sent.`
            : `Approved.${authorityNote} It could not be issued yet: ${blockers.map((b) => b.label || b.key).join("; ") || "check the quote details"}.`
        );
      } else if (authorityNote) {
        toast(`Approved.${authorityNote}`, "success");
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to approve revision."));
    } finally {
      setSaving(false);
    }
  }

  async function rejectRevision() {
    if (!approval.can_actor_approve || !canApproveQuotes) return;
    const remarks = window.prompt("Rejection remarks:", "");
    if (remarks === null) return;
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ remarks: remarks || "" }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setEditing(false);
      setDraftLines([]);
      setApproval(data?.approval || approval);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to reject revision."));
    } finally {
      setSaving(false);
    }
  }

  async function saveCommercial() {
    setCommercialSaving(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/commercial`, {
        method: "PUT",
        body: JSON.stringify({
          attention_to: commercialForm.attention_to,
          pricing_display_mode: commercialForm.pricing_display_mode,
          is_export: commercialForm.is_export,
          incoterm_id: commercialForm.incoterm_id ? Number(commercialForm.incoterm_id) : null,
          base_currency_id: commercialForm.base_currency_id ? Number(commercialForm.base_currency_id) : null,
          quote_currency_id: commercialForm.quote_currency_id ? Number(commercialForm.quote_currency_id) : null,
          payment_term_id: commercialForm.payment_term_id ? Number(commercialForm.payment_term_id) : null,
          freight_term_id: commercialForm.freight_term_id ? Number(commercialForm.freight_term_id) : null,
          delivery_lead_time_days: commercialForm.delivery_lead_time_days === "" ? null : Number(commercialForm.delivery_lead_time_days),
          warranty_months: commercialForm.warranty_months === "" ? null : Number(commercialForm.warranty_months),
        }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      await refreshTermsAndMeta();
      runQuietly(() => refreshMailBootstrap());
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save commercial settings."));
    } finally {
      setCommercialSaving(false);
    }
  }

  async function sendQuoteMail({ confirmResend = false, confirmLarge = false } = {}) {
    setMailSending(true);
    setMailNotice("");
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/send-mail`, {
        method: "POST",
        body: JSON.stringify({
          to: mailForm.to,
          cc: mailForm.cc,
          bcc: mailForm.bcc,
          subject: mailForm.subject,
          body: mailForm.body,
          clubbed: mailForm.clubbed,
          confirm_resend: confirmResend === true,
          confirm_large_attachments: confirmLarge === true,
        }),
      });
      setMailBootstrap((prev) => ({
        ...prev,
        history: Array.isArray(data?.history) ? data.history : prev.history,
      }));
      const skipped = Array.isArray(data?.warnings) && data.warnings.length ? ` Note: ${data.warnings.join(" ")}` : "";
      setMailNotice(
        data?.warning === "SENT_BUT_NOT_RECORDED"
          ? "The email reached the customer, but Josh could not update the quote record. Do not resend — ask your administrator to check the mail history."
          : `Quote mail sent successfully.${skipped}`
      );
    } catch (e) {
      if (e?.data?.error === "RECENTLY_SENT") {
        const when = e.data.sent_at ? new Date(e.data.sent_at).toLocaleTimeString() : "a few minutes ago";
        const again = window.confirm(
          `This quote was already emailed to ${e.data.recipient_to || "the same recipients"} at ${when}.\n\nSend it again anyway?`
        );
        setMailSending(false);
        if (again) await sendQuoteMail({ confirmResend: true, confirmLarge });
        return;
      }
      if (e?.data?.error === "ATTACHMENTS_TOO_LARGE") {
        const mb = (v) => `${((Number(v) || 0) / (1024 * 1024)).toFixed(1)} MB`;
        const again = window.confirm(
          `The attachments add up to ${mb(e.data.total_bytes)}, above the ${mb(e.data.limit_bytes)} safe limit. Many customer mailboxes reject emails this large.\n\nSend anyway?`
        );
        setMailSending(false);
        if (again) await sendQuoteMail({ confirmResend, confirmLarge: true });
        return;
      }
      if (Array.isArray(e?.data?.history)) {
        setMailBootstrap((prev) => ({
          ...prev,
          history: e.data.history,
        }));
      } else {
        refreshMailBootstrap().catch(() => {});
      }
      if (e?.data?.error === "REVISION_NOT_ISSUED") {
        setError("Issue the revision before sending it to the customer.");
      } else if (e?.data?.error === "MAILBOX_RECONNECT_REQUIRED") {
        setError(
          `Your Gmail connection${e.data.sender_email ? ` (${e.data.sender_email})` : ""} has expired, so nothing was sent. Reconnect it under Mail Accounts, then send again.`
        );
      } else if (e?.data?.error === "MAIL_ACCOUNT_NOT_CONFIGURED") {
        setError("No mailbox is set up to send from. Connect your Gmail under Mail Accounts, or ask your administrator to set the company mailbox.");
      } else if (e?.data?.error === "NO_RECIPIENT") {
        setError("Add at least one recipient email in the To field.");
      } else if (e?.data?.error === "MISSING_SUBJECT") {
        setError("Add a subject line before sending.");
      } else if (e?.data?.error === "MAIL_SEND_FAILED") {
        const details = e?.data?.mail_error?.message ? ` Reason: ${e.data.mail_error.message}` : "";
        setError(`The email could not be sent, so the customer has not received it.${details}`);
      } else if (Number.isInteger(e?.status) && e.status >= 400) {
        const detail = typeof e?.data?.detail === "string" ? e.data.detail.trim() : "";
        const safeDetail = detail && !looksLikeHtml(detail) ? ` ${detail}` : "";
        setError(`The email could not be sent (HTTP ${e.status}).${safeDetail} Please try again; if it keeps failing, contact your administrator.`);
      } else {
        setError("The email could not be sent. Please try again in a moment.");
      }
    } finally {
      setMailSending(false);
    }
  }

  async function createSalesOrder() {
    if (revision?.revision_status !== "issued") return;
    setCreatingSalesOrder(true);
    setError("");
    try {
      const data = await apiFetch(`/sales-orders/from-quote/${id}`, { method: "POST" });
      const so = data?.sales_order || null;
      const salesOrderId = so?.id;
      if (so) {
        setSalesOrder(so);
        setSalesOrderId(Number(so.id) || null);
      }
      if (salesOrderId && onOpenSalesOrder) {
        onOpenSalesOrder(salesOrderId);
      }
      return data;
    } catch (e) {
      if (e?.data?.error === "SALES_ORDER_ALREADY_EXISTS" && e?.data?.sales_order_id) {
        const existingId = Number(e.data.sales_order_id);
        setSalesOrderId(existingId);
        if (e?.data?.so_number) {
          setSalesOrder((prev) => ({ ...(prev || {}), id: existingId, so_number: e.data.so_number }));
        }
        if (onOpenSalesOrder) onOpenSalesOrder(existingId);
        return { ok: true, sales_order: { id: existingId, so_number: e.data.so_number } };
      }
      if (e?.data?.error === "QUOTE_NOT_ISSUED") {
        setError("Only issued quote revisions can be converted into sales orders.");
      } else {
        setError(getApiErrorMessage(e, "Failed to create sales order."));
      }
      throw e;
    } finally {
      setCreatingSalesOrder(false);
    }
  }

  async function pressFitLinkQuoteToSalesOrder() {
    if (revision?.revision_status !== "issued") {
      const err = new Error("Only issued quote revisions can be converted into sales orders.");
      err.data = { error: "QUOTE_NOT_ISSUED" };
      throw err;
    }
    await createSalesOrder();
  }

  async function createProformaFromQuote() {
    const ok = window.confirm("Create an advance Proforma (30%) from this quote? A sales order will be created if needed.");
    if (!ok) return;
    setCreatingProforma(true);
    setError("");
    try {
      const data = await apiFetch(`/proforma-invoices/from-quote/${id}`, {
        method: "POST",
        body: JSON.stringify({ billed_percent: 30 }),
      });
      setMailNotice(data?.proforma?.proforma_number ? `Proforma ${data.proforma.proforma_number} created.` : "Proforma created.");
      if (data?.sales_order_id) {
        setSalesOrderId(Number(data.sales_order_id));
      }
      const proformaId = Number(data?.proforma?.id);
      if (Number.isFinite(proformaId) && proformaId > 0 && typeof onOpenProforma === "function") {
        onOpenProforma(proformaId);
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to create proforma from quote."));
    } finally {
      setCreatingProforma(false);
    }
  }

  async function saveCadence(e) {
    e.preventDefault();
    setSavingCadence(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${id}/cadence`, {
        method: "PATCH",
        body: JSON.stringify({
          quote_valid_till: cadenceValidTill || null,
          next_follow_up_at: cadenceFollowUp ? new Date(cadenceFollowUp).toISOString() : null,
          quote_kind: cadenceKind || "firm",
        }),
      });
      if (data?.quote) {
        setQuote((prev) => ({ ...(prev || {}), ...data.quote }));
      }
      setMailNotice("Quote cadence saved.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save quote cadence."));
    } finally {
      setSavingCadence(false);
    }
  }

  function startMailConnect() {
    const redirectTo = `/?page=quotes&quoteId=${id}`;
    window.location.href = `/mail-accounts/google/connect?redirectTo=${encodeURIComponent(redirectTo)}`;
  }

  async function disconnectMyMailbox() {
    setMailLoading(true);
    setError("");
    setMailNotice("");
    try {
      await apiFetch(`/mail-accounts/me/disconnect`, { method: "POST", body: JSON.stringify({}) });
      await refreshMailBootstrap();
      setMailNotice("Mailbox disconnected.");
    } catch {
      setError("Failed to disconnect mailbox.");
    } finally {
      setMailLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1260 }}>
      <div style={executiveSurfaceStyle}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr)",
            gap: 12,
            alignItems: "start",
          }}
        >
          {!embedded ? <button onClick={onBack}>Back</button> : null}
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <h2 style={{ margin: 0 }}>{quote.quote_number}</h2>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.78 }}>
                  {quote.customer_name} • {quote.quote_status}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "5px 10px",
                    borderRadius: 999,
                    background: stageTone,
                    color: stageColor,
                    fontSize: 11,
                    fontWeight: 700,
                    border: "1px solid rgba(0,0,0,0.05)",
                    textTransform: "capitalize",
                  }}
                >
                  {revisionStateLabel}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "5px 10px",
                    borderRadius: 999,
                    background: approval.approval_required ? "#fff5de" : "#eef8f1",
                    color: approval.approval_required ? "#8a5a00" : "#0b6b38",
                    fontSize: 11,
                    fontWeight: 700,
                    border: "1px solid rgba(0,0,0,0.05)",
                  }}
                >
                  {approval.approval_required ? "Approval Needed" : "Approval Clear"}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "5px 10px",
                    borderRadius: 999,
                    background: mailReady ? "#eef8f1" : "#f4f6fb",
                    color: mailReady ? "#0b6b38" : "#50607f",
                    fontSize: 11,
                    fontWeight: 700,
                    border: "1px solid rgba(0,0,0,0.05)",
                  }}
                >
                  {mailReady ? "Mail Ready" : "Mail Locked"}
                </span>
              </div>
            </div>
            <BlockerRibbon blockers={quoteBlockers} />
            <div
              style={{
                marginTop: 12,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 10,
              }}
            >
              <div style={compactMetricStyle}>
                <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.08em" }}>Revision</div>
                <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800, color: "#1f3a6d" }}>{revision?.revision_no || "—"}</div>
              </div>
              <div style={compactMetricStyle}>
                <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.08em" }}>Pricing Mode</div>
                <div style={{ marginTop: 6, fontSize: 15, fontWeight: 700, color: "#1f3a6d" }}>{revision?.pricing_display_mode || "—"}</div>
              </div>
              <div style={compactMetricStyle}>
                <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.08em" }}>Quote Currency</div>
                <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800, color: "#1f3a6d" }}>{quoteCurrencyCode}</div>
              </div>
              <div style={compactMetricStyle}>
                <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.08em" }}>Grand Total</div>
                <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800, color: "#1f3a6d" }}>{fmt(uiGrand)}</div>
              </div>
            </div>
          </div>
        </div>
        <div
          style={{
            marginTop: 12,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 10,
          }}
        >
          <div style={actionClusterStyle}>
            <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.08em" }}>Workspace</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="button-primary"
                onClick={onOpenBuilder}
                disabled={saving}
                style={{ fontWeight: 800 }}
              >
                {revision?.revision_status === "draft" ? "Continue in builder" : "Open in builder"}
              </button>
              {editing ? (
                <>
                  <button onClick={() => setEditing(false)} disabled={saving}>
                    Cancel
                  </button>
                  <button onClick={saveEdits} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                </>
              ) : (
                <button onClick={startEdit} disabled={!canEdit}>
                  Edit Lines
                </button>
              )}
              <button onClick={createRevision} disabled={saving || editing || revision?.revision_status === "draft"}>
                New Revision
              </button>
              <button type="button" onClick={loadRevisionCompare} disabled={revisionCompareLoading}>
                {revisionCompareLoading ? "Comparing…" : "Compare revisions"}
              </button>
              {String(quote?.quote_status || "").toLowerCase() === "lapsed" ? (
                <button type="button" className="button-primary" onClick={reviveQuote} disabled={reviveBusy}>
                  {reviveBusy ? "Reviving…" : "Revive quote"}
                </button>
              ) : null}
              {quote?.lead_id && typeof onOpenLead === "function" ? (
                <button type="button" onClick={() => onOpenLead(Number(quote.lead_id))}>
                  Open Lead
                </button>
              ) : null}
              {hasLinkedSalesOrder && typeof onOpenSalesOrder === "function" ? (
                <button
                  type="button"
                  className="button-primary"
                  onClick={() => onOpenSalesOrder(resolvedSalesOrderId)}
                  style={{ fontWeight: 800 }}
                >
                  Open Sales Order
                </button>
              ) : null}
              {["issued", "sent", "approved", "converted"].includes(String(quote?.quote_status || "").toLowerCase()) || hasLinkedSalesOrder ? (
                <button type="button" onClick={createProformaFromQuote} disabled={creatingProforma || saving || editing}>
                  {creatingProforma ? "Creating PI…" : "Create Proforma (advance)"}
                </button>
              ) : null}
              {!["closed", "cancelled", "converted"].includes(String(quote?.quote_status || "").toLowerCase()) ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setShowClosePanel((prev) => !prev);
                      setShowEngRequestPanel(false);
                      if (!closeReasonId && quoteBootstrap.quote_closure_reasons?.[0]?.id) {
                        setCloseReasonId(String(quoteBootstrap.quote_closure_reasons[0].id));
                      }
                    }}
                    disabled={saving || editing}
                  >
                    {showClosePanel ? "Hide Close" : "Close Quote"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowEngRequestPanel((prev) => !prev);
                      setShowClosePanel(false);
                    }}
                    disabled={saving || editing}
                  >
                    {showEngRequestPanel ? "Hide Engineering" : "Request Custom Engineering"}
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <div style={actionClusterStyle}>
            <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.08em" }}>Next Step</div>
            <div style={{ fontWeight: 800, color: "#1f3a6d", fontSize: 14 }}>{nextAction.title}</div>
            <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>{nextAction.note}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {nextAction.actions.map((action) => (
                <button
                  key={action.label}
                  onClick={action.onClick}
                  disabled={action.disabled}
                  style={
                    action.tone === "primary"
                      ? { background: "linear-gradient(180deg, #edf3ff 0%, #f7fbff 100%)", borderColor: "#cfe0ff" }
                      : action.tone === "success"
                        ? { background: "linear-gradient(180deg, #f2fbf5 0%, #fbfffc 100%)", borderColor: "#cfe7d6" }
                        : action.tone === "danger"
                          ? { background: "linear-gradient(180deg, #fff4f4 0%, #fffafa 100%)", borderColor: "#f3c7c7" }
                          : undefined
                  }
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {revision?.revision_status === "issued" || hasLinkedSalesOrder ? (
        <div
          style={{
            ...sectionSurfaceStyle,
            marginTop: 12,
            background: "#f8fafc",
            display: "grid",
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontWeight: 800, fontSize: 14 }}>Press-fit quote → sales order</div>
            <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4, lineHeight: 1.5 }}>
              Mechanical handoff from issued quote into the plant-to-cash order. Crimp locks only after the SO is created.
            </div>
          </div>
          <div style={{ overflowX: "auto", paddingBottom: 4 }}>
            <div style={{ minWidth: 320 }}>
              <PressFitLinker
                leftLabel={quote?.quote_number || `Quote #${id}`}
                rightLabel={
                  salesOrder?.so_number ||
                  (hasLinkedSalesOrder ? `SO #${resolvedSalesOrderId}` : "New sales order")
                }
                linked={hasLinkedSalesOrder}
                disabled={saving || editing || creatingSalesOrder || revision?.revision_status !== "issued"}
                linkLabel="Link quote → SO"
                linkedLabel="Converted · Crimped"
                onLink={pressFitLinkQuoteToSalesOrder}
                onError={(err) => toast(getApiErrorMessage(err, "Could not create sales order."), "error")}
                onLinked={() =>
                  toast(
                    salesOrder?.so_number
                      ? `Sales order ${salesOrder.so_number} linked`
                      : "Sales order created from quote",
                    "success"
                  )
                }
              />
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ ...sectionSurfaceStyle, marginTop: 12 }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>Quote cadence</div>
        <form onSubmit={saveCadence} style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Valid till
            <input type="date" value={cadenceValidTill} onChange={(e) => setCadenceValidTill(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Next follow-up
            <input type="datetime-local" value={cadenceFollowUp} onChange={(e) => setCadenceFollowUp(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Quote kind
            <select value={cadenceKind} onChange={(e) => setCadenceKind(e.target.value)}>
              <option value="firm">firm</option>
              <option value="budgetary">budgetary</option>
            </select>
          </label>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" disabled={savingCadence}>
              {savingCadence ? "Saving…" : "Save cadence"}
            </button>
          </div>
        </form>
      </div>

      {revisionCompare ? (
        <div style={{ ...sectionSurfaceStyle, marginTop: 12 }}>
          <div style={{ fontWeight: 800 }}>Revision compare</div>
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
            Rev {revisionCompare.from_revision?.revision_no || "—"} → Rev {revisionCompare.to_revision?.revision_no || "—"}
          </div>
          <div style={{ marginTop: 10, display: "grid", gap: 8, fontSize: 13 }}>
            {(revisionCompare.lines?.added || []).map((line) => (
              <div key={`add-${line.line_no}-${line.item_name}`}>Added #{line.line_no} {line.item_name} · qty {line.qty} · {Number(line.unit_price_quote || 0).toFixed(2)}</div>
            ))}
            {(revisionCompare.lines?.removed || []).map((line) => (
              <div key={`rm-${line.line_no}-${line.item_name}`}>Removed #{line.line_no} {line.item_name}</div>
            ))}
            {(revisionCompare.lines?.changed || []).map((line) => (
              <div key={`ch-${line.line_no}-${line.item_name}`}>
                Changed #{line.line_no} {line.item_name}: qty {line.from_qty}→{line.to_qty}, price {Number(line.from_unit_price_quote || 0).toFixed(2)}→{Number(line.to_unit_price_quote || 0).toFixed(2)}, disc {Number(line.from_discount_pct || 0).toFixed(2)}%→{Number(line.to_discount_pct || 0).toFixed(2)}%
              </div>
            ))}
            {!revisionCompare.lines?.added?.length && !revisionCompare.lines?.removed?.length && !revisionCompare.lines?.changed?.length ? (
              <div style={{ opacity: 0.7 }}>No line differences between these revisions.</div>
            ) : null}
            {revisionCompare.commercial ? (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #e8eef8" }}>
                {[
                  revisionCompare.commercial.payment_term_changed ? "Payment term changed" : null,
                  revisionCompare.commercial.freight_term_changed ? "Freight term changed" : null,
                  revisionCompare.commercial.incoterm_changed ? "Incoterm changed" : null,
                  revisionCompare.commercial.p_and_f_term_changed ? "P&F term changed" : null,
                  revisionCompare.commercial.delivery_lead_time_changed
                    ? `Lead time ${revisionCompare.from_revision?.delivery_lead_time_days ?? "—"}→${revisionCompare.to_revision?.delivery_lead_time_days ?? "—"} days`
                    : null,
                  revisionCompare.commercial.warranty_months_changed
                    ? `Warranty ${revisionCompare.from_revision?.warranty_months ?? "—"}→${revisionCompare.to_revision?.warranty_months ?? "—"} months`
                    : null,
                ]
                  .filter(Boolean)
                  .map((label) => (
                    <div key={label}>{label}</div>
                  ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {mailNotice ? <div style={{ color: "#0b6b38", marginTop: 12 }}>{mailNotice}</div> : null}
      {String(quote?.quote_status || "").toLowerCase() === "closed" ? (
        <div style={{ ...sectionSurfaceStyle, marginTop: 12, borderColor: "#f0d9a8", background: "#fffaf0" }}>
          <div style={{ fontWeight: 800 }}>Closed</div>
          <div style={{ marginTop: 6, fontSize: 13 }}>
            Reason: {quote.closure_reason_name || quote.closure_reason_code || "—"}
          </div>
          {quote.customer_po_ref ? <div style={{ marginTop: 6, fontSize: 13 }}>Customer PO: {quote.customer_po_ref}</div> : null}
          {quote.closure_remarks ? <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>{quote.closure_remarks}</div> : null}
        </div>
      ) : null}
      {showClosePanel ? (
        <div style={{ ...sectionSurfaceStyle, marginTop: 12 }}>
          <div style={{ fontWeight: 800 }}>Close Quote</div>
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>Capture win/loss reason for this commercial opportunity.</div>
          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <select value={closeReasonId} onChange={(e) => setCloseReasonId(e.target.value)}>
              <option value="">Select reason</option>
              {(quoteBootstrap.quote_closure_reasons || []).map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.outcome_kind === "won" ? "Won · " : "Lost · "}
                  {reason.reason_name}
                </option>
              ))}
            </select>
            {(quoteBootstrap.quote_closure_reasons || []).find((reason) => String(reason.id) === String(closeReasonId))?.outcome_kind === "won" ? (
              <input
                value={closeCustomerPo}
                onChange={(e) => setCloseCustomerPo(e.target.value)}
                placeholder="Customer PO number"
              />
            ) : null}
            <textarea
              value={closeRemarks}
              onChange={(e) => setCloseRemarks(e.target.value)}
              placeholder="Optional remarks"
              rows={3}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setShowClosePanel(false)} disabled={closeBusy}>
                Cancel
              </button>
              <button type="button" className="button-primary" onClick={closeQuoteFromDetail} disabled={closeBusy || !closeReasonId}>
                {closeBusy ? "Closing…" : "Submit Close"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showEngRequestPanel ? (
        <div style={{ ...sectionSurfaceStyle, marginTop: 12 }}>
          <div style={{ fontWeight: 800 }}>Request Custom Engineering</div>
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
            Optional handoff for non-standard / custom requirements. Standard catalog quotes can skip this.
          </div>
          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <textarea
              value={engNotes}
              onChange={(e) => setEngNotes(e.target.value)}
              placeholder="Technical Requirements / Notes"
              rows={4}
            />
            <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
              Attach Customer Datasheet / Specs
              <input type="file" onChange={(e) => setEngFile(e.target.files?.[0] || null)} />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setShowEngRequestPanel(false)} disabled={engBusy}>
                Cancel
              </button>
              <button type="button" className="button-primary" onClick={submitEngineeringRequest} disabled={engBusy || !String(engNotes || "").trim()}>
                {engBusy ? "Sending…" : "Send to Engineering"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {engineeringRequests.length ? (
        <div id="quote-eng-responses" style={{ ...sectionSurfaceStyle, marginTop: 12 }}>
          <div style={{ fontWeight: 800 }}>Engineering Responses</div>
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>Sales ↔ Engineering datasheet handoff for this quote.</div>
          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            {engineeringRequests.map((req) => (
              <div key={req.id} style={subtleSurfaceStyle}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <strong>{req.request_title || `Request #${req.id}`}</strong>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>{req.request_status}</span>
                </div>
                {req.request_details ? <div style={{ marginTop: 6, fontSize: 13 }}>{req.request_details}</div> : null}
                {(req.attachments || []).length ? (
                  <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {req.attachments.map((att) => (
                      <a
                        key={att.id}
                        href={`/quotes/${id}/engineering-attachments/${att.id}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 12 }}
                      >
                        {att.direction === "engineering_return" ? "Engineering datasheet" : "Customer datasheet"}: {att.file_name}
                      </a>
                    ))}
                  </div>
                ) : (
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>No returned datasheet yet.</div>
                )}
                {["new", "in_review", "waiting_input", "ready"].includes(String(req.request_status || "")) ? (
                  <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                    {req.request_status === "waiting_input" ? (
                      <div style={{ fontSize: 12, color: "#b45309", fontWeight: 700 }}>Engineering is waiting on your input.</div>
                    ) : null}
                    {req.request_status === "ready" ? (
                      <div style={{ fontSize: 12, color: "#0a7a35", fontWeight: 700 }}>
                        Engineering has returned this. Update the quote, then accept to close the request.
                      </div>
                    ) : null}
                    <textarea
                      rows={2}
                      placeholder={req.request_status === "ready" ? "Optional note or follow-up question" : "Reply to Engineering"}
                      value={engReplyDrafts[req.id] || ""}
                      onChange={(e) => setEngReplyDrafts((prev) => ({ ...prev, [req.id]: e.target.value }))}
                      disabled={engReplyBusyId === req.id}
                    />
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <input
                        type="file"
                        onChange={(e) => setEngReplyFiles((prev) => ({ ...prev, [req.id]: e.target.files?.[0] || null }))}
                        disabled={engReplyBusyId === req.id}
                      />
                      <button
                        type="button"
                        className={req.request_status === "waiting_input" ? "button-primary" : "button-ghost"}
                        disabled={engReplyBusyId === req.id}
                        onClick={() => respondToEngineering(req.id, "reply")}
                      >
                        {req.request_status === "waiting_input" ? "Reply to Engineering" : "Send follow-up"}
                      </button>
                      {req.request_status === "ready" ? (
                        <button
                          type="button"
                          className="button-primary"
                          disabled={engReplyBusyId === req.id}
                          onClick={() => respondToEngineering(req.id, "accept")}
                        >
                          Accept &amp; close
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {pdfWarnings.length ? (
        <div style={{ color: "#8a5a00", marginTop: 12, fontSize: 12 }}>
          Delivery warnings: {pdfWarnings.join(" • ")}
        </div>
      ) : null}

      <div style={{ ...sectionSurfaceStyle, marginTop: 16, padding: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>Quote Delivery</div>
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>
              Preview the proposal, check what is still missing, and open the send panel only when you are ready to face the customer.
            </div>
          </div>
          <button onClick={() => window.open(`/quotes/${id}/pdf`, "_blank", "noopener,noreferrer")} disabled={saving}>
            Open Proposal
          </button>
          <button onClick={() => window.open(`/quotes/${id}/pdf?club=1`, "_blank", "noopener,noreferrer")} disabled={saving}>
            Open Lump-sum PDF (prices hidden)
          </button>
          <button onClick={() => setShowMailComposer((prev) => !prev)} disabled={mailLoading}>
            {showMailComposer ? "Hide Send Panel" : "Open Send Panel"}
          </button>
        </div>
        <div
          style={{
            marginTop: 10,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 10,
          }}
        >
          {handoffChecks.map((check) => (
            <div key={check.label} style={subtleSurfaceStyle}>
              <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>{check.label}</div>
              <div style={{ marginTop: 6, fontSize: 14, fontWeight: 800, color: check.ok ? "#0b6b38" : "#8a5a00" }}>{check.value}</div>
            </div>
          ))}
        </div>
      </div>

      {showMailComposer ? (
        <div id="quote-send-panel" style={{ ...sectionSurfaceStyle, marginTop: 16 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>Customer Delivery</div>
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>
                Confirm the recipient, review the proposal pack, and send the issued quote without leaving the guided flow.
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={mailForm.clubbed}
                onChange={(e) => setMailForm((prev) => ({ ...prev, clubbed: e.target.checked }))}
                disabled={mailSending}
              />
              Send as lump-sum offer (hide line prices)
            </label>
            <button
              onClick={() => sendQuoteMail()}
              disabled={!canSendQuoteNow}
            >
              {mailSending ? "Sending..." : "Send Quote"}
            </button>
            <button type="button" onClick={restoreMailPrefill} disabled={mailSending || mailLoading}>
              Restore Prefill
            </button>
          </div>

          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            {deliveryChecklist.map((check) => (
              <DeliveryCheckCard key={check.label} label={check.label} value={check.value} note={check.note} tone={check.tone} />
            ))}
          </div>

          {revision?.revision_status !== "issued" ? (
            <div style={{ color: "#8a6708", marginTop: 8, fontSize: 12 }}>
              Issue the revision first. Customer mail sending is enabled only for issued quotes.
            </div>
          ) : null}
          {revision?.revision_status === "issued" && !effectiveMailSource?.connected ? (
            <div style={{ color: "#b4234d", marginTop: 8, fontSize: 12 }}>
              Mailbox connection is still missing, so delivery cannot be sent until a sender route is configured.
            </div>
          ) : null}

          <div style={{ ...subtleSurfaceStyle, marginTop: 12 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>Delivery Route</div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>
                  This shows who the mail comes from and how the current default routing is being applied.
                </div>
              </div>
              <button type="button" onClick={() => setShowMailSetup((prev) => !prev)}>
                {showMailSetup ? "Hide Mail Setup" : "Mailbox Setup"}
              </button>
              <button type="button" onClick={() => setShowMailHistory((prev) => !prev)}>
                {showMailHistory ? "Hide Delivery History" : `Delivery History (${Array.isArray(mailBootstrap.history) ? mailBootstrap.history.length : 0})`}
              </button>
            </div>
            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>Owner</div>
                <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700 }}>{quote?.owner_name || mailBootstrap.sender?.full_name || me?.full_name || "—"}</div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>{quote?.owner_email || mailBootstrap.sender?.email || "—"}</div>
                {revision?.edited_by_name && revision.edited_by_name !== quote?.owner_name ? (
                  <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>Last edited by {revision.edited_by_name}</div>
                ) : null}
              </div>
              {mailBootstrap.send_as ? (
                <div>
                  <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>Customer Sees It From</div>
                  <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700 }}>{mailBootstrap.send_as.from || "No sender available"}</div>
                  <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72, lineHeight: 1.5 }}>
                    {mailBootstrap.send_as.mode === "owner_address"
                      ? `Sent from ${mailBootstrap.send_as.owner?.full_name || "the owner"}'s mailbox on their behalf. It lands in their Sent folder.`
                      : mailBootstrap.send_as.mode === "fallback_cc"
                        ? `${mailBootstrap.send_as.owner?.full_name || "The owner"}'s mailbox can't be used, so it goes from yours with them in CC.`
                        : "Sent from your own mailbox."}
                  </div>
                </div>
              ) : null}
              <div>
                <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>Sending Mailbox</div>
                <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700 }}>
                  {effectiveMailSource?.connected ? effectiveMailSource.email || "Mailbox ready" : "Not configured"}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>
                  {effectiveMailSource?.connected ? effectiveMailSource.source || "Active sender" : "No sender route yet"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>Manager CC</div>
                <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.6 }}>
                  {Array.isArray(mailBootstrap.cc_users) && mailBootstrap.cc_users.length
                    ? mailBootstrap.cc_users.map((u) => `${u.full_name || u.email} (${u.email})`).join(", ")
                    : "No manager CC default"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>Fallback Route</div>
                <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700 }}>
                  {mailBootstrap.mail_source?.company_default_available ? "Company mailbox ready" : "No company fallback"}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>
                  {mailBootstrap.mail_source?.distributor_shared_account?.connected
                    ? `${mailBootstrap.mail_source.distributor_shared_account.mailbox_email} available`
                    : "Shared mailbox is not connected"}
                </div>
              </div>
            </div>
          </div>

          {showMailSetup ? (
            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
              <div style={subtleSurfaceStyle}>
                <div style={{ fontWeight: 600 }}>Your Mailbox</div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.76 }}>
                  {mailBootstrap.mail_source?.user_account?.connected
                    ? `${mailBootstrap.mail_source.user_account.mailbox_email} (${mailBootstrap.mail_source.user_account.provider})`
                    : "Not connected"}
                </div>
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button type="button" onClick={startMailConnect} disabled={mailLoading || mailSending}>
                    {mailBootstrap.mail_source?.user_account?.connected ? "Reconnect Google Mail" : "Connect Google Mail"}
                  </button>
                  {mailBootstrap.mail_source?.user_account?.connected ? (
                    <button type="button" onClick={disconnectMyMailbox} disabled={mailLoading || mailSending}>
                      Disconnect
                    </button>
                  ) : null}
                </div>
              </div>
              <div style={subtleSurfaceStyle}>
                <div style={{ fontWeight: 600 }}>Distributor Shared Mailbox</div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.76 }}>
                  {mailBootstrap.mail_source?.distributor_shared_account?.connected
                    ? `${mailBootstrap.mail_source.distributor_shared_account.mailbox_email} (${mailBootstrap.mail_source.distributor_shared_account.provider})`
                    : "Not connected"}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
                  SuperAdmin manages distributor shared mailbox from Admin Masters.
                </div>
              </div>
            </div>
          ) : null}

          <div style={{ ...subtleSurfaceStyle, marginTop: 12 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>Recipient And Message</div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>
                  The form opens with quote defaults. Adjust only when this delivery needs a different recipient or cover note.
                </div>
              </div>
            </div>

            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
              <Field label="To">
                <input
                  value={mailForm.to}
                  onChange={(e) => setMailForm((prev) => ({ ...prev, to: e.target.value }))}
                  placeholder="client@example.com"
                  disabled={mailSending}
                />
              </Field>
              <Field label="CC">
                <input
                  value={mailForm.cc}
                  onChange={(e) => setMailForm((prev) => ({ ...prev, cc: e.target.value }))}
                  placeholder="manager1@example.com, manager2@example.com"
                  disabled={mailSending}
                />
              </Field>
              <Field label="BCC">
                <input
                  value={mailForm.bcc}
                  onChange={(e) => setMailForm((prev) => ({ ...prev, bcc: e.target.value }))}
                  placeholder="Optional"
                  disabled={mailSending}
                />
              </Field>
              <Field label="Mail Style">
                <select
                  value={mailForm.preset_key || mailBootstrap.default_preset_key || ""}
                  onChange={(e) => applyMailPreset(e.target.value)}
                  disabled={mailSending || !Array.isArray(mailBootstrap.mail_presets) || !mailBootstrap.mail_presets.length}
                >
                  {(Array.isArray(mailBootstrap.mail_presets) ? mailBootstrap.mail_presets : []).map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Subject">
                <input
                  value={mailForm.subject}
                  onChange={(e) => setMailForm((prev) => ({ ...prev, subject: e.target.value }))}
                  disabled={mailSending}
                />
              </Field>
            </div>

            {selectedMailPreset?.description ? (
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
                {selectedMailPreset.description}
              </div>
            ) : null}

            <Field label="Mail Body">
              <textarea
                value={mailForm.body}
                onChange={(e) => setMailForm((prev) => ({ ...prev, body: e.target.value }))}
                rows={8}
                style={{ width: "100%", resize: "vertical" }}
                disabled={mailSending}
              />
            </Field>
          </div>

          {showMailHistory ? (
            <div style={historyTableShellStyle}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "160px 100px 1fr 1fr",
                  ...historyTableHeaderStyle,
                }}
              >
                <div>Sent At</div>
                <div>Mode</div>
                <div>To</div>
                <div>Subject</div>
              </div>
              {mailLoading ? (
                <div style={softEmptyStateStyle}>Loading mail history…</div>
              ) : Array.isArray(mailBootstrap.history) && mailBootstrap.history.length ? (
                mailBootstrap.history.map((entry) => (
                  <div
                    key={entry.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "160px 100px 1fr 1fr",
                      ...historyTableRowStyle,
                      alignItems: "start",
                    }}
                  >
                    <div>{fmtDateTime(entry.sent_at)}</div>
                    <div>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "4px 8px",
                          borderRadius: 999,
                          background: entry.send_status === "failed" ? "#fff4e8" : entry.opened_at ? "#edf9f0" : "#eef4ff",
                          border:
                            entry.send_status === "failed"
                              ? "1px solid rgba(194,110,37,0.18)"
                              : entry.opened_at
                                ? "1px solid rgba(42,138,77,0.18)"
                                : "1px solid rgba(138,165,221,0.24)",
                          fontSize: 11,
                          fontWeight: 700,
                          color: entry.send_status === "failed" ? "#9a4f10" : entry.opened_at ? "#1f7a43" : "#2954aa",
                        }}
                      >
                        {getMailStatusMeta(entry).label}
                      </span>
                    </div>
                    <div>
                      <div>{entry.recipient_to || "—"}</div>
                      <div style={{ opacity: 0.7 }}>{entry.recipient_cc ? `CC: ${entry.recipient_cc}` : ""}</div>
                    </div>
                    <div>
                      <div>
                        {entry.revision_no != null ? `Rev ${entry.revision_no} • ` : ""}
                        {entry.subject || "—"}
                        {entry.has_sent_pdf ? (
                          <>
                            {" • "}
                            <a href={`/quotes/${id}/mail-logs/${entry.id}/pdf`} target="_blank" rel="noopener noreferrer">
                              View sent PDF
                            </a>
                          </>
                        ) : null}
                      </div>
                      <div style={{ opacity: 0.7 }}>
                        {entry.send_status === "failed"
                          ? entry.error_text || "Failed"
                          : `${entry.sender_email || entry.sent_by_name || entry.sent_by_email || "System"}${entry.sender_source ? ` • ${entry.sender_source}` : ""}${entry.mail_mode ? ` • ${entry.mail_mode}` : ""}${entry.opened_at ? ` • Opened ${fmtDateTime(entry.last_opened_at || entry.opened_at)}` : ""}${entry.smtp_message_id ? ` • ${entry.smtp_message_id}` : ""}`}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div style={softEmptyStateStyle}>No quote mails sent yet.</div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(320px, 0.85fr)", gap: 14 }}>
        <div style={sectionSurfaceStyle}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700, flex: 1 }}>Commercial Setup</div>
            <div style={{ fontSize: 12, opacity: 0.68 }}>Attention, currency and commercial terms</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Attention To">
              <input
                value={commercialForm.attention_to}
                onChange={(e) => setCommercialForm((prev) => ({ ...prev, attention_to: e.target.value }))}
                disabled={!canEditTerms || commercialSaving}
              />
            </Field>
            <Field label="Pricing Mode">
              <select
                value={commercialForm.pricing_display_mode}
                onChange={(e) => setCommercialForm((prev) => ({ ...prev, pricing_display_mode: e.target.value }))}
                disabled={!canEditTerms || commercialSaving}
              >
                {(quoteBootstrap.pricing_modes || []).map((mode) => (
                  <option key={mode.key} value={mode.key}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Base Currency">
              <select
                value={commercialForm.base_currency_id}
                onChange={(e) => setCommercialForm((prev) => ({ ...prev, base_currency_id: e.target.value }))}
                disabled={!canEditTerms || commercialSaving}
              >
                <option value="">—</option>
                {(quoteBootstrap.currencies || []).map((currency) => (
                  <option key={currency.id} value={String(currency.id)}>
                    {currency.currency_code} - {currency.currency_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quote Currency">
              <select
                value={commercialForm.quote_currency_id}
                onChange={(e) => setCommercialForm((prev) => ({ ...prev, quote_currency_id: e.target.value }))}
                disabled={!canEditTerms || commercialSaving}
              >
                <option value="">—</option>
                {(quoteBootstrap.currencies || []).map((currency) => (
                  <option key={currency.id} value={String(currency.id)}>
                    {currency.currency_code} - {currency.currency_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Incoterm">
              <select
                value={commercialForm.incoterm_id}
                onChange={(e) => setCommercialForm((prev) => ({ ...prev, incoterm_id: e.target.value }))}
                disabled={!canEditTerms || commercialSaving}
              >
                <option value="">—</option>
                {(quoteBootstrap.incoterms || []).map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.incoterm_code} - {item.incoterm_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Payment Term">
              <select
                value={commercialForm.payment_term_id}
                onChange={(e) => setCommercialForm((prev) => ({ ...prev, payment_term_id: e.target.value }))}
                disabled={!canEditTerms || commercialSaving}
              >
                <option value="">—</option>
                {(quoteBootstrap.payment_terms || []).map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.term_code} - {item.term_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Freight Term">
              <select
                value={commercialForm.freight_term_id}
                onChange={(e) => setCommercialForm((prev) => ({ ...prev, freight_term_id: e.target.value }))}
                disabled={!canEditTerms || commercialSaving}
              >
                <option value="">—</option>
                {(quoteBootstrap.freight_terms || []).map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.term_code} - {item.term_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Delivery Lead Time (days)">
              <input
                type="number"
                min="0"
                step="1"
                value={commercialForm.delivery_lead_time_days}
                onChange={(e) => setCommercialForm((prev) => ({ ...prev, delivery_lead_time_days: e.target.value }))}
                disabled={!canEditTerms || commercialSaving}
                placeholder="e.g. 45"
              />
            </Field>
            <Field label="Warranty (months)">
              <input
                type="number"
                min="0"
                step="1"
                value={commercialForm.warranty_months}
                onChange={(e) => setCommercialForm((prev) => ({ ...prev, warranty_months: e.target.value }))}
                disabled={!canEditTerms || commercialSaving}
                placeholder="e.g. 12"
              />
            </Field>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 22 }}>
              <input
                type="checkbox"
                checked={commercialForm.is_export}
                onChange={(e) => setCommercialForm((prev) => ({ ...prev, is_export: e.target.checked }))}
                disabled={!canEditTerms || commercialSaving}
              />
              Export Quote
            </label>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={saveCommercial} disabled={!canEditTerms || commercialSaving}>
              {commercialSaving ? "Saving..." : "Save Commercial"}
            </button>
          </div>
        </div>

        <div style={sectionSurfaceStyle}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700 }}>Executive Snapshot</div>
            <div style={{ fontSize: 12, opacity: 0.72 }}>Revision {revision?.revision_no || "—"}</div>
          </div>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
            <div style={subtleSurfaceStyle}>
              <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>Attention To</div>
              <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700 }}>{quote.attention_to || "—"}</div>
            </div>
            <div style={subtleSurfaceStyle}>
              <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>Current Approver</div>
              <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700 }}>{approval.current_approver?.full_name || "—"}</div>
            </div>
          </div>
          <div style={{ marginTop: 10, display: "grid", gap: 8, fontSize: 12, opacity: 0.76 }}>
            <div>Export: {revision?.is_export ? "Yes" : "No"}</div>
            <div>Base Currency: {baseCurrencyCode}</div>
            <div>Quote Currency: {quoteCurrencyCode}</div>
            <div>Approval Needed: {approval.approval_required ? "Yes" : "No"}</div>
          </div>
        </div>
      </div>

      <div style={{ ...sectionSurfaceStyle, marginTop: 16, background: "linear-gradient(180deg, rgba(251,252,255,0.98) 0%, rgba(246,249,255,0.98) 100%)" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, flex: 1 }}>Approval Workflow</div>
          <div style={{ fontSize: 12, opacity: 0.72 }}>{approvalLoading ? "Refreshing..." : revisionStateLabel}</div>
          <button type="button" onClick={() => setShowApprovalHistory((prev) => !prev)}>
            {showApprovalHistory ? "Hide History" : `Show History (${approval.approvals?.length || 0})`}
          </button>
        </div>
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "minmax(260px, 0.8fr) minmax(0, 1.2fr)", gap: 12 }}>
          <div style={{ ...subtleSurfaceStyle, fontSize: 12, lineHeight: 1.7 }}>
            <div>Max Discount: {toNumber(approval.max_discount_pct, 0).toFixed(2)}%</div>
            <div>Autonomous Threshold: {toNumber(approval.autonomous_discount_pct, 0).toFixed(2)}%</div>
            <div>Approval Required: {approval.approval_required ? "Yes" : "No"}</div>
            <div>Current Approver: {approval.current_approver?.full_name || "—"}</div>
          </div>
          <div style={subtleSurfaceStyle}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Approver Chain</div>
            <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
              {(approval.suggested_approvers || []).length ? (
                approval.suggested_approvers.map((approver) => (
                  <div
                    key={approver.id}
                    style={{
                      border: "1px solid #e6ebf5",
                      borderRadius: 12,
                      padding: "9px 11px",
                      fontSize: 12,
                      background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
                    }}
                  >
                    Seq {approver.sequence_no} • {approver.full_name || approver.email}
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 12, opacity: 0.72 }}>No approval chain needed for the current threshold.</div>
              )}
            </div>
          </div>
        </div>
        {approval.triggering_lines?.length ? (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.78 }}>
            Triggering lines:{" "}
            {approval.triggering_lines
              .map((line) => `${line.item_name} (${toNumber(line.discount_pct, 0).toFixed(2)}%)`)
              .join(", ")}
          </div>
        ) : null}
        {showApprovalHistory ? (
          <div style={historyTableShellStyle}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "90px 120px 1fr 160px 1fr",
                ...historyTableHeaderStyle,
              }}
            >
              <div>Cycle</div>
              <div>Status</div>
              <div>Approver</div>
              <div>Acted At</div>
              <div>Remarks</div>
            </div>
            {approval.approvals?.length ? (
              approval.approvals.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "90px 120px 1fr 160px 1fr",
                  ...historyTableRowStyle,
                  }}
                >
                  <div>{entry.approval_cycle_no || "—"}</div>
                  <div>{entry.approval_status || "—"}</div>
                  <div>{entry.approver_name || entry.approver_email || "—"}</div>
                  <div>{fmtDateTime(entry.approved_at || entry.created_at)}</div>
                  <div>{entry.remarks || "—"}</div>
                </div>
              ))
            ) : (
              <div style={softEmptyStateStyle}>No approval history yet.</div>
            )}
          </div>
        ) : null}
      </div>

      <div style={{ ...sectionSurfaceStyle, marginTop: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, flex: 1 }}>Configurator Tools</div>
          <div style={{ fontSize: 12, opacity: 0.72 }}>Nitrogen and Oxygen recommendation helpers</div>
          <button type="button" onClick={() => setShowConfiguratorTools((prev) => !prev)}>
            {showConfiguratorTools ? "Hide Tools" : "Show Tools"}
          </button>
        </div>
        {showConfiguratorTools ? (
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 14 }}>
            <div style={subtleSurfaceStyle}>
              <div style={{ fontWeight: 700 }}>Model Selection (Nitrogen)</div>
          <div
            style={{
              marginTop: 10,
              display: "grid",
              gridTemplateColumns: "160px 180px 1fr",
              gap: 12,
              alignItems: "end",
            }}
          >
            <Field label="Purity">
              <select
                value={nitroPurity}
                onChange={(e) => setNitroPurity(e.target.value)}
                disabled={!canEditTerms || nitroWorking}
              >
                {nitroPurities.map((p) => (
                  <option key={p} value={p}>
                    {p}%
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Required Flow (Nm³/hr)">
              <input
                type="number"
                value={nitroFlow}
                onChange={(e) => setNitroFlow(e.target.value)}
                min={0}
                step={0.1}
                disabled={!canEditTerms || nitroWorking}
              />
            </Field>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={recommendNitrogen} disabled={!canEditTerms || nitroWorking || !nitroFlow}>
                Recommend
              </button>
              <button onClick={applyNitrogen} disabled={!canEditTerms || nitroWorking || !nitroRec}>
                Apply to Quote
              </button>
            </div>
          </div>

          {nitroRec ? (
            <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ ...subtleSurfaceStyle, background: "#fdfefe" }}>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Choose Model</div>
                <div style={{ marginTop: 6, display: "flex", gap: 10, alignItems: "center" }}>
                  <select
                    value={nitroModel}
                    onChange={(e) => setNitroModel(e.target.value)}
                    disabled={!canEditTerms || nitroWorking}
                  >
                    {(nitroRec.options || []).map((o) => (
                      <option key={o.model} value={o.model}>
                        {o.model} (Flow {o.flow})
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    Air req: {nitroRec.recommended?.airRequirement ?? "—"} CFM • Storage:{" "}
                    {nitroRec.recommended?.storageVolume ?? "—"} L • Dry Air Storage:{" "}
                    {nitroRec.recommended?.airVesselVolume ?? "—"} L
                  </div>
                </div>
                {nitroRec.catalog_source_label ? (
                  <div
                    style={{
                      marginTop: 8,
                      padding: "8px 10px",
                      borderRadius: 12,
                      fontSize: 12,
                      lineHeight: 1.55,
                      background: nitroRec.used_family_fallback ? "#fff7ea" : "#eefbf3",
                      border: `1px solid ${nitroRec.used_family_fallback ? "#f4dfb2" : "#ccefd9"}`,
                      color: nitroRec.used_family_fallback ? "#8b5a00" : "#147a3d",
                    }}
                  >
                    {nitroRec.used_family_fallback
                      ? `Sizing source: ${nitroRec.catalog_source_label}. Dedicated compact-family master rows are not configured separately yet.`
                      : `Sizing source: ${nitroRec.catalog_source_label}.`}
                  </div>
                ) : null}
              </div>
              <div style={{ ...subtleSurfaceStyle, background: "#fdfefe" }}>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Suggested Compressor</div>
                <div style={{ marginTop: 6, fontSize: 13 }}>
                  {nitroRec.compressor
                    ? `${nitroRec.compressor.compressorModel} • ${nitroRec.compressor.kw} • ${nitroRec.compressor.airflow} CFM`
                    : "—"}
                </div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                  Apply adds generator + storage vessel + compressor package. Dry Air Storage remains part of the compressor package.
                </div>
              </div>
            </div>
          ) : null}
            </div>

            <div style={subtleSurfaceStyle}>
              <div style={{ fontWeight: 700 }}>Model Selection (Oxygen)</div>
          <div
            style={{
              marginTop: 10,
              display: "grid",
              gridTemplateColumns: "160px 180px 1fr",
              gap: 12,
              alignItems: "end",
            }}
          >
            <Field label="Purity">
              <select
                value={oxygenPurity}
                onChange={(e) => setOxygenPurity(e.target.value)}
                disabled={!canEditTerms || oxygenWorking}
              >
                <option value="95">95%</option>
              </select>
            </Field>
            <Field label="Required Flow (Nm³/hr)">
              <input
                type="number"
                value={oxygenFlow}
                onChange={(e) => setOxygenFlow(e.target.value)}
                min={0}
                step={0.1}
                disabled={!canEditTerms || oxygenWorking}
              />
            </Field>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={recommendOxygen} disabled={!canEditTerms || oxygenWorking || !oxygenFlow}>
                Recommend
              </button>
              <button onClick={applyOxygen} disabled={!canEditTerms || oxygenWorking || !oxygenRec}>
                Apply to Quote
              </button>
            </div>
          </div>

          {oxygenRec ? (
            <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ ...subtleSurfaceStyle, background: "#fdfefe" }}>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Choose Model</div>
                <div style={{ marginTop: 6, display: "flex", gap: 10, alignItems: "center" }}>
                  <select
                    value={oxygenModel}
                    onChange={(e) => setOxygenModel(e.target.value)}
                    disabled={!canEditTerms || oxygenWorking}
                  >
                    {(oxygenRec.options || []).map((o) => (
                      <option key={o.model} value={o.model}>
                        {o.model} (Flow {o.flow})
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    Air req: {oxygenRec.recommended?.airRequirement ?? "—"} CFM • Storage:{" "}
                    {oxygenRec.recommended?.storageVolume ?? "—"} L • Dry Air Storage:{" "}
                    {oxygenRec.recommended?.airVesselVolume ?? "—"} L
                  </div>
                </div>
              </div>
              <div style={{ ...subtleSurfaceStyle, background: "#fdfefe" }}>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Suggested Compressor</div>
                <div style={{ marginTop: 6, fontSize: 13 }}>
                  {oxygenRec.compressor
                    ? `${oxygenRec.compressor.compressorModel} • ${oxygenRec.compressor.kw} • ${oxygenRec.compressor.airflow} CFM`
                    : "—"}
                </div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                  Apply adds generator + storage vessel + compressor package. Dry Air Storage remains part of the compressor package.
                </div>
              </div>
            </div>
          ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 14 }}>
        <div style={sectionSurfaceStyle}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Revision: {revision?.revision_no || "—"} • Mode: {revision?.pricing_display_mode || "—"} • Status:{" "}
            {revisionStateLabel}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
            {editing
              ? "Editing mode is active. Save or cancel changes before issuing or moving to downstream actions."
              : "Review totals and jump straight into line editing without scrolling through long stacked sections."}
          </div>
        </div>

        <div style={sectionSurfaceStyle}>
          <div style={{ fontSize: 12, opacity: 0.75 }}>Totals</div>
          <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
            <div style={{ opacity: 0.8 }}>Subtotal</div>
            <div>{fmt(uiSubtotal)}</div>
            <div style={{ opacity: 0.8 }}>GST</div>
            <div>{fmt(uiTax)}</div>
            <div style={{ fontWeight: 600 }}>Grand Total</div>
            <div style={{ fontWeight: 600 }}>{fmt(uiGrand)}</div>
          </div>
        </div>
      </div>

      <div style={{ ...sectionSurfaceStyle, marginTop: 16, padding: 0, overflowX: "auto" }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid #e5ebf5", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, flex: 1 }}>Quote Lines</div>
          <div style={{ fontSize: 12, opacity: 0.72 }}>
            {uiLines.length} line{uiLines.length === 1 ? "" : "s"} • Subtotal {fmt(uiSubtotal)} • GST {fmt(uiTax)} • Total {fmt(uiGrand)}
          </div>
          {editing ? (
            <button type="button" onClick={() => setShowAddItemComposer((prev) => !prev)}>
              {showAddItemComposer ? "Hide Add Item" : "Show Add Item"}
            </button>
          ) : null}
        </div>

        {editing ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "72px minmax(260px, 1.8fr) 130px 90px 120px 100px 120px 120px 90px",
              gap: 8,
              padding: 12,
              fontSize: 12,
              opacity: 0.8,
              borderBottom: "1px solid #e5e5e5",
              minWidth: 1110,
            }}
          >
            <div>Line</div>
            <div>Item</div>
            <div>Scope</div>
            <div>Qty</div>
            <div>Gross</div>
            <div>Disc %</div>
            <div>Net Unit</div>
            <div>Total</div>
            <div>Action</div>
          </div>
        ) : null}

        {editing ? (
          showAddItemComposer ? (
            <div
              style={{
                padding: 14,
                borderBottom: "1px solid #edf1f7",
                background: "linear-gradient(180deg, rgba(249,251,255,0.98) 0%, rgba(255,255,255,0.98) 100%)",
              }}
            >
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                <div style={{ fontWeight: 700, flex: 1 }}>Add Items</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>Search Product Master, apply pricing, then add directly to the draft.</div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(180px, 220px) minmax(180px, 220px) minmax(320px, 1.4fr)",
                  gap: 10,
                  alignItems: "end",
                }}
              >
                <Field label="Category">
                  <select value={addCategoryId} onChange={(e) => setAddCategoryId(e.target.value)} style={{ width: "100%" }}>
                    <option value="">All</option>
                    {productCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.category_name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Group">
                  <select value={addGroupId} onChange={(e) => setAddGroupId(e.target.value)} style={{ width: "100%" }}>
                    <option value="">All</option>
                    {filteredGroups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.group_name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div style={{ position: "relative" }}>
                  <Field label="Item Name / Code">
                    <input
                      value={addProductQ}
                      onChange={(e) => {
                        setAddProductQ(e.target.value);
                        setAddSelectedProduct(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!addSelectedProduct && addProductResults.length === 1) {
                            setAddSelectedProduct(addProductResults[0]);
                            setAddProductQ(addProductResults[0].item_name || "");
                          } else {
                            addItemToDraft();
                          }
                        }
                      }}
                      placeholder="Type to search"
                      style={{ width: "100%" }}
                    />
                  </Field>
                  {!addSelectedProduct && addProductResults.length ? (
                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        top: 64,
                        zIndex: 5,
                        background: "#fff",
                        border: "1px solid #dfe6f3",
                        borderRadius: 12,
                        maxHeight: 220,
                        overflow: "auto",
                        boxShadow: "0 18px 36px rgba(23,33,56,0.08)",
                      }}
                    >
                      {addProductResults.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setAddSelectedProduct(p);
                            setAddProductQ(p.item_name || "");
                          }}
                          style={{
                            all: "unset",
                            cursor: "pointer",
                            display: "block",
                            padding: "10px 12px",
                            borderBottom: "1px solid #f2f2f2",
                          }}
                        >
                          <div style={{ fontSize: 13, fontWeight: 600 }}>
                            {p.item_name}{" "}
                            <span style={{ fontSize: 12, opacity: 0.7 }}>
                              {p.item_code ? `(${p.item_code})` : ""}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.75 }}>
                            {(p.category_name ? `${p.category_name} • ` : "") + (p.group_name || "—")} • GST {p.gst_pct}% • List {fmt(p.list_price)}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
              {addSelectedProduct ? (
                <div
                  style={{
                    marginTop: 10,
                    border: "1px solid #dbe5fb",
                    background: "linear-gradient(180deg, rgba(247,250,255,0.98) 0%, rgba(255,255,255,0.98) 100%)",
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 700, flex: 1 }}>{addSelectedProduct.item_name}</div>
                    <span style={{ padding: "4px 8px", borderRadius: 999, background: "#eef4ff", color: "#2354d5", fontSize: 11, fontWeight: 700 }}>
                      {addSelectedProduct.item_code || "Selected"}
                    </span>
                  </div>
                  <div style={{ marginTop: 4, opacity: 0.76 }}>
                    {(addSelectedProduct.group_name || "—")} • GST {toNumber(addSelectedProduct.gst_pct, 0).toFixed(2)}% • List {fmt(addSelectedProduct.list_price)}
                  </div>
                </div>
              ) : null}
              <div
                style={{
                  marginTop: 12,
                  display: "grid",
                  gridTemplateColumns: "90px 140px 140px minmax(180px, 220px) minmax(220px, 1fr)",
                  gap: 10,
                  alignItems: "end",
                }}
              >
                <Field label="Qty">
                  <input
                    type="number"
                    value={addQty}
                    onChange={(e) => setAddQty(e.target.value)}
                    min={1}
                    step={1}
                    disabled={!addSelectedProduct}
                    style={{ width: "100%" }}
                  />
                </Field>
                <Field label="Price List">
                  <select
                    value={addPriceList}
                    onChange={(e) => setAddPriceList(e.target.value)}
                    disabled={!addSelectedProduct}
                    style={{ width: "100%" }}
                  >
                    {priceTypeOptions.map((pl) => (
                      <option key={pl.key} value={pl.key}>
                        {pl.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Gross Unit">
                  <input
                    type="number"
                    value={addGrossUnit}
                    min={0}
                    step={0.01}
                    readOnly
                    style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
                  />
                </Field>
                <Field label="Disc %">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <input
                      type="number"
                      value={addDiscPct}
                      onChange={(e) => {
                        setAddDiscPct(e.target.value);
                        setAddDiscAmt("");
                      }}
                      min={0}
                      step={0.01}
                      placeholder="%"
                      disabled={!addSelectedProduct}
                      style={{ width: "100%" }}
                    />
                    <input
                      type="number"
                      value={addDiscAmt}
                      min={0}
                      step={0.01}
                      placeholder="Amt"
                      readOnly
                      style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
                    />
                  </div>
                </Field>
                <Field label="Remarks (optional)">
                  <input value={addRemarks} onChange={(e) => setAddRemarks(e.target.value)} disabled={!addSelectedProduct} style={{ width: "100%" }} />
                </Field>
              </div>
              <div style={helperNoteStyle}>
                Quote lines must come from Product Master or the configurator package builder. Distributors also use Product Master items only.
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 12 }}>
                <button type="button" onClick={addItemToDraft} disabled={saving || !addSelectedProduct}>
                  Add Selected Item
                </button>
              </div>
            </div>
          ) : (
            <div style={{ ...softEmptyStateStyle, borderBottom: "1px solid #edf1f7" }}>
              Add-item composer is hidden to keep the draft workspace tight. Use `Show Add Item` when you need to insert another line.
            </div>
          )
        ) : null}

        {uiLines.map((l, idx) => (
          <div
            key={editing ? l.key : l.id}
            style={{
              padding: editing ? 12 : "10px 14px",
              borderBottom: "1px solid #f2f4f8",
              background: editing ? (idx % 2 ? "rgba(250,252,255,0.92)" : "#fff") : "#fff",
            }}
          >
            {editing ? (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "72px minmax(260px, 1.8fr) 130px 90px 120px 100px 120px 120px 90px",
                    gap: 8,
                    alignItems: "center",
                    minWidth: 1110,
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        minWidth: 40,
                        padding: "6px 10px",
                        borderRadius: 999,
                        background: "#eef4ff",
                        color: "#2354d5",
                        fontSize: 11,
                        fontWeight: 800,
                      }}
                    >
                      {idx + 1}
                    </div>
                  </div>
                  <div>
                    <input
                      value={l.item_name}
                      onChange={(e) => setDraftLine(l.key, { item_name: e.target.value })}
                      placeholder="Item name"
                      style={{ width: "100%" }}
                    />
                    <div style={{ fontSize: 11, opacity: 0.65, marginTop: 6 }}>{l.item_code || "Manual item"}</div>
                  </div>
                  <div>
                    <select value={l.scope_type} onChange={(e) => setDraftLine(l.key, { scope_type: e.target.value })} style={{ width: "100%" }}>
                      <option value="included">Included</option>
                      <option value="client_scope">Client Scope</option>
                      <option value="quoted_separately">Quoted Separately</option>
                    </select>
                  </div>
                  <div>
                    <input
                      type="number"
                      value={l.qty}
                      onChange={(e) => setDraftLine(l.key, { qty: e.target.value }, "disc_pct")}
                      min={1}
                      step={1}
                      style={{ width: "100%" }}
                    />
                  </div>
                  <div>
                    <input
                      type="number"
                      value={l.gross_unit_price_quote}
                      min={0}
                      step={0.01}
                      readOnly
                      style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
                    />
                  </div>
                  <div>
                    <input
                      type="number"
                      value={l.discount_pct}
                      onChange={(e) => setDraftLine(l.key, { discount_pct: e.target.value, discount_amt: "" }, "disc_pct")}
                      min={0}
                      step={0.01}
                      style={{ width: "100%" }}
                    />
                  </div>
                  <div>
                    <input
                      type="number"
                      value={l.unit_price_quote}
                      min={0}
                      step={0.01}
                      readOnly
                      style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
                    />
                  </div>
                  <div style={{ fontWeight: 700, color: "#1f3a6d" }}>{fmt(calcLineTotal(l))}</div>
                  <div>
                    <button onClick={() => removeDraftLine(l.key)} disabled={saving}>
                      Remove
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, minmax(160px, 1fr))",
                    gap: 10,
                    alignItems: "end",
                    paddingTop: 10,
                    marginTop: 10,
                    borderTop: "1px dashed #e6ebf4",
                    minWidth: 1110,
                  }}
                >
                  <Field label="Discount Amount">
                    <input
                      type="number"
                      value={l.discount_amt}
                      min={0}
                      step={0.01}
                      readOnly
                      style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
                    />
                  </Field>
                  <Field label="GST %">
                    <input
                      type="number"
                      value={l.gst_pct}
                      onChange={(e) => setDraftLine(l.key, { gst_pct: e.target.value })}
                      min={0}
                      max={100}
                      step={0.01}
                      style={{ width: "100%" }}
                    />
                  </Field>
                  <Field label="Price List">
                    <select value={resolvePriceTypeKey(priceTypeOptions, l.price_list)} onChange={(e) => setDraftLine(l.key, { price_list: e.target.value })} style={{ width: "100%" }}>
                      {priceTypeOptions.map((pl) => (
                        <option key={pl.key} value={pl.key}>
                          {pl.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Remarks">
                    <input
                      value={l.remarks}
                      onChange={(e) => setDraftLine(l.key, { remarks: e.target.value })}
                      placeholder="Line note"
                      style={{ width: "100%" }}
                    />
                  </Field>
                </div>
              </>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "56px minmax(0, 1fr) minmax(220px, 280px)",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    background: "#f3f6fd",
                    color: "#2f4f8f",
                    fontWeight: 800,
                    fontSize: 12,
                  }}
                >
                  {l.line_no}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: "#1b2a46", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.item_name}</div>
                  <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    {l.item_code ? (
                      <span style={{ padding: "4px 8px", borderRadius: 999, background: "#f4f6fb", color: "#53627f", fontSize: 11, fontWeight: 700 }}>
                        {l.item_code}
                      </span>
                    ) : null}
                    <span style={{ padding: "4px 8px", borderRadius: 999, background: "#eef4ff", color: "#2354d5", fontSize: 11, fontWeight: 700 }}>
                      {formatScopeLabel(l.scope_type)}
                    </span>
                    <span style={{ fontSize: 12, opacity: 0.72 }}>Qty {l.qty}</span>
                  </div>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 6,
                    fontSize: 12,
                    alignItems: "center",
                  }}
                >
                  <div style={{ opacity: 0.68 }}>Unit</div>
                  <div>{fmt(l.unit_price_quote)}</div>
                  <div style={{ opacity: 0.68 }}>GST</div>
                  <div>{fmt(l.gst_pct)}%</div>
                  <div style={{ fontWeight: 700, color: "#1f3a6d" }}>Line Total</div>
                  <div style={{ fontWeight: 700, color: "#1f3a6d" }}>{fmt(toNumber(l.line_total_quote, calcLineTotal(l)))}</div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ ...sectionSurfaceStyle, marginTop: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, flex: 1 }}>Terms & Conditions</div>
          <div style={{ fontSize: 12, opacity: 0.72 }}>{selectedTermsCount}/{terms.length} selected</div>
          <button type="button" onClick={() => setShowTermsPanel((prev) => !prev)}>
            {showTermsPanel ? "Hide Terms" : "Show Terms"}
          </button>
          <button onClick={addTerm} disabled={!canEditTerms || termsSaving}>
            Add
          </button>
          <button onClick={saveTerms} disabled={!canEditTerms || termsSaving || termsLoading}>
            {termsSaving ? "Saving…" : "Save Terms"}
          </button>
        </div>

        {termsLoading ? <div style={{ paddingTop: 10, fontSize: 12, opacity: 0.75 }}>Loading…</div> : null}

        {showTermsPanel ? (
          <div style={historyTableShellStyle}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "70px 260px 1fr 90px",
                ...historyTableHeaderStyle,
              }}
            >
              <div>Use</div>
              <div>Caption</div>
              <div>Description</div>
              <div />
            </div>

            {terms.map((t) => (
              <div
                key={t.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "70px 260px 1fr 90px",
                  ...historyTableRowStyle,
                  alignItems: "start",
                }}
              >
                <div>
                  <input
                    type="checkbox"
                    checked={Boolean(t.is_selected)}
                    onChange={(e) => setTerm(t.id, { is_selected: e.target.checked })}
                    disabled={!canEditTerms}
                  />
                </div>
                <div>
                  <input
                    value={t.caption || ""}
                    onChange={(e) => setTerm(t.id, { caption: e.target.value })}
                    disabled={!canEditTerms}
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <textarea
                    value={t.description || ""}
                    onChange={(e) => setTerm(t.id, { description: e.target.value })}
                    disabled={!canEditTerms}
                    rows={2}
                    style={{ width: "100%", resize: "vertical" }}
                  />
                </div>
                <div>
                  <button onClick={() => removeTerm(t.id)} disabled={!canEditTerms || termsSaving}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={helperNoteStyle}>
            Terms stay collapsed until needed so the quote working area stays compact.
          </div>
        )}
      </div>
    </div>
  );
}

