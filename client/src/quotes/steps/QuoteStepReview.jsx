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

export default function QuoteStepReview({ api }) {
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
    updateAnnexureMode,
    useContactForAttention,
    validateCurrentStep,
    validateStep,
    validation,
    visibleConfiguratorFamilies,
    warningList,
    warnings
  } = api;
  const annexureMode = quoteSummary?.annexure_mode || (quoteSummary?.merge_annexures === false ? "separate" : "merged");
  const annexureModeLabel =
    annexureMode === "none" ? "Offer PDF only" : annexureMode === "separate" ? "Separate PDFs" : "One PDF";

  return (
            <div style={{ marginTop: 16, border: "1px solid #dfe6f4", borderRadius: 20, padding: 20, background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)", boxShadow: "0 16px 36px rgba(25,45,84,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>Step 4</div>
                  <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>Review & Commit</div>
                </div>
                <button type="button" onClick={() => setStep(2)}>
                  Back to Commercials
                </button>
              </div>

              <div style={{ marginTop: 12, fontSize: 13, opacity: 0.74, lineHeight: 1.7 }}>
                Finish only the last handoff decisions here: confirm blockers, check the send package, then send the issued quote.
              </div>
              <div style={{ marginTop: 12, marginBottom: 2, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#2354d5" }}>Recommended method</div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.76, lineHeight: 1.7 }}>
                  The safe order is: clear blockers, issue the revision if needed, confirm the final document package, and then send the customer handoff.
                </div>
              </div>

              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                <CustomerStatCard label="Revision" value={`${revision?.revision_no || "—"} • ${revisionStateLabel}`} accent="#2354d5" />
                <CustomerStatCard label="Approval" value={approval.approval_required ? "Needed" : "Clear"} accent={approval.approval_required ? "#9a5a00" : "#1a7f47"} />
                <CustomerStatCard label="Mail Ready" value={(selectedContact?.email || customerDetail?.email) ? "Yes" : "No"} accent={(selectedContact?.email || customerDetail?.email) ? "#1a7f47" : "#9a5a00"} />
              </div>

              <div style={{ marginTop: 16, display: "grid", gap: 16 }}>
                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Supporting Clauses</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        Curate only the supporting clauses that should travel after the 4 managed commercial terms. Keep the library tight and intentional.
                      </div>
                    </div>
                    <button type="button" onClick={addTerm}>
                      Add Term
                    </button>
                  </div>
                  <div style={{ marginTop: 12, maxHeight: 420, overflow: "auto" }}>
                    {libraryTerms.map((term) => (
                      <div key={term.id} style={{ border: term.is_selected ? "1px solid rgba(35,84,213,0.24)" : "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, marginBottom: 10, background: term.is_selected ? "linear-gradient(135deg, rgba(237,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)" : "#fff", boxShadow: term.is_selected ? "0 12px 26px rgba(35,84,213,0.08)" : "none" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                          <input
                            type="checkbox"
                            checked={Boolean(term.is_selected)}
                            onChange={(e) => setTerm(term.id, { is_selected: e.target.checked })}
                          />
                          <input
                            value={term.caption || ""}
                            onChange={(e) => setTerm(term.id, { caption: e.target.value })}
                            placeholder="Caption"
                          />
                          {term.is_selected ? <CustomerChip label="Included" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" /> : null}
                          <button type="button" onClick={() => removeTerm(term.id)}>
                            Remove
                          </button>
                        </div>
                        <textarea
                          value={term.description || ""}
                          onChange={(e) => setTerm(term.id, { description: e.target.value })}
                          rows={3}
                          style={{ width: "100%", resize: "vertical" }}
                        />
                      </div>
                    ))}
                    {!libraryTerms.length ? (
                      <div style={{ border: "1px dashed rgba(214,224,244,0.92)", borderRadius: 14, padding: 14, background: "#fff", fontSize: 12, opacity: 0.72 }}>
                        No supporting library clauses selected yet. The 4 managed commercial terms will still appear first in the offer.
                      </div>
                    ) : null}
                  </div>
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                <div style={{ fontWeight: 800, fontSize: 18 }}>Preflight</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                    See only the blockers that matter before issue or send. Use the next action buttons below to clear the path quickly.
                  </div>
                  <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                    {readiness.blockers.length ? (
                      readiness.blockers.map((item) => (
                        <div
                          key={item.key}
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                            justifyContent: "space-between",
                            border: "1px solid #f5d0d0",
                            background: "linear-gradient(180deg, #fff6f6 0%, #fffbfb 100%)",
                            borderRadius: 12,
                            padding: "10px 12px",
                            fontSize: 12,
                          }}
                        >
                          <div>{item.label}</div>
                          <button type="button" onClick={() => setStep(item.step)}>
                            Fix
                          </button>
                        </div>
                      ))
                    ) : (
                      <div style={{ border: "1px solid #d7eadf", background: "linear-gradient(180deg, #f6fcf8 0%, #fcfffd 100%)", borderRadius: 12, padding: "10px 12px", fontSize: 12 }}>
                        No blocking issues remain for issue or send.
                      </div>
                    )}
                    {revisionState !== "issued" ? (
                      <div style={{ border: "1px solid rgba(234,215,161,0.92)", background: "linear-gradient(180deg, #fffaf0 0%, #fffdf6 100%)", borderRadius: 12, padding: "10px 12px", fontSize: 12, lineHeight: 1.6 }}>
                        Issue is still pending. Customer mail stays locked until the revision is issued so the final PDF and quote state remain aligned.
                      </div>
                    ) : null}
                    {reviewConfiguratorWarnings.length ? (
                      <div style={{ border: "1px solid #f2e3b2", background: "linear-gradient(180deg, #fffaf0 0%, #fffdf7 100%)", borderRadius: 12, padding: "10px 12px", fontSize: 12, lineHeight: 1.6 }}>
                        {reviewConfiguratorWarnings.join(" ")}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    {readiness.blockers.length ? (
                      <button type="button" className="button-primary" onClick={() => setStep(readiness.blockers[0].step)} style={{ fontWeight: 800 }}>
                        Clear blockers first
                      </button>
                    ) : null}
                    {!readiness.blockers.length && revisionState === "draft" && approval.approval_required ? (
                      <button type="button" className="button-primary" onClick={submitForApproval} disabled={saving} style={{ fontWeight: 800 }}>
                        {saving ? "Working..." : "Submit for approval"}
                      </button>
                    ) : null}
                    {!readiness.blockers.length && revisionState === "draft" && !approval.approval_required ? (
                      <button type="button" className="button-primary" onClick={issueRevision} disabled={saving} style={{ fontWeight: 800 }}>
                        {saving ? "Working..." : "Issue quote"}
                      </button>
                    ) : null}
                    {!readiness.blockers.length && approval.can_actor_approve && canApproveQuotes && revisionState === "pending_approval" ? (
                      <>
                        <button type="button" className="button-primary" onClick={approveRevision} disabled={saving} style={{ fontWeight: 800 }}>
                          {saving ? "Working..." : "Approve revision"}
                        </button>
                        <button type="button" onClick={rejectRevision} disabled={saving}>
                          Reject
                        </button>
                      </>
                    ) : null}
                    {!readiness.blockers.length && revisionState === "approved" ? (
                      <button type="button" className="button-primary" onClick={issueRevision} disabled={saving} style={{ fontWeight: 800 }}>
                        {saving ? "Working..." : "Issue approved quote"}
                      </button>
                    ) : null}
                    {!readiness.blockers.length && revisionState === "issued" ? (
                      <button type="button" className="button-primary" onClick={createSalesOrder} disabled={creatingSalesOrder} style={{ fontWeight: 800 }}>
                        {creatingSalesOrder ? "Creating SO..." : "Convert to sales order"}
                      </button>
                    ) : null}
                  </div>
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Approval Trail</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        {approval.approval_required
                          ? "Discount on this quote exceeds your autonomous limit, so it needs an approval stamp before it can be issued."
                          : "This quote is inside your autonomous discount limit, so you can issue it without an approval stamp."}
                      </div>
                    </div>
                    <CustomerChip
                      label={approval.approval_required ? "Approval needed" : "No approval needed"}
                      tone={approval.approval_required ? "#fff7ea" : "#f2fbf5"}
                      color={approval.approval_required ? "#9a5a00" : "#0b6b38"}
                      borderColor={approval.approval_required ? "rgba(154,90,0,0.12)" : "rgba(207,231,214,0.95)"}
                    />
                  </div>

                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                    <CustomerStatCard label="Your Discount Limit" value={`${Number(approval.autonomous_discount_pct || 0).toFixed(2)}%`} accent="#2354d5" />
                    <CustomerStatCard
                      label="Highest On Quote"
                      value={`${Number(approval.max_discount_pct || 0).toFixed(2)}%`}
                      accent={approval.approval_required ? "#9a5a00" : "#1a7f47"}
                    />
                    <CustomerStatCard
                      label="Waiting On"
                      value={approval.current_approver?.full_name || (revisionState === "pending_approval" ? "Unassigned" : "—")}
                      accent={revisionState === "pending_approval" ? "#9a5a00" : "#31539d"}
                    />
                  </div>

                  {revisionState === "pending_approval" && approval.current_approver ? (
                    <div style={{ marginTop: 12, border: "1px solid rgba(234,215,161,0.92)", background: "linear-gradient(180deg, #fffaf0 0%, #fffdf6 100%)", borderRadius: 12, padding: "10px 12px", fontSize: 12, lineHeight: 1.6 }}>
                      Waiting on {approval.current_approver.full_name || approval.current_approver.email || "the assigned approver"}
                      {approval.current_approver.email ? ` (${approval.current_approver.email})` : ""}. Chase this person directly if the customer is waiting.
                    </div>
                  ) : null}

                  {approval.approval_required && (approval.suggested_approvers || []).length ? (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Approval chain</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {approval.suggested_approvers.map((person) => (
                          <CustomerChip
                            key={person.id || person.email || person.sequence_no}
                            label={`${person.sequence_no || "?"}. ${person.full_name || person.email || "Approver"}`}
                            tone="#eef4ff"
                            color="#2354d5"
                            borderColor="rgba(35,84,213,0.14)"
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {(approval.triggering_lines || []).length ? (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Lines driving the approval</div>
                      <div style={{ display: "grid", gap: 8 }}>
                        {approval.triggering_lines.map((line) => (
                          <div
                            key={line.line_id || `${line.line_no}-${line.item_name}`}
                            style={{
                              display: "flex",
                              gap: 10,
                              alignItems: "center",
                              justifyContent: "space-between",
                              border: "1px solid rgba(214,224,244,0.92)",
                              borderRadius: 12,
                              padding: "10px 12px",
                              fontSize: 12,
                              background: "#fff",
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <span style={{ opacity: 0.6, marginRight: 8 }}>#{line.line_no}</span>
                              {line.item_name}
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <span style={{ fontWeight: 800, color: Number(line.discount_pct || 0) > Number(approval.autonomous_discount_pct || 0) ? "#9a5a00" : "#0b6b38" }}>
                                {Number(line.discount_pct || 0).toFixed(2)}%
                              </span>
                              <button type="button" onClick={() => setStep(1)} style={{ fontSize: 11, padding: "4px 8px" }}>
                                Review price
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Approval history</div>
                    <HistoryTable
                      headers={["Cycle", "Status", "Approver", "Acted at", "Remarks"]}
                      columns="minmax(0, 0.5fr) minmax(0, 0.8fr) minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1.4fr)"
                      rows={approvalHistoryRows}
                      loading={approvalLoading}
                      loadingLabel="Loading approval history…"
                      emptyLabel="No approval action has been recorded on this revision yet."
                    />
                  </div>

                  {revisionState === "issued" || revisionState === "rejected" ? (
                    <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <button type="button" onClick={startNewRevision} disabled={saving}>
                        {saving ? "Working..." : "Revise in builder"}
                      </button>
                      <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                        {revisionState === "issued"
                          ? "Creates the next revision and reopens the offer here so you can amend price or scope without leaving this screen."
                          : "This revision was rejected. Create the next revision to make changes and resubmit."}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "radial-gradient(circle at top right, rgba(141,180,255,0.16), transparent 34%), linear-gradient(135deg, #f8fbff 0%, #ffffff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Send Package</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        Confirm exactly what the customer will receive with the main offer before you send it.
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CustomerChip label={annexureModeLabel} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                      <CustomerChip label={`${annexures.length} ready-made doc${annexures.length === 1 ? "" : "s"} available`} tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                    </div>
                  </div>
                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                    <CustomerStatCard label="Offer PDF" value="Included" accent="#2354d5" />
                    <CustomerStatCard label="Ready-made Docs" value={annexureMode === "none" ? "Not sent" : annexures.length} accent="#31539d" />
                    <CustomerStatCard label="Output Mode" value={annexureModeLabel} accent={annexureMode === "separate" ? "#9a5a00" : "#1a7f47"} />
                  </div>
                  {annexures.length ? (
                    <div style={{ marginTop: 12 }}>
                      <Field label="Ready-made brochure / scope PDFs">
                        <select
                          value={annexureMode}
                          onChange={(e) => updateAnnexureMode(e.target.value)}
                          disabled={summarySaving || revisionState !== "draft"}
                          style={{ width: "100%" }}
                        >
                          <option value="none">Don't include (offer already has generated technical pages)</option>
                          <option value="merged">Merge into the offer PDF</option>
                          <option value="separate">Attach as separate files</option>
                        </select>
                      </Field>
                    </div>
                  ) : null}
                  <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => window.open(`/quotes/${quoteId}/pdf?annexures=${annexureMode === "merged" ? 1 : 0}`, "_blank", "noopener,noreferrer")}
                      style={{ background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)" }}
                    >
                      Preview Offer PDF
                    </button>
                    <button
                      type="button"
                      onClick={() => window.open(`/quotes/${quoteId}/pdf?club=1&annexures=${annexureMode === "merged" ? 1 : 0}`, "_blank", "noopener,noreferrer")}
                      style={{ background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)" }}
                    >
                      Preview Lump-sum PDF (line prices hidden)
                    </button>
                    <button type="button" onClick={() => onOpenDetail(quoteId)} style={{ background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)" }}>
                      Open Full Quote Desk
                    </button>
                  </div>
                  {annexureMode === "separate" && annexures.length ? (
                    <div style={{ marginTop: 12, border: "1px solid #eef2fb", borderRadius: 14, padding: 12, background: "#ffffff" }}>
                      <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>Additional Documents (separate)</div>
                      <div style={{ display: "grid", gap: 8 }}>
                        {annexures.map((a) => (
                          <button
                            key={a.attachment_id}
                            type="button"
                            onClick={() => window.open(`/quotes/${quoteId}/annexures/${a.attachment_id}`, "_blank", "noopener,noreferrer")}
                            style={{ textAlign: "left", background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)" }}
                          >
                            {(a.group_name ? `${a.group_name} - ` : "") + (a.file_name || "Additional document")}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #fbfcff 0%, #ffffff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Customer Handoff</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        Preflight and PDF preview stay here. Compose and send from the slide-over when you are ready.
                      </div>
                    </div>
                  </div>

                  <div className="builder-four-stat-grid" style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                    <CustomerStatCard label="Sender" value={mailBootstrap.sender?.full_name || me?.full_name || "—"} accent="#2354d5" />
                    <CustomerStatCard label="Mailbox" value={mailBootstrap.mail_source?.effective_sender?.connected ? "Ready" : "Missing"} accent={mailBootstrap.mail_source?.effective_sender?.connected ? "#1a7f47" : "#9a5a00"} />
                    <CustomerStatCard label="Recipient" value={(selectedContact?.email || customerDetail?.email || mailForm.to) ? "Set" : "Missing"} accent={(selectedContact?.email || customerDetail?.email || mailForm.to) ? "#1a7f47" : "#9a5a00"} />
                  </div>

                  {mailNotice ? <div style={{ color: "#0b6b38", marginTop: 10, fontSize: 12 }}>{mailNotice}</div> : null}

                  <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    {revisionState === "issued" || revisionState === "sent" ? (
                      <button
                        type="button"
                        className="button-primary"
                        onClick={openMailComposer}
                        disabled={mailLoading || !quoteId}
                        style={{ fontWeight: 800 }}
                      >
                        {mailLoading ? "Preparing mail…" : "Email Quote to Customer"}
                      </button>
                    ) : null}
                    {sendRequiresIssue ? (
                      <button
                        type="button"
                        onClick={openMailComposer}
                        disabled={mailLoading || !quoteId || readiness.blockers.length > 0 || issueBlockedByApproval || approval.can_issue === false}
                      >
                        {mailLoading ? "Preparing mail…" : "Issue & Email Quote"}
                      </button>
                    ) : null}
                    {issueBlockedByApproval ? (
                      <div style={{ marginTop: 4, fontSize: 12, color: "#9a5a00", lineHeight: 1.6 }}>
                        Manager discount approval is required before issue or email.
                      </div>
                    ) : null}
                    <button type="button" onClick={onCancel}>
                      Return to Quotes List
                    </button>
                  </div>
                  {sendRequiresIssue ? (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                      Issuing locks the revision. Use <strong>Issue quote</strong> above if you want to review the PDF first. <strong>Issue & Email</strong> asks you to confirm both in one step.
                    </div>
                  ) : null}
                  {revisionState === "pending_approval" ? (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                      This revision is waiting for approval, so it cannot be issued or emailed yet.
                    </div>
                  ) : null}

                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Delivery timeline</div>
                    <HistoryTable
                      headers={["Sent", "Status", "To", "Subject"]}
                      columns="minmax(0, 0.9fr) minmax(0, 0.7fr) minmax(0, 1.1fr) minmax(0, 1.4fr)"
                      rows={mailHistoryRows}
                      loading={mailLoading}
                      loadingLabel="Loading delivery history…"
                      emptyLabel="This quote has not been emailed yet."
                    />
                  </div>
                </div>
              </div>
            </div>
  );
}
