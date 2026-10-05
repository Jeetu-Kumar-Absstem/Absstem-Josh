import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  DEFAULT_PRICE_TYPES,
  EMPTY_APPROVAL,
  EMPTY_MAIL_BOOTSTRAP,
  apiFetch,
  apiFetchForm,
  dateInputValueFromToday,
  daysUntilDate,
  formatBytes,
  getApiErrorMessage,
  getPriceListMultiplier,
  normalizePriceTypes,
  parseDraftNumber,
  resolvePriceTypeKey,
  runQuietly,
  toDateInputValue,
  validateDraftLines,
} from "./quoteShared";
import {
  CONFIGURATOR_FAMILIES,
  EMPTY_NEW_CUSTOMER,
  appendCityOption,
  buildAftermarketContext,
  buildConfiguratorContextPayload,
  buildConfiguratorNarrative,
  buildConfiguratorRecommendationCard,
  buildLineFloorHint,
  buildLineMeta,
  calcLineNetTotal,
  calcLineTaxTotal,
  citiesForState,
  cloneDraftLine,
  convertBaseAmountToQuote,
  createCityMaster,
  detectConfiguratorFamilyKeyFromLine,
  detectConfiguratorFamilyKeyFromText,
  findCityId,
  findDefaultFreightTermId,
  findDefaultIncotermId,
  findDefaultPAndFTermId,
  findDefaultPaymentTermId,
  findSparesPaymentTermId,
  resolveDefaultDeliveryLeadTimeDays,
  resolveDefaultWarrantyMonths,
  findIndiaCountryId,
  findStateId,
  getFallbackDraftLineQuotePrice,
  getManagedCommercialTermKind,
  getPriceTypeLabel,
  isBlockingDuplicateLevel,
  isHealthcareConfiguratorFamilyKey,
  isManagedCommercialTerm,
  mapServerLinesToDraft,
  matchClientGuardrail,
  normalizeEditableLinePricing,
  normalizeLookupText,
  normalizePricingFields,
  pickConfiguratorModel,
  resolveQuoteExchangeRate,
  roundPricing,
  safeParseMeta,
  shouldReplaceMailValue,
  statesForCountry,
  summarizeDraftConfiguratorFamilies,
  toEditableLine,
  toNumber,
} from "./quoteBuilderHelpers";

export const QUOTE_STEPS = [
  { key: "customer", label: "Customer", hint: "Choose customer, site, and start draft" },
  { key: "config", label: "Config", hint: "Recommended package first, extras only if needed" },
  { key: "commercials", label: "Commercials", hint: "Payment, freight, tax/currency, validity" },
  { key: "review", label: "Review", hint: "Scope, library terms, preflight, issue and send" },
];

const INITIAL_WIZARD = { step: 0, error: "", notice: "" };

function wizardReducer(state, action) {
  switch (action.type) {
    case "SET_STEP": {
      const next =
        typeof action.step === "function" ? action.step(state.step) : Number(action.step);
      const clamped = Math.max(0, Math.min(QUOTE_STEPS.length - 1, Number.isFinite(next) ? next : 0));
      return {
        ...state,
        step: clamped,
        error: action.clearError ? "" : state.error,
      };
    }
    case "SET_ERROR":
      return { ...state, error: String(action.error || "") };
    case "SET_NOTICE":
      return { ...state, notice: String(action.notice || "") };
    case "CLEAR_MESSAGES":
      return { ...state, error: "", notice: "" };
    case "RESET_WIZARD":
      return { ...INITIAL_WIZARD };
    default:
      return state;
  }
}

