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
  inferNgenVariantFromValue,
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

const PACKAGE_MODES = {
  full_package: {
    label: "Complete system (compressor package + PSA + storage tank)",
    chip: "Compressor package, PSA and storage tank all in Absstem scope",
    note: "Adds the compressor package (air compressor, air dryer, air receiver, primary filter), the PSA generator and the product gas storage tank, all priced in the offer.",
    warn: false,
  },
  psa_compressor: {
    label: "PSA + compressor package (storage tank by client)",
    chip: "Storage tank will be shown as Client Scope",
    note: "Adds the PSA generator and compressor package as priced items. The product gas storage tank is added as a Client Scope line with its minimum size, not priced.",
    warn: true,
  },
  psa_only: {
    label: "Only PSA (compressor package + storage tank by client)",
    chip: "Compressor package and storage tank will be shown as Client Scope",
    note: "Adds only the PSA generator as a priced item. The compressor package and product gas storage tank are added as Client Scope lines with their minimum requirements, not priced.",
    warn: true,
  },
};

function packageModeInfo(mode) {
  return PACKAGE_MODES[mode] || PACKAGE_MODES.full_package;
}

function PackageModeOptions() {
  return Object.entries(PACKAGE_MODES).map(([value, info]) => (
    <option key={value} value={value}>
      {info.label}
    </option>
  ));
}

