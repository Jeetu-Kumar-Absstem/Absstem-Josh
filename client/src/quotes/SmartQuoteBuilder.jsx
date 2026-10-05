import SlideOverDrawer from "../components/SlideOverDrawer";
import useQuoteBuilder from "./useQuoteBuilder";
import LiveQuoteSummary from "./LiveQuoteSummary";
import QuoteStepCustomer from "./steps/QuoteStepCustomer";
import QuoteStepConfig from "./steps/QuoteStepConfig";
import QuoteStepCommercials from "./steps/QuoteStepCommercials";
import QuoteStepReview from "./steps/QuoteStepReview";
import {
  CustomerChip,
  CustomerStatCard,
  DuplicateWarningBanner,
  Field,
  StepBadge,
} from "./quoteBuilderUi";
import { formatBytes } from "./quoteShared";

const ATTACHMENT_KIND_LABELS = { quote_pdf: "Offer PDF", annexure: "Scope PDF", manual: "Extra file" };

export default function SmartQuoteBuilder({
  onCancel,
  onOpenDetail,
  onOpenSalesOrder,
  onOpenLead,
  onQuoteChanged,
  me,
  initialQuoteId,
  initialLaunch = null,
}) {
  const api = useQuoteBuilder({
    onCancel,
    onOpenDetail,
    onOpenSalesOrder,
    onOpenLead,
    onQuoteChanged,
    me,
    initialQuoteId,
    initialLaunch,
  });

  const {
    steps,
    step,
    setStep,
    error,
    notice,
    draftDuplicateAdvisory,
    selectCustomer,
    setDraftDuplicateAdvisory,
    quoteRoute,
    setQuoteRoute,
    revision,
    revisionState,
    revisionStateLabel,
    lifecycleBadge,
    quoteId,
    quote,
    offerType,
    offerTypeSource,
    changeOfferType,
    progressPct,
    currentStepIndex,
    goBack,
    goNext,
    canGoNext,
    saving,
    summarySaving,
    mailComposerOpen,
    setMailComposerOpen,
    mailSending,
    selectedCustomer,
    sendQuoteMail,
    sendRequiresIssue,
    mailLoading,
    mailForm,
    setMailForm,
    issueBlockedByApproval,
    approval,
    readiness,
    mailBootstrap,
    mailNotice,
    me: meFromApi,
    applyMailPreset,
    selectedMailPreset,
    openMailAttachmentPicker,
    mailAttachmentUploading,
    mailAttachmentInputRef,
    handleMailAttachmentUpload,
    mailAttachments,
    mailPreview,
    mailPreviewLoading,
    previewQuoteMail,
    setMailPreview,
    mailSignature,
    setMailSignature,
    saveMailSignature,
  } = api;

  const continueLabel =
    step >= 3 ? "Commit" : step === 2 ? "Save & Continue" : step === 0 && !quoteId ? "Start Draft & Continue" : "Continue";

  return (
    <>
      <div className="smart-quote-builder-shell" style={{ maxWidth: 1240 }}>
        <style>{`
        .smart-quote-builder-shell button {
          border: 1px solid rgba(210, 220, 239, 0.92);
          background: linear-gradient(180deg, #ffffff 0%, #f7faff 100%);
          color: #20324d;
          padding: 10px 14px;
          border-radius: 12px;
          box-shadow: 0 6px 16px rgba(31, 41, 55, 0.04);
          font-weight: 700;
        }
        .smart-quote-builder-shell button:hover:not(:disabled) {
          border-color: rgba(115, 145, 214, 0.72);
        }
        .smart-quote-builder-shell button:disabled {
          opacity: 0.55;
          cursor: not-allowed;
          box-shadow: none;
        }
        .smart-quote-builder-shell input,
        .smart-quote-builder-shell select,
        .smart-quote-builder-shell textarea {
          border: 1px solid rgba(210, 220, 239, 0.92);
          border-radius: 12px;
          background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
          color: #22324a;
          padding: 11px 12px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.82);
        }
        .smart-quote-builder-shell input:focus,
        .smart-quote-builder-shell select:focus,
        .smart-quote-builder-shell textarea:focus {
          outline: none;
          border-color: rgba(35, 84, 213, 0.6);
          box-shadow: 0 0 0 3px rgba(35, 84, 213, 0.10);
          background: #fff;
        }
        .builder-layout-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
          gap: 18px;
          align-items: start;
        }
        .builder-four-stat-grid,
        .builder-action-grid,
        .builder-mail-meta {
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)) !important;
        }
        .builder-mail-grid,
        .builder-two-col {
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)) !important;
        }
        .builder-step-progress {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
        }
        @media (max-width: 1100px) {
          .builder-layout-grid {
            grid-template-columns: minmax(0, 1fr);
          }
          .builder-sidebar {
            position: static !important;
            top: auto !important;
          }
        }
      `}</style>

        <div
          style={{
            border: "1px solid #dfe6f4",
            borderRadius: 18,
            padding: 18,
            background: "linear-gradient(180deg, #f8fbff 0%, #ffffff 100%)",
            boxShadow: "0 18px 40px rgba(18, 41, 88, 0.06)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button type="button" onClick={onCancel}>
              Back
            </button>
            <div style={{ flex: 1, minWidth: 180 }}>
              <h2 style={{ margin: 0 }}>Smart Quote Builder</h2>
              <div style={{ fontSize: 12, opacity: 0.72 }}>
                Autopilot quote flow for sales teams. Standard industrial quotes stay simple, while healthcare quoting remains an explicit alternate route.
              </div>
            </div>
            <div
              style={{
                fontSize: 12,
                padding: "7px 10px",
                borderRadius: 999,
                background: revisionState === "draft" ? "#fff6e8" : "#eef8ff",
                border: revisionState === "draft" ? "1px solid #efd59a" : "1px solid #cfe3f7",
              }}
            >
              Revision {revision?.revision_no || "—"} • {revisionStateLabel}
            </div>
            <div
              style={{
                fontSize: 12,
                padding: "7px 10px",
                borderRadius: 999,
                background: lifecycleBadge.background,
                border: lifecycleBadge.border,
                color: lifecycleBadge.color,
              }}
            >
              {lifecycleBadge.label}
            </div>
            {quoteId ? (
              <button type="button" onClick={() => onOpenDetail(quoteId)}>
                Open Full Quote Desk
              </button>
            ) : null}
            {quote?.lead_id && typeof onOpenLead === "function" ? (
              <button type="button" onClick={() => onOpenLead(Number(quote.lead_id))}>
                Open Lead
              </button>
            ) : null}
          </div>

          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center" }}>
            <div>
              <div style={{ height: 8, borderRadius: 999, background: "#e9eef8", overflow: "hidden" }}>
                <div
                  style={{
                    width: `${progressPct}%`,
                    height: "100%",
                    background: "linear-gradient(90deg, #2354d5 0%, #5e8cff 100%)",
                  }}
                />
              </div>
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
                {quote?.quote_number ? `Working on ${quote.quote_number}` : "Draft not created yet"} • Step {currentStepIndex + 1} of {steps.length}
              </div>
            </div>
            <div style={{ fontSize: 12, opacity: 0.72 }}>{progressPct}% complete</div>
          </div>

          <div className="builder-step-progress" style={{ marginTop: 12 }}>
            {steps.map((item, index) => (
              <StepBadge key={item.key} index={index} item={item} currentStepIndex={currentStepIndex} onSelect={setStep} />
            ))}
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setQuoteRoute("industrial")}
              style={{
                background: quoteRoute === "industrial" ? "#edf3ff" : undefined,
                borderColor: quoteRoute === "industrial" ? "#2354d5" : undefined,
                color: quoteRoute === "industrial" ? "#143f9f" : undefined,
              }}
            >
              Industrial Quote
            </button>
            <button
              type="button"
              onClick={() => setQuoteRoute("healthcare")}
              style={{
                background: quoteRoute === "healthcare" ? "#edf7f0" : undefined,
                borderColor: quoteRoute === "healthcare" ? "#1a7f47" : undefined,
                color: quoteRoute === "healthcare" ? "#13592f" : undefined,
              }}
            >
              Healthcare Quote
            </button>
            {quoteId && quote?.offer_type ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto", flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, opacity: 0.72 }}>Quote type</span>
                {[
                  { key: "completes", label: "Completes", tone: "#edf3ff", border: "#2354d5", color: "#143f9f" },
                  { key: "spares", label: "Spares & Aftermarket", tone: "#fff6e8", border: "#b26a00", color: "#8a5200" },
                ].map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={saving || revisionState !== "draft" || (offerType === opt.key && offerTypeSource === "manual")}
                    onClick={() => changeOfferType(opt.key)}
                    title={offerType === opt.key && offerTypeSource === "auto" ? "Detected from the lines. Click to lock this type." : undefined}
                    style={{
                      background: offerType === opt.key ? opt.tone : undefined,
                      borderColor: offerType === opt.key ? opt.border : undefined,
                      color: offerType === opt.key ? opt.color : undefined,
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
                {offerTypeSource === "auto" ? (
                  <span style={{ fontSize: 12, opacity: 0.72 }}>Auto-detected from lines</span>
                ) : revisionState === "draft" ? (
                  <button type="button" disabled={saving} onClick={() => changeOfferType("auto")} style={{ fontSize: 12 }}>
                    Auto-detect
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
        {notice ? <div style={{ color: "#0b6b38", marginTop: 12 }}>{notice}</div> : null}
        {draftDuplicateAdvisory.length ? (
          <div style={{ marginTop: 12 }}>
            <DuplicateWarningBanner
              duplicates={draftDuplicateAdvisory}
              advisoryOnly
              requireAllow={false}
              title="Similar customer masters found"
              onUseExisting={(dup) => {
                selectCustomer(dup);
                setDraftDuplicateAdvisory([]);
                setStep(0);
              }}
            />
            <button type="button" style={{ marginTop: 8 }} onClick={() => setDraftDuplicateAdvisory([])}>
              Dismiss advisory
            </button>
          </div>
        ) : null}

        <div className="builder-layout-grid" style={{ marginTop: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                marginBottom: 14,
                border: "1px solid rgba(214,224,244,0.92)",
                borderRadius: 16,
                padding: 14,
                background: "radial-gradient(circle at top right, rgba(141,180,255,0.12), transparent 34%), linear-gradient(135deg, #f8fbff 0%, #ffffff 100%)",
                boxShadow: "0 14px 30px rgba(31,41,55,0.05)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Current section</div>
                  <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800 }}>{steps[currentStepIndex]?.label || "Quote flow"}</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                    {steps[currentStepIndex]?.hint || "Work one section at a time."}
                  </div>
                </div>
                <CustomerChip label={`Current focus: ${steps[currentStepIndex]?.label || "Quote flow"}`} tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
              </div>
            </div>

            {step === 0 ? <QuoteStepCustomer api={api} /> : null}
            {step === 1 ? <QuoteStepConfig api={api} /> : null}
            {step === 2 ? <QuoteStepCommercials api={api} /> : null}
            {step === 3 ? <QuoteStepReview api={api} /> : null}

            {step < 3 ? (
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, gap: 10, flexWrap: "wrap" }}>
                <button type="button" onClick={goBack} disabled={step === 0 || saving || summarySaving}>
                  Back
                </button>
                <button type="button" className="button-primary" onClick={goNext} disabled={saving || summarySaving || (step > 0 && !canGoNext)} style={{ fontWeight: 800 }}>
                  {saving ? "Saving…" : continueLabel}
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, gap: 10, flexWrap: "wrap" }}>
                <button type="button" onClick={goBack} disabled={saving || summarySaving}>
                  Back
                </button>
                <div style={{ fontSize: 12, opacity: 0.72, alignSelf: "center" }}>Use Review actions to approve, issue, mail, or create the sales order.</div>
              </div>
            )}
          </div>

          <LiveQuoteSummary api={api} />
        </div>
      </div>

      <SlideOverDrawer
        open={mailComposerOpen}
        onClose={() => !mailSending && setMailComposerOpen(false)}
        title="Email Quote to Customer"
        subtitle={quote?.quote_number ? `${quote.quote_number} · ${quote?.customer_name || selectedCustomer?.customer_name || "Customer"}` : "Compose the customer handoff"}
        eyebrow="Quote delivery"
        width={640}
        footer={
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button type="button" onClick={() => setMailComposerOpen(false)} disabled={mailSending}>
              Cancel
            </button>
            <button type="button" onClick={previewQuoteMail} disabled={mailSending || mailLoading || mailPreviewLoading || !quoteId}>
              {mailPreviewLoading ? "Building preview…" : mailPreview ? "Refresh Preview" : "Preview Email"}
            </button>
            <button
              type="button"
              className="button-primary"
              onClick={() => sendQuoteMail({ issueAndSend: sendRequiresIssue })}
              disabled={
                mailSending ||
                mailLoading ||
                saving ||
                !mailForm.to ||
                !mailForm.subject ||
                revisionState === "pending_approval" ||
                (sendRequiresIssue && (issueBlockedByApproval || approval.can_issue === false || readiness.blockers.length > 0))
              }
              style={{ fontWeight: 800 }}
            >
              {mailSending ? "Sending…" : sendRequiresIssue ? "Issue & Send Quote" : "Send Quote"}
            </button>
          </div>
        }
      >
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            <CustomerStatCard label="Mailbox" value={mailBootstrap.mail_source?.effective_sender?.connected ? "Ready" : "Missing"} accent={mailBootstrap.mail_source?.effective_sender?.connected ? "#1a7f47" : "#9a5a00"} />
            <CustomerStatCard label="Attachments" value={mailAttachments.length} accent="#2354d5" />
            <CustomerStatCard label="Prior Sends" value={Array.isArray(mailBootstrap.history) ? mailBootstrap.history.length : 0} accent="#31539d" />
          </div>

          {mailNotice ? <div style={{ color: "#0b6b38", fontSize: 12 }}>{mailNotice}</div> : null}

          <div style={{ fontSize: 12, opacity: 0.78, lineHeight: 1.7, border: "1px solid #e8eef8", borderRadius: 12, padding: 12, background: "#f8fbff" }}>
            <div>
              From:{" "}
              {mailBootstrap.mail_source?.effective_sender?.connected
                ? `${mailBootstrap.mail_source.effective_sender.email} (${mailBootstrap.mail_source.effective_sender.source})`
                : "Mailbox not configured"}
            </div>
            <div>Reply-To: {mailBootstrap.sender?.email || meFromApi?.email || "—"}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            <Field label="To">
              <input
                value={mailForm.to}
                onChange={(e) => setMailForm((prev) => ({ ...prev, to: e.target.value }))}
                disabled={mailSending}
                placeholder="client@example.com"
              />
            </Field>
            <Field label="CC">
              <input value={mailForm.cc} onChange={(e) => setMailForm((prev) => ({ ...prev, cc: e.target.value }))} disabled={mailSending} />
            </Field>
            <Field label="BCC">
              <input value={mailForm.bcc} onChange={(e) => setMailForm((prev) => ({ ...prev, bcc: e.target.value }))} disabled={mailSending} />
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
              <input value={mailForm.subject} onChange={(e) => setMailForm((prev) => ({ ...prev, subject: e.target.value }))} disabled={mailSending} />
            </Field>
          </div>

          {selectedMailPreset?.description ? <div style={{ fontSize: 12, opacity: 0.72 }}>{selectedMailPreset.description}</div> : null}

          <Field label="Message">
            <textarea
              value={mailForm.body}
              onChange={(e) => setMailForm((prev) => ({ ...prev, body: e.target.value }))}
              rows={8}
              style={{ width: "100%", resize: "vertical" }}
              disabled={mailSending}
            />
          </Field>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={mailForm.clubbed}
              onChange={(e) => setMailForm((prev) => ({ ...prev, clubbed: e.target.checked }))}
              disabled={mailSending}
            />
            Send as lump-sum offer (hide individual line prices)
          </label>

          <div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
              <button type="button" onClick={openMailAttachmentPicker} disabled={mailAttachmentUploading || !quoteId || mailSending}>
                {mailAttachmentUploading ? "Attaching…" : "Attach Additional Files"}
              </button>
              <input ref={mailAttachmentInputRef} type="file" multiple onChange={handleMailAttachmentUpload} style={{ display: "none" }} />
            </div>
            {mailAttachments.length ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {mailAttachments.map((item) => (
                  <CustomerChip
                    key={item.attachment_id || item.id}
                    label={item.file_name || "Attached file"}
                    tone="#eef4ff"
                    color="#2354d5"
                    borderColor="rgba(35,84,213,0.14)"
                  />
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.7 }}>No extra attachments yet. The main quote PDF is included automatically.</div>
            )}
          </div>

          <details style={{ border: "1px solid #e8eef8", borderRadius: 12, padding: "10px 12px", background: "#ffffff" }}>
            <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
              My email signature {mailSignature.saved ? "(custom)" : "(standard footer)"}
            </summary>
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
                First line shows in bold, the rest below it. It replaces the standard name / designation / phone lines on every quote you prepare. Leave empty to use the standard footer.
              </div>
              <textarea
                rows={5}
                value={mailSignature.value}
                onChange={(e) => setMailSignature((prev) => ({ ...prev, value: e.target.value }))}
                placeholder={mailSignature.suggested || "Your name\nDesignation\nPhone\nEmail"}
                disabled={mailSignature.saving || mailSending}
                style={{ width: "100%", resize: "vertical" }}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={saveMailSignature} disabled={mailSignature.saving || mailSending || mailSignature.value === mailSignature.saved}>
                  {mailSignature.saving ? "Saving…" : "Save Signature"}
                </button>
                {!mailSignature.value && mailSignature.suggested ? (
                  <button type="button" onClick={() => setMailSignature((prev) => ({ ...prev, value: prev.suggested }))} disabled={mailSignature.saving}>
                    Start from my profile
                  </button>
                ) : null}
              </div>
              {mailBootstrap.sender?.id && meFromApi?.id && Number(mailBootstrap.sender.id) !== Number(meFromApi.id) ? (
                <div style={{ fontSize: 12, color: "#9a5a00" }}>
                  This quote was prepared by {mailBootstrap.sender.full_name || "a colleague"}, so their signature is used on this email.
                </div>
              ) : null}
            </div>
          </details>

          {mailPreview ? (
            <div style={{ border: "1px solid #dbe6f4", borderRadius: 14, overflow: "hidden", background: "#ffffff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", background: "#f6f9ff", borderBottom: "1px solid #e8eef8" }}>
                <div style={{ fontWeight: 800, fontSize: 13 }}>Customer view</div>
                <button type="button" onClick={() => setMailPreview(null)} style={{ fontSize: 12 }}>
                  Close preview
                </button>
              </div>
              <div style={{ padding: "10px 12px", fontSize: 12, lineHeight: 1.7, borderBottom: "1px solid #eef2fb" }}>
                <div><strong>From:</strong> {mailPreview.from || "Mailbox not configured"}</div>
                <div><strong>To:</strong> {mailPreview.to || "—"}</div>
                {mailPreview.cc ? <div><strong>CC:</strong> {mailPreview.cc}</div> : null}
                {mailPreview.bcc ? <div><strong>BCC:</strong> {mailPreview.bcc}</div> : null}
                <div><strong>Subject:</strong> {mailPreview.subject || "—"}</div>
              </div>
              <iframe
                title="Email preview"
                srcDoc={mailPreview.html || ""}
                sandbox=""
                style={{ width: "100%", height: 460, border: 0, display: "block", background: "#ffffff" }}
              />
              <div style={{ padding: "10px 12px", borderTop: "1px solid #eef2fb" }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                  Attachments ({(mailPreview.attachments || []).length}) · {formatBytes(mailPreview.total_bytes)}
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {(mailPreview.attachments || []).map((item, idx) => (
                    <div key={`${item.file_name}-${idx}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12 }}>
                      <span style={{ overflowWrap: "anywhere" }}>
                        {item.file_name} <span style={{ opacity: 0.6 }}>· {ATTACHMENT_KIND_LABELS[item.kind] || "File"}</span>
                      </span>
                      <span style={{ whiteSpace: "nowrap", opacity: 0.75 }}>{formatBytes(item.size_bytes)}</span>
                    </div>
                  ))}
                </div>
                {mailPreview.over_limit ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#9a4f10", background: "#fff4e8", border: "1px solid rgba(194,110,37,0.2)", borderRadius: 8, padding: "6px 8px" }}>
                    Total is above {formatBytes(mailPreview.limit_bytes)}. Many customer mailboxes reject emails this large — consider removing extra files or sending scope PDFs separately.
                  </div>
                ) : null}
                {Array.isArray(mailPreview.warnings) && mailPreview.warnings.length ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#9a4f10", display: "grid", gap: 4 }}>
                    {mailPreview.warnings.map((text, idx) => (
                      <div key={idx}>⚠ {text}</div>
                    ))}
                  </div>
                ) : null}
                <div style={{ marginTop: 8, fontSize: 11, opacity: 0.6 }}>If you edit the message, recipients or attachments, press Refresh Preview.</div>
              </div>
            </div>
          ) : null}
        </div>
      </SlideOverDrawer>
    </>
  );
}
