import { dateInputValueFromToday } from "../quoteShared";
import {
  calcLineNetTotal,
  citiesForState,
  formatProposalProfileLabel,
  getPriceTypeLabel,
  statesForCountry,
  toNumber,
  findIndiaCountryId,
  findStateId,
  findCityId,
  appendCityOption,
  createCityMaster,
  isBlockingDuplicateLevel,
  normalizeLookupText,
  getManagedCommercialTermKind,
  isManagedCommercialTerm,
  CONFIGURATOR_FAMILIES,
  pickConfiguratorModel,
  buildConfiguratorNarrative,
  buildConfiguratorRecommendationCard,
  buildConfiguratorContextPayload,
  summarizeDraftConfiguratorFamilies,
  detectConfiguratorFamilyKeyFromText,
  detectConfiguratorFamilyKeyFromLine,
  convertBaseAmountToQuote,
  resolveQuoteExchangeRate,
  getFallbackDraftLineQuotePrice,
  roundPricing,
  getPriceTypeLabel as _gptl,
  toEditableLine,
  mapServerLinesToDraft,
  buildLineMeta,
  buildLineFloorHint,
  cloneDraftLine,
  normalizeEditableLinePricing,
  normalizePricingFields,
  calcLineTaxTotal,
  safeParseMeta,
} from "../quoteBuilderHelpers";
import {
  CustomerChip,
  CustomerResultCard,
  CustomerStatCard,
  DraftLineCard,
  DuplicateWarningBanner,
  Field,
  HistoryTable,
  ProductResultCard,
  SelectedCustomerCard,
  ConfiguratorFamilyCard,
  ConfiguratorOptionCard,
} from "../quoteBuilderUi";