export default function QuoteStepConfig({ api }) {
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
    warnings,
    offerType
  } = api;

  return (
              <div style={{ marginTop: 18, border: "1px solid #dfe6f4", borderRadius: 20, padding: 20, background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)", boxShadow: "0 16px 36px rgba(25,45,84,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>Step 2</div>
                  <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>Config</div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {selectedJobAssetId ? (
                    <button type="button" onClick={openAbsstemShieldLane}>
                      Open Absstem Shield
                    </button>
                  ) : null}
                  <button type="button" onClick={openProductMasterLane}>
                    Open Product Master
                  </button>
                </div>
              </div>
              {offerType === "spares" ? (
                <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 14, border: "1px solid rgba(178,106,0,0.22)", background: "#fff9ef", fontSize: 13, lineHeight: 1.6 }}>
                  <strong>Spares &amp; Aftermarket quote.</strong> The PDF lists each part's number, HSN code, quantity, unit rate and compatible
                  equipment. Plant sizing, civil works and erection &amp; commissioning sections are left out. Add parts through Absstem Shield
                  (recommended spares for the selected job asset) or directly from Product Master.
                </div>
              ) : null}
              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 0.9fr) minmax(0, 0.9fr)", gap: 12 }}>
                <div
                  style={{
                    border: "1px solid rgba(19,107,60,0.16)",
                    borderRadius: 16,
                    padding: 14,
                    background: "linear-gradient(180deg, #f3fbf6 0%, #ffffff 100%)",
                    boxShadow: "0 10px 22px rgba(19,107,60,0.06)",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <CustomerChip label="Step 1" tone="#eefaf2" color="#136b3c" borderColor="rgba(19,107,60,0.14)" />
                    <CustomerChip label="Main path" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                  </div>
                  <div style={{ marginTop: 10, fontSize: 17, fontWeight: 800 }}>Build the main package first</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78, lineHeight: 1.6 }}>Configurator-driven main package.</div>
                </div>
                <div
                  style={{
                    border: "1px solid rgba(214,224,244,0.92)",
                    borderRadius: 16,
                    padding: 14,
                    background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <CustomerChip label="Step 2" tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                    <CustomerChip label="Optional extras" tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" />
                  </div>
                  <div style={{ marginTop: 10, fontSize: 15, fontWeight: 800 }}>Add extra catalog items any time</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.6 }}>Approved add-ons or standalone lines.</div>
                  <div style={{ marginTop: 10 }}>
                    <button type="button" onClick={openProductMasterLane}>
                      Open Product Master
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    border: "1px solid rgba(35,84,213,0.16)",
                    borderRadius: 16,
                    padding: 14,
                    background: "linear-gradient(180deg, #f5f8ff 0%, #ffffff 100%)",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <CustomerChip label="Absstem Shield" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                    <CustomerChip label="Deployed asset spares" tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" />
                  </div>
                  <div style={{ marginTop: 10, fontSize: 15, fontWeight: 800 }}>Quote mapped job consumables fast</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.6 }}>Asset-linked spares and consumables.</div>
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.74 }}>
                    {selectedJobAsset
                      ? `${selectedJobAsset.serial_no || selectedJobAsset.job_id || "Selected asset"} • ${recommendedJobSparesLoading ? "loading mapped spares..." : `${recommendedJobSpares.length} mapped spare(s)`}`
                      : "Select a Job Asset / Serial No in Step 1 to unlock this lane."}
                  </div>
                  {selectedJobAssetId ? (
                    <div style={{ marginTop: 10 }}>
                      <button type="button" onClick={openAbsstemShieldLane}>
                        Open Absstem Shield
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              {itemsLane === "product_master" ? (
              <div style={{ marginTop: 18, border: "1px solid rgba(225,229,238,0.96)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%)", boxShadow: "0 12px 24px rgba(31,41,55,0.04)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 18 }}>Product Master: Additional Quote Items</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <CustomerChip label={hasQuoteItems ? "Quote already has items" : "Standalone or add-on use"} tone={hasQuoteItems ? "#eefaf2" : "#fff7ea"} color={hasQuoteItems ? "#136b3c" : "#9a5a00"} borderColor={hasQuoteItems ? "rgba(19,107,60,0.14)" : "rgba(154,90,0,0.12)"} />
                    <CustomerChip label="Catalog only" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                    <CustomerChip label="No manual lines" tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                    <button type="button" onClick={returnToPackageBuilder}>
                      Back To Package Builder
                    </button>
                  </div>
                </div>
                <div style={{ display: "grid", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10, alignItems: "end" }}>
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
                      <Field label="Item Search">
                        <input
                          value={addProductQ}
                          onChange={(e) => {
                            setAddProductQ(e.target.value);
                            setAddSelectedProduct(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            e.preventDefault();
                            if (!addSelectedProduct && addProductResults.length === 1) {
                              selectProductForAdd(addProductResults[0]);
                              return;
                            }
                            if (addSelectedProduct) {
                              addSelectedItem(false);
                            }
                          }}
                          placeholder={isBrowsingProducts ? "Type to narrow the filtered item list" : "Type item code or name"}
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
                            background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,251,255,0.98) 100%)",
                            border: "1px solid rgba(214,224,244,0.92)",
                            borderRadius: 16,
                            maxHeight: 280,
                            overflow: "auto",
                            zIndex: 5,
                            padding: 10,
                            boxShadow: "0 20px 40px rgba(22,36,71,0.12)",
                          }}
                        >
                          <div style={{ display: "grid", gap: 10 }}>
                            {addProductResults.map((p) => (
                              <ProductResultCard
                                key={p.id}
                                product={p}
                                selected={String(addSelectedProduct?.id || "") === String(p.id)}
                                onClick={() => {
                                  selectProductForAdd(p);
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {!addSelectedProduct && !addProductResults.length && (addProductQ.trim() || isBrowsingProducts) ? (
                        <div
                          style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            top: 64,
                            background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)",
                            border: "1px solid rgba(214,224,244,0.92)",
                            borderRadius: 16,
                            padding: 14,
                            zIndex: 5,
                            fontSize: 12,
                            opacity: 0.78,
                            boxShadow: "0 18px 34px rgba(22,36,71,0.1)",
                          }}
                        >
                          No items matched this search/filter.
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                    {isBrowsingProducts
                      ? "Browsing works from category/group filters even without typing."
                      : "Tip: choose category/group first for faster Product Master pickup."}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, alignItems: "end" }}>
                    <Field label="Qty">
                      <input
                        type="number"
                        value={addQty}
                        onChange={(e) => setAddQty(e.target.value)}
                        min={1}
                        step={1}
                        style={{ width: "100%" }}
                      />
                    </Field>
                    <Field label="Price List">
                      <select value={addPriceList} onChange={(e) => setAddPriceList(e.target.value)} style={{ width: "100%" }}>
                        {priceTypeOptions.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.label}
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
                          placeholder="%"
                          min={0}
                          step={0.01}
                          style={{ width: "100%" }}
                        />
                        <input
                          type="number"
                          value={addDiscAmt}
                          placeholder="Amt"
                          min={0}
                          step={0.01}
                          readOnly
                          style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
                        />
                      </div>
                    </Field>
                    <Field label="Remarks">
                      <input value={addRemarks} onChange={(e) => setAddRemarks(e.target.value)} placeholder="Optional line remarks" style={{ width: "100%" }} />
                    </Field>
                  </div>
                </div>
                {addSelectedProduct ? (
                  <div
                    style={{
                      marginTop: 12,
                      border: "1px solid rgba(173,198,255,0.84)",
                      background: "radial-gradient(circle at top right, rgba(141,180,255,0.18), transparent 34%), linear-gradient(135deg, #edf4ff 0%, #ffffff 100%)",
                      borderRadius: 16,
                      padding: 14,
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: 12,
                      alignItems: "center",
                      boxShadow: "0 14px 30px rgba(56,94,178,0.08)",
                    }}
                  >
                    <div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <CustomerChip label="Selected item" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" />
                        {addSelectedProduct.item_code ? <CustomerChip label={addSelectedProduct.item_code} tone="#f8fbff" color="#31539d" borderColor="rgba(49,83,157,0.12)" /> : null}
                      </div>
                      <div style={{ marginTop: 10, fontWeight: 800, fontSize: 16 }}>{addSelectedProduct.item_name}</div>
                      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {addSelectedProduct.group_name ? <CustomerChip label={addSelectedProduct.group_name} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" /> : null}
                        <CustomerChip label={`GST ${toNumber(addSelectedProduct.gst_pct, 0).toFixed(2)}%`} tone="#f3fbf5" color="#1a7f47" borderColor="rgba(26,127,71,0.14)" />
                        <CustomerChip label={`List ${selectedProductQuoteListPrice.toFixed(2)}`} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                      </div>
                    </div>
                    <button type="button" onClick={() => setAddSelectedProduct(null)}>
                      Clear Selection
                    </button>
                  </div>
                ) : null}
                <div style={{ fontSize: 12, opacity: 0.72, marginTop: 12 }}>
                  All users, including distributors, can add only Product Master items in this lane. Manual line entry is locked.
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
                  <div style={{ display: "flex", gap: 10 }}>
                    {draftLines.length ? (
                      <button type="button" onClick={() => setDraftLines((prev) => [...prev, cloneDraftLine(prev[prev.length - 1])])}>
                        Duplicate Last Line
                      </button>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button type="button" onClick={() => addSelectedItem(true)} disabled={!addSelectedProduct}>
                      Add & Keep Item
                    </button>
                    <button type="button" onClick={() => addSelectedItem(false)} disabled={!addSelectedProduct}>
                      Add Selected Item
                    </button>
                  </div>
                </div>
              </div>
              ) : null}
              {itemsLane === "absstem_shield" ? (
              <div style={{ marginTop: 18, border: "1px solid rgba(35,84,213,0.16)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f5f8ff 100%)", boxShadow: "0 12px 24px rgba(31,41,55,0.04)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 18 }}>Absstem Shield: Recommended Job Spares</div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.72, lineHeight: 1.7 }}>
                      This lane converts installed asset BOM items into quoteable mapped spares and consumables. Add these first for deployed-system support quotes.
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <CustomerChip label={selectedJobAsset ? "Asset linked" : "Select asset first"} tone={selectedJobAsset ? "#eefaf2" : "#fff7ea"} color={selectedJobAsset ? "#136b3c" : "#9a5a00"} borderColor={selectedJobAsset ? "rgba(19,107,60,0.14)" : "rgba(154,90,0,0.12)"} />
                    <CustomerChip label={`${recommendedJobSpares.length} mapped spare(s)`} tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                    <button type="button" onClick={returnToPackageBuilder}>
                      Back To Package Builder
                    </button>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 0.9fr) minmax(0, 1.1fr)", gap: 12, alignItems: "start" }}>
                  <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 12, background: "#fff" }}>
                    <Field label="Deployed Job Asset / Serial No">
                      <select value={selectedJobAssetId} onChange={(e) => setSelectedJobAssetId(e.target.value)} disabled={!jobAssets.length}>
                        <option value="">Select deployed asset</option>
                        {jobAssets.map((asset) => (
                          <option key={asset.id} value={String(asset.id)}>
                            {[asset.serial_no || null, asset.job_id || null, asset.so_number ? `SO ${asset.so_number}` : null].filter(Boolean).join(" • ")}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.76, lineHeight: 1.7 }}>
                      <div>{jobAssetSummary}</div>
                      {selectedJobAsset ? (
                        <>
                          <div>{[selectedJobAsset.finished_good_item_name || null, selectedJobAsset.asset_name || null].filter(Boolean).join(" • ") || "Deployed package selected"}</div>
                          <div>{[selectedJobAsset.so_number ? `SO ${selectedJobAsset.so_number}` : null, selectedJobAsset.dispatch_number ? `Dispatch ${selectedJobAsset.dispatch_number}` : null].filter(Boolean).join(" • ") || "Commercial links available"}</div>
                          <div>{recommendedJobSparesLoading ? "Loading mapped consumables..." : `${totalRecommendedJobSpareQty || 0} total recommended qty`}</div>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {recommendedJobSparesLoading ? (
                      <div style={{ border: "1px dashed #d6deea", borderRadius: 14, padding: 16, background: "#fff", fontSize: 13, opacity: 0.76 }}>
                        Loading mapped spares for the selected Job Asset...
                      </div>
                    ) : !selectedJobAsset ? (
                      <div style={{ border: "1px dashed #d6deea", borderRadius: 14, padding: 16, background: "#fff", fontSize: 13, opacity: 0.76 }}>
                        Select a deployed Job Asset / Serial No to load mapped consumables and spare items.
                      </div>
                    ) : recommendedJobSpares.length ? (
                      recommendedJobSpares.map((spare) => (
                        <div key={`${spare.product_id}:${spare.mapping_type}`} style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 14, background: "#fff" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                            <div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                                <CustomerChip label={spare.item_code || "Mapped spare"} tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                                <CustomerChip label={String(spare.mapping_type || "consumable").replace(/_/g, " ")} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                                {spare.is_mandatory ? <CustomerChip label="Mandatory" tone="#fff1f4" color="#9f2042" borderColor="rgba(159,32,66,0.12)" /> : null}
                              </div>
                              <div style={{ fontWeight: 800, fontSize: 15 }}>{spare.item_name || "Mapped spare"}</div>
                              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                                Recommended qty {spare.qty_recommended || 0}
                                {spare.uom ? ` ${spare.uom}` : ""}
                                {spare.list_price ? ` • Base list ${Number(spare.list_price).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : ""}
                              </div>
                            </div>
                            <button type="button" onClick={() => addRecommendedJobSpare(spare)}>
                              Add To Draft
                            </button>
                          </div>
                          {Array.isArray(spare.source_lines) && spare.source_lines.length ? (
                            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.78, lineHeight: 1.7 }}>
                              From installed items: {spare.source_lines.map((line) => `${line.installed_item_code}${line.qty_installed ? ` x ${line.qty_installed}` : ""}`).join(" • ")}
                            </div>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div style={{ border: "1px dashed #d6deea", borderRadius: 14, padding: 16, background: "#fff", fontSize: 13, opacity: 0.76 }}>
                        No mapped recommended spares are configured yet for this deployed asset.
                      </div>
                    )}
                  </div>
                </div>
              </div>
              ) : null}

              <div style={{ marginTop: 18, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 18 }}>Step 2: Recommended Package</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 12 }}>
                  {visibleConfiguratorFamilies.map((family) => {
                    const selected = selectedConfiguratorFamily.key === family.key;
                    return (
                      <ConfiguratorFamilyCard key={family.key} family={family} selected={selected} onClick={() => setSelectedConfiguratorFamilyKey(family.key)} />
                    );
                  })}
                  <button
                    type="button"
                    onClick={openAbsstemShieldLane}
                    disabled={!selectedJobAssetId}
                    style={{
                      all: "unset",
                      cursor: selectedJobAssetId ? "pointer" : "not-allowed",
                      border: itemsLane === "absstem_shield" ? "1px solid #2354d5" : "1px solid rgba(214,224,244,0.92)",
                      background: itemsLane === "absstem_shield"
                        ? "radial-gradient(circle at top right, rgba(141,180,255,0.2), transparent 34%), linear-gradient(135deg, rgba(235,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)"
                        : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
                      borderRadius: 18,
                      padding: 14,
                      display: "block",
                      boxShadow: itemsLane === "absstem_shield" ? "0 18px 36px rgba(35,84,213,0.14)" : "0 8px 18px rgba(31,41,55,0.04)",
                      minHeight: 332,
                      opacity: selectedJobAssetId ? 1 : 0.76,
                    }}
                  >
                    <div
                      style={{
                        position: "relative",
                        height: 152,
                        borderRadius: 16,
                        overflow: "hidden",
                        background: "radial-gradient(circle at top right, rgba(80,120,255,0.28), transparent 38%), linear-gradient(135deg, #163472 0%, #2354d5 45%, #82a6ff 100%)",
                        boxShadow: itemsLane === "absstem_shield" ? "0 16px 30px rgba(16,38,79,0.14)" : "0 10px 22px rgba(16,38,79,0.08)",
                      }}
                    >
                      <div style={{ position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start", padding: 14 }}>
                        <CustomerChip label="AFM" tone="rgba(255,255,255,0.84)" color="#31539d" borderColor="rgba(255,255,255,0.18)" />
                        {itemsLane === "absstem_shield" ? <CustomerChip label="Open" tone="rgba(18,107,60,0.92)" color="#fff" borderColor="rgba(18,107,60,0.22)" /> : null}
                      </div>
                      <div style={{ position: "absolute", left: 14, right: 14, bottom: 14, zIndex: 1 }}>
                        <div style={{ fontWeight: 800, fontSize: 20, color: "#ffffff", textShadow: "0 2px 10px rgba(0,0,0,0.24)" }}>Absstem Shield</div>
                        <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,0.92)", lineHeight: 1.5, textShadow: "0 1px 6px rgba(0,0,0,0.24)" }}>Aftermarket spares</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CustomerChip
                        label={selectedJobAssetId ? "Asset-linked lane" : "Select asset first"}
                        tone={selectedJobAssetId ? "#eef4ff" : "#fff7ea"}
                        color={selectedJobAssetId ? "#2354d5" : "#9a5a00"}
                        borderColor={selectedJobAssetId ? "rgba(35,84,213,0.14)" : "rgba(154,90,0,0.12)"}
                      />
                    </div>
                    <div style={{ marginTop: 12, fontSize: 14, fontWeight: 700, color: "#24324a", lineHeight: 1.55 }}>
                      Quote recommended spares for the selected asset.
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.66, marginTop: 8, lineHeight: 1.7 }}>
                      {selectedJobAsset
                        ? `${selectedJobAsset.serial_no || selectedJobAsset.job_id || "Selected asset"}${recommendedJobSparesLoading ? " • Loading spares..." : ` • ${recommendedJobSpares.length} mapped spare(s)`}`
                        : "Choose a Job Asset / Serial No in Customer first."}
                    </div>
                  </button>
                </div>
                <div style={{ marginBottom: 14, padding: 14, borderRadius: 16, background: "radial-gradient(circle at top right, rgba(141,180,255,0.16), transparent 34%), linear-gradient(135deg, #f7faff 0%, #ffffff 100%)", border: "1px solid rgba(214,224,244,0.92)", boxShadow: "0 10px 22px rgba(31,41,55,0.04)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontWeight: 700, flex: 1 }}>{selectedConfiguratorFamily.label}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CustomerChip label={`${selectedConfiguratorFamily.company} presentation`} tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                    </div>
                  </div>
                </div>
                {selectedConfiguratorFamily.gas === "nitrogen" ? (
                <>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700, flex: 1 }}>{selectedConfiguratorFamily.label} Package Selector</div>
                </div>
                <div
                  style={{
                    marginTop: 12,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 12,
                    alignItems: "end",
                  }}
                >
                  <Field label="Purity">
                    <select value={nitroPurity} onChange={(e) => setNitroPurity(e.target.value)} disabled={nitroWorking}>
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
                      disabled={nitroWorking}
                    />
                  </Field>
                  <Field label="Quote Mode">
                    <select value={nitroPackageMode} onChange={(e) => setNitroPackageMode(e.target.value)} disabled={nitroWorking}>
                      <PackageModeOptions />
                    </select>
                  </Field>
                </div>
                {!quoteId ? (
                  <div style={{ marginTop: 10, border: "1px solid #f0d9a8", borderRadius: 12, padding: "10px 12px", background: "#fff7ea", fontSize: 12, color: "#8b5a00", lineHeight: 1.5 }}>
                    Draft quote is not started yet. Go back to Customer, select a customer, then Continue to start the draft before recommending.
                  </div>
                ) : null}
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, alignItems: "stretch" }}>
                  <button type="button" style={{ width: "100%" }} onClick={recommendNitrogen} disabled={nitroWorking || !nitroFlow || !quoteId}>
                    {nitroWorking ? "Recommending…" : "Recommend"}
                  </button>
                  <button
                    type="button"
                    className="button-primary"
                    style={{ width: "100%", fontWeight: 800 }}
                    onClick={applyNitrogen}
                    disabled={nitroWorking || !nitroRec || !quoteId}
                  >
                    {nitroWorking ? "Applying…" : "Apply Package to Quote"}
                  </button>
                </div>
                {nitroRec ? (
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.76, lineHeight: 1.6 }}>
                    “Selected” only chooses the model. Click <strong>Apply Package to Quote</strong> to add lines and update totals.
                  </div>
                ) : null}
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <CustomerChip
                    label={packageModeInfo(nitroPackageMode).chip}
                    tone={packageModeInfo(nitroPackageMode).warn ? "#fff7ea" : "#eefaf2"}
                    color={packageModeInfo(nitroPackageMode).warn ? "#9a5a00" : "#136b3c"}
                    borderColor={packageModeInfo(nitroPackageMode).warn ? "rgba(154,90,0,0.12)" : "rgba(19,107,60,0.14)"}
                  />
                </div>
                {nitroRec ? (
                  <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                    <div style={{ border: "1px solid rgba(173,198,255,0.84)", borderRadius: 16, padding: 14, background: "radial-gradient(circle at top right, rgba(141,180,255,0.18), transparent 34%), linear-gradient(135deg, #edf4ff 0%, #ffffff 100%)", boxShadow: "0 14px 30px rgba(56,94,178,0.08)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                            <CustomerChip label={`${activeConfiguratorCard.familyLabel} recommendation`} tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" />
                            <CustomerChip label={activeConfiguratorCard.proposalProfileKey} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.76, marginTop: 6 }}>{activeConfiguratorCard.familyTitle}</div>
                        </div>
                        <CustomerChip label={`${activeConfiguratorCard.company} route`} tone="#f8fbff" color="#31539d" borderColor="rgba(49,83,157,0.12)" />
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.78, marginTop: 8, lineHeight: 1.6 }}>{activeConfiguratorCard.routeReason}</div>
                      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Recommended Package</div>
                          <div style={{ fontWeight: 700, marginTop: 6 }}>{activeConfiguratorCard.selectedModel || "—"}</div>
                          {activeConfiguratorCard.variantLabel ? (
                            <div style={{ fontSize: 11, opacity: 0.72, marginTop: 4 }}>
                              Story delta: {activeConfiguratorCard.variantLabel}
                            </div>
                          ) : null}
                          <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>
                            Flow {activeConfiguratorCard.selectedFlow || "—"} • Air {activeConfiguratorCard.selectedAirRequirement || "—"} CFM
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.74 }}>Storage {activeConfiguratorCard.selectedStorageVolume || "—"} L</div>
                        </div>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Story Framing</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
                            {activeConfiguratorCard.variantStory || selectedConfiguratorFamily.packageHint}
                          </div>
                        </div>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Proof Points</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
                            {(activeConfiguratorCard.proofPoints || []).slice(0, 3).join(" • ")}
                          </div>
                        </div>
                      </div>
                      {(activeConfiguratorCard?.warnings || []).length ? (
                        <div style={{ marginTop: 10, border: "1px solid #ffe1a8", background: "linear-gradient(180deg, #fff8e8 0%, #fffdf5 100%)", borderRadius: 14, padding: 12 }}>
                          <div style={{ fontWeight: 700, fontSize: 12 }}>Configurator warnings</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82, lineHeight: 1.6 }}>
                            {(activeConfiguratorCard?.warnings || []).join(" ")}
                          </div>
                        </div>
                      ) : null}
                      <div style={{ marginTop: 10 }}>{renderConfiguratorPreviewBlocks()}</div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 12 }}>
                    <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 12, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ fontSize: 12, opacity: 0.72, flex: 1 }}>Recommended Generator Options</div>
                        <select value={nitroApplyMode} onChange={(e) => setNitroApplyMode(e.target.value)} disabled={nitroWorking}>
                          <option value="replace">Replace ALL quote lines with this package</option>
                          <option value="append">Append package (keep existing lines)</option>
                        </select>
                      </div>
                      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                        {(nitroRec.options || []).map((option) => {
                          const selected = nitroModel === option.model;
                          return <ConfiguratorOptionCard key={option.model} option={option} selected={selected} onClick={() => setNitroModel(option.model)} familyLabel={selectedConfiguratorFamily.label} familyKey={selectedConfiguratorFamily.key} proposalProfileKey={selectedConfiguratorFamily.proposalProfileKey} variantLabel={inferNgenVariantFromValue(option.model)} />;
                        })}
                      </div>
                    </div>
                    <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 12, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)" }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        <CustomerChip label="Selected Package Summary" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                      </div>
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        Generator: {nitroModel || nitroRec.recommended?.model || "—"}
                      </div>
                    {selectedConfiguratorFamily.key === "NGENX" && nitroRec.catalog_source_label ? (
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
                          ? `Sizing source: ${nitroRec.catalog_source_label}. Dedicated nGENX master rows are not configured separately yet.`
                          : `Sizing source: ${nitroRec.catalog_source_label}.`}
                      </div>
                    ) : null}
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78 }}>
                        Air req: {nitroRec.recommended?.airRequirement ?? "—"} CFM
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.78 }}>
                        Storage: {nitroRec.recommended?.storageVolume ?? "—"} L
                      </div>
                      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.72 }}>Suggested Compressor</div>
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        {nitroRec.compressor
                          ? `${nitroRec.compressor.compressorModel} • ${nitroRec.compressor.kw} • ${nitroRec.compressor.airflow} CFM`
                          : "—"}
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
                        {packageModeInfo(nitroPackageMode).note}
                      </div>
                      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" onClick={openProductMasterLane}>
                          Step 2: Add Approved Extras
                        </button>
                        <button type="button" onClick={openAbsstemShieldLane} disabled={!selectedJobAssetId}>
                          Absstem Shield
                        </button>
                      </div>
                    </div>
                    </div>
                  </div>
                ) : null}
              </>
              ) : null}
              </div>

              {selectedConfiguratorFamily.gas === "oxygen" ? (
              <div style={{ marginTop: 16, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 14, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 10px 22px rgba(31,41,55,0.04)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700, flex: 1 }}>{selectedConfiguratorFamily.label} Package Selector</div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>{selectedConfiguratorFamily.note}</div>
                </div>
                <div
                  style={{
                    marginTop: 12,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 12,
                    alignItems: "end",
                  }}
                >
                  <Field label="Purity">
                    <select value={oxygenPurity} onChange={(e) => setOxygenPurity(e.target.value)} disabled={oxygenWorking}>
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
                      disabled={oxygenWorking}
                    />
                  </Field>
                  <Field label="Quote Mode">
                    <select value={oxygenPackageMode} onChange={(e) => setOxygenPackageMode(e.target.value)} disabled={oxygenWorking}>
                      <PackageModeOptions />
                    </select>
                  </Field>
                </div>
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, alignItems: "stretch" }}>
                  <button type="button" style={{ width: "100%" }} onClick={recommendOxygen} disabled={oxygenWorking || !oxygenFlow || !quoteId}>
                    {oxygenWorking ? "Recommending…" : "Recommend"}
                  </button>
                  <button type="button" style={{ width: "100%" }} onClick={applyOxygen} disabled={oxygenWorking || !oxygenRec || !quoteId}>
                    Apply Package
                  </button>
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <CustomerChip
                    label={packageModeInfo(oxygenPackageMode).chip}
                    tone={packageModeInfo(oxygenPackageMode).warn ? "#fff7ea" : "#eefaf2"}
                    color={packageModeInfo(oxygenPackageMode).warn ? "#9a5a00" : "#136b3c"}
                    borderColor={packageModeInfo(oxygenPackageMode).warn ? "rgba(154,90,0,0.12)" : "rgba(19,107,60,0.14)"}
                  />
                </div>
                {oxygenRec ? (
                  <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                    <div style={{ border: "1px solid rgba(173,198,255,0.84)", borderRadius: 16, padding: 14, background: "radial-gradient(circle at top right, rgba(141,180,255,0.18), transparent 34%), linear-gradient(135deg, #edf4ff 0%, #ffffff 100%)", boxShadow: "0 14px 30px rgba(56,94,178,0.08)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                            <CustomerChip label={`${activeConfiguratorCard.familyLabel} recommendation`} tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" />
                            <CustomerChip label={activeConfiguratorCard.proposalProfileKey} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.76, marginTop: 6 }}>{activeConfiguratorCard.familyTitle}</div>
                        </div>
                        <CustomerChip label={`${activeConfiguratorCard.company} route`} tone="#f8fbff" color="#31539d" borderColor="rgba(49,83,157,0.12)" />
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.78, marginTop: 8, lineHeight: 1.6 }}>{activeConfiguratorCard.routeReason}</div>
                      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Recommended Package</div>
                          <div style={{ fontWeight: 700, marginTop: 6 }}>{activeConfiguratorCard.selectedModel || "—"}</div>
                          {activeConfiguratorCard.variantLabel ? (
                            <div style={{ fontSize: 11, opacity: 0.72, marginTop: 4 }}>
                              Story delta: {activeConfiguratorCard.variantLabel}
                            </div>
                          ) : null}
                          <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>
                            Flow {activeConfiguratorCard.selectedFlow || "—"} • Air {activeConfiguratorCard.selectedAirRequirement || "—"} CFM
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.74 }}>Storage {activeConfiguratorCard.selectedStorageVolume || "—"} L</div>
                        </div>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Story Framing</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
                            {activeConfiguratorCard.variantStory || selectedConfiguratorFamily.packageHint}
                          </div>
                        </div>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Proof Points</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
                            {(activeConfiguratorCard.proofPoints || []).slice(0, 3).join(" • ")}
                          </div>
                        </div>
                      </div>
                      {(activeConfiguratorCard?.warnings || []).length ? (
                        <div style={{ marginTop: 10, border: "1px solid #ffe1a8", background: "linear-gradient(180deg, #fff8e8 0%, #fffdf5 100%)", borderRadius: 14, padding: 12 }}>
                          <div style={{ fontWeight: 700, fontSize: 12 }}>Configurator warnings</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82, lineHeight: 1.6 }}>
                            {(activeConfiguratorCard?.warnings || []).join(" ")}
                          </div>
                        </div>
                      ) : null}
                      <div style={{ marginTop: 10 }}>{renderConfiguratorPreviewBlocks()}</div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 12 }}>
                    <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 12, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ fontSize: 12, opacity: 0.72, flex: 1 }}>Recommended Generator Options</div>
                        <select value={oxygenApplyMode} onChange={(e) => setOxygenApplyMode(e.target.value)} disabled={oxygenWorking}>
                          <option value="replace">Replace ALL quote lines with this package</option>
                          <option value="append">Append package (keep existing lines)</option>
                        </select>
                      </div>
                      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                        {(oxygenRec.options || []).map((option) => {
                          const selected = oxygenModel === option.model;
                          return <ConfiguratorOptionCard key={option.model} option={option} selected={selected} onClick={() => setOxygenModel(option.model)} familyLabel={selectedConfiguratorFamily.label} familyKey={selectedConfiguratorFamily.key} proposalProfileKey={selectedConfiguratorFamily.proposalProfileKey} />;
                        })}
                      </div>
                    </div>
                    <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 12, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)" }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        <CustomerChip label="Selected Package Summary" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                      </div>
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        Generator: {oxygenModel || oxygenRec.recommended?.model || "—"}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78 }}>
                        Air req: {oxygenRec.recommended?.airRequirement ?? "—"} CFM
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.78 }}>
                        Storage: {oxygenRec.recommended?.storageVolume ?? "—"} L
                      </div>
                      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.72 }}>Suggested Compressor</div>
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        {oxygenRec.compressor
                          ? `${oxygenRec.compressor.compressorModel} • ${oxygenRec.compressor.kw} • ${oxygenRec.compressor.airflow} CFM`
                          : "—"}
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
                        {packageModeInfo(oxygenPackageMode).note}
                      </div>
                      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" onClick={openProductMasterLane}>
                          Step 2: Add Approved Extras
                        </button>
                        <button type="button" onClick={openAbsstemShieldLane} disabled={!selectedJobAssetId}>
                          Absstem Shield
                        </button>
                      </div>
                    </div>
                    </div>
                  </div>
                ) : null}
              </div>
              ) : null}

              <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
                {itemsLane !== "product_master" && itemsLane !== "absstem_shield" ? (
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                    {selectedJobAssetId ? (
                      <button type="button" onClick={openAbsstemShieldLane}>
                        Absstem Shield
                      </button>
                    ) : null}
                    <button type="button" onClick={openProductMasterLane}>
                      Open Product Master
                    </button>
                  </div>
                ) : null}
                {draftLines.length ? (
                  draftLines.map((line) => (
                    <DraftLineCard
                      key={line.key}
                      line={line}
                      isAdvancedOpen={advancedLineKey === line.key}
                      onToggleAdvanced={() => setAdvancedLineKey((prev) => (prev === line.key ? "" : line.key))}
                      onMove={(direction) => moveDraftLine(line.key, direction)}
                      onDuplicate={() => duplicateDraftLine(line.key)}
                      onRemove={() => removeDraftLine(line.key)}
                      onChange={(patch, source = undefined) => setDraftLine(line.key, patch, source)}
                      lineTotal={calcLineNetTotal(line).toFixed(2)}
                      priceTypeOptions={priceTypeOptions}
                      priceHint={line.product_id ? priceHints[String(line.product_id)] || null : null}
                      floorHint={buildLineFloorHint(line, pricingGuardrails)}
                    />
                  ))
                ) : (
                  <div style={{ padding: 12, opacity: 0.7, border: "1px dashed #e5e5e5", borderRadius: 10 }}>
                    No items added yet.
                  </div>
                )}
              </div>
            </div>
  );
}
