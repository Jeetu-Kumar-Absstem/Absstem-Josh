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
  EMPTY_NEW_CUSTOMER,
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

export default function QuoteStepCustomer({ api }) {
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

  return (
            <div style={{ marginTop: 18, border: "1px solid #dfe6f4", borderRadius: 20, padding: 20, background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)", boxShadow: "0 16px 36px rgba(25,45,84,0.05)" }}>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>Step 1</div>
                <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>Customer</div>
                <div style={{ marginTop: 6, fontSize: 13, opacity: 0.72, lineHeight: 1.7 }}>
                  Search Customer Master first. Create only when needed, then confirm contact and site.
                </div>
              </div>

              <div style={{ display: "grid", gap: 16 }}>
                {selectedCustomer ? (
                  <>
                    <SelectedCustomerCard
                      customer={{
                        ...selectedCustomer,
                        city: customerDetail?.city || selectedCustomer.city,
                        state: customerDetail?.state || selectedCustomer.state,
                        gstin: customerDetail?.gstin || selectedCustomer.gstin,
                        customer_code: customerDetail?.customer_code || selectedCustomer.customer_code,
                      }}
                      contactCount={customerContacts.length}
                      siteCount={quotableCustomerSites.length}
                      onChange={clearCustomerSelection}
                    />

                    <div style={{ border: "1px solid #efefef", borderRadius: 14, padding: 14, background: "#fff" }}>
                      <div style={{ fontWeight: 700, marginBottom: 8 }}>Recipient And Site</div>
                      <div style={{ display: "grid", gap: 12 }}>
                        <Field label="Customer Contact">
                          <div style={{ display: "grid", gap: 8 }}>
                            {customerContacts.length ? (
                              <select value={selectedContactId} onChange={(e) => setSelectedContactId(e.target.value)}>
                                <option value="">Select contact</option>
                                {customerContacts.map((contact) => (
                                  <option key={contact.id} value={String(contact.id)}>
                                    {[contact.salutation || null, contact.full_name || null].filter(Boolean).join(" ")}
                                    {contact.designation ? ` - ${contact.designation}` : ""}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div style={{ fontSize: 12, opacity: 0.72 }}>No contacts yet.</div>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setShowContactCreate((prev) => !prev);
                                setShowSiteCreate(false);
                                setNewContactForm({
                                  full_name: "",
                                  email: customerDetail?.email || "",
                                  phone: customerDetail?.phone || "",
                                  designation: "",
                                });
                              }}
                            >
                              {showContactCreate ? "Hide contact form" : "+ Add contact"}
                            </button>
                            {showContactCreate ? (
                              <div style={{ border: "1px solid #e7ebf3", borderRadius: 12, padding: 12, background: "#fbfcff", display: "grid", gap: 10 }}>
                                <Field label="Full name">
                                  <input
                                    value={newContactForm.full_name}
                                    onChange={(e) => setNewContactForm((prev) => ({ ...prev, full_name: e.target.value }))}
                                    placeholder="Contact name"
                                  />
                                </Field>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
                                  <Field label="Email">
                                    <input
                                      value={newContactForm.email}
                                      onChange={(e) => setNewContactForm((prev) => ({ ...prev, email: e.target.value }))}
                                      placeholder="email@company.com"
                                    />
                                  </Field>
                                  <Field label="Phone">
                                    <input
                                      value={newContactForm.phone}
                                      onChange={(e) => setNewContactForm((prev) => ({ ...prev, phone: e.target.value }))}
                                      placeholder="Phone"
                                    />
                                  </Field>
                                  <Field label="Designation">
                                    <input
                                      value={newContactForm.designation}
                                      onChange={(e) => setNewContactForm((prev) => ({ ...prev, designation: e.target.value }))}
                                      placeholder="Optional"
                                    />
                                  </Field>
                                </div>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  <button type="button" className="button-primary" onClick={createInlineContact} disabled={contactCreating}>
                                    {contactCreating ? "Saving…" : "Save contact"}
                                  </button>
                                  <button type="button" onClick={() => setShowContactCreate(false)} disabled={contactCreating}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </Field>
                        {selectedContact ? (
                          <div style={{ marginTop: -4, fontSize: 12, opacity: 0.78, lineHeight: 1.6 }}>
                            <div>{selectedContact.email || "—"}</div>
                            <div>{selectedContact.phone || "—"}</div>
                            <button type="button" onClick={() => useContactForAttention(selectedContact)} style={{ marginTop: 8 }}>
                              Use Contact For Attention To
                            </button>
                          </div>
                        ) : null}

                        <Field label="Quote Site / Plant">
                          <div style={{ display: "grid", gap: 8 }}>
                            {quotableCustomerSites.length ? (
                              <select value={selectedSiteId} onChange={(e) => setSelectedSiteId(e.target.value)}>
                                <option value="">Select site / plant</option>
                                {quotableCustomerSites.map((site) => (
                                  <option key={site.id} value={String(site.id)}>
                                    {site.site_name}
                                    {site.site_code ? ` - ${site.site_code}` : ""}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div style={{ fontSize: 12, opacity: 0.72 }}>No quotable plant/site yet.</div>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setShowSiteCreate((prev) => !prev);
                                setShowContactCreate(false);
                                setNewSiteForm({
                                  site_name: customerDetail?.city ? `${customerDetail.city} Plant` : "",
                                  site_type: "plant",
                                  address_line1: customerDetail?.address_line1 || "",
                                  city: customerDetail?.city || "",
                                  state: customerDetail?.state || "",
                                  pincode: customerDetail?.pincode || "",
                                  country_id: customerDetail?.country_id ? String(customerDetail.country_id) : defaultIndiaCountryId || "",
                                });
                              }}
                            >
                              {showSiteCreate ? "Hide site form" : "+ Add plant / site"}
                            </button>
                            {showSiteCreate ? (
                              <div style={{ border: "1px solid #e7ebf3", borderRadius: 12, padding: 12, background: "#fbfcff", display: "grid", gap: 10 }}>
                                <Field label="Site / plant name">
                                  <input
                                    value={newSiteForm.site_name}
                                    onChange={(e) => setNewSiteForm((prev) => ({ ...prev, site_name: e.target.value }))}
                                    placeholder="e.g. Pune Plant"
                                  />
                                </Field>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
                                  <Field label="Address">
                                    <input
                                      value={newSiteForm.address_line1}
                                      onChange={(e) => setNewSiteForm((prev) => ({ ...prev, address_line1: e.target.value }))}
                                      placeholder="Optional"
                                    />
                                  </Field>
                                  <Field label="City">
                                    <input
                                      value={newSiteForm.city}
                                      onChange={(e) => setNewSiteForm((prev) => ({ ...prev, city: e.target.value }))}
                                      placeholder="City"
                                    />
                                  </Field>
                                  <Field label="State">
                                    <input
                                      value={newSiteForm.state}
                                      onChange={(e) => setNewSiteForm((prev) => ({ ...prev, state: e.target.value }))}
                                      placeholder="State"
                                    />
                                  </Field>
                                  <Field label="Pincode">
                                    <input
                                      value={newSiteForm.pincode}
                                      onChange={(e) => setNewSiteForm((prev) => ({ ...prev, pincode: e.target.value }))}
                                      placeholder="Pincode"
                                    />
                                  </Field>
                                </div>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  <button type="button" className="button-primary" onClick={createInlineSite} disabled={siteCreating}>
                                    {siteCreating ? "Saving…" : "Save plant / site"}
                                  </button>
                                  <button type="button" onClick={() => setShowSiteCreate(false)} disabled={siteCreating}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </Field>
                        {selectedSite ? (
                          <div style={{ marginTop: -4, fontSize: 12, opacity: 0.78, lineHeight: 1.6 }}>
                            <div>{[selectedSite.site_type || null, selectedSite.city || null, selectedSite.state || null].filter(Boolean).join(" • ") || "Site selected"}</div>
                            <div>
                              GST Status: {selectedSite.gst_status === "available" ? selectedSite.tax_gstin || "Available" : selectedSite.gst_status || "pending"}
                            </div>
                          </div>
                        ) : null}

                        <Field label="Job Asset / Serial No">
                          {jobAssets.length ? (
                            <select value={selectedJobAssetId} onChange={(e) => setSelectedJobAssetId(e.target.value)}>
                              <option value="">Select deployed Job Asset</option>
                              {jobAssets.map((asset) => (
                                <option key={asset.id} value={String(asset.id)}>
                                  {[asset.serial_no || null, asset.job_id || null, asset.so_number ? `SO ${asset.so_number}` : null].filter(Boolean).join(" • ")}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <div style={{ fontSize: 12, opacity: 0.72 }}>{jobAssetSummary}</div>
                          )}
                        </Field>
                        {selectedJobAsset ? (
                          <div style={{ marginTop: -4, fontSize: 12, opacity: 0.78, lineHeight: 1.6 }}>
                            <div>
                              {[selectedJobAsset.serial_no || null, selectedJobAsset.job_id || null, selectedJobAsset.asset_name || selectedJobAsset.finished_good_item_name || null]
                                .filter(Boolean)
                                .join(" • ") || "Selected deployed asset"}
                            </div>
                            <div>
                              Recommended mapped spares: {recommendedJobSparesLoading ? "Loading..." : recommendedJobSpares.length || 0}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div style={{ border: "1px solid #efefef", borderRadius: 14, padding: 14, background: "#fff" }}>
                      <div style={{ fontWeight: 800, marginBottom: 10 }}>Quote Header</div>
                      <Field label="Attention To">
                        <input
                          value={attentionTo}
                          onChange={(e) => setAttentionTo(e.target.value)}
                          placeholder="Customer recipient for this quote"
                        />
                      </Field>
                      {selectedContact && !attentionTo ? (
                        <div style={{ fontSize: 12, opacity: 0.72, marginTop: -2 }}>
                          Defaulting to selected contact: {selectedContact.full_name}
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ border: "1px solid #d9e3fb", borderRadius: 16, padding: 16, background: "#fff" }}>
                      <Field label="Search Customer Master">
                        <input
                          value={customerQ}
                          onChange={(e) => setCustomerQ(e.target.value)}
                          placeholder="Company name, code, phone, email, city, or GST"
                          style={{ width: "100%", fontSize: 16, padding: "12px 14px" }}
                          autoFocus
                        />
                      </Field>
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>{customerResultsSummary}</div>

                      <div style={{ marginTop: 14, display: "grid", gap: 8, maxHeight: 360, overflow: "auto", paddingRight: 2 }}>
                        {customerResults.map((c) => (
                          <CustomerResultCard key={c.id} customer={c} onSelect={selectCustomer} />
                        ))}
                        {!customerSearching && customerSearchQuery.length >= 3 && !customerResults.length ? (
                          <div style={{ fontSize: 13, opacity: 0.72, padding: "8px 2px" }}>
                            No match for &ldquo;{customerSearchQuery}&rdquo;. Create a new customer below, or refine the search.
                          </div>
                        ) : null}
                        {!customerSearching && !customerSearchQuery ? (
                          <div style={{ fontSize: 13, opacity: 0.72, padding: "8px 2px" }}>
                            Start typing to search the live Customer Master.
                          </div>
                        ) : null}
                      </div>

                      <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        {!showCustomerCreate ? (
                          <button type="button" onClick={() => openCustomerCreate(customerSearchQuery)}>
                            + Create New Customer
                          </button>
                        ) : (
                          <button type="button" onClick={dismissCustomerCreate}>
                            Hide create form
                          </button>
                        )}
                      </div>
                    </div>

                    {showCustomerCreate ? (
                      <div
                        style={{
                          border: "1px solid rgba(218,226,241,0.92)",
                          borderRadius: 16,
                          padding: 16,
                          background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)",
                        }}
                      >
                        <div style={{ fontWeight: 800, fontSize: 16 }}>Create New Customer</div>
                        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7, lineHeight: 1.6 }}>
                          Company, contact, email, and phone are enough to start. Location and GSTIN are optional.
                        </div>
                        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                          <Field label="Company Name">
                            <input
                              value={newCustomerForm.customer_name}
                              onChange={(e) => {
                                const v = e.target.value;
                                setNewCustomerForm((prev) => ({ ...prev, customer_name: v }));
                              }}
                              placeholder="Company / hospital / plant name"
                              autoFocus
                            />
                          </Field>
                          <Field label="Contact Person">
                            <input
                              value={newCustomerForm.contact_name}
                              onChange={(e) => setNewCustomerForm((prev) => ({ ...prev, contact_name: e.target.value }))}
                              placeholder="Primary contact"
                            />
                          </Field>
                          <Field label="Email">
                            <input
                              value={newCustomerForm.email}
                              onChange={(e) => {
                                const v = e.target.value;
                                setNewCustomerForm((prev) => ({ ...prev, email: v, contact_email: v }));
                              }}
                              placeholder="Email"
                            />
                          </Field>
                          <Field label="Phone">
                            <input
                              value={newCustomerForm.phone}
                              onChange={(e) => {
                                const v = e.target.value;
                                setNewCustomerForm((prev) => ({ ...prev, phone: v, contact_phone: v }));
                              }}
                              placeholder="Phone"
                            />
                          </Field>
                        </div>

                        <div style={{ marginTop: 12 }}>
                          <button type="button" onClick={() => setShowCustomerOptional((prev) => !prev)}>
                            {showCustomerOptional ? "Hide optional details" : "More details (location / GSTIN)"}
                          </button>
                        </div>

                        {showCustomerOptional ? (
                          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                            <Field label="Country (optional)">
                              <select
                                value={newCustomerForm.country_id}
                                onChange={(e) =>
                                  setNewCustomerForm((prev) => ({
                                    ...prev,
                                    country_id: e.target.value,
                                    state: "",
                                    city: "",
                                  }))
                                }
                              >
                                <option value="">Select country</option>
                                {(quoteBootstrap.countries || []).map((country) => (
                                  <option key={country.id} value={String(country.id)}>
                                    {country.iso_code} - {country.country_name}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="State (optional)">
                              <select
                                value={newCustomerSelectedStateId}
                                onChange={(e) => {
                                  const next = newCustomerStateOptions.find((item) => String(item.id) === e.target.value) || null;
                                  setNewCustomerForm((prev) => ({
                                    ...prev,
                                    state: next?.state_name || "",
                                    city: "",
                                  }));
                                }}
                                disabled={!newCustomerForm.country_id}
                              >
                                <option value="">Select state</option>
                                {newCustomerStateOptions.map((state) => (
                                  <option key={state.id} value={String(state.id)}>
                                    {state.state_code} - {state.state_name}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="City (optional)">
                              <select
                                value={newCustomerSelectedCityId}
                                onChange={(e) => {
                                  const next = newCustomerCityOptions.find((item) => String(item.id) === e.target.value) || null;
                                  setNewCustomerForm((prev) => ({ ...prev, city: next?.city_name || "" }));
                                }}
                                disabled={!newCustomerSelectedStateId}
                              >
                                <option value="">Select city</option>
                                {newCustomerCityOptions.map((city) => (
                                  <option key={city.id} value={String(city.id)}>
                                    {city.city_name}
                                  </option>
                                ))}
                              </select>
                              <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  onClick={() => setNewCustomerAddCityOpen((prev) => !prev)}
                                  disabled={!newCustomerSelectedStateId || newCustomerSavingCity}
                                >
                                  {newCustomerAddCityOpen ? "Cancel Add City" : "Add City"}
                                </button>
                              </div>
                              {newCustomerAddCityOpen ? (
                                <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                  <input
                                    value={newCustomerAddCityName}
                                    onChange={(e) => setNewCustomerAddCityName(e.target.value)}
                                    placeholder="Enter city name"
                                    style={{ minWidth: 220 }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleAddNewCustomerCity()}
                                    disabled={newCustomerSavingCity || !newCustomerAddCityName.trim()}
                                  >
                                    {newCustomerSavingCity ? "Adding..." : "Save City"}
                                  </button>
                                </div>
                              ) : null}
                            </Field>
                            <Field label="GSTIN (optional)">
                              <input
                                value={newCustomerForm.gstin}
                                onChange={(e) => setNewCustomerForm((prev) => ({ ...prev, gstin: e.target.value }))}
                                placeholder="Optional GSTIN"
                              />
                            </Field>
                            <Field label="Address (optional)">
                              <input
                                value={newCustomerForm.address_line1}
                                onChange={(e) => setNewCustomerForm((prev) => ({ ...prev, address_line1: e.target.value }))}
                                placeholder="Address"
                              />
                            </Field>
                            <Field label="PIN Code (optional)">
                              <input
                                value={newCustomerForm.pincode}
                                onChange={(e) => setNewCustomerForm((prev) => ({ ...prev, pincode: e.target.value }))}
                                placeholder="PIN Code"
                              />
                            </Field>
                          </div>
                        ) : null}

                        {newCustomerChecking ? (
                          <div style={{ marginTop: 12, fontSize: 13, opacity: 0.76 }}>Checking for duplicates…</div>
                        ) : newCustomerChecked ? (
                          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                            {newCustomerBlockingDuplicates.length ? (
                              <DuplicateWarningBanner
                                duplicates={newCustomerBlockingDuplicates}
                                allowDuplicate={newCustomerAllowDuplicate}
                                onAllowChange={setNewCustomerAllowDuplicate}
                                onUseExisting={selectCustomer}
                                disabled={customerCreating || newCustomerChecking}
                              />
                            ) : null}
                            {!newCustomerBlockingDuplicates.length && newCustomerAdvisoryDuplicates.length ? (
                              <DuplicateWarningBanner
                                duplicates={newCustomerAdvisoryDuplicates}
                                advisoryOnly
                                requireAllow={false}
                                title="Low-confidence overlaps (advisory)"
                                disabled={customerCreating || newCustomerChecking}
                                onUseExisting={selectCustomer}
                              />
                            ) : null}
                            {!newCustomerBlockingDuplicates.length && !newCustomerAdvisoryDuplicates.length ? (
                              <div style={{ fontSize: 13, opacity: 0.84, padding: 12, borderRadius: 12, background: "#f4fbf5", border: "1px solid #d6ead9" }}>
                                No duplicates detected. Ready to create.
                              </div>
                            ) : null}
                          </div>
                        ) : newCustomerForm.customer_name.trim().length >= 3 ? (
                          <div style={{ marginTop: 12, fontSize: 13, opacity: 0.76 }}>
                            Duplicate check runs as you update company name, email, phone, GSTIN, or location.
                          </div>
                        ) : null}

                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                          <button type="button" onClick={dismissCustomerCreate} disabled={customerCreating}>
                            Back to search
                          </button>
                          <button
                            type="button"
                            onClick={() => setNewCustomerForm({ ...EMPTY_NEW_CUSTOMER, country_id: defaultIndiaCountryId || "" })}
                            disabled={customerCreating}
                          >
                            Reset
                          </button>
                          <button
                            type="button"
                            className="button-primary"
                            onClick={createInlineCustomer}
                            disabled={
                              customerCreating ||
                              newCustomerChecking ||
                              !newCustomerForm.customer_name.trim() ||
                              !newCustomerChecked ||
                              (newCustomerBlockingDuplicates.length > 0 && !newCustomerAllowDuplicate)
                            }
                          >
                            {customerCreating ? "Creating..." : "Create & Use Customer"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
                {draftDuplicateAdvisory.length ? (
                  <DuplicateWarningBanner
                    duplicates={draftDuplicateAdvisory}
                    advisoryOnly
                    requireAllow={false}
                    title="Similar customer masters found"
                    onUseExisting={(dup) => {
                      selectCustomer(dup);
                      setDraftDuplicateAdvisory([]);
                    }}
                  />
                ) : null}
                <div style={{ fontSize: 12, opacity: 0.72, textAlign: "right" }}>
                  Use <strong>Continue</strong> below to {isExistingDraft ? "resume this draft" : "start the draft quote"} and move to Config.
                </div>
              </div>
            </div>
  );
}