export default function QuoteStepCommercials({ api }) {
  const {
    QUOTE_STEPS,
    activeConfiguratorCard,
    activeConfiguratorModel,
    activeConfiguratorPackageMode,
    activeConfiguratorPreview,
    activeConfiguratorRec,
    activeModel,
    activePackageMode,
    activeQuoteExchangeRate,
    activeRec,
    activeSite,
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
    amendmentReason,
    annexureData,
    annexures,
    applyMailPreset,
    applyNitrogen,
    applyOxygen,
    approval,
    approvalHistoryPreview,
    approvalHistoryRows,
    approvalLoading,
    approveRevision,
    assetLabel,
    attentionTo,
    autoExpandedQueryRef,
    baseCurrencyLabel,
    blockers,
    blocking,
    buildDraftLineFromProduct,
    bulletsToText,
    cadenceData,
    cadenceForm,
    cadenceValidityNote,
    canApproveQuotes,
    canGoNext,
    canIssueAndSend,
    canSelectForeignQuoteCurrency,
    checklistItems,
    cid,
    city,
    clearCustomerSelection,
    commercialData,
    commercialForm,
    computedGross,
    contact,
    contactCreating,
    contactName,
    contacts,
    copy,
    createInlineContact,
    createInlineCustomer,
    createInlineSite,
    createSalesOrder,
    creatingSalesOrder,
    ctx,
    current,
    currentGrossUnit,
    currentRevisionState,
    currentSiteId,
    currentState,
    currentStepIndex,
    customer,
    customerContacts,
    customerCreateDismissed,
    customerCreating,
    customerDetail,
    customerId,
    customerName,
    customerQ,
    customerResults,
    customerResultsSummary,
    customerSearchQuery,
    customerSearching,
    customerSites,
    d,
    data,
    days,
    defaultFreightTermId,
    defaultIncotermId,
    defaultIndiaCountryId,
    defaultPAndFTermId,
    defaultPaymentTermId,
    deliverables,
    detail,
    details,
    dismissCustomerCreate,
    draftDuplicateAdvisory,
    draftLines,
    duplicateDraftLine,
    email,
    err,
    error,
    existing,
    exists,
    files,
    filteredGroups,
    firstFamily,
    fixedInrId,
    fmtDateTime,
    formData,
    freightTermLabel,
    fromResults,
    generateSummaryFromConfigurator,
    generated,
    goBack,
    goNext,
    goToStep,
    gross,
    groups,
    gstin,
    handleAddNewCustomerCity,
    handleMailAttachmentUpload,
    hasQuoteItems,
    id,
    incotermLabel,
    index,
    initialLaunch,
    initialQuoteId,
    inrCurrency,
    isBrowsingProducts,
    isChanged,
    isExistingDraft,
    issueBlockedByApproval,
    issuePrompt,
    issueRevision,
    issued,
    items,
    itemsLane,
    jobAssetSummary,
    jobAssets,
    jobAssetsLoading,
    key,
    kind,
    latestApproval,
    libraryTerms,
    lifecycleBadge,
    lineValidation,
    lines,
    liveConfiguratorContext,
    loadQuoteContext,
    loading,
    lockSummary,
    mailAttachmentData,
    mailAttachmentInputRef,
    mailAttachmentUploading,
    mailAttachments,
    mailBootstrap,
    mailComposerOpen,
    mailContext,
    mailForm,
    mailHistoryPreview,
    mailHistoryRows,
    mailLoading,
    mailNotice,
    mailSending,
    managedByKind,
    managedCommercialTerms,
    master,
    match,
    me,
    merged,
    modeLabel,
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
    next,
    nextApproval,
    nextAttention,
    nextAttentionTo,
    nextCustomerId,
    nextCustomerName,
    nextJobAssetId,
    nextQuoteCurrencyId,
    nextSeed,
    nextSourceLabel,
    nextSourceNote,
    nitroApplyMode,
    nitroFlow,
    nitroModel,
    nitroPackageMode,
    nitroPurities,
    nitroPurity,
    nitroRec,
    nitroWorking,
    norm,
    notice,
    ok,
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
    params,
    parseBulletLines,
    payload,
    paymentTermLabel,
    persistDraftLines,
    persistTermsAndCommercial,
    phone,
    preset,
    presets,
    previousBootstrap,
    previousMultiplier,
    previousPriceListKey,
    priceHintProductKey,
    priceHints,
    priceListChanged,
    priceTypeOptions,
    pricingGuardrails,
    pricingSnapshotCards,
    primary,
    primaryFlowAction,
    productCategories,
    productGroups,
    productIds,
    progressPct,
    purities,
    q,
    qp,
    qty,
    qtyRecommended,
    quotableCustomerSites,
    quote,
    quoteBootstrap,
    quoteChangeSignature,
    quoteCurrencyLabel,
    quoteId,
    quoteListPrice,
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
    refreshed,
    rejectRevision,
    remarks,
    removeDeliverableRow,
    removeDraftLine,
    removeResponsibilityRow,
    removeTerm,
    renderConfiguratorPreviewBlocks,
    resetFastAdd,
    resolveConfiguratorContextForSave,
    resolveMailPreset,
    resolvedPriceList,
    returnToPackageBuilder,
    reviewConfiguratorContext,
    reviewConfiguratorWarnings,
    revision,
    revisionState,
    revisionStateLabel,
    rows,
    salesOrderId,
    saveItemsAndContinue,
    saveSummary,
    saveTermsAndCommercial,
    savedQuote,
    saving,
    scope,
    searchCustomers,
    seededRoute,
    selectCustomer,
    selectProductForAdd,
    selected,
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
    seq,
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
    site,
    siteCreating,
    sites,
    skipped,
    soft,
    sourceCodes,
    sourceListPrice,
    sourceListPriceRaw,
    startDraftQuote,
    startNewRevision,
    state,
    step,
    steps,
    submitForApproval,
    submitPrompt,
    summaryContext,
    summaryData,
    summarySaving,
    t,
    target,
    techHighlights,
    terms,
    termsData,
    topLineItemsPreview,
    totalBytes,
    totalLimitBytes,
    totalRecommendedJobSpareQty,
    totals,
    unlockSummary,
    updateMergeAnnexures,
    useContactForAttention,
    validateCurrentStep,
    validateStep,
    validation,
    visibleConfiguratorFamilies,
    warningList,
    warnings
  } = api;
  const pdfOutputLabel =
    quoteSummary.annexure_mode === "none"
      ? "Offer PDF only"
      : quoteSummary.annexure_mode === "separate" || quoteSummary.merge_annexures === false
        ? "Separate PDFs"
        : "One PDF";

  return (
<div style={{ marginTop: 18, border: "1px solid #dfe6f4", borderRadius: 20, padding: 20, background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)", boxShadow: "0 16px 36px rgba(25,45,84,0.05)" }}>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>Step 3</div>
                <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>Commercials</div>
                <div style={{ marginTop: 6, fontSize: 13, opacity: 0.72, lineHeight: 1.7 }}>
                  Confirm payment, freight, currency, tax framing, and quote validity before review and delivery.
                </div>
              </div>

              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                <CustomerStatCard label="Route" value={quoteRoute === "healthcare" ? "Healthcare" : "Industrial"} accent={quoteRoute === "healthcare" ? "#1a7f47" : "#2354d5"} />
                <CustomerStatCard label="PDF Output" value={pdfOutputLabel} accent={quoteSummary.annexure_mode === "separate" ? "#9a5a00" : "#1a7f47"} />
              </div>

              <div style={{ marginTop: 16, display: "grid", gap: 16 }}>
                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "radial-gradient(circle at top right, rgba(141,180,255,0.16), transparent 34%), linear-gradient(135deg, #f8fbff 0%, #ffffff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Commercial Defaults</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        Keep the standard domestic quote path simple. Review INR, `ADV50`, `3% Extra`, `Extra at actuals` freight, and `EXW` here, and only open export controls when the quote is truly exceptional.
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CustomerChip label="Domestic default" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                      <CustomerChip label={quoteRoute === "healthcare" ? "Healthcare route" : "Industrial route"} tone={quoteRoute === "healthcare" ? "#edf7f0" : "#eef4ff"} color={quoteRoute === "healthcare" ? "#1a7f47" : "#2354d5"} borderColor={quoteRoute === "healthcare" ? "rgba(26,127,71,0.14)" : "rgba(35,84,213,0.14)"} />
                    </div>
                  </div>

                  <div style={{ marginBottom: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                    <CustomerStatCard label="Pricing Mode" value={(quoteBootstrap.pricing_modes || []).find((mode) => mode.key === commercialForm.pricing_display_mode)?.label || "—"} accent="#2354d5" />
                    <CustomerStatCard label="Quote Currency" value={quoteCurrencyLabel || "INR - Indian Rupee"} accent="#31539d" />
                    <CustomerStatCard label="Supporting Clauses" value={selectedLibraryTermsCount} accent="#1a7f47" />
                    <CustomerStatCard label="PDF Output" value={pdfOutputLabel} accent={quoteSummary.annexure_mode === "separate" ? "#9a5a00" : "#1a7f47"} />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                    <Field label="Attention To">
                      <input
                        value={commercialForm.attention_to}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, attention_to: e.target.value }))}
                      />
                    </Field>
                    <Field label="Pricing Mode">
                      <select
                        value={commercialForm.pricing_display_mode}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, pricing_display_mode: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        {(quoteBootstrap.pricing_modes || []).map((mode) => (
                          <option key={mode.key} value={mode.key}>
                            {mode.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Base Currency">
                      <select value={commercialForm.base_currency_id} disabled style={{ width: "100%", minWidth: 0 }}>
                        <option value={inrCurrency?.id ? String(inrCurrency.id) : ""}>
                          {inrCurrency ? `${inrCurrency.currency_code} - ${inrCurrency.currency_name}` : "INR - Indian Rupee"}
                        </option>
                      </select>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>Base currency is fixed to INR for all quotes.</div>
                    </Field>
                    <Field label="Quote Currency">
                      <select
                        value={commercialForm.quote_currency_id}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, quote_currency_id: e.target.value }))}
                        disabled={!canSelectForeignQuoteCurrency}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        {!canSelectForeignQuoteCurrency ? null : <option value="">Select quote</option>}
                        {(quoteBootstrap.currencies || []).map((currency) =>
                          !canSelectForeignQuoteCurrency && String(currency.currency_code || "").trim().toUpperCase() !== "INR" ? null : (
                            <option key={currency.id} value={String(currency.id)}>
                              {currency.currency_code} - {currency.currency_name}
                            </option>
                          )
                        )}
                      </select>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>
                        {canSelectForeignQuoteCurrency ? "Export or outside-India quotes can use a quoted currency different from INR." : "Domestic quote currency stays locked to INR."}
                      </div>
                    </Field>
                    <Field label="Incoterm">
                      <select
                        value={commercialForm.incoterm_id}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, incoterm_id: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        <option value="">Select incoterm</option>
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
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        <option value="">Select payment term</option>
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
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        <option value="">Select freight term</option>
                        {(quoteBootstrap.freight_terms || []).map((item) => (
                          <option key={item.id} value={String(item.id)}>
                            {item.term_code} - {item.term_name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="P&F Term">
                      <select
                        value={commercialForm.p_and_f_term_id}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, p_and_f_term_id: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        <option value="">Select P&F term</option>
                        {(quoteBootstrap.p_and_f_terms || []).map((item) => (
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
                        placeholder="e.g. 56"
                        style={{ width: "100%", minWidth: 0 }}
                      />
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>
                        Defaults from Terms Library Delivery (e.g. 6–8 weeks → days). Free-text Delivery clause still lives under Supporting Clauses.
                      </div>
                    </Field>
                    <Field label="Warranty (months)">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={commercialForm.warranty_months}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, warranty_months: e.target.value }))}
                        placeholder="e.g. 12"
                        style={{ width: "100%", minWidth: 0 }}
                      />
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>
                        Defaults from Terms Library Warranty (commissioning months). Full warranty wording stays in Supporting Clauses.
                      </div>
                    </Field>
                    <div style={{ marginTop: 22, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                      {!showExportControls && !commercialForm.is_export ? (
                        <>
                          <div style={{ fontSize: 12, fontWeight: 700 }}>Domestic default locked</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68, lineHeight: 1.6 }}>
                            Export and foreign-currency settings stay hidden for standard quotes. Open them only if this quote is intentionally export or exception-based.
                          </div>
                          <button type="button" onClick={() => setShowExportControls(true)} style={{ marginTop: 10 }}>
                            Open Export / FX Settings
                          </button>
                        </>
                      ) : (
                        <>
                          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input
                              type="checkbox"
                              checked={commercialForm.is_export}
                              onChange={(e) =>
                                setCommercialForm((prev) => ({
                                  ...prev,
                                  is_export: e.target.checked,
                                  quote_currency_id: e.target.checked ? prev.quote_currency_id || String(inrCurrency?.id || "") : String(inrCurrency?.id || ""),
                                }))
                              }
                              disabled={!inrCurrency?.id}
                            />
                            Export Quote
                          </label>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>
                            Toggles export-specific commercial handling and downstream proposal expectations.
                          </div>
                          <div style={{ marginTop: 10 }}>
                            <button type="button" onClick={() => setShowExportControls(false)} disabled={commercialForm.is_export}>
                              Hide Export / FX Settings
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Validity & Follow-up</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        Decide the validity you are committing to and when you will chase it. Both travel with the quote and drive your Sales Desk follow-up queue.
                      </div>
                    </div>
                    <CustomerChip
                      label={cadenceValidityNote.label}
                      tone={cadenceValidityNote.tone}
                      color={cadenceValidityNote.color}
                      borderColor={cadenceValidityNote.borderColor}
                    />
                  </div>
                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                    <Field label="Quote Valid Till">
                      <input
                        type="date"
                        value={cadenceForm.quote_valid_till}
                        onChange={(e) => setCadenceForm((prev) => ({ ...prev, quote_valid_till: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      />
                      <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {[15, 30, 45, 60].map((days) => (
                          <button
                            key={days}
                            type="button"
                            onClick={() => setCadenceForm((prev) => ({ ...prev, quote_valid_till: dateInputValueFromToday(days) }))}
                            style={{ fontSize: 11, padding: "4px 8px" }}
                          >
                            {days} days
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label="Next Follow-up">
                      <input
                        type="date"
                        value={cadenceForm.next_follow_up_at}
                        onChange={(e) => setCadenceForm((prev) => ({ ...prev, next_follow_up_at: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      />
                      <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {[3, 7, 14].map((days) => (
                          <button
                            key={days}
                            type="button"
                            onClick={() => setCadenceForm((prev) => ({ ...prev, next_follow_up_at: dateInputValueFromToday(days) }))}
                            style={{ fontSize: 11, padding: "4px 8px" }}
                          >
                            +{days}d
                          </button>
                        ))}
                        <button type="button" onClick={() => setCadenceForm((prev) => ({ ...prev, next_follow_up_at: "" }))} style={{ fontSize: 11, padding: "4px 8px" }}>
                          Clear
                        </button>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>
                        {cadenceForm.next_follow_up_at ? "This quote will surface in your follow-up queue on that date." : "Without a follow-up date this quote never reminds you to chase it."}
                      </div>
                    </Field>
                    <Field label="Quote Kind">
                      <select
                        value={cadenceForm.quote_kind}
                        onChange={(e) => setCadenceForm((prev) => ({ ...prev, quote_kind: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        <option value="firm">Firm offer</option>
                        <option value="budgetary">Budgetary estimate</option>
                      </select>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>
                        Budgetary estimates are indicative; firm offers are commitments the customer can order against.
                      </div>
                    </Field>
                  </div>
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Commercial Terms</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        These 4 terms are system-managed from the commercial selectors above and always travel first in the offer.
                      </div>
                    </div>
                    <CustomerChip label="Fixed order" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                  </div>
                  <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                    {managedCommercialTerms.map((term) => (
                      <div key={term.id} style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                          <div style={{ fontWeight: 700, color: "#24324a", flex: 1 }}>{term.caption}</div>
                          <CustomerChip label="Managed" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" />
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.6, color: "#334155" }}>{term.description || "—"}</div>
                      </div>
                    ))}
                  </div>
                </div>

            </div>
            </div>
  );
}