export function useQuoteBuilder({
  onCancel,
  onOpenDetail,
  onOpenSalesOrder,
  onOpenLead,
  onQuoteChanged,
  me,
  initialQuoteId,
  initialLaunch = null,
}) {
  const steps = QUOTE_STEPS;

  const [wizard, dispatchWizard] = useReducer(wizardReducer, INITIAL_WIZARD);
  const step = wizard.step;
  const error = wizard.error;
  const notice = wizard.notice;
  const setStep = (next, options = {}) =>
    dispatchWizard({ type: "SET_STEP", step: next, clearError: options.clearError === true });
  const setError = (value) => dispatchWizard({ type: "SET_ERROR", error: typeof value === "function" ? value(wizard.error) : value });
  const setNotice = (value) => dispatchWizard({ type: "SET_NOTICE", notice: typeof value === "function" ? value(wizard.notice) : value });
  const [quoteId, setQuoteId] = useState(null);
  const [quote, setQuote] = useState(null);
  const [revision, setRevision] = useState(null);
  const [lines, setLines] = useState([]);
  const [terms, setTerms] = useState([]);
  const [aftermarketContext, setAftermarketContext] = useState(() => buildAftermarketContext(initialLaunch));
  const [quoteRoute, setQuoteRoute] = useState(() => {
    const seededRoute = String(initialLaunch?.quote_route || "").trim().toLowerCase();
    if (seededRoute === "healthcare" || seededRoute === "industrial") return seededRoute;
    return isHealthcareConfiguratorFamilyKey(initialLaunch?.configurator_family_key || initialLaunch?.family_key) ? "healthcare" : "industrial";
  });
  const [customerQ, setCustomerQ] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [selectedCustomerRecord, setSelectedCustomerRecord] = useState(null);
  const [customerDetail, setCustomerDetail] = useState(null);
  const [customerContacts, setCustomerContacts] = useState([]);
  const [customerSites, setCustomerSites] = useState([]);
  const [jobAssets, setJobAssets] = useState([]);
  const [jobAssetsLoading, setJobAssetsLoading] = useState(false);
  const [selectedJobAssetId, setSelectedJobAssetId] = useState("");
  const [selectedJobAssetDetail, setSelectedJobAssetDetail] = useState(null);
  const [recommendedJobSpares, setRecommendedJobSpares] = useState([]);
  const [recommendedJobSparesLoading, setRecommendedJobSparesLoading] = useState(false);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [showCustomerCreate, setShowCustomerCreate] = useState(false);
  const [customerCreateDismissed, setCustomerCreateDismissed] = useState(false);
  const [showCustomerOptional, setShowCustomerOptional] = useState(false);
  const [customerCreating, setCustomerCreating] = useState(false);
  const [newCustomerForm, setNewCustomerForm] = useState(EMPTY_NEW_CUSTOMER);
  const [newCustomerChecking, setNewCustomerChecking] = useState(false);
  const [newCustomerChecked, setNewCustomerChecked] = useState(false);
  const [newCustomerDuplicates, setNewCustomerDuplicates] = useState([]);
  const [newCustomerAllowDuplicate, setNewCustomerAllowDuplicate] = useState(false);
  const [draftDuplicateAdvisory, setDraftDuplicateAdvisory] = useState([]);
  const [newCustomerAddCityOpen, setNewCustomerAddCityOpen] = useState(false);
  const [newCustomerAddCityName, setNewCustomerAddCityName] = useState("");
  const [newCustomerSavingCity, setNewCustomerSavingCity] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState("");
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [showContactCreate, setShowContactCreate] = useState(false);
  const [showSiteCreate, setShowSiteCreate] = useState(false);
  const [contactCreating, setContactCreating] = useState(false);
  const [siteCreating, setSiteCreating] = useState(false);
  const [newContactForm, setNewContactForm] = useState({
    full_name: "",
    email: "",
    phone: "",
    designation: "",
  });
  const [newSiteForm, setNewSiteForm] = useState({
    site_name: "",
    site_type: "plant",
    address_line1: "",
    city: "",
    state: "",
    pincode: "",
    country_id: "",
  });
  const [attentionTo, setAttentionTo] = useState("");
  const [draftLines, setDraftLines] = useState([]);
  const [priceHints, setPriceHints] = useState({});
  const [advancedLineKey, setAdvancedLineKey] = useState("");
  const [productCategories, setProductCategories] = useState([]);
  const [productGroups, setProductGroups] = useState([]);
  const [addCategoryId, setAddCategoryId] = useState("");
  const [addGroupId, setAddGroupId] = useState("");
  const [addProductQ, setAddProductQ] = useState("");
  const [addProductResults, setAddProductResults] = useState([]);
  const [addSelectedProduct, setAddSelectedProduct] = useState(null);
  const [itemsLane, setItemsLane] = useState("configurator");
  const [selectedConfiguratorFamilyKey, setSelectedConfiguratorFamilyKey] = useState("NGEN");
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
    pricing_guardrails: [],
    currencies: [],
    exchange_rates: [],
    incoterms: [],
    payment_terms: [],
    freight_terms: [],
    p_and_f_terms: [],
    terms_master: [],
    countries: [],
    states: [],
    cities: [],
  });
  const [commercialForm, setCommercialForm] = useState({
    attention_to: "",
    pricing_display_mode: "detailed",
    is_export: false,
    incoterm_id: "",
    base_currency_id: "",
    quote_currency_id: "",
    payment_term_id: "",
    freight_term_id: "",
    p_and_f_term_id: "",
    delivery_lead_time_days: "",
    warranty_months: "",
    order_flow: "direct",
    fulfillment_mode: "direct_customer",
    buyer_po_number: "",
    buyer_po_date: "",
    po_exception_reason: "",
    end_customer_name: "",
    end_customer_po_number: "",
    end_customer_po_date: "",
    ship_to_customer_site_id: "",
    bill_to_name: "",
    bill_to_address: "",
    ship_to_name: "",
    ship_to_address: "",
  });
  const [cadenceForm, setCadenceForm] = useState({
    quote_valid_till: dateInputValueFromToday(30),
    next_follow_up_at: "",
    quote_kind: "firm",
  });
  const [quoteSummary, setQuoteSummary] = useState({
    revision_id: null,
    merge_annexures: true,
    executive_summary: { problem: "", solution: "", highlights: [], note: "" },
    scope_summary: { deliverables: [], tech_highlights: [], exclusions: [], assumptions: [], acceptance: [], responsibilities: [] },
    configurator_context: {},
    is_locked: false,
    locked_at: null,
    locked_by: null,
    can_edit: false,
    can_lock: false,
    can_unlock: false,
  });
  const [annexures, setAnnexures] = useState([]);
  const [summarySaving, setSummarySaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nitroPurity, setNitroPurity] = useState("99.99");
  const [nitroFlow, setNitroFlow] = useState("");
  const [nitroRec, setNitroRec] = useState(null);
  const [nitroModel, setNitroModel] = useState("");
  const [nitroApplyMode, setNitroApplyMode] = useState("replace");
  const [nitroPackageMode, setNitroPackageMode] = useState("full_package");
  const [nitroWorking, setNitroWorking] = useState(false);
  const [nitroPurities, setNitroPurities] = useState(["99.99", "99.995", "99.999"]);
  const [oxygenPurity, setOxygenPurity] = useState("95");
  const [oxygenFlow, setOxygenFlow] = useState("");
  const [oxygenRec, setOxygenRec] = useState(null);
  const [oxygenModel, setOxygenModel] = useState("");
  const [oxygenApplyMode, setOxygenApplyMode] = useState("replace");
  const [oxygenPackageMode, setOxygenPackageMode] = useState("full_package");
  const [oxygenWorking, setOxygenWorking] = useState(false);
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
  const [mailAttachments, setMailAttachments] = useState([]);
  const [mailAttachmentUploading, setMailAttachmentUploading] = useState(false);
  const [mailComposerOpen, setMailComposerOpen] = useState(false);
  const [mailPreview, setMailPreview] = useState(null);
  const [mailPreviewLoading, setMailPreviewLoading] = useState(false);
  const [mailSignature, setMailSignature] = useState({ value: "", saved: "", suggested: "", saving: false, loaded: false });
  const [approval, setApproval] = useState(EMPTY_APPROVAL);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [creatingSalesOrder, setCreatingSalesOrder] = useState(false);
  const [showExportControls, setShowExportControls] = useState(false);
  const mailAttachmentInputRef = useRef(null);
  const newCustomerDupeTimerRef = useRef(null);
  const newCustomerDupeSeqRef = useRef(0);
  const autoExpandedQueryRef = useRef("");
  const isExistingDraft = Number.isFinite(Number(quoteId)) && Number(quoteId) > 0;

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

  const selectedCustomer = useMemo(() => {
    const id = customerId ? Number(customerId) : null;
    if (!id) return null;
    if (selectedCustomerRecord && Number(selectedCustomerRecord.id) === id) return selectedCustomerRecord;
    const fromResults = customerResults.find((c) => Number(c.id) === id);
    if (fromResults) return fromResults;
    if (customerDetail && Number(customerDetail.id) === id) return customerDetail;
    if (quote?.customer_id && Number(quote.customer_id) === id) {
      return {
        id,
        customer_name: quote.customer_name || `Customer #${id}`,
        customer_code: quote.customer_code || "",
        gstin: quote.customer_gstin || "",
        city: quote.customer_city || "",
        state: quote.customer_state || "",
      };
    }
    return null;
  }, [customerId, selectedCustomerRecord, customerResults, customerDetail, quote?.customer_id, quote?.customer_name, quote?.customer_code, quote?.customer_gstin, quote?.customer_city, quote?.customer_state]);

  const selectedContact = useMemo(() => {
    const id = selectedContactId ? Number(selectedContactId) : null;
    return id ? customerContacts.find((c) => Number(c.id) === id) || null : null;
  }, [selectedContactId, customerContacts]);

  const selectedSite = useMemo(() => {
    const id = selectedSiteId ? Number(selectedSiteId) : null;
    return id ? customerSites.find((site) => Number(site.id) === id) || null : null;
  }, [selectedSiteId, customerSites]);
  const selectedJobAsset = useMemo(() => {
    const id = selectedJobAssetId ? Number(selectedJobAssetId) : null;
    if (!id) return null;
    return jobAssets.find((asset) => Number(asset.id) === id) || selectedJobAssetDetail || null;
  }, [selectedJobAssetId, jobAssets, selectedJobAssetDetail]);

  const customerSearchQuery = customerQ.trim();
  const customerResultsSummary = useMemo(() => {
    if (customerSearching) return "Searching live Customer Master...";
    if (!customerSearchQuery) return "Type a company name, code, phone, email, city, or GST to search live.";
    if (!customerResults.length) return `No existing customer matched "${customerSearchQuery}".`;
    return `${customerResults.length} matching customer${customerResults.length === 1 ? "" : "s"} found.`;
  }, [customerSearching, customerResults.length, customerSearchQuery]);

  const quotableCustomerSites = useMemo(
    () => customerSites.filter((site) => site && site.is_active !== false && site.can_quote !== false),
    [customerSites]
  );
  const newCustomerBlockingDuplicates = useMemo(
    () => (Array.isArray(newCustomerDuplicates) ? newCustomerDuplicates.filter(isBlockingDuplicateLevel) : []),
    [newCustomerDuplicates]
  );
  const newCustomerAdvisoryDuplicates = useMemo(
    () => (Array.isArray(newCustomerDuplicates) ? newCustomerDuplicates.filter((row) => !isBlockingDuplicateLevel(row)) : []),
    [newCustomerDuplicates]
  );
  const totalRecommendedJobSpareQty = useMemo(
    () =>
      recommendedJobSpares.reduce((sum, item) => sum + toNumber(item?.qty_recommended, 0), 0),
    [recommendedJobSpares]
  );
  const jobAssetSummary = useMemo(() => {
    if (jobAssetsLoading) return "Loading deployed Job Assets...";
    if (!customerId) return "Select a customer to load deployed assets / serial numbers.";
    if (!jobAssets.length) return "No deployed Job Asset is linked to this customer yet.";
    return `${jobAssets.length} linked Job Asset${jobAssets.length === 1 ? "" : "s"} found for this customer.`;
  }, [jobAssetsLoading, customerId, jobAssets.length]);
  const newCustomerStateOptions = useMemo(
    () => statesForCountry(quoteBootstrap.states, newCustomerForm.country_id),
    [quoteBootstrap.states, newCustomerForm.country_id]
  );
  const newCustomerSelectedStateId = useMemo(
    () => findStateId(quoteBootstrap.states, newCustomerForm.country_id, newCustomerForm.state),
    [quoteBootstrap.states, newCustomerForm.country_id, newCustomerForm.state]
  );
  const newCustomerCityOptions = useMemo(
    () => citiesForState(quoteBootstrap.cities, newCustomerSelectedStateId),
    [quoteBootstrap.cities, newCustomerSelectedStateId]
  );
  const newCustomerSelectedCityId = useMemo(
    () => findCityId(quoteBootstrap.cities, newCustomerSelectedStateId, newCustomerForm.city),
    [quoteBootstrap.cities, newCustomerSelectedStateId, newCustomerForm.city]
  );
  const defaultIndiaCountryId = useMemo(() => findIndiaCountryId(quoteBootstrap.countries), [quoteBootstrap.countries]);

  const filteredGroups = useMemo(() => {
    const cid = addCategoryId ? Number(addCategoryId) : null;
    if (!Number.isFinite(cid)) return productGroups;
    return productGroups.filter((g) => Number(g.category_id) === cid);
  }, [addCategoryId, productGroups]);
  const isBrowsingProducts = Boolean(addCategoryId || addGroupId);
  const visibleConfiguratorFamilies = useMemo(
    () =>
      CONFIGURATOR_FAMILIES.filter((item) =>
        quoteRoute === "healthcare" ? isHealthcareConfiguratorFamilyKey(item.key) : !isHealthcareConfiguratorFamilyKey(item.key)
      ),
    [quoteRoute]
  );
  const selectedConfiguratorFamily = useMemo(
    () => visibleConfiguratorFamilies.find((item) => item.key === selectedConfiguratorFamilyKey) || visibleConfiguratorFamilies[0] || CONFIGURATOR_FAMILIES[0],
    [selectedConfiguratorFamilyKey, visibleConfiguratorFamilies]
  );
  const activeConfiguratorRec = useMemo(
    () => (selectedConfiguratorFamily.gas === "nitrogen" ? nitroRec : oxygenRec),
    [selectedConfiguratorFamily.gas, nitroRec, oxygenRec]
  );
  const activeConfiguratorModel = useMemo(
    () => (selectedConfiguratorFamily.gas === "nitrogen" ? nitroModel : oxygenModel),
    [selectedConfiguratorFamily.gas, nitroModel, oxygenModel]
  );
  const activeConfiguratorPackageMode = useMemo(
    () => (selectedConfiguratorFamily.gas === "nitrogen" ? nitroPackageMode : oxygenPackageMode),
    [selectedConfiguratorFamily.gas, nitroPackageMode, oxygenPackageMode]
  );
  const activeConfiguratorCard = useMemo(
    () =>
      buildConfiguratorRecommendationCard({
        family: selectedConfiguratorFamily,
        rec: activeConfiguratorRec,
        selectedModel: activeConfiguratorModel,
        packageMode: activeConfiguratorPackageMode,
        lines: draftLines,
      }),
    [selectedConfiguratorFamily, activeConfiguratorRec, activeConfiguratorModel, activeConfiguratorPackageMode, draftLines]
  );
  const activeConfiguratorPreview = useMemo(
    () =>
      buildConfiguratorNarrative({
        family: selectedConfiguratorFamily,
        lines: draftLines,
        rec: activeConfiguratorRec,
        selectedModel: activeConfiguratorModel,
        packageMode: activeConfiguratorPackageMode,
        customerName: customerDetail?.customer_name || quote?.customer_name || "",
        siteName: selectedSite?.site_name || "",
      }),
    [
      selectedConfiguratorFamily,
      draftLines,
      activeConfiguratorRec,
      activeConfiguratorModel,
      activeConfiguratorPackageMode,
      customerDetail?.customer_name,
      quote?.customer_name,
      selectedSite?.site_name,
    ]
  );
  const liveConfiguratorContext = useMemo(
    () =>
      buildConfiguratorContextPayload({
        family: selectedConfiguratorFamily,
        rec: activeConfiguratorRec,
        selectedModel: activeConfiguratorModel,
        packageMode: activeConfiguratorPackageMode,
        lines: draftLines,
        preview: activeConfiguratorPreview,
      }),
    [selectedConfiguratorFamily, activeConfiguratorRec, activeConfiguratorModel, activeConfiguratorPackageMode, draftLines, activeConfiguratorPreview]
  );
  const reviewConfiguratorContext = useMemo(() => {
    const summaryContext = quoteSummary?.configurator_context;
    if (summaryContext && typeof summaryContext === "object" && (summaryContext.family_key || summaryContext.selected_model || summaryContext.source === "ui_configurator")) {
      return summaryContext;
    }
    const mailContext = mailBootstrap?.configurator_context;
    if (mailContext && typeof mailContext === "object" && (mailContext.family_key || mailContext.selected_model)) {
      return mailContext;
    }
    return liveConfiguratorContext;
  }, [quoteSummary?.configurator_context, mailBootstrap?.configurator_context, liveConfiguratorContext]);
  const reviewConfiguratorWarnings = useMemo(() => {
    const items = [];
    const ctx = reviewConfiguratorContext && typeof reviewConfiguratorContext === "object" ? reviewConfiguratorContext : {};
    const warningList = Array.isArray(ctx.warnings) ? ctx.warnings.map((item) => String(item || "").trim()).filter(Boolean) : [];
    if (ctx.mixed_branding_risk === true || ctx.recommended_split_quote === true) {
      items.push("This revision mixes medical and industrial branding context. Split-quote review is recommended before release.");
    }
    if (ctx.presentation_company_code === "AT") {
      items.push("This proposal is routed on AT healthcare presentation. Confirm the quote should stay on the healthcare seller identity before issue.");
    }
    return Array.from(new Set([...items, ...warningList]));
  }, [reviewConfiguratorContext]);

  const { subtotal, taxTotal, discountTotal, grandTotal } = useMemo(() => {
    const totals = draftLines.reduce(
      (acc, line) => {
        if (String(line?.scope_type || "included") !== "included") return acc;
        acc.subtotal += calcLineNetTotal(line);
        acc.taxTotal += calcLineTaxTotal(line);
        acc.discountTotal += toNumber(line.discount_amt, 0);
        return acc;
      },
      { subtotal: 0, taxTotal: 0, discountTotal: 0, grandTotal: 0 }
    );
    totals.grandTotal = totals.subtotal + totals.taxTotal;
    return totals;
  }, [draftLines]);
  const inrCurrency = useMemo(
    () => (quoteBootstrap.currencies || []).find((item) => String(item.currency_code || "").trim().toUpperCase() === "INR") || null,
    [quoteBootstrap.currencies]
  );
  const offerType = quote?.offer_type === "spares" ? "spares" : "completes";
  const offerTypeSource = quote?.offer_type_source === "manual" ? "manual" : quote?.offer_type_source === "auto" ? "auto" : "";
  const completesPaymentTermId = useMemo(() => findDefaultPaymentTermId(quoteBootstrap.payment_terms), [quoteBootstrap.payment_terms]);
  const sparesPaymentTermId = useMemo(() => findSparesPaymentTermId(quoteBootstrap.payment_terms), [quoteBootstrap.payment_terms]);
  const defaultPaymentTermId = offerType === "spares" && sparesPaymentTermId ? sparesPaymentTermId : completesPaymentTermId;
  const defaultFreightTermId = useMemo(() => findDefaultFreightTermId(quoteBootstrap.freight_terms), [quoteBootstrap.freight_terms]);
  const defaultIncotermId = useMemo(() => findDefaultIncotermId(quoteBootstrap.incoterms), [quoteBootstrap.incoterms]);
  const defaultPAndFTermId = useMemo(() => findDefaultPAndFTermId(quoteBootstrap.p_and_f_terms), [quoteBootstrap.p_and_f_terms]);
  const canSelectForeignQuoteCurrency = commercialForm.is_export;
  const currentStepIndex = Math.max(0, Math.min(steps.length - 1, Number(step) || 0));
  const selectedGroupNames = useMemo(() => {
    const groups = new Set();
    for (const line of draftLines) {
      if (line.item_name) groups.add(line.item_name);
    }
    return Array.from(groups).slice(0, 5);
  }, [draftLines]);
  const approvalHistoryPreview = useMemo(() => (Array.isArray(approval.approvals) ? approval.approvals.slice(0, 6) : []), [approval.approvals]);
  const mailHistoryPreview = useMemo(() => (Array.isArray(mailBootstrap.history) ? mailBootstrap.history.slice(0, 5) : []), [mailBootstrap.history]);
  const selectedMailPreset = useMemo(() => {
    const presets = Array.isArray(mailBootstrap.mail_presets) ? mailBootstrap.mail_presets : [];
    const key = String(mailForm.preset_key || mailBootstrap.default_preset_key || "").trim();
    return presets.find((preset) => String(preset?.key || "").trim() === key) || null;
  }, [mailForm.preset_key, mailBootstrap.default_preset_key, mailBootstrap.mail_presets]);
  const topLineItemsPreview = useMemo(() => draftLines.slice(0, 3), [draftLines]);
  const baseCurrencyLabel = useMemo(() => {
    const match = (quoteBootstrap.currencies || []).find((item) => String(item.id) === String(commercialForm.base_currency_id));
    return match ? `${match.currency_code} - ${match.currency_name}` : "—";
  }, [quoteBootstrap.currencies, commercialForm.base_currency_id]);
  const quoteCurrencyLabel = useMemo(() => {
    const match = (quoteBootstrap.currencies || []).find((item) => String(item.id) === String(commercialForm.quote_currency_id));
    return match ? `${match.currency_code} - ${match.currency_name}` : "—";
  }, [quoteBootstrap.currencies, commercialForm.quote_currency_id]);
  const activeQuoteExchangeRate = useMemo(
    () => resolveQuoteExchangeRate(quoteBootstrap.exchange_rates, commercialForm.base_currency_id, commercialForm.quote_currency_id),
    [quoteBootstrap.exchange_rates, commercialForm.base_currency_id, commercialForm.quote_currency_id]
  );
  const paymentTermLabel = useMemo(() => {
    const match = (quoteBootstrap.payment_terms || []).find((item) => String(item.id) === String(commercialForm.payment_term_id));
    return match ? `${match.term_code} - ${match.term_name}` : "—";
  }, [quoteBootstrap.payment_terms, commercialForm.payment_term_id]);
  const freightTermLabel = useMemo(() => {
    const match = (quoteBootstrap.freight_terms || []).find((item) => String(item.id) === String(commercialForm.freight_term_id));
    return match ? `${match.term_code} - ${match.term_name}` : "—";
  }, [quoteBootstrap.freight_terms, commercialForm.freight_term_id]);
  const pAndFTermLabel = useMemo(() => {
    const match = (quoteBootstrap.p_and_f_terms || []).find((item) => String(item.id) === String(commercialForm.p_and_f_term_id));
    return match ? `${match.term_code} - ${match.term_name}` : "—";
  }, [quoteBootstrap.p_and_f_terms, commercialForm.p_and_f_term_id]);
  const incotermLabel = useMemo(() => {
    const match = (quoteBootstrap.incoterms || []).find((item) => String(item.id) === String(commercialForm.incoterm_id));
    return match ? `${match.incoterm_code} - ${match.incoterm_name}` : "—";
  }, [quoteBootstrap.incoterms, commercialForm.incoterm_id]);
  const libraryTerms = useMemo(
    () => terms.filter((term) => !isManagedCommercialTerm(term?.caption)),
    [terms]
  );
  const managedCommercialTerms = useMemo(() => {
    const managedByKind = new Map();
    for (const term of terms) {
      const kind = getManagedCommercialTermKind(term?.caption);
      if (kind && !managedByKind.has(kind)) managedByKind.set(kind, term);
    }
    return [
      { kind: "incoterm", defaultCaption: "Incoterm", description: incotermLabel },
      { kind: "payment_term", defaultCaption: "Payment Term", description: paymentTermLabel },
      { kind: "freight_term", defaultCaption: "Freight Term", description: freightTermLabel },
      { kind: "p_and_f_term", defaultCaption: "P&F Term", description: pAndFTermLabel },
    ].map((item) => {
      const existing = managedByKind.get(item.kind);
      return {
        id: existing?.id || `managed:${item.kind}`,
        caption: existing?.caption || item.defaultCaption,
        description: item.description || "—",
        is_selected: true,
      };
    });
  }, [terms, incotermLabel, paymentTermLabel, freightTermLabel, pAndFTermLabel]);
  const selectedLibraryTermsCount = useMemo(() => libraryTerms.filter((t) => t && t.is_selected).length, [libraryTerms]);
  const readiness = useMemo(() => {
    const blockers = [];
    const warnings = [];
    const lineValidation = validateDraftLines(draftLines, { requireAtLeastOne: true });

    if (!quoteId) blockers.push({ key: "draft", label: "Draft quote is not created yet.", step: 0 });
    if (!selectedCustomer && !quote?.customer_name) blockers.push({ key: "customer", label: "Customer is missing.", step: 0 });
    if (!lineValidation.ok) blockers.push({ key: "items", label: lineValidation.message, step: 1 });
    if (!commercialForm.attention_to && !attentionTo) warnings.push({ key: "attention", label: "Attention To is blank.", step: 0 });
    if (quotableCustomerSites.length && !selectedSite) {
      warnings.push({ key: "site", label: "Quote site / plant is not selected.", step: 0 });
    }
    if (selectedSite?.gst_status === "pending") {
      warnings.push({ key: "site_gst", label: "Selected site is GST pending.", step: 0 });
    }
    if (!quoteCurrencyLabel || quoteCurrencyLabel === "—") blockers.push({ key: "quote_currency", label: "Quote currency is not selected.", step: 2 });
    if (!baseCurrencyLabel || baseCurrencyLabel === "—") warnings.push({ key: "base_currency", label: "Base currency is not selected.", step: 2 });
    if (!paymentTermLabel || paymentTermLabel === "—") blockers.push({ key: "payment", label: "Payment term is not selected.", step: 2 });
    if (!freightTermLabel || freightTermLabel === "—") warnings.push({ key: "freight", label: "Freight term is not selected.", step: 2 });
    if (!pAndFTermLabel || pAndFTermLabel === "—") warnings.push({ key: "p_and_f", label: "P&F term is not selected.", step: 2 });
    if (!incotermLabel || incotermLabel === "—") warnings.push({ key: "incoterm", label: "Incoterm is not selected.", step: 2 });
    if (!cadenceForm.quote_valid_till) blockers.push({ key: "validity", label: "Quote validity date is required before issue.", step: 2 });
    if (quoteRoute === "industrial" && (reviewConfiguratorContext?.mixed_branding_risk === true || reviewConfiguratorContext?.recommended_split_quote === true)) {
      warnings.push({ key: "config_split_quote", label: "Configurator context suggests a split-quote review due to mixed branding.", step: 1 });
    }
    if (!(selectedContact?.email || customerDetail?.email || mailForm.to)) warnings.push({ key: "email", label: "Customer email is missing for send flow.", step: 3 });
    if (!mailBootstrap.mail_source?.effective_sender?.connected) warnings.push({ key: "mailbox", label: "No effective sender mailbox is configured.", step: 3 });

    return { blockers, warnings };
  }, [
    quoteId,
    selectedCustomer,
    quote?.customer_name,
    draftLines,
    commercialForm.attention_to,
    attentionTo,
    quotableCustomerSites.length,
    selectedSite,
    quoteCurrencyLabel,
    baseCurrencyLabel,
    paymentTermLabel,
    freightTermLabel,
    pAndFTermLabel,
    incotermLabel,
    cadenceForm.quote_valid_till,
    quoteRoute,
    reviewConfiguratorContext?.mixed_branding_risk,
    reviewConfiguratorContext?.recommended_split_quote,
    selectedContact?.email,
    customerDetail?.email,
    mailForm.to,
    mailBootstrap.mail_source?.effective_sender?.connected,
  ]);

  useEffect(() => {
    if (!inrCurrency?.id) return;
    setCommercialForm((prev) => {
      const fixedInrId = String(inrCurrency.id);
      const nextQuoteCurrencyId = canSelectForeignQuoteCurrency ? prev.quote_currency_id || fixedInrId : fixedInrId;
      if (prev.base_currency_id === fixedInrId && prev.quote_currency_id === nextQuoteCurrencyId) return prev;
      return {
        ...prev,
        base_currency_id: fixedInrId,
        quote_currency_id: nextQuoteCurrencyId,
      };
    });
  }, [inrCurrency, canSelectForeignQuoteCurrency]);
  useEffect(() => {
    const firstFamily = visibleConfiguratorFamilies[0];
    if (!firstFamily) return;
    if (visibleConfiguratorFamilies.some((item) => item.key === selectedConfiguratorFamilyKey)) return;
    setSelectedConfiguratorFamilyKey(firstFamily.key);
  }, [visibleConfiguratorFamilies, selectedConfiguratorFamilyKey]);

  useEffect(() => {
    if (!commercialForm.is_export) return;
    setShowExportControls(true);
  }, [commercialForm.is_export]);

  const termsMasterByOfferType = useMemo(() => {
    const all = Array.isArray(quoteBootstrap.terms_master) ? quoteBootstrap.terms_master : [];
    const forType = (type) =>
      all
        .filter((t) => !t?.applies_to || t.applies_to === "all" || t.applies_to === type)
        .map((t) => (type === "spares" && String(t?.spares_description || "").trim() ? { ...t, default_description: t.spares_description } : t));
    return { completes: forType("completes"), spares: forType("spares") };
  }, [quoteBootstrap.terms_master]);
  const effectiveTermsMaster = termsMasterByOfferType[offerType];

  // A type switch moves commercial fields that still hold the old type's default; user-picked values stay.
  const offerTypeSeenRef = useRef({ quoteId: null, offerType: null });
  useEffect(() => {
    const seen = offerTypeSeenRef.current;
    offerTypeSeenRef.current = { quoteId: quote?.id ?? null, offerType: quote ? offerType : null };
    if (!quote || seen.quoteId !== quote.id || !seen.offerType || seen.offerType === offerType) return;
    const defaultsFor = (type) => ({
      payment_term_id: type === "spares" && sparesPaymentTermId ? sparesPaymentTermId : completesPaymentTermId,
      warranty_months: resolveDefaultWarrantyMonths({ termsMaster: termsMasterByOfferType[type] }),
      delivery_lead_time_days: resolveDefaultDeliveryLeadTimeDays({ termsMaster: termsMasterByOfferType[type] }),
    });
    const before = defaultsFor(seen.offerType);
    const after = defaultsFor(offerType);
    setCommercialForm((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const key of Object.keys(after)) {
        const current = String(prev[key] ?? "");
        if (after[key] && (!current || current === String(before[key] ?? "")) && current !== String(after[key])) {
          next[key] = after[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [quote?.id, offerType, termsMasterByOfferType, sparesPaymentTermId, completesPaymentTermId]);

  useEffect(() => {
    const defaultLeadTime = resolveDefaultDeliveryLeadTimeDays({
      revisionTerms: terms,
      termsMaster: effectiveTermsMaster,
    });
    const defaultWarranty = resolveDefaultWarrantyMonths({
      revisionTerms: terms,
      termsMaster: effectiveTermsMaster,
    });

    setCommercialForm((prev) => {
      let changed = false;
      const next = { ...prev };
      if (!next.base_currency_id && inrCurrency?.id) {
        next.base_currency_id = String(inrCurrency.id);
        changed = true;
      }
      if (!next.quote_currency_id && inrCurrency?.id) {
        next.quote_currency_id = String(inrCurrency.id);
        changed = true;
      }
      if (!next.payment_term_id && defaultPaymentTermId) {
        next.payment_term_id = defaultPaymentTermId;
        changed = true;
      }
      if (!next.freight_term_id && defaultFreightTermId) {
        next.freight_term_id = defaultFreightTermId;
        changed = true;
      }
      if (!next.p_and_f_term_id && defaultPAndFTermId) {
        next.p_and_f_term_id = defaultPAndFTermId;
        changed = true;
      }
      if (!next.incoterm_id && defaultIncotermId) {
        next.incoterm_id = defaultIncotermId;
        changed = true;
      }
      if (!String(next.delivery_lead_time_days || "").trim() && defaultLeadTime) {
        next.delivery_lead_time_days = defaultLeadTime;
        changed = true;
      }
      if (!String(next.warranty_months || "").trim() && defaultWarranty) {
        next.warranty_months = defaultWarranty;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [
    commercialForm.payment_term_id,
    commercialForm.freight_term_id,
    commercialForm.p_and_f_term_id,
    commercialForm.incoterm_id,
    commercialForm.base_currency_id,
    commercialForm.quote_currency_id,
    commercialForm.delivery_lead_time_days,
    commercialForm.warranty_months,
    defaultPaymentTermId,
    defaultFreightTermId,
    defaultPAndFTermId,
    defaultIncotermId,
    inrCurrency?.id,
    terms,
    effectiveTermsMaster,
  ]);

  const progressPct = Math.round(((currentStepIndex + 1) / steps.length) * 100);
  const revisionState = revision?.revision_status || "draft";
  const revisionStateLabel = String(revisionState).replaceAll("_", " ");
  const issueBlockedByApproval = Boolean(approval.approval_required) && revisionState === "draft";
  const canIssueAndSend =
    ["draft", "approved"].includes(revisionState) &&
    !issueBlockedByApproval &&
    approval.can_issue !== false;
  const sendRequiresIssue = canIssueAndSend;
  const canApproveQuotes = Boolean(
    me?.group_name === "SuperAdmin" || me?.permissions?.screens?.quotes?.can_approve || me?.permissions?.modules?.quotes?.can_approve
  );
  const lifecycleBadge = useMemo(() => {
    if (readiness.blockers.length) {
      return {
        label: "Blocked",
        background: "#fff1f1",
        border: "1px solid #f3c7c7",
        color: "#a33d3d",
      };
    }
    if (readiness.warnings.length) {
      return {
        label: "Needs Review",
        background: "#fff9ee",
        border: "1px solid #ead7a1",
        color: "#8a6708",
      };
    }
    return {
      label: "Ready",
      background: "#f2fbf5",
      border: "1px solid #cfe7d6",
      color: "#0b6b38",
    };
  }, [readiness.blockers.length, readiness.warnings.length]);
  const checklistItems = useMemo(
    () => [
      {
        key: "customer",
        label: "Customer selected",
        detail: selectedCustomer || quote?.customer_name ? "Customer context is set." : "Pick or create the customer first.",
        done: Boolean(selectedCustomer || quote?.customer_name),
        step: 0,
      },
      {
        key: "draft",
        label: "Draft started",
        detail: quoteId ? `Draft ${quote?.quote_number || "ready"} is live.` : "Start the draft after customer selection.",
        done: Boolean(quoteId),
        step: 0,
      },
      {
        key: "items",
        label: "Offer built",
        detail: draftLines.length ? `${draftLines.length} quoted line${draftLines.length === 1 ? "" : "s"} added.` : "Apply package and add any approved extras.",
        done: draftLines.length > 0,
        step: 1,
      },
      {
        key: "commercials",
        label: "Review ready",
        detail:
          quoteCurrencyLabel &&
          quoteCurrencyLabel !== "—" &&
          paymentTermLabel !== "—" &&
          cadenceForm.quote_valid_till
            ? "Core proposal and commercial fields are in place."
            : "Finish payment term, validity, and required commercial fields.",
        done: Boolean(
          quoteCurrencyLabel &&
            quoteCurrencyLabel !== "—" &&
            paymentTermLabel &&
            paymentTermLabel !== "—" &&
            cadenceForm.quote_valid_till
        ),
        step: 2,
      },
      {
        key: "issue",
        label: "Ready to deliver",
        detail: readiness.blockers.length ? "Resolve blockers before issue." : "No issue blockers remain.",
        done: readiness.blockers.length === 0,
        step: 3,
      },
    ],
    [
      selectedCustomer,
      quote?.customer_name,
      quoteId,
      quote?.quote_number,
      draftLines.length,
      quoteCurrencyLabel,
      paymentTermLabel,
      cadenceForm.quote_valid_till,
      readiness.blockers.length,
    ]
  );
  const recommendedNextAction = useMemo(() => {
    if (!selectedCustomer && !quote?.customer_name) {
      return {
        title: "Choose the customer",
        body: "Search an existing customer first. If nothing matches, create the customer inline and then start the draft.",
        step: 0,
        ctaLabel: "Go to customer",
      };
    }
    if (!quoteId) {
      return {
        title: "Start the draft quote",
        body: "Once the customer is selected, start the draft so the builder can attach items, scope, and commercials to a live revision.",
        step: 0,
        ctaLabel: "Start the draft",
      };
    }
    if (!draftLines.length) {
      return {
        title: "Build the offer from the recommended package",
        body: "Start with the route-specific package recommendation first, then open extra item lanes only if the customer needs approved additions.",
        step: 1,
        ctaLabel: "Go to config",
      };
    }
    if (step < 2) {
      return {
        title: "Set commercials and validity",
        body: "Confirm payment term, currency, freight framing, and quote validity before the final review and delivery step.",
        step: 2,
        ctaLabel: "Open commercials",
      };
    }
    if (step === 2) {
      return {
        title: "Finish commercial defaults",
        body: "Keep the domestic quote on INR, ADV50, Extra at actuals, and EXW unless this is a deliberate export or exception case. Confirm validity before review.",
        step: 2,
        ctaLabel: "Finish commercials",
      };
    }
    if (revisionState !== "issued") {
      return {
        title: approval.approval_required ? "Submit or issue in the right order" : "Issue the quote",
        body: approval.approval_required
          ? "This revision needs approval before issue. Follow the approval path first, then issue and send."
          : "Preview the final quote, issue it, and only then move to customer send.",
        step: 3,
        ctaLabel: approval.approval_required ? "Review approval path" : "Go to issue",
      };
    }
    return {
      title: "Send the final quote",
      body: "The quote is issued. Preview the correct PDF mode, confirm recipient details, and send the mail handoff.",
      step: 3,
      ctaLabel: "Go to send",
    };
  }, [
    selectedCustomer,
    quote?.customer_name,
    quoteId,
    draftLines.length,
    step,
    readiness.warnings,
    revisionState,
    approval.approval_required,
  ]);
  const primaryFlowAction = useMemo(() => {
    if (readiness.blockers.length) {
      return {
        label: "Complete missing details",
        tone: "#fff1f1",
        color: "#9f3f3f",
        borderColor: "rgba(243,199,199,0.95)",
      };
    }
    if (revisionState === "issued") {
      return {
        label: "Ready to send",
        tone: "#f2fbf5",
        color: "#0b6b38",
        borderColor: "rgba(207,231,214,0.95)",
      };
    }
    if (approval.approval_required) {
      return {
        label: revisionState === "pending_approval" ? "Waiting for approval" : "Send for approval",
        tone: revisionState === "pending_approval" ? "#eef4ff" : "#fff7e8",
        color: revisionState === "pending_approval" ? "#2354d5" : "#8a6708",
        borderColor: revisionState === "pending_approval" ? "rgba(170,194,242,0.95)" : "rgba(234,215,161,0.95)",
      };
    }
    return {
      label: "Issue PDF",
      tone: "#eef4ff",
      color: "#2354d5",
      borderColor: "rgba(170,194,242,0.95)",
    };
  }, [approval.approval_required, readiness.blockers.length, revisionState]);

  const sidebarCommercialRows = useMemo(
    () => [
      { label: "Pricing mode", value: commercialForm.pricing_display_mode || "—" },
      { label: "Export", value: commercialForm.is_export ? "Yes" : "No" },
      { label: "Revision", value: revision?.revision_no || "—" },
      { label: "Base currency", value: baseCurrencyLabel },
      { label: "Quote currency", value: quoteCurrencyLabel },
      { label: "Payment term", value: paymentTermLabel },
      { label: "Freight term", value: freightTermLabel },
      { label: "P&F term", value: pAndFTermLabel },
      { label: "Incoterm", value: incotermLabel },
      { label: "Valid till", value: cadenceForm.quote_valid_till ? toDateInputValue(cadenceForm.quote_valid_till) : "Not set" },
      { label: "Follow-up", value: cadenceForm.next_follow_up_at ? toDateInputValue(cadenceForm.next_follow_up_at) : "Not set" },
    ],
    [
      commercialForm.pricing_display_mode,
      commercialForm.is_export,
      revision?.revision_no,
      baseCurrencyLabel,
      quoteCurrencyLabel,
      paymentTermLabel,
      freightTermLabel,
      pAndFTermLabel,
      incotermLabel,
      cadenceForm.quote_valid_till,
      cadenceForm.next_follow_up_at,
    ]
  );
  const cadenceValidityNote = useMemo(() => {
    if (!cadenceForm.quote_valid_till) {
      return { label: "Validity not set", tone: "#fff4e8", color: "#9a5a00", borderColor: "rgba(154,90,0,0.14)" };
    }
    const days = daysUntilDate(cadenceForm.quote_valid_till);
    if (days === null) {
      return { label: "Validity not set", tone: "#fff4e8", color: "#9a5a00", borderColor: "rgba(154,90,0,0.14)" };
    }
    if (days < 0) {
      return { label: `Expired ${Math.abs(days)}d ago`, tone: "#fff1f1", color: "#9f3f3f", borderColor: "rgba(243,199,199,0.95)" };
    }
    if (days === 0) {
      return { label: "Expires today", tone: "#fff4e8", color: "#9a5a00", borderColor: "rgba(154,90,0,0.14)" };
    }
    return { label: `Valid ${days} day${days === 1 ? "" : "s"}`, tone: "#f2fbf5", color: "#0b6b38", borderColor: "rgba(207,231,214,0.95)" };
  }, [cadenceForm.quote_valid_till]);
  const approvalHistoryRows = useMemo(
    () =>
      approvalHistoryPreview.map((entry) => ({
        id: entry.id,
        cells: [
          entry.approval_cycle_no || "—",
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "4px 8px",
              borderRadius: 999,
              background: "#f4f7fd",
              border: "1px solid rgba(171,188,221,0.28)",
              fontSize: 11,
              fontWeight: 700,
              color: "#385282",
              textTransform: "capitalize",
            }}
          >
            {String(entry.approval_status || "—").replaceAll("_", " ")}
          </span>,
          entry.approver_name || entry.approver_email || "—",
          fmtDateTime(entry.approved_at || entry.created_at),
          <span style={{ opacity: 0.82 }}>{entry.remarks || "—"}</span>,
        ],
      })),
    [approvalHistoryPreview]
  );
  const mailHistoryRows = useMemo(
    () =>
      mailHistoryPreview.map((entry) => ({
        id: entry.id,
        cells: [
          fmtDateTime(entry.sent_at),
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
              textTransform: "capitalize",
            }}
          >
            {entry.send_status === "failed"
              ? "Failed"
              : entry.opened_at
                ? Number(entry.open_count || 0) > 1
                  ? `Opened ${Number(entry.open_count || 0)}x`
                  : "Opened"
                : "Sent"}
          </span>,
          <span style={{ overflowWrap: "anywhere" }}>{entry.recipient_to || "—"}</span>,
          <span style={{ opacity: 0.82 }}>
            {entry.revision_no != null ? `Rev ${entry.revision_no} • ` : ""}
            {entry.subject || "—"}
            {entry.opened_at ? ` • Opened ${fmtDateTime(entry.last_opened_at || entry.opened_at)}` : ""}
            {entry.has_sent_pdf ? (
              <>
                {" • "}
                <a href={`/quotes/${quoteId}/mail-logs/${entry.id}/pdf`} target="_blank" rel="noopener noreferrer">
                  View sent PDF
                </a>
              </>
            ) : null}
          </span>,
        ],
      })),
    [mailHistoryPreview, quoteId]
  );
  const pricingSnapshotCards = useMemo(
    () => [
      { label: "Items", value: draftLines.length, note: "Product Master-backed lines", accent: "#1f4db8" },
      { label: "Supporting Clauses", value: selectedLibraryTermsCount, note: "Additional clauses included", accent: "#255d7a" },
      { label: "Discount", value: discountTotal.toFixed(2), note: "Combined line discount", accent: "#8f4a12" },
      { label: "Grand total", value: grandTotal.toFixed(2), note: quoteCurrencyLabel === "—" ? "Quote currency pending" : quoteCurrencyLabel, accent: "#144c9c" },
    ],
    [draftLines.length, selectedLibraryTermsCount, discountTotal, grandTotal, quoteCurrencyLabel]
  );
  const priceTypeOptions = useMemo(() => normalizePriceTypes(quoteBootstrap.price_types), [quoteBootstrap.price_types]);
  const pricingGuardrails = useMemo(
    () => (Array.isArray(quoteBootstrap.pricing_guardrails) ? quoteBootstrap.pricing_guardrails : []),
    [quoteBootstrap.pricing_guardrails]
  );
  const selectedProductBasePrice = useMemo(
    () => Math.max(0, toNumber(addSelectedProduct?.list_price, 0)),
    [addSelectedProduct]
  );
  const selectedProductQuoteListPrice = useMemo(
    () =>
      Math.max(
        convertBaseAmountToQuote(selectedProductBasePrice, activeQuoteExchangeRate),
        getFallbackDraftLineQuotePrice(addSelectedProduct, draftLines)
      ),
    [selectedProductBasePrice, activeQuoteExchangeRate, addSelectedProduct, draftLines]
  );
  const hasQuoteItems = draftLines.length > 0;

  useEffect(() => {
    if (!defaultIndiaCountryId) return;
    setNewCustomerForm((prev) => {
      if (String(prev.country_id || "").trim()) return prev;
      return { ...prev, country_id: defaultIndiaCountryId };
    });
  }, [defaultIndiaCountryId]);

  useEffect(() => {
    apiFetch("/products/categories")
      .then((data) => setProductCategories(Array.isArray(data?.categories) ? data.categories : []))
      .catch(() => setProductCategories([]));

    apiFetch("/products/groups")
      .then((data) => setProductGroups(Array.isArray(data?.groups) ? data.groups : []))
      .catch(() => setProductGroups([]));

    apiFetch("/quotes/bootstrap")
      .then((data) =>
        setQuoteBootstrap({
          pricing_modes: Array.isArray(data?.pricing_modes) ? data.pricing_modes : [],
          allow_manual_line_entry: data?.allow_manual_line_entry === true,
          require_catalog_products_for_lines: data?.require_catalog_products_for_lines !== false,
          allow_distributor_external_items: data?.allow_distributor_external_items === true,
          distributor_item_sourcing_mode: data?.distributor_item_sourcing_mode || "",
          price_types: Array.isArray(data?.price_types) ? data.price_types : [],
          currencies: Array.isArray(data?.currencies) ? data.currencies : [],
          exchange_rates: Array.isArray(data?.exchange_rates) ? data.exchange_rates : [],
          incoterms: Array.isArray(data?.incoterms) ? data.incoterms : [],
          payment_terms: Array.isArray(data?.payment_terms) ? data.payment_terms : [],
          freight_terms: Array.isArray(data?.freight_terms) ? data.freight_terms : [],
          p_and_f_terms: Array.isArray(data?.p_and_f_terms) ? data.p_and_f_terms : [],
          terms_master: Array.isArray(data?.terms_master) ? data.terms_master : [],
          countries: Array.isArray(data?.countries) ? data.countries : [],
          states: Array.isArray(data?.states) ? data.states : [],
          cities: Array.isArray(data?.cities) ? data.cities : [],
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
          exchange_rates: [],
          incoterms: [],
          payment_terms: [],
          freight_terms: [],
          p_and_f_terms: [],
          terms_master: [],
          countries: [],
          states: [],
          cities: [],
        })
      );
  }, []);

  const pendingInitialLandingRef = useRef(false);

  useEffect(() => {
    const id = Number(initialQuoteId);
    if (!Number.isFinite(id) || id <= 0) return;
    setQuoteId(id);
    setStep(1);
    pendingInitialLandingRef.current = true;
  }, [initialQuoteId]);

  useEffect(() => {
    if (!pendingInitialLandingRef.current) return;
    const status = String(revision?.revision_status || "").toLowerCase();
    if (!status) return;
    pendingInitialLandingRef.current = false;
    if (status === "draft") {
      setNotice("Loaded existing draft. Update items and commercial settings, then issue when ready.");
      return;
    }
    setStep(3);
    setNotice(
      status === "issued"
        ? "This revision is issued and locked. Send it, convert it, or start a new revision to make changes."
        : status === "approved"
          ? "This revision is approved. Issue it to lock the offer and send it to the customer."
          : status === "pending_approval"
            ? "This revision is waiting for discount approval."
            : "This revision is locked. Start a new revision to make changes."
    );
  }, [revision?.revision_status]);

  useEffect(() => {
    if (!initialLaunch || typeof initialLaunch !== "object") return;
    if (quoteId) return;

    const nextCustomerId =
      initialLaunch.customer_id === null || initialLaunch.customer_id === undefined || initialLaunch.customer_id === ""
        ? null
        : Number(initialLaunch.customer_id);
    const nextJobAssetId =
      initialLaunch.job_asset_id === null || initialLaunch.job_asset_id === undefined || initialLaunch.job_asset_id === ""
        ? null
        : Number(initialLaunch.job_asset_id);
    const nextCustomerName = typeof initialLaunch.customer_name === "string" ? initialLaunch.customer_name.trim() : "";
    const nextAttentionTo = typeof initialLaunch.attention_to === "string" ? initialLaunch.attention_to.trim() : "";
    const nextSourceLabel = typeof initialLaunch.source_label === "string" ? initialLaunch.source_label.trim() : "Aftermarket quote";
    const nextSourceNote = typeof initialLaunch.source_note === "string" ? initialLaunch.source_note.trim() : "";

    setAftermarketContext(buildAftermarketContext(initialLaunch));
    if (Number.isFinite(nextCustomerId) && nextCustomerId > 0) {
      setCustomerId(String(nextCustomerId));
      setSelectedCustomerRecord({
        id: nextCustomerId,
        customer_name: nextCustomerName || `Customer #${nextCustomerId}`,
      });
    }
    if (nextCustomerName) setCustomerQ(nextCustomerName);
    if (Number.isFinite(nextJobAssetId) && nextJobAssetId > 0) {
      setSelectedJobAssetId(String(nextJobAssetId));
      setItemsLane("absstem_shield");
    } else {
      setItemsLane("product_master");
    }
    if (nextAttentionTo) {
      setAttentionTo(nextAttentionTo);
      setCommercialForm((prev) => ({ ...prev, attention_to: prev.attention_to || nextAttentionTo }));
    }
    if (nextSourceNote || nextSourceLabel) {
      setNotice([nextSourceLabel, nextSourceNote].filter(Boolean).join(" • "));
    }
  }, [initialLaunch, quoteId]);

  useEffect(() => {
    if (!quoteId) return;
    loadQuoteContext(quoteId).catch(() => {});
  }, [quoteId]);

  useEffect(() => {
    if (!quoteId) return;
    setNitroPurities(["99.99", "99.995", "99.999"]);
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
  }, [quoteId]);

  useEffect(() => {
    if (selectedConfiguratorFamily.gas === "nitrogen") {
      setNitroRec(null);
      setNitroModel("");
      setNitroApplyMode("replace");
      if (!nitroPurities.includes(String(nitroPurity)) && nitroPurities.length) {
        setNitroPurity(nitroPurities[0]);
      }
      return;
    }
    setOxygenRec(null);
    setOxygenModel("");
    setOxygenApplyMode("replace");
    setOxygenPurity("95");
  }, [selectedConfiguratorFamily, nitroPurities, nitroPurity]);

  useEffect(() => {
    if (!quoteId) return;
    refreshMailBootstrap(quoteId).catch(() => {});
  }, [quoteId]);

  useEffect(() => {
    if (!quoteId) return;
    refreshApprovalStatus(quoteId).catch(() => {});
  }, [quoteId]);

  useEffect(() => {
    if (!quoteId || step !== 3) return;
    refreshApprovalStatus(quoteId).catch(() => {});
  }, [quoteId, step]);

  useEffect(() => {
    if (step !== 0) return;
    const q = customerQ.trim();
    // Mark searching immediately so auto-expand waits for the settled result, not a stale empty list.
    if (q.length) setCustomerSearching(true);
    const t = setTimeout(() => {
      setCustomerSearching(true);
      const qp = q.length ? `?q=${encodeURIComponent(q)}` : "";
      apiFetch(`/customers${qp}`)
        .then((data) => setCustomerResults(Array.isArray(data?.customers) ? data.customers : []))
        .catch(() => setCustomerResults([]))
        .finally(() => setCustomerSearching(false));
    }, q.length ? 220 : 0);
    return () => clearTimeout(t);
  }, [step, customerQ]);

  // Reset create-form dismissal whenever the search query changes so auto-expand can fire again.
  useEffect(() => {
    setCustomerCreateDismissed(false);
    autoExpandedQueryRef.current = "";
  }, [customerQ]);

  // Auto-expand create on settled zero results (≥3 chars), once per query unless dismissed.
  useEffect(() => {
    if (step !== 0) return;
    if (customerId) return;
    if (customerSearching) return;
    if (showCustomerCreate) return;
    const q = customerQ.trim();
    if (q.length < 3) return;
    if (customerResults.length > 0) return;
    if (customerCreateDismissed) return;
    if (autoExpandedQueryRef.current === q) return;
    autoExpandedQueryRef.current = q;
    openCustomerCreate(q);
  }, [step, customerId, customerSearching, customerQ, customerResults.length, customerCreateDismissed, showCustomerCreate]);

  useEffect(() => {
    if (customerDetail?.id && String(customerDetail.id) === String(customerId)) {
      setSelectedCustomerRecord((prev) => ({ ...(prev || {}), ...customerDetail }));
    }
  }, [customerDetail, customerId]);

  useEffect(() => {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) {
      setCustomerDetail(null);
      setCustomerContacts([]);
      setCustomerSites([]);
      setJobAssets([]);
      setSelectedJobAssetId("");
      setSelectedJobAssetDetail(null);
      setRecommendedJobSpares([]);
      setSelectedContactId("");
      setSelectedSiteId("");
      return;
    }
    apiFetch(`/customers/${id}`)
      .then((data) => {
        setCustomerDetail(data?.customer || null);
        const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
        const sites = Array.isArray(data?.sites) ? data.sites : [];
        setCustomerContacts(contacts);
        setCustomerSites(sites);
        const primary = contacts.find((c) => c.is_primary) || contacts[0] || null;
        setSelectedContactId(primary ? String(primary.id) : "");
        const currentSiteId = Number(selectedSiteId);
        const activeSite =
          (Number.isFinite(currentSiteId) &&
            sites.find(
              (site) => Number(site.id) === currentSiteId && site.is_active !== false && site.can_quote !== false
            )) ||
          sites.find((site) => site.is_default_quote_site && site.is_active !== false && site.can_quote !== false) ||
          sites.find((site) => site.is_active !== false && site.can_quote !== false) ||
          null;
        setSelectedSiteId(activeSite ? String(activeSite.id) : "");
        if (!attentionTo && primary?.full_name) {
          const nextAttention = [primary.salutation || null, primary.full_name || null].filter(Boolean).join(" ");
          setAttentionTo(nextAttention);
          setCommercialForm((prev) => (prev.attention_to ? prev : { ...prev, attention_to: nextAttention }));
        }
      })
      .catch(() => {
        setCustomerDetail(null);
        setCustomerContacts([]);
        setCustomerSites([]);
        setJobAssets([]);
        setSelectedJobAssetId("");
        setSelectedJobAssetDetail(null);
        setRecommendedJobSpares([]);
        setSelectedContactId("");
        setSelectedSiteId("");
      });
  }, [customerId]);

  useEffect(() => {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) {
      setJobAssets([]);
      setSelectedJobAssetId("");
      setSelectedJobAssetDetail(null);
      setRecommendedJobSpares([]);
      return;
    }
    setJobAssetsLoading(true);
    apiFetch(`/quotes/customers/${id}/job-assets`)
      .then((data) => {
        const rows = Array.isArray(data?.job_assets) ? data.job_assets : [];
        setJobAssets(rows);
        setSelectedJobAssetId((prev) => {
          if (prev && rows.some((item) => String(item.id) === String(prev))) return prev;
          if (rows.length === 1) return String(rows[0].id);
          return "";
        });
      })
      .catch(() => {
        setJobAssets([]);
        setSelectedJobAssetId("");
      })
      .finally(() => setJobAssetsLoading(false));
  }, [customerId]);

  useEffect(() => {
    const id = Number(selectedJobAssetId);
    if (!Number.isFinite(id) || id <= 0) {
      setSelectedJobAssetDetail(null);
      setRecommendedJobSpares([]);
      return;
    }
    setRecommendedJobSparesLoading(true);
    Promise.all([apiFetch(`/quotes/job-assets/${id}`), apiFetch(`/quotes/job-assets/${id}/recommended-spares`)])
      .then(([assetData, spareData]) => {
        setSelectedJobAssetDetail(assetData?.job_asset || spareData?.job_asset || null);
        setRecommendedJobSpares(Array.isArray(spareData?.recommended_spares) ? spareData.recommended_spares : []);
      })
      .catch(() => {
        setSelectedJobAssetDetail(null);
        setRecommendedJobSpares([]);
      })
      .finally(() => setRecommendedJobSparesLoading(false));
  }, [selectedJobAssetId]);

  useEffect(() => {
    if (!selectedContact?.full_name) return;
    if (attentionTo && attentionTo.trim().length) return;
    const nextAttention = [selectedContact.salutation || null, selectedContact.full_name || null].filter(Boolean).join(" ");
    setAttentionTo(nextAttention);
    setCommercialForm((prev) => (prev.attention_to ? prev : { ...prev, attention_to: nextAttention }));
  }, [selectedContactId, selectedContact?.full_name]);

  useEffect(() => {
    if (!addSelectedProduct) return;
    const gross = selectedProductQuoteListPrice * getPriceListMultiplier(priceTypeOptions, addPriceList);
    setAddGrossUnit(String(gross));
    setAddDiscPct("");
    setAddDiscAmt("");
  }, [addSelectedProduct, addPriceList, priceTypeOptions, selectedProductQuoteListPrice]);

  useEffect(() => {
    setAddPriceList((prev) => resolvePriceTypeKey(priceTypeOptions, prev));
  }, [priceTypeOptions]);

  const priceHintProductKey = useMemo(
    () =>
      (Array.isArray(draftLines) ? draftLines : [])
        .map((line) => Number(line?.product_id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .sort((a, b) => a - b)
        .join(","),
    [draftLines]
  );

  useEffect(() => {
    const cid = Number(customerId);
    const productIds = priceHintProductKey
      ? priceHintProductKey.split(",").map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    if (!Number.isFinite(cid) || cid <= 0 || !productIds.length) {
      setPriceHints({});
      return;
    }
    const params = new URLSearchParams();
    params.set("customer_id", String(cid));
    params.set("product_ids", productIds.join(","));
    let active = true;
    apiFetch(`/quotes/price-reference?${params.toString()}`)
      .then((data) => {
        if (!active) return;
        setPriceHints(data?.hints && typeof data.hints === "object" ? data.hints : {});
      })
      .catch(() => {
        if (active) setPriceHints({});
      });
    return () => {
      active = false;
    };
  }, [customerId, priceHintProductKey]);

  useEffect(() => {
    if (!quoteId || step !== 1) return;
    const q = addProductQ.trim();
    if (!q.length && !addCategoryId && !addGroupId) {
      setAddProductResults([]);
      return;
    }
    const t = setTimeout(() => {
      const params = new URLSearchParams();
      if (q.length) params.set("q", q);
      if (addCategoryId) params.set("category_id", addCategoryId);
      if (addGroupId) params.set("group_id", addGroupId);
      apiFetch(`/products?${params.toString()}`)
        .then((data) => setAddProductResults(Array.isArray(data?.products) ? data.products : []))
        .catch(() => setAddProductResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [quoteId, step, addProductQ, addCategoryId, addGroupId]);

  useEffect(() => {
    if (!addGroupId) return;
    const exists = filteredGroups.some((group) => String(group.id) === String(addGroupId));
    if (!exists) setAddGroupId("");
  }, [addGroupId, filteredGroups]);

  async function loadQuoteContext(id) {
    const data = await apiFetch(`/quotes/${id}`);
    const termsData = await apiFetch(`/quotes/${id}/terms`).catch(() => ({ terms: [] }));
    const summaryData = await apiFetch(`/quotes/${id}/summary`).catch(() => null);
    const annexureData = await apiFetch(`/quotes/${id}/annexures`).catch(() => ({ annexures: [] }));
    const mailAttachmentData = await apiFetch(`/quotes/${id}/mail-attachments`).catch(() => ({ attachments: [] }));
    setQuote(data?.quote || null);
    setRevision(data?.revision || null);
    setLines(Array.isArray(data?.lines) ? data.lines : []);
    setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
    setTerms(Array.isArray(termsData?.terms) ? termsData.terms : []);
    if (summaryData && summaryData.ok !== false) {
      setQuoteSummary({
        revision_id: summaryData?.revision_id ?? null,
        merge_annexures: summaryData?.merge_annexures !== false,
        annexure_mode: summaryData?.annexure_mode || (summaryData?.merge_annexures === false ? "separate" : "merged"),
        executive_summary: summaryData?.executive_summary || {},
        scope_summary: summaryData?.scope_summary || {},
        configurator_context: summaryData?.configurator_context || {},
        is_locked: summaryData?.is_locked === true,
        locked_at: summaryData?.locked_at || null,
        locked_by: summaryData?.locked_by || null,
        can_edit: summaryData?.can_edit === true,
        can_lock: summaryData?.can_lock === true,
        can_unlock: summaryData?.can_unlock === true,
      });
    }
    setAnnexures(Array.isArray(annexureData?.annexures) ? annexureData.annexures : []);
    setMailAttachments(Array.isArray(mailAttachmentData?.attachments) ? mailAttachmentData.attachments : []);
    setCustomerId(data?.quote?.customer_id ? String(data.quote.customer_id) : "");
    if (data?.quote?.customer_id) {
      setSelectedCustomerRecord({
        id: data.quote.customer_id,
        customer_name: data.quote.customer_name || `Customer #${data.quote.customer_id}`,
      });
    } else {
      setSelectedCustomerRecord(null);
    }
    setCustomerQ(data?.quote?.customer_name || "");
    setSelectedSiteId(data?.quote?.customer_site_id ? String(data.quote.customer_site_id) : "");
    setSelectedJobAssetId(data?.quote?.job_asset_id ? String(data.quote.job_asset_id) : "");
    setAttentionTo(data?.quote?.attention_to || "");
    setCommercialForm({
      attention_to: data?.quote?.attention_to || "",
      pricing_display_mode: data?.revision?.pricing_display_mode || "detailed",
      is_export: Boolean(data?.revision?.is_export),
      incoterm_id: data?.revision?.incoterm_id ? String(data.revision.incoterm_id) : "",
      base_currency_id: data?.revision?.base_currency_id ? String(data.revision.base_currency_id) : "",
      quote_currency_id: data?.revision?.quote_currency_id ? String(data.revision.quote_currency_id) : "",
      payment_term_id: data?.revision?.payment_term_id ? String(data.revision.payment_term_id) : "",
      freight_term_id: data?.revision?.freight_term_id ? String(data.revision.freight_term_id) : "",
      p_and_f_term_id: data?.revision?.p_and_f_term_id ? String(data.revision.p_and_f_term_id) : "",
      delivery_lead_time_days:
        data?.revision?.delivery_lead_time_days === null || data?.revision?.delivery_lead_time_days === undefined
          ? ""
          : String(data.revision.delivery_lead_time_days),
      warranty_months:
        data?.revision?.warranty_months === null || data?.revision?.warranty_months === undefined
          ? ""
          : String(data.revision.warranty_months),
      order_flow: data?.quote?.order_flow || (data?.quote?.distributor_id ? "distributor" : "direct"),
      fulfillment_mode: data?.quote?.fulfillment_mode || (data?.quote?.distributor_id ? "stock_sale" : "direct_customer"),
      buyer_po_number: data?.quote?.buyer_po_number || "",
      buyer_po_date: data?.quote?.buyer_po_date || "",
      po_exception_reason: data?.quote?.po_exception_reason || "",
      end_customer_name: data?.quote?.end_customer_name || "",
      end_customer_po_number: data?.quote?.end_customer_po_number || "",
      end_customer_po_date: data?.quote?.end_customer_po_date || "",
      ship_to_customer_site_id: data?.quote?.ship_to_customer_site_id ? String(data.quote.ship_to_customer_site_id) : "",
      bill_to_name: data?.quote?.bill_to_name || "",
      bill_to_address: data?.quote?.bill_to_address || "",
      ship_to_name: data?.quote?.ship_to_name || "",
      ship_to_address: data?.quote?.ship_to_address || "",
    });
    setCadenceForm({
      quote_valid_till: toDateInputValue(data?.quote?.quote_valid_till) || dateInputValueFromToday(30),
      next_follow_up_at: toDateInputValue(data?.quote?.next_follow_up_at),
      quote_kind: data?.quote?.quote_kind === "budgetary" ? "budgetary" : "firm",
    });
  }

  async function refreshMailBootstrap(activeQuoteId = quoteId) {
    if (!activeQuoteId) return;
    setMailLoading(true);
    try {
      const data = await apiFetch(`/quotes/${activeQuoteId}/mail-bootstrap`);
      const previousBootstrap = mailBootstrap;
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
        to: shouldReplaceMailValue(prev.to, previousBootstrap.default_to) ? selectedContact?.email || data?.default_to || "" : prev.to,
        cc: shouldReplaceMailValue(prev.cc, previousBootstrap.default_cc) ? data?.default_cc || "" : prev.cc,
        preset_key: prev.preset_key || data?.default_preset_key || "",
        subject: shouldReplaceMailValue(prev.subject, previousBootstrap.default_subject) ? data?.default_subject || "" : prev.subject,
        body: shouldReplaceMailValue(prev.body, previousBootstrap.default_body) ? data?.default_body || "" : prev.body,
      }));
    } catch {
      setMailBootstrap(EMPTY_MAIL_BOOTSTRAP);
    } finally {
      setMailLoading(false);
    }
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
  }

  async function openMailComposer() {
    if (!quoteId) return;
    setMailComposerOpen(true);
    setMailNotice("");
    setMailPreview(null);
    await Promise.all([refreshMailBootstrap(quoteId), refreshMailAttachments(quoteId), loadMailSignature()]);
  }

  async function loadMailSignature() {
    try {
      const data = await apiFetch(`/mail-accounts/me/signature`);
      const saved = String(data?.email_signature || "");
      setMailSignature({ value: saved, saved, suggested: String(data?.suggested_signature || ""), saving: false, loaded: true });
    } catch {
      setMailSignature((prev) => ({ ...prev, loaded: true }));
    }
  }

  async function saveMailSignature() {
    setMailSignature((prev) => ({ ...prev, saving: true }));
    try {
      const data = await apiFetch(`/mail-accounts/me/signature`, {
        method: "PUT",
        body: JSON.stringify({ email_signature: mailSignature.value }),
      });
      const saved = String(data?.email_signature || "");
      setMailSignature((prev) => ({ ...prev, value: saved, saved, saving: false }));
      setMailPreview(null);
      setMailNotice(saved ? "Your email signature is saved." : "Your email signature is cleared; the standard footer will be used.");
    } catch (e) {
      setMailSignature((prev) => ({ ...prev, saving: false }));
      setError(
        e?.data?.error === "SIGNATURE_TOO_LONG"
          ? `Keep the signature under ${e.data.max_chars || 600} characters.`
          : getApiErrorMessage(e, "Could not save your email signature.")
      );
    }
  }

  function buildMailRequestBody() {
    return {
      to: mailForm.to,
      cc: mailForm.cc,
      bcc: mailForm.bcc,
      subject: mailForm.subject,
      body: mailForm.body,
      clubbed: mailForm.clubbed,
      manual_attachment_ids: mailAttachments.map((item) => Number(item.attachment_id || item.id)).filter(Number.isFinite),
    };
  }

  async function previewQuoteMail() {
    if (!quoteId) return;
    setMailPreviewLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/mail-preview`, {
        method: "POST",
        body: JSON.stringify(buildMailRequestBody()),
      });
      setMailPreview(data || null);
    } catch (e) {
      setMailPreview(null);
      setError(getApiErrorMessage(e, "Could not build the email preview."));
    } finally {
      setMailPreviewLoading(false);
    }
  }

  async function refreshMailAttachments(activeQuoteId = quoteId) {
    if (!activeQuoteId) return;
    try {
      const data = await apiFetch(`/quotes/${activeQuoteId}/mail-attachments`);
      setMailAttachments(Array.isArray(data?.attachments) ? data.attachments : []);
    } catch {
      setMailAttachments([]);
    }
  }

  async function handleMailAttachmentUpload(event) {
    const files = Array.from(event?.target?.files || []);
    if (!quoteId || !files.length) return;
    const totalBytes = files.reduce((sum, file) => sum + (Number(file?.size) || 0), 0);
    const totalLimitBytes = 20 * 1024 * 1024;
    if (totalBytes > totalLimitBytes) {
      setError("Please keep the total selected attachment size within 20 MB.");
      if (event?.target) event.target.value = "";
      return;
    }
    setMailAttachmentUploading(true);
    setError("");
    setMailNotice("");
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        await apiFetchForm(`/quotes/${quoteId}/mail-attachments`, formData, { method: "POST" });
      }
      await refreshMailAttachments(quoteId);
      setMailNotice(files.length === 1 ? `${files[0].name} attached for mail.` : `${files.length} files attached for mail.`);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to attach additional files."));
    } finally {
      setMailAttachmentUploading(false);
      if (event?.target) event.target.value = "";
    }
  }

  function openMailAttachmentPicker() {
    if (mailAttachmentUploading || !quoteId) return;
    mailAttachmentInputRef.current?.click();
  }

  async function refreshApprovalStatus(activeQuoteId = quoteId) {
    if (!activeQuoteId) return EMPTY_APPROVAL;
    setApprovalLoading(true);
    try {
      const data = await apiFetch(`/quotes/${activeQuoteId}/approval-status`);
      const nextApproval = data?.approval || EMPTY_APPROVAL;
      setApproval(nextApproval);
      return nextApproval;
    } catch {
      setApproval(EMPTY_APPROVAL);
      return EMPTY_APPROVAL;
    } finally {
      setApprovalLoading(false);
    }
  }

  async function persistDraftLines({ requireAtLeastOne = true } = {}) {
    if (!quoteId) return null;
    const validation = validateDraftLines(draftLines, { requireAtLeastOne });
    if (!validation.ok) {
      setError(validation.message);
      const err = new Error(validation.message);
      err.data = { error: "INVALID_DRAFT_LINES", detail: validation.message };
      throw err;
    }
    const data = await apiFetch(`/quotes/${quoteId}/lines`, {
      method: "PUT",
      body: JSON.stringify({
        lines: validation.actionable
          .map(({ line }) => ({
            id: line.id,
            product_id: line.product_id === null || line.product_id === undefined ? null : Number(line.product_id),
            item_name: line.item_name || null,
            qty: toNumber(line.qty, 0),
            unit_price_quote: toNumber(line.unit_price_quote, 0),
            gst_pct: toNumber(line.gst_pct, 0),
            discount_pct: toNumber(line.discount_pct, 0),
            discount_amt: toNumber(line.discount_amt, 0),
            gross_unit_price_quote: toNumber(line.gross_unit_price_quote, 0),
            list_price_snapshot: toNumber(line.source_list_price, 0),
            scope_type: line.scope_type || "included",
            line_description: buildLineMeta(line),
            customer_item_code: line.customer_item_code || null,
            customer_item_description: line.customer_item_description || null,
          })),
      }),
    }).catch((e) => {
      if (e?.data?.error === "PRICE_FLOOR_BREACH") {
        const detail = Array.isArray(e?.data?.lines)
          ? e.data.lines.map((line) => `${line.item_name || `Line ${line.line_no}`} below ${Number(line.min_net_pct_of_list || 0).toFixed(0)}% of list`).join("; ")
          : "A line is below the company price floor.";
        setError(detail);
      }
      throw e;
    });
    setQuote(data?.quote || quote);
    setRevision(data?.revision || revision);
    setLines(Array.isArray(data?.lines) ? data.lines : []);
    setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
    if (data?.pricing_warnings?.detail) setNotice(data.pricing_warnings.detail);
    if (data?.offer_type_changed) {
      const termsData = await apiFetch(`/quotes/${quoteId}/terms`).catch(() => null);
      if (Array.isArray(termsData?.terms)) setTerms(termsData.terms);
      setNotice(
        data?.quote?.offer_type === "spares"
          ? "No main equipment in the lines, so this is now a Spares & Aftermarket quote: supply terms and the parts PDF apply."
          : "Main equipment added, so this is now a Completes quote: plant terms and the full proposal PDF apply."
      );
      runQuietly(() => refreshMailBootstrap(quoteId));
    }
    runQuietly(() => refreshApprovalStatus(quoteId));
    return data;
  }

  async function changeOfferType(nextType) {
    if (!quoteId) return;
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/offer-type`, {
        method: "PUT",
        body: JSON.stringify({ offer_type: nextType }),
      });
      if (data?.quote) setQuote((prev) => ({ ...(prev || {}), ...data.quote }));
      if (Array.isArray(data?.terms)) setTerms(data.terms);
      const label = data?.quote?.offer_type === "spares" ? "Spares & Aftermarket" : "Completes";
      setNotice(nextType === "auto" ? `Quote type follows the lines (currently ${label}).` : `Quote type set to ${label}. Terms updated.`);
      runQuietly(() => refreshMailBootstrap(quoteId));
    } catch (e) {
      setError(
        e?.data?.error === "OFFER_TYPE_NOT_READY"
          ? "Quote types are not enabled on this server yet (migration 199 pending)."
          : getApiErrorMessage(e, "Failed to change the quote type.")
      );
    } finally {
      setSaving(false);
    }
  }

  async function searchCustomers() {
    setError("");
    try {
      const qp = customerQ.trim().length ? `?q=${encodeURIComponent(customerQ.trim())}` : "";
      const data = await apiFetch(`/customers${qp}`);
      setCustomerResults(Array.isArray(data?.customers) ? data.customers : []);
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to search customers.");
    }
  }

  function selectCustomer(customer) {
    if (!customer) return;
    const isChanged = String(customer.id) !== String(customerId || "");
    setCustomerId(String(customer.id));
    setSelectedCustomerRecord(customer);
    setShowCustomerCreate(false);
    setCustomerCreateDismissed(false);
    setShowCustomerOptional(false);
    if (isChanged) {
      setCustomerDetail(null);
      setCustomerContacts([]);
      setCustomerSites([]);
      setSelectedContactId("");
      setSelectedSiteId("");
      setAttentionTo("");
      setCommercialForm((prev) => ({ ...prev, attention_to: "" }));
      setMailForm((prev) => ({
        ...prev,
        to: "",
        cc: "",
        subject: "",
        body: "",
      }));
    }
    if ((customer.primary_contact_name || customer.contact_name) && (!attentionTo || isChanged)) {
      setAttentionTo([customer.primary_contact_salutation || null, customer.primary_contact_name || customer.contact_name || null].filter(Boolean).join(" "));
    }
  }

  function clearCustomerSelection() {
    setCustomerId("");
    setSelectedCustomerRecord(null);
    setCustomerDetail(null);
    setCustomerContacts([]);
    setCustomerSites([]);
    setSelectedContactId("");
    setSelectedSiteId("");
    setAttentionTo("");
    setShowCustomerCreate(false);
    setCustomerCreateDismissed(false);
    setShowCustomerOptional(false);
    autoExpandedQueryRef.current = "";
  }

  function openCustomerCreate(seedName = "") {
    const nextSeed = String(seedName || customerQ || "").trim();
    setShowCustomerCreate(true);
    setCustomerCreateDismissed(false);
    setNewCustomerForm((prev) => ({
      ...prev,
      customer_name: prev.customer_name && prev.customer_name.trim() ? prev.customer_name : nextSeed,
    }));
    setNewCustomerChecked(false);
    setNewCustomerDuplicates([]);
    setNewCustomerAllowDuplicate(false);
  }

  function dismissCustomerCreate() {
    setShowCustomerCreate(false);
    setCustomerCreateDismissed(true);
    setShowCustomerOptional(false);
  }

  function useContactForAttention(contact) {
    if (!contact) return;
    if (contact.id) setSelectedContactId(String(contact.id));
    const nextAttention = [contact.salutation || null, contact.full_name || null].filter(Boolean).join(" ");
    setAttentionTo(nextAttention);
    setCommercialForm((prev) => ({ ...prev, attention_to: nextAttention }));
  }

  useEffect(() => {
    if (!showCustomerCreate) return undefined;
    const customerName = String(newCustomerForm.customer_name || "").trim();
    const email = String(newCustomerForm.email || "").trim();
    const phone = String(newCustomerForm.phone || "").trim();
    const contactName = String(newCustomerForm.contact_name || "").trim();
    const gstin = String(newCustomerForm.gstin || "").trim();
    const city = String(newCustomerForm.city || "").trim();
    const state = String(newCustomerForm.state || "").trim();
    setNewCustomerChecked(false);
    setNewCustomerDuplicates([]);
    setNewCustomerAllowDuplicate(false);
    if (newCustomerDupeTimerRef.current) {
      clearTimeout(newCustomerDupeTimerRef.current);
      newCustomerDupeTimerRef.current = null;
    }
    if (customerName.length < 3) {
      setNewCustomerChecking(false);
      return undefined;
    }
    const seq = ++newCustomerDupeSeqRef.current;
    setNewCustomerChecking(true);
    newCustomerDupeTimerRef.current = setTimeout(() => {
      (async () => {
        try {
          const data = await apiFetch("/customers/duplicate-check", {
            method: "POST",
            body: JSON.stringify({
              customer_name: customerName,
              email,
              phone,
              contact_name: contactName,
              contact_email: email,
              contact_phone: phone,
              gstin,
              city,
              state,
              country_id: newCustomerForm.country_id || null,
            }),
          });
          if (seq !== newCustomerDupeSeqRef.current) return;
          setNewCustomerDuplicates(Array.isArray(data?.duplicates) ? data.duplicates : []);
          setNewCustomerChecked(true);
          setNewCustomerAllowDuplicate(false);
        } catch {
          if (seq !== newCustomerDupeSeqRef.current) return;
          setNewCustomerDuplicates([]);
          setNewCustomerChecked(false);
          setNewCustomerAllowDuplicate(false);
        } finally {
          if (seq === newCustomerDupeSeqRef.current) setNewCustomerChecking(false);
        }
      })().catch(() => {});
    }, 400);
    return () => {
      if (newCustomerDupeTimerRef.current) {
        clearTimeout(newCustomerDupeTimerRef.current);
        newCustomerDupeTimerRef.current = null;
      }
    };
  }, [
    showCustomerCreate,
    newCustomerForm.customer_name,
    newCustomerForm.email,
    newCustomerForm.phone,
    newCustomerForm.contact_name,
    newCustomerForm.gstin,
    newCustomerForm.city,
    newCustomerForm.state,
    newCustomerForm.country_id,
  ]);

  async function createInlineCustomer() {
    if (!newCustomerForm.customer_name.trim()) {
      setError("Customer name is required.");
      return;
    }
    if (newCustomerChecking || !newCustomerChecked) {
      setError("Wait for the duplicate check to finish.");
      return;
    }
    setCustomerCreating(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        customer_name: newCustomerForm.customer_name.trim(),
        phone: String(newCustomerForm.phone || "").trim(),
        email: String(newCustomerForm.email || "").trim(),
        contact_name: String(newCustomerForm.contact_name || "").trim(),
        contact_email: String(newCustomerForm.contact_email || newCustomerForm.email || "").trim(),
        contact_phone: String(newCustomerForm.contact_phone || newCustomerForm.phone || "").trim(),
        country_id: newCustomerForm.country_id || null,
        state: String(newCustomerForm.state || "").trim(),
        city: String(newCustomerForm.city || "").trim(),
        address_line1: String(newCustomerForm.address_line1 || "").trim(),
        pincode: String(newCustomerForm.pincode || "").trim(),
        gstin: String(newCustomerForm.gstin || "").trim(),
        allow_duplicate: newCustomerAllowDuplicate === true,
      };
      const data = await apiFetch("/customers", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const customer = data?.customer || null;
      if (!customer?.id) throw new Error("create failed");
      selectCustomer({
        ...customer,
        contact_name: payload.contact_name || "",
      });
      if (data?.site?.id) {
        setSelectedSiteId(String(data.site.id));
      }
      setNewCustomerForm({ ...EMPTY_NEW_CUSTOMER, country_id: defaultIndiaCountryId || "" });
      setNewCustomerChecked(false);
      setNewCustomerDuplicates([]);
      setNewCustomerAllowDuplicate(false);
      setNewCustomerAddCityOpen(false);
      setNewCustomerAddCityName("");
      setShowCustomerCreate(false);
      setNotice(
        data?.site?.id
          ? "Customer created with a quotable plant/site and selected for this quote."
          : "Customer created and selected. Add a plant/site below if you still need one."
      );
      await searchCustomers();
    } catch (e) {
      if (e?.data?.error === "POSSIBLE_DUPLICATE_CUSTOMER") {
        setNewCustomerDuplicates(Array.isArray(e?.data?.duplicates) ? e.data.duplicates : []);
        setNewCustomerChecked(true);
        setNewCustomerAllowDuplicate(false);
        setError("Possible duplicate customer found. Please select an existing master or confirm create anyway.");
      } else {
        setError(e?.data?.error === "FORBIDDEN" ? "You do not have rights to create customers." : "Failed to create customer.");
      }
    } finally {
      setCustomerCreating(false);
    }
  }

  async function refreshCustomerMaster(activeCustomerId = customerId) {
    const id = Number(activeCustomerId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const data = await apiFetch(`/customers/${id}`);
    const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
    const sites = Array.isArray(data?.sites) ? data.sites : [];
    setCustomerDetail(data?.customer || null);
    setCustomerContacts(contacts);
    setCustomerSites(sites);
    return { contacts, sites, customer: data?.customer || null };
  }

  async function createInlineContact() {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) {
      setError("Select a customer first.");
      return;
    }
    if (!String(newContactForm.full_name || "").trim()) {
      setError("Contact name is required.");
      return;
    }
    setContactCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/customers/${id}/contacts`, {
        method: "POST",
        body: JSON.stringify({
          full_name: String(newContactForm.full_name || "").trim(),
          email: String(newContactForm.email || "").trim() || null,
          phone: String(newContactForm.phone || "").trim() || null,
          designation: String(newContactForm.designation || "").trim() || null,
          is_primary: customerContacts.length === 0,
          roles: ["sales_enquiry", "quote_recipient"],
        }),
      });
      const contact = data?.contact || null;
      const refreshed = await refreshCustomerMaster(id);
      if (contact?.id) {
        setSelectedContactId(String(contact.id));
        useContactForAttention(contact);
      } else if (refreshed?.contacts?.length) {
        const primary = refreshed.contacts.find((c) => c.is_primary) || refreshed.contacts[0];
        if (primary?.id) setSelectedContactId(String(primary.id));
      }
      setNewContactForm({ full_name: "", email: "", phone: "", designation: "" });
      setShowContactCreate(false);
      setNotice("Contact added without leaving the quote.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to add contact."));
    } finally {
      setContactCreating(false);
    }
  }

  async function createInlineSite() {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) {
      setError("Select a customer first.");
      return;
    }
    if (!String(newSiteForm.site_name || "").trim()) {
      setError("Site / plant name is required.");
      return;
    }
    setSiteCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/customers/${id}/sites`, {
        method: "POST",
        body: JSON.stringify({
          site_name: String(newSiteForm.site_name || "").trim(),
          site_type: newSiteForm.site_type || "plant",
          address_line1: String(newSiteForm.address_line1 || "").trim() || null,
          city: String(newSiteForm.city || "").trim() || null,
          state: String(newSiteForm.state || "").trim() || null,
          pincode: String(newSiteForm.pincode || "").trim() || null,
          country_id: newSiteForm.country_id || customerDetail?.country_id || defaultIndiaCountryId || null,
          can_quote: true,
          can_dispatch: true,
          can_bill: true,
          is_default_quote_site: quotableCustomerSites.length === 0,
          is_default_ship_to: quotableCustomerSites.length === 0,
          is_active: true,
        }),
      });
      const site = data?.site || null;
      const refreshed = await refreshCustomerMaster(id);
      if (site?.id) {
        setSelectedSiteId(String(site.id));
      } else if (refreshed?.sites?.length) {
        const next =
          refreshed.sites.find((row) => row.is_default_quote_site && row.can_quote !== false) ||
          refreshed.sites.find((row) => row.can_quote !== false) ||
          refreshed.sites[0];
        if (next?.id) setSelectedSiteId(String(next.id));
      }
      setNewSiteForm({
        site_name: "",
        site_type: "plant",
        address_line1: "",
        city: "",
        state: "",
        pincode: "",
        country_id: defaultIndiaCountryId || "",
      });
      setShowSiteCreate(false);
      setNotice("Plant / site added and selected for this quote.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to add plant/site."));
    } finally {
      setSiteCreating(false);
    }
  }

  async function handleAddNewCustomerCity() {
    if (!newCustomerForm.country_id || !newCustomerSelectedStateId) {
      setError("Select country and state before adding a city.");
      return;
    }
    setNewCustomerSavingCity(true);
    setError("");
    setNotice("");
    try {
      const city = await createCityMaster({
        countryId: newCustomerForm.country_id,
        stateId: newCustomerSelectedStateId,
        cityName: newCustomerAddCityName,
      });
      setQuoteBootstrap((prev) => ({ ...prev, cities: appendCityOption(prev.cities, city) }));
      setNewCustomerForm((prev) => ({ ...prev, city: city?.city_name || prev.city }));
      setNewCustomerAddCityName("");
      setNewCustomerAddCityOpen(false);
      setNotice(`City ${city?.city_name || ""} added.`);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to add city."));
    } finally {
      setNewCustomerSavingCity(false);
    }
  }

  async function startDraftQuote() {
    if (!customerId) {
      setError("Select a customer first.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    setDraftDuplicateAdvisory([]);
    try {
      let advisoryNotice = "";
      // Soft integrity check: advisory only — never blocks draft creation.
      try {
        const master = customerDetail || selectedCustomer || {};
        const soft = await apiFetch("/customers/duplicate-check", {
          method: "POST",
          body: JSON.stringify({
            customer_name: master.customer_name || "",
            email: master.email || "",
            phone: master.phone || "",
            gstin: master.gstin || "",
            pan: master.pan || "",
            contact_email: selectedContact?.email || master.email || "",
            contact_phone: selectedContact?.phone || master.phone || "",
            exclude_customer_id: Number(customerId),
          }),
        });
        const blocking =
          Array.isArray(soft?.blocking_duplicates) && soft.blocking_duplicates.length
            ? soft.blocking_duplicates
            : Array.isArray(soft?.duplicates)
              ? soft.duplicates.filter(isBlockingDuplicateLevel)
              : [];
        if (blocking.length) {
          setDraftDuplicateAdvisory(blocking);
          advisoryNotice = `Advisory: ${blocking.length} similar customer master${blocking.length === 1 ? "" : "s"} found. Draft still started.`;
        }
      } catch {
        // Soft check failures must not prevent drafting.
      }

      const data = await apiFetch("/quotes", {
        method: "POST",
        body: JSON.stringify({
          customer_id: Number(customerId),
          customer_site_id: selectedSiteId ? Number(selectedSiteId) : null,
          job_asset_id: selectedJobAssetId ? Number(selectedJobAssetId) : null,
          service_warranty_case_id: aftermarketContext.service_warranty_case_id ? Number(aftermarketContext.service_warranty_case_id) : null,
          amc_contract_id: aftermarketContext.amc_contract_id ? Number(aftermarketContext.amc_contract_id) : null,
          attention_to: attentionTo || [selectedContact?.salutation || null, selectedContact?.full_name || null].filter(Boolean).join(" ") || null,
          offer_type: initialLaunch?.offer_type === "spares" || initialLaunch?.offer_type === "completes" ? initialLaunch.offer_type : undefined,
          lines: [],
        }),
      });
      setQuoteId(data?.quote?.id || null);
      setStep(1);
      setNotice(advisoryNotice || "Draft quote created. Now add items.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to start draft quote."));
    } finally {
      setSaving(false);
    }
  }

  function setDraftLine(lineKey, patch, pricingChanged) {
    setDraftLines((prev) =>
      prev.map((line) => {
        if (line.key !== lineKey) return line;
        const merged = { ...line, ...patch };
        const priceListChanged = Object.prototype.hasOwnProperty.call(patch || {}, "price_list");
        if (priceListChanged) {
          merged.price_list = resolvePriceTypeKey(priceTypeOptions, merged.price_list);
          const sourceListPriceRaw = toNumber(merged.source_list_price, 0);
          const currentGrossUnit = toNumber(merged.gross_unit_price_quote, toNumber(line.gross_unit_price_quote, 0));
          const previousPriceListKey = resolvePriceTypeKey(priceTypeOptions, line.price_list);
          const previousMultiplier = getPriceListMultiplier(priceTypeOptions, previousPriceListKey) || 1;
          const sourceListPrice =
            sourceListPriceRaw > 0
              ? sourceListPriceRaw
              : previousMultiplier > 0
                ? currentGrossUnit / previousMultiplier
                : currentGrossUnit;
          merged.source_list_price = String(sourceListPrice);
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
        next.line_description = buildLineMeta(next);
        return next;
      })
    );
  }

  function removeDraftLine(lineKey) {
    setDraftLines((prev) => prev.filter((line) => line.key !== lineKey));
  }

  function duplicateDraftLine(lineKey) {
    setDraftLines((prev) => {
      const index = prev.findIndex((line) => line.key === lineKey);
      if (index < 0) return prev;
      const copy = cloneDraftLine(prev[index]);
      const next = [...prev];
      next.splice(index + 1, 0, copy);
      return next;
    });
  }

  function moveDraftLine(lineKey, direction) {
    setDraftLines((prev) => {
      const index = prev.findIndex((line) => line.key === lineKey);
      if (index < 0) return prev;
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [line] = next.splice(index, 1);
      next.splice(target, 0, line);
      return next;
    });
  }

  function resetFastAdd(keepSelection = false) {
    setAddProductQ(keepSelection && addSelectedProduct ? addSelectedProduct.item_name || "" : "");
    setAddProductResults([]);
    if (!keepSelection) setAddSelectedProduct(null);
    setAddQty("1");
    setAddGrossUnit(keepSelection && addSelectedProduct ? addGrossUnit : "");
    setAddDiscPct("");
    setAddDiscAmt("");
    setAddRemarks("");
  }

  function selectProductForAdd(product) {
    const selected = product && typeof product === "object" ? product : null;
    const quoteListPrice = Math.max(
      convertBaseAmountToQuote(Math.max(0, toNumber(selected?.list_price, 0)), activeQuoteExchangeRate),
      getFallbackDraftLineQuotePrice(selected, draftLines)
    );
    setAddSelectedProduct(selected);
    setAddProductQ(selected?.item_name || "");
    setAddGrossUnit(String(quoteListPrice * getPriceListMultiplier(priceTypeOptions, addPriceList)));
    setAddDiscPct("");
    setAddDiscAmt("");
  }

  function buildDraftLineFromProduct(product, { qty = 1, remarks = "", priceList = addPriceList } = {}) {
    const sourceListPrice = Math.max(0, convertBaseAmountToQuote(Math.max(0, toNumber(product?.list_price, 0)), activeQuoteExchangeRate));
    const resolvedPriceList = resolvePriceTypeKey(priceTypeOptions, priceList);
    const norm = normalizePricingFields({
      qty,
      grossUnit: sourceListPrice * getPriceListMultiplier(priceTypeOptions, resolvedPriceList),
      discPct: 0,
      discAmt: 0,
      netUnit: 0,
      changed: "disc_pct",
    });
    const next = {
      key: `new:${Math.random().toString(16).slice(2)}`,
      id: null,
      product_id: product?.product_id || product?.id || null,
      item_code: product?.item_code || "",
      item_name: product?.item_name || "",
      product_group_name: String(product?.group_name || "").trim(),
      qty: String(qty),
      source_list_price: String(sourceListPrice),
      gross_unit_price_quote: String(norm.grossUnit),
      discount_pct: String(norm.discPct),
      discount_amt: String(norm.discAmt),
      price_list: resolvedPriceList,
      remarks: remarks || "",
      unit_price_quote: String(norm.netUnit),
      gst_pct: String(toNumber(product?.gst_pct, 0)),
      scope_type: "included",
      line_description: "",
      customer_item_code: "",
      customer_item_description: "",
    };
    next.line_description = buildLineMeta(next);
    return next;
  }

  function openProductMasterLane() {
    setItemsLane("product_master");
    setAddProductQ("");
    setAddProductResults([]);
    setAddSelectedProduct(null);
  }

  function openAbsstemShieldLane() {
    if (!selectedJobAssetId) {
      setNotice("Select the deployed Job Asset / Serial No first.");
      return;
    }
    setItemsLane("absstem_shield");
  }

  function returnToPackageBuilder() {
    setItemsLane("configurator");
  }

  function addSelectedItem(keepSelection = false) {
    if (!addSelectedProduct) return;
    const qty = Math.max(1, toNumber(addQty, 1));
    const computedGross = selectedProductQuoteListPrice * getPriceListMultiplier(priceTypeOptions, addPriceList);
    const gross = Math.max(0, toNumber(addGrossUnit, computedGross));
    const norm = normalizePricingFields({
      qty,
      grossUnit: gross,
      discPct: addDiscPct,
      discAmt: addDiscAmt,
      netUnit: 0,
      changed: addDiscAmt && String(addDiscAmt).trim().length ? "disc_amt" : "disc_pct",
    });
    const next = {
      key: `new:${Math.random().toString(16).slice(2)}`,
      id: null,
      product_id: addSelectedProduct.id,
      item_code: addSelectedProduct.item_code || "",
      item_name: addSelectedProduct.item_name || "",
      hsn_no: addSelectedProduct.hsn_no || "",
      product_group_id: addSelectedProduct.group_id ?? null,
      product_group_name: String(addSelectedProduct.group_name || "").trim(),
      qty: String(qty),
      source_list_price: String(selectedProductQuoteListPrice),
      gross_unit_price_quote: String(norm.grossUnit),
      discount_pct: String(norm.discPct),
      discount_amt: String(norm.discAmt),
      price_list: addPriceList || "list",
      unit_price_quote: String(norm.netUnit),
      gst_pct: String(toNumber(addSelectedProduct.gst_pct, 0)),
      scope_type: "included",
      remarks: addRemarks || "",
      line_description: "",
      customer_item_code: "",
      customer_item_description: "",
    };
    next.line_description = buildLineMeta(next);
    setDraftLines((prev) => [...prev, next]);
    resetFastAdd(keepSelection);
  }

  function addRecommendedJobSpare(spare) {
    if (!spare) return;
    const qtyRecommended = Math.max(1, toNumber(spare?.qty_recommended, 1));
    const sourceCodes = Array.isArray(spare?.source_lines)
      ? Array.from(new Set(spare.source_lines.map((line) => String(line?.installed_item_code || "").trim()).filter(Boolean))).join(", ")
      : "";
    const assetLabel = selectedJobAsset?.serial_no || selectedJobAsset?.job_id || "";
    const remarks = [
      "Absstem Shield recommended spare",
      assetLabel ? `Asset ${assetLabel}` : "",
      sourceCodes ? `Installed item ${sourceCodes}` : "",
    ]
      .filter(Boolean)
      .join(" • ");
    const next = buildDraftLineFromProduct(spare, { qty: qtyRecommended, remarks, priceList: addPriceList });
    setDraftLines((prev) => [...prev, next]);
    setNotice(`${spare?.item_name || "Recommended spare"} added from Absstem Shield.`);
    setError("");
  }

  async function saveItemsAndContinue() {
    if (!quoteId) return;
    setSaving(true);
    setError("");
    try {
      await persistDraftLines();
      setStep(2);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save items."));
    } finally {
      setSaving(false);
    }
  }

  function parseBulletLines(value) {
    return String(value || "")
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function bulletsToText(list) {
    return (Array.isArray(list) ? list : []).map((x) => String(x || "").trim()).filter(Boolean).join("\n");
  }

  function setExecutiveSummaryField(key, value) {
    setQuoteSummary((prev) => ({ ...prev, executive_summary: { ...(prev.executive_summary || {}), [key]: value } }));
  }

  function setScopeSummaryField(key, value) {
    setQuoteSummary((prev) => ({ ...prev, scope_summary: { ...(prev.scope_summary || {}), [key]: value } }));
  }

  function setScopeBulletField(key, textValue) {
    setScopeSummaryField(key, parseBulletLines(textValue));
  }

  function generateSummaryFromConfigurator() {
    const activeRec = selectedConfiguratorFamily.gas === "nitrogen" ? nitroRec : oxygenRec;
    const activeModel = selectedConfiguratorFamily.gas === "nitrogen" ? nitroModel : oxygenModel;
    const activePackageMode = selectedConfiguratorFamily.gas === "nitrogen" ? nitroPackageMode : oxygenPackageMode;
    const generated = buildConfiguratorNarrative({
      family: selectedConfiguratorFamily,
      lines: draftLines,
      rec: activeRec,
      selectedModel: activeModel,
      packageMode: activePackageMode,
      customerName: customerDetail?.customer_name || quote?.customer_name || "",
      siteName: selectedSite?.site_name || "",
    });
    setQuoteSummary((prev) => ({
      ...prev,
      executive_summary: generated.executive_summary,
      scope_summary: generated.scope_summary,
      configurator_context: liveConfiguratorContext,
    }));
    setNotice(`${selectedConfiguratorFamily.label} proposal draft generated from configurator context.`);
    setError("");
  }

  function resolveConfiguratorContextForSave() {
    const existing = quoteSummary?.configurator_context;
    if (existing && typeof existing === "object" && (existing.family_key || existing.selected_model || existing.source === "ui_configurator")) {
      return existing;
    }
    if (liveConfiguratorContext && (liveConfiguratorContext.selected_model || liveConfiguratorContext.family_key)) {
      return liveConfiguratorContext;
    }
    return {};
  }

  function renderConfiguratorPreviewBlocks() {
    const scope = activeConfiguratorPreview?.scope_summary || {};
    const deliverables = Array.isArray(scope.deliverables) ? scope.deliverables : [];
    const techHighlights = Array.isArray(scope.tech_highlights) ? scope.tech_highlights : [];

    return (
      <div style={{ border: "1px solid #edf1f7", borderRadius: 10, padding: 10, background: "#fff" }}>
        <div style={{ fontSize: 11, opacity: 0.68 }}>Scope Summary Preview</div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.82 }}>
          Deliverables: {deliverables.length ? deliverables.slice(0, 3).map((row) => row.model).filter(Boolean).join(" • ") : "—"}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.82 }}>Included lines preview: {deliverables.length}</div>
        {techHighlights.length ? (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.82, lineHeight: 1.6 }}>{techHighlights.slice(0, 3).join(" • ")}</div>
        ) : null}
        {activeConfiguratorCard.draftFamiliesLabel ? (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72 }}>Draft family mix: {activeConfiguratorCard.draftFamiliesLabel}</div>
        ) : null}
      </div>
    );
  }

  function setDeliverableRow(index, patch) {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.deliverables) ? current.deliverables.slice() : [];
      if (index < 0 || index >= rows.length) return prev;
      rows[index] = { ...(rows[index] || {}), ...(patch || {}) };
      return { ...prev, scope_summary: { ...current, deliverables: rows } };
    });
  }

  function addDeliverableRow() {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.deliverables) ? current.deliverables.slice() : [];
      rows.push({ model: "", description: "", qty: 1, remarks: "" });
      return { ...prev, scope_summary: { ...current, deliverables: rows } };
    });
  }

  function removeDeliverableRow(index) {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.deliverables) ? current.deliverables.slice() : [];
      rows.splice(index, 1);
      return { ...prev, scope_summary: { ...current, deliverables: rows } };
    });
  }

  function setResponsibilityRow(index, patch) {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.responsibilities) ? current.responsibilities.slice() : [];
      if (index < 0 || index >= rows.length) return prev;
      rows[index] = { ...(rows[index] || {}), ...(patch || {}) };
      return { ...prev, scope_summary: { ...current, responsibilities: rows } };
    });
  }

  function addResponsibilityRow() {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.responsibilities) ? current.responsibilities.slice() : [];
      rows.push({ party: "", responsibility: "" });
      return { ...prev, scope_summary: { ...current, responsibilities: rows } };
    });
  }

  function removeResponsibilityRow(index) {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.responsibilities) ? current.responsibilities.slice() : [];
      rows.splice(index, 1);
      return { ...prev, scope_summary: { ...current, responsibilities: rows } };
    });
  }

  async function refreshSummary(activeQuoteId = quoteId) {
    if (!activeQuoteId) return;
    const data = await apiFetch(`/quotes/${activeQuoteId}/summary`);
    setQuoteSummary({
      revision_id: data?.revision_id ?? null,
      merge_annexures: data?.merge_annexures !== false,
      annexure_mode: data?.annexure_mode || (data?.merge_annexures === false ? "separate" : "merged"),
      executive_summary: data?.executive_summary || {},
      scope_summary: data?.scope_summary || {},
      configurator_context: data?.configurator_context || {},
      is_locked: data?.is_locked === true,
      locked_at: data?.locked_at || null,
      locked_by: data?.locked_by || null,
      can_edit: data?.can_edit === true,
      can_lock: data?.can_lock === true,
      can_unlock: data?.can_unlock === true,
    });
  }

  async function saveSummary() {
    if (!quoteId) return;
    setSummarySaving(true);
    setError("");
    try {
      await apiFetch(`/quotes/${quoteId}/summary`, {
        method: "PUT",
        body: JSON.stringify({
          scope_summary: quoteSummary.scope_summary || {},
          configurator_context: resolveConfiguratorContextForSave(),
        }),
      });
      await refreshSummary(quoteId);
      setNotice("Scope summary saved.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save scope summary."));
    } finally {
      setSummarySaving(false);
    }
  }

  async function updateMergeAnnexures(nextValue) {
    return updateAnnexureMode(nextValue === false ? "separate" : "merged");
  }

  async function updateAnnexureMode(mode) {
    if (!quoteId) return;
    setSummarySaving(true);
    setError("");
    try {
      await apiFetch(`/quotes/${quoteId}/summary`, { method: "PUT", body: JSON.stringify({ annexure_mode: mode }) });
      await refreshSummary(quoteId);
      setNotice(
        mode === "none"
          ? "Ready-made documents will not be sent. The offer uses the generated technical pages."
          : mode === "separate"
            ? "Ready-made documents will be attached as separate files."
            : "Ready-made documents will be merged into the offer PDF."
      );
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save annexure preference."));
    } finally {
      setSummarySaving(false);
    }
  }

  async function lockSummary() {
    if (!quoteId) return;
    setSummarySaving(true);
    setError("");
    try {
      await apiFetch(`/quotes/${quoteId}/summary/lock`, { method: "POST" });
      await refreshSummary(quoteId);
      setNotice("Scope summary locked.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to lock scope summary."));
    } finally {
      setSummarySaving(false);
    }
  }

  async function unlockSummary() {
    if (!quoteId) return;
    setSummarySaving(true);
    setError("");
    try {
      await apiFetch(`/quotes/${quoteId}/summary/unlock`, { method: "POST" });
      await refreshSummary(quoteId);
      setNotice("Scope summary unlocked.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to unlock scope summary."));
    } finally {
      setSummarySaving(false);
    }
  }

  function setTerm(termId, patch) {
    setTerms((prev) => prev.map((term) => (term.id === termId ? { ...term, ...patch } : term)));
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
    setTerms((prev) => prev.filter((term) => term.id !== termId));
  }

  async function persistTermsAndCommercial() {
    if (!quoteId) return null;
    const commercialData = await apiFetch(`/quotes/${quoteId}/commercial`, {
      method: "PUT",
      body: JSON.stringify({
        customer_id: customerId ? Number(customerId) : null,
        customer_site_id: selectedSiteId ? Number(selectedSiteId) : null,
        job_asset_id: selectedJobAssetId ? Number(selectedJobAssetId) : null,
        attention_to: commercialForm.attention_to,
        pricing_display_mode: commercialForm.pricing_display_mode,
        is_export: commercialForm.is_export,
        incoterm_id: commercialForm.incoterm_id ? Number(commercialForm.incoterm_id) : null,
        base_currency_id: commercialForm.base_currency_id ? Number(commercialForm.base_currency_id) : null,
        quote_currency_id: commercialForm.quote_currency_id ? Number(commercialForm.quote_currency_id) : null,
        payment_term_id: commercialForm.payment_term_id ? Number(commercialForm.payment_term_id) : null,
        freight_term_id: commercialForm.freight_term_id ? Number(commercialForm.freight_term_id) : null,
        p_and_f_term_id: commercialForm.p_and_f_term_id ? Number(commercialForm.p_and_f_term_id) : null,
        delivery_lead_time_days: commercialForm.delivery_lead_time_days === "" ? null : Number(commercialForm.delivery_lead_time_days),
        warranty_months: commercialForm.warranty_months === "" ? null : Number(commercialForm.warranty_months),
      }),
    });
    const cadenceData = await apiFetch(`/quotes/${quoteId}/cadence`, {
      method: "PATCH",
      body: JSON.stringify({
        quote_valid_till: cadenceForm.quote_valid_till || null,
        next_follow_up_at: cadenceForm.next_follow_up_at || null,
        quote_kind: cadenceForm.quote_kind || "firm",
      }),
    });
    const termsData = await apiFetch(`/quotes/${quoteId}/terms`, {
      method: "PUT",
      body: JSON.stringify({
        terms: libraryTerms.map((term, idx) => ({
          id: typeof term.id === "number" ? term.id : null,
          caption: term.caption || "",
          description: term.description || "",
          is_selected: Boolean(term.is_selected),
          sort_order: idx + 1,
        })),
      }),
    });
    const savedQuote = commercialData?.quote || quote;
    setQuote(
      cadenceData?.quote
        ? {
            ...savedQuote,
            quote_valid_till: cadenceData.quote.quote_valid_till,
            next_follow_up_at: cadenceData.quote.next_follow_up_at,
            quote_kind: cadenceData.quote.quote_kind,
          }
        : savedQuote
    );
    setRevision(commercialData?.revision || revision);
    if (Array.isArray(commercialData?.lines)) {
      setLines(commercialData.lines);
      setDraftLines(mapServerLinesToDraft(commercialData.lines, quoteBootstrap.price_types));
    }
    setTerms(Array.isArray(termsData?.terms) ? termsData.terms : []);
    runQuietly(() => refreshMailBootstrap(quoteId));
    return { commercialData, cadenceData, termsData };
  }

  async function saveTermsAndCommercial(nextStep = 3) {
    if (!quoteId) return;
    setSaving(true);
    setError("");
    try {
      await persistTermsAndCommercial();
      setStep(nextStep);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save terms and commercial settings."));
    } finally {
      setSaving(false);
    }
  }

  async function recommendNitrogen() {
    if (!quoteId) {
      setError("Start the draft quote on the Customer step before recommending a package.");
      setStep(0);
      return;
    }
    if (!nitroFlow) {
      setError("Enter required flow before recommending.");
      return;
    }
    setNitroWorking(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/recommend/nitrogen`, {
        method: "POST",
        body: JSON.stringify({ purity: nitroPurity, flow: Number(nitroFlow), family_key: selectedConfiguratorFamily.key }),
      });
      setNitroRec(data || null);
      setNitroModel(data?.recommended?.model || "");
      // Keep the user's replace/append choice across re-recommendations.
    } catch (e) {
      setNitroRec(null);
      setNitroModel("");
      setError(e?.data?.error === "NO_DATA" ? "Nitrogen data not configured on server." : getApiErrorMessage(e, "Failed to recommend model."));
    } finally {
      setNitroWorking(false);
    }
  }

  function confirmPackageReplace(applyMode) {
    if (applyMode !== "replace") return true;
    const existing = draftLines.filter((line) => String(line?.product_id || line?.item_code || line?.description || "").trim()).length;
    if (!existing) return true;
    return window.confirm(
      `Applying this package will remove the ${existing} line${existing === 1 ? "" : "s"} already on this quote, including any extras you added.\n\nChoose Cancel and switch to "Append" to keep them.`
    );
  }

  async function applyNitrogen() {
    if (!quoteId || !nitroRec) return;
    if (!confirmPackageReplace(nitroApplyMode)) return;
    setNitroWorking(true);
    setError("");
    setNotice("");
    try {
      // Don't block package apply on an empty draft — same as pre-refactor intent.
      const hasActionableDraft = validateDraftLines(draftLines, { requireAtLeastOne: false }).actionable.length > 0;
      if (hasActionableDraft) {
        await persistDraftLines({ requireAtLeastOne: false });
      }

      const selectedOption =
        (Array.isArray(nitroRec?.options) ? nitroRec.options : []).find(
          (option) => String(option?.model || "").trim() === String(nitroModel || "").trim()
        ) ||
        nitroRec?.recommended ||
        null;
      const modelToApply = String(nitroModel || selectedOption?.model || nitroRec?.recommended?.model || "").trim();

      const data = await apiFetch(`/quotes/${quoteId}/apply/nitrogen`, {
        method: "POST",
        body: JSON.stringify({
          purity: nitroPurity,
          flow: Number(nitroFlow),
          family_key: selectedConfiguratorFamily?.key || "NGEN",
          model: modelToApply || null,
          product_id: selectedOption?.product_id || nitroRec?.recommended?.product_id || null,
          item_code: selectedOption?.item_code || nitroRec?.recommended?.item_code || null,
          replace: nitroApplyMode === "replace",
          package_mode: nitroPackageMode,
        }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines || [], quoteBootstrap.price_types));
      refreshSummary(quoteId).catch(() => {});
      const skipped = Array.isArray(data?.skipped_unmapped_items) ? data.skipped_unmapped_items : [];
      const modeLabel = nitroApplyMode === "replace" ? "replaced existing lines with" : "appended";
      setNotice(
        skipped.length
          ? `Nitrogen package ${modeLabel} the draft. Skipped unmapped items: ${skipped.join(", ")}. Add extras from Product Master if needed.`
          : `Nitrogen package ${modeLabel} the draft. Tax/HSN and list pricing were preserved. Add extras from Product Master if needed.`
      );
    } catch (e) {
      const detail =
        getApiErrorMessage(e, "") ||
        (typeof e?.message === "string" && e.message.trim() ? e.message.trim() : "") ||
        "Failed to apply nitrogen package.";
      setError(detail === "Failed to apply nitrogen package." ? detail : `Failed to apply nitrogen package. ${detail}`);
    } finally {
      setNitroWorking(false);
    }
  }

  async function recommendOxygen() {
    if (!quoteId) {
      setError("Start the draft quote on the Customer step before recommending a package.");
      setStep(0);
      return;
    }
    if (!oxygenFlow) {
      setError("Enter required flow before recommending.");
      return;
    }
    setOxygenWorking(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/recommend/oxygen`, {
        method: "POST",
        body: JSON.stringify({ purity: oxygenPurity, flow: Number(oxygenFlow), family_key: selectedConfiguratorFamily.key }),
      });
      setOxygenRec(data || null);
      setOxygenModel(data?.recommended?.model || "");
      // Keep the user's replace/append choice across re-recommendations.
    } catch (e) {
      setOxygenRec(null);
      setOxygenModel("");
      setError(e?.data?.error === "NO_DATA" ? "Oxygen data not configured on server." : getApiErrorMessage(e, "Failed to recommend oxygen model."));
    } finally {
      setOxygenWorking(false);
    }
  }

  async function applyOxygen() {
    if (!quoteId || !oxygenRec) return;
    if (!confirmPackageReplace(oxygenApplyMode)) return;
    setOxygenWorking(true);
    setError("");
    setNotice("");
    try {
      await persistDraftLines({ requireAtLeastOne: false });
      const data = await apiFetch(`/quotes/${quoteId}/apply/oxygen`, {
        method: "POST",
        body: JSON.stringify({
          purity: oxygenPurity,
          flow: Number(oxygenFlow),
          family_key: selectedConfiguratorFamily.key,
          model: oxygenModel || null,
          replace: oxygenApplyMode === "replace",
          package_mode: oxygenPackageMode,
        }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      refreshSummary(quoteId).catch(() => {});
      const skipped = Array.isArray(data?.skipped_unmapped_items) ? data.skipped_unmapped_items : [];
      const modeLabel = oxygenApplyMode === "replace" ? "replaced existing lines with" : "appended";
      setNotice(
        skipped.length
          ? `Oxygen package ${modeLabel} the draft. Skipped unmapped items: ${skipped.join(", ")}. Add extras from Product Master if needed.`
          : `Oxygen package ${modeLabel} the draft. Tax/HSN and list pricing were preserved. Add extras from Product Master if needed.`
      );
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to apply oxygen package."));
    } finally {
      setOxygenWorking(false);
    }
  }

  async function issueRevision(options = {}) {
    const { promptText = "", successNotice = "Revision issued successfully.", skipConfirm = false } = options;
    if (!quoteId || !["draft", "approved"].includes(revision?.revision_status || "")) return false;
    if (readiness.blockers.length) {
      setError(`Complete required items before issue: ${readiness.blockers.map((item) => item.label).join(" ")}`);
      setStep(readiness.blockers[0].step);
      return false;
    }
    if (issueBlockedByApproval || approval.can_issue === false) {
      setError("This revision needs approval — a discount is above your limit or a price is below the approved band. Submit it for approval first.");
      return false;
    }
    const issuePrompt = [
      promptText || (revision?.revision_status === "approved" ? "Issue this approved revision now?" : "Issue and lock this revision now?"),
      reviewConfiguratorWarnings.length
        ? `\n\nConfigurator review:\n${reviewConfiguratorWarnings.join(" ")}`
        : "",
    ].join("");
    if (!skipConfirm) {
      const ok = window.confirm(issuePrompt);
      if (!ok) return false;
    }
    setSaving(true);
    setError("");
    try {
      // Approved revisions are locked server-side; re-saving them fails with REVISION_NOT_EDITABLE.
      if (String(revision?.revision_status || "") === "draft") {
        await persistDraftLines();
        await persistTermsAndCommercial();
      }
      const latestApproval = await refreshApprovalStatus(quoteId);
      if (latestApproval?.approval_required && String(revision?.revision_status || "") === "draft") {
        setApproval(latestApproval);
        setError("This revision needs approval — a discount is above your limit or a price is below the approved band. Submit it for approval first.");
        return false;
      }
      if (latestApproval?.can_issue === false) {
        setApproval(latestApproval);
        setError("This revision cannot be issued until discount approval is complete.");
        return false;
      }
      const data = await apiFetch(`/quotes/${quoteId}/issue`, { method: "POST" });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      setApproval(data?.approval || approval);
      if (successNotice) setNotice(successNotice);
      runQuietly(() => refreshMailBootstrap(quoteId));
      return true;
    } catch (e) {
      if (e?.data?.approval) setApproval(e.data.approval);
      if (e?.data?.error === "APPROVAL_REQUIRED") {
        setError("This revision needs approval — a discount is above your limit or a price is below the approved band. Submit it for approval first.");
      } else if (e?.data?.error === "ISSUE_READINESS_FAILED" && Array.isArray(e?.data?.blockers) && e.data.blockers.length) {
        setError(`Complete required items before issue: ${e.data.blockers.map((item) => item?.label || "Missing requirement.").join(" ")}`);
      } else if (e?.data?.error === "REVISION_NOT_ISSUABLE") {
        setError("This revision cannot be issued in its current state.");
      } else {
        setError(getApiErrorMessage(e, "Failed to issue revision."));
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submitForApproval() {
    if (!quoteId || revision?.revision_status !== "draft") return;
    if (readiness.blockers.length) {
      setError(`Complete required items before submission: ${readiness.blockers.map((item) => item.label).join(" ")}`);
      setStep(readiness.blockers[0].step);
      return;
    }
    const submitPrompt = [
      "Submit this revision into the approval workflow?",
      reviewConfiguratorWarnings.length
        ? `\n\nConfigurator review:\n${reviewConfiguratorWarnings.join(" ")}`
        : "",
    ].join("");
    const ok = window.confirm(submitPrompt);
    if (!ok) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await persistDraftLines();
      await persistTermsAndCommercial();
      const data = await apiFetch(`/quotes/${quoteId}/submit-approval`, { method: "POST" });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      setApproval(data?.approval || approval);
      setNotice("Revision submitted for approval.");
    } catch (e) {
      if (e?.data?.approval) setApproval(e.data.approval);
      if (e?.data?.error === "APPROVAL_NOT_REQUIRED") {
        setError("Approval is not required for this revision. You can issue it directly.");
      } else if (e?.data?.error === "APPROVER_NOT_CONFIGURED") {
        setError("Approval chain is not configured. Assign manager approvers with quote approval rights.");
      } else {
        setError(getApiErrorMessage(e, "Failed to submit for approval."));
      }
    } finally {
      setSaving(false);
    }
  }

  async function approveRevision() {
    if (!quoteId || !approval.can_actor_approve || !canApproveQuotes) return;
    const remarks = window.prompt("Approval remarks (optional):", "");
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/approve`, {
        method: "POST",
        body: JSON.stringify({ remarks: remarks || "" }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      setApproval(data?.approval || approval);
      setNotice(data?.revision?.revision_status === "approved" ? "Revision approved." : "Approval recorded and routed to the next approver.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to approve revision."));
    } finally {
      setSaving(false);
    }
  }

  async function rejectRevision() {
    if (!quoteId || !approval.can_actor_approve || !canApproveQuotes) return;
    const remarks = window.prompt("Rejection remarks:", "");
    if (remarks === null) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/reject`, {
        method: "POST",
        body: JSON.stringify({ remarks: remarks || "" }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      setApproval(data?.approval || approval);
      setNotice("Revision rejected. Create a new revision to make changes.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to reject revision."));
    } finally {
      setSaving(false);
    }
  }

  async function startNewRevision() {
    if (!quoteId) return;
    const currentState = String(revision?.revision_status || "").toLowerCase();
    if (!["issued", "rejected"].includes(currentState)) return;
    const amendmentReason = window.prompt("What is changing in this revision? (optional)", "");
    if (amendmentReason === null) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/quotes/${quoteId}/revisions`, {
        method: "POST",
        body: JSON.stringify({ amendment_reason: amendmentReason || "" }),
      });
      await loadQuoteContext(quoteId);
      await refreshApprovalStatus(quoteId);
      runQuietly(() => refreshMailBootstrap(quoteId));
      setStep(1);
      setNotice("New revision opened. Amend the offer, then move through Review to reissue.");
    } catch (e) {
      if (e?.data?.error === "ALREADY_DRAFT") {
        setError("A draft revision already exists on this quote. Continue editing that revision instead of creating another.");
      } else {
        setError(getApiErrorMessage(e, "Failed to create a new revision."));
      }
    } finally {
      setSaving(false);
    }
  }

  async function createSalesOrder() {
    if (!quoteId || revision?.revision_status !== "issued") return;
    const ok = window.confirm("Create Sales Order from this issued quote revision?");
    if (!ok) return;
    setCreatingSalesOrder(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/sales-orders/from-quote/${quoteId}`, { method: "POST" });
      const salesOrderId = data?.sales_order?.id;
      if (salesOrderId && onOpenSalesOrder) {
        onOpenSalesOrder(salesOrderId);
      } else {
        setNotice("Sales order created successfully.");
      }
    } catch (e) {
      if (e?.data?.error === "SALES_ORDER_ALREADY_EXISTS" && e?.data?.sales_order_id && onOpenSalesOrder) {
        onOpenSalesOrder(e.data.sales_order_id);
        return;
      }
      if (e?.data?.error === "QUOTE_NOT_ISSUED") {
        setError("Only issued quote revisions can be converted into sales orders.");
      } else {
        setError(getApiErrorMessage(e, "Failed to create sales order."));
      }
    } finally {
      setCreatingSalesOrder(false);
    }
  }

  async function sendQuoteMail({ issueAndSend = false, confirmResend = false, confirmLarge = false } = {}) {
    if (!quoteId) return;
    if (readiness.blockers.length) {
      setError(`Complete required items before sending: ${readiness.blockers.map((item) => item.label).join(" ")}`);
      setStep(readiness.blockers[0].step);
      return;
    }
    const currentRevisionState = String(revision?.revision_status || "").toLowerCase();
    if (currentRevisionState !== "issued") {
      if (!issueAndSend) {
        setError("Issue the quote first. Sending is a separate customer handoff after the commercial lock.");
        return;
      }
      if (!["draft", "approved"].includes(currentRevisionState)) {
        setError("Only issue-ready revisions can be sent from this screen.");
        return;
      }
      if (issueBlockedByApproval || approval.can_issue === false) {
        setError("This revision needs approval — a discount is above your limit or a price is below the approved band. Submit it for approval first.");
        return;
      }
      const issued = await issueRevision({
        promptText: currentRevisionState === "approved" ? "Issue this approved revision and send it now?" : "Issue, lock, and send this revision now?",
        successNotice: "",
      });
      if (!issued) return;
    }
    setMailSending(true);
    setMailNotice("");
    setError("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/send-mail`, {
        method: "POST",
        body: JSON.stringify({
          ...buildMailRequestBody(),
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
          : `${currentRevisionState === "issued" ? "Quote mail sent successfully." : "Revision issued and quote mail sent successfully."}${skipped}`
      );
      setMailPreview(null);
      setMailComposerOpen(false);
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
        const again = window.confirm(
          `The attachments add up to ${formatBytes(e.data.total_bytes)}, above the ${formatBytes(e.data.limit_bytes)} safe limit. Many customer mailboxes reject emails this large.\n\nSend anyway?`
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
        refreshMailBootstrap(quoteId).catch(() => {});
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
      } else {
        setError(getApiErrorMessage(e, "The email could not be sent. Please try again in a moment."));
      }
    } finally {
      setMailSending(false);
    }
  }

  function fmtDateTime(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }

  function validateStep(targetStep) {
    if (targetStep === 0) {
      if (!customerId) return { ok: false, message: "Select a customer before continuing." };
      return { ok: true };
    }
    if (targetStep === 1) {
      const lineValidation = validateDraftLines(draftLines, { requireAtLeastOne: true });
      if (!lineValidation.ok) return { ok: false, message: lineValidation.message || "Add at least one valid quote line." };
      if (!quoteId) return { ok: false, message: "Start the draft quote before continuing." };
      return { ok: true };
    }
    if (targetStep === 2) {
      if (!quoteCurrencyLabel || quoteCurrencyLabel === "—") return { ok: false, message: "Quote currency is required." };
      if (!paymentTermLabel || paymentTermLabel === "—") return { ok: false, message: "Payment term is required." };
      if (!cadenceForm.quote_valid_till) return { ok: false, message: "Quote validity date is required." };
      return { ok: true };
    }
    return { ok: true };
  }

  function validateCurrentStep() {
    return validateStep(step);
  }

  const canGoNext = useMemo(() => validateStep(step).ok, [
    step,
    customerId,
    draftLines,
    quoteId,
    quoteCurrencyLabel,
    paymentTermLabel,
    cadenceForm.quote_valid_till,
  ]);

  function goToStep(next) {
    const idx = Math.max(0, Math.min(steps.length - 1, Number(next) || 0));
    setStep(idx);
  }

  function goBack() {
    if (step <= 0) return;
    setStep(step - 1);
  }

  async function goNext() {
    const check = validateStep(step);
    if (!check.ok) {
      setError(check.message || "Complete the required fields before continuing.");
      return false;
    }
    setError("");
    try {
      if (step === 0) {
        if (!quoteId) {
          await startDraftQuote();
        } else {
          setStep(1);
        }
        return true;
      }
      if (step === 1) {
        await saveItemsAndContinue();
        return true;
      }
      if (step === 2) {
        await saveTermsAndCommercial(3);
        return true;
      }
      return true;
    } catch (e) {
      setError(getApiErrorMessage(e, "Could not continue to the next step."));
      return false;
    }
  }

  return {
    state: { step, error, notice },
    derived: {
      readiness,
      recommendedNextAction,
      checklistItems,
      lifecycleBadge,
      primaryFlowAction,
      progressPct,
      revisionState,
      revisionStateLabel,
      canIssueAndSend,
      sendRequiresIssue,
      issueBlockedByApproval,
      canApproveQuotes,
      canGoNext,
      currentStepIndex,
    },
    actions: {
      setStep,
      setError,
      setNotice,
      goNext,
      goBack,
      goToStep,
      validateStep,
      validateCurrentStep,
      startDraftQuote,
      saveItemsAndContinue,
      persistDraftLines,
      persistTermsAndCommercial,
      saveTermsAndCommercial,
      issueRevision,
      submitForApproval,
      sendQuoteMail,
    },
    activeConfiguratorCard,
    activeConfiguratorModel,
    activeConfiguratorPackageMode,
    activeConfiguratorPreview,
    activeConfiguratorRec,
    activeQuoteExchangeRate,
    addCategoryId,
    addDeliverableRow,
    addDiscAmt,
    addDiscPct,
    addGrossUnit,
    addGroupId,
    addPriceList,
    addProductQ,
    addProductResults,
    addQty,
    addRecommendedJobSpare,
    addRemarks,
    addResponsibilityRow,
    addSelectedItem,
    addSelectedProduct,
    addTerm,
    advancedLineKey,
    aftermarketContext,
    annexures,
    changeOfferType,
    offerType,
    offerTypeSource,
    applyMailPreset,
    applyNitrogen,
    applyOxygen,
    approval,
    approvalHistoryPreview,
    approvalHistoryRows,
    approvalLoading,
    approveRevision,
    attentionTo,
    autoExpandedQueryRef,
    baseCurrencyLabel,
    buildDraftLineFromProduct,
    bulletsToText,
    cadenceForm,
    cadenceValidityNote,
    canApproveQuotes,
    canGoNext,
    canIssueAndSend,
    canSelectForeignQuoteCurrency,
    checklistItems,
    clearCustomerSelection,
    commercialForm,
    contactCreating,
    createInlineContact,
    createInlineCustomer,
    createInlineSite,
    createSalesOrder,
    creatingSalesOrder,
    currentStepIndex,
    customerContacts,
    customerCreateDismissed,
    customerCreating,
    customerDetail,
    customerId,
    customerQ,
    customerResults,
    customerResultsSummary,
    customerSearchQuery,
    customerSearching,
    customerSites,
    defaultFreightTermId,
    defaultIncotermId,
    defaultIndiaCountryId,
    defaultPAndFTermId,
    defaultPaymentTermId,
    discountTotal,
    dismissCustomerCreate,
    draftDuplicateAdvisory,
    draftLines,
    duplicateDraftLine,
    error,
    filteredGroups,
    fmtDateTime,
    freightTermLabel,
    generateSummaryFromConfigurator,
    goBack,
    goNext,
    goToStep,
    grandTotal,
    handleAddNewCustomerCity,
    handleMailAttachmentUpload,
    hasQuoteItems,
    incotermLabel,
    initialLaunch,
    initialQuoteId,
    inrCurrency,
    isBrowsingProducts,
    isExistingDraft,
    issueBlockedByApproval,
    issueRevision,
    itemsLane,
    jobAssetSummary,
    jobAssets,
    jobAssetsLoading,
    libraryTerms,
    lifecycleBadge,
    lines,
    liveConfiguratorContext,
    loadQuoteContext,
    loading,
    lockSummary,
    mailAttachmentInputRef,
    mailAttachmentUploading,
    mailAttachments,
    mailBootstrap,
    mailComposerOpen,
    mailForm,
    mailPreview,
    mailPreviewLoading,
    mailSignature,
    setMailSignature,
    saveMailSignature,
    previewQuoteMail,
    setMailPreview,
    mailHistoryPreview,
    mailHistoryRows,
    mailLoading,
    mailNotice,
    mailSending,
    managedCommercialTerms,
    me,
    moveDraftLine,
    newContactForm,
    newCustomerAddCityName,
    newCustomerAddCityOpen,
    newCustomerAdvisoryDuplicates,
    newCustomerAllowDuplicate,
    newCustomerBlockingDuplicates,
    newCustomerChecked,
    newCustomerChecking,
    newCustomerCityOptions,
    newCustomerDupeSeqRef,
    newCustomerDupeTimerRef,
    newCustomerDuplicates,
    newCustomerForm,
    newCustomerSavingCity,
    newCustomerSelectedCityId,
    newCustomerSelectedStateId,
    newCustomerStateOptions,
    newSiteForm,
    nitroApplyMode,
    nitroFlow,
    nitroModel,
    nitroPackageMode,
    nitroPurities,
    nitroPurity,
    nitroRec,
    nitroWorking,
    notice,
    onCancel,
    onOpenDetail,
    onOpenLead,
    onOpenSalesOrder,
    onQuoteChanged,
    openAbsstemShieldLane,
    openCustomerCreate,
    openMailAttachmentPicker,
    openMailComposer,
    openProductMasterLane,
    oxygenApplyMode,
    oxygenFlow,
    oxygenModel,
    oxygenPackageMode,
    oxygenPurity,
    oxygenRec,
    oxygenWorking,
    pAndFTermLabel,
    parseBulletLines,
    paymentTermLabel,
    persistDraftLines,
    persistTermsAndCommercial,
    priceHintProductKey,
    priceHints,
    priceTypeOptions,
    pricingGuardrails,
    pricingSnapshotCards,
    primaryFlowAction,
    productCategories,
    productGroups,
    progressPct,
    quotableCustomerSites,
    quote,
    quoteBootstrap,
    quoteChangeSignature,
    quoteCurrencyLabel,
    quoteId,
    quoteRoute,
    quoteSummary,
    readiness,
    recommendNitrogen,
    recommendOxygen,
    recommendedJobSpares,
    recommendedJobSparesLoading,
    recommendedNextAction,
    refreshApprovalStatus,
    refreshCustomerMaster,
    refreshMailAttachments,
    refreshMailBootstrap,
    refreshSummary,
    rejectRevision,
    removeDeliverableRow,
    removeDraftLine,
    removeResponsibilityRow,
    removeTerm,
    renderConfiguratorPreviewBlocks,
    resetFastAdd,
    resolveConfiguratorContextForSave,
    resolveMailPreset,
    returnToPackageBuilder,
    reviewConfiguratorContext,
    reviewConfiguratorWarnings,
    revision,
    revisionState,
    revisionStateLabel,
    saveItemsAndContinue,
    saveSummary,
    saveTermsAndCommercial,
    saving,
    searchCustomers,
    selectCustomer,
    selectProductForAdd,
    selectedConfiguratorFamily,
    selectedConfiguratorFamilyKey,
    selectedContact,
    selectedContactId,
    selectedCustomer,
    selectedCustomerRecord,
    selectedGroupNames,
    selectedJobAsset,
    selectedJobAssetDetail,
    selectedJobAssetId,
    selectedLibraryTermsCount,
    selectedMailPreset,
    selectedProductBasePrice,
    selectedProductQuoteListPrice,
    selectedSite,
    selectedSiteId,
    sendQuoteMail,
    sendRequiresIssue,
    setAddCategoryId,
    setAddDiscAmt,
    setAddDiscPct,
    setAddGrossUnit,
    setAddGroupId,
    setAddPriceList,
    setAddProductQ,
    setAddProductResults,
    setAddQty,
    setAddRemarks,
    setAddSelectedProduct,
    setAdvancedLineKey,
    setAftermarketContext,
    setAnnexures,
    setApproval,
    setApprovalLoading,
    setAttentionTo,
    setCadenceForm,
    setCommercialForm,
    setContactCreating,
    setCreatingSalesOrder,
    setCustomerContacts,
    setCustomerCreateDismissed,
    setCustomerCreating,
    setCustomerDetail,
    setCustomerId,
    setCustomerQ,
    setCustomerResults,
    setCustomerSearching,
    setCustomerSites,
    setDeliverableRow,
    setDraftDuplicateAdvisory,
    setDraftLine,
    setDraftLines,
    setError,
    setExecutiveSummaryField,
    setItemsLane,
    setJobAssets,
    setJobAssetsLoading,
    setLines,
    setLoading,
    setMailAttachmentUploading,
    setMailAttachments,
    setMailBootstrap,
    setMailComposerOpen,
    setMailForm,
    setMailLoading,
    setMailNotice,
    setMailSending,
    setNewContactForm,
    setNewCustomerAddCityName,
    setNewCustomerAddCityOpen,
    setNewCustomerAllowDuplicate,
    setNewCustomerChecked,
    setNewCustomerChecking,
    setNewCustomerDuplicates,
    setNewCustomerForm,
    setNewCustomerSavingCity,
    setNewSiteForm,
    setNitroApplyMode,
    setNitroFlow,
    setNitroModel,
    setNitroPackageMode,
    setNitroPurities,
    setNitroPurity,
    setNitroRec,
    setNitroWorking,
    setNotice,
    setOxygenApplyMode,
    setOxygenFlow,
    setOxygenModel,
    setOxygenPackageMode,
    setOxygenPurity,
    setOxygenRec,
    setOxygenWorking,
    setPriceHints,
    setProductCategories,
    setProductGroups,
    setQuote,
    setQuoteBootstrap,
    setQuoteId,
    setQuoteRoute,
    setQuoteSummary,
    setRecommendedJobSpares,
    setRecommendedJobSparesLoading,
    setResponsibilityRow,
    setRevision,
    setSaving,
    setScopeBulletField,
    setScopeSummaryField,
    setSelectedConfiguratorFamilyKey,
    setSelectedContactId,
    setSelectedCustomerRecord,
    setSelectedJobAssetDetail,
    setSelectedJobAssetId,
    setSelectedSiteId,
    setShowContactCreate,
    setShowCustomerCreate,
    setShowCustomerOptional,
    setShowExportControls,
    setShowSiteCreate,
    setSiteCreating,
    setStep,
    setSummarySaving,
    setTerm,
    setTerms,
    showContactCreate,
    showCustomerCreate,
    showCustomerOptional,
    showExportControls,
    showSiteCreate,
    sidebarCommercialRows,
    siteCreating,
    startDraftQuote,
    startNewRevision,
    step,
    steps,
    submitForApproval,
    subtotal,
    summarySaving,
    taxTotal,
    terms,
    topLineItemsPreview,
    totalRecommendedJobSpareQty,
    unlockSummary,
    updateMergeAnnexures,
    updateAnnexureMode,
    useContactForAttention,
    validateCurrentStep,
    validateStep,
    visibleConfiguratorFamilies,
  };
}

export default useQuoteBuilder;
