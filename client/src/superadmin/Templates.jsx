import { useEffect, useMemo, useState } from "react";

async function apiFetchJson(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error("Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function apiFetchForm(path, formData, options) {
  const res = await fetch(path, {
    credentials: "include",
    body: formData,
    ...options,
  });
  const data = await res.json().catch(async () => {
    const text = await res.text().catch(() => "");
    return text ? { error: text } : null;
  });
  if (!res.ok) {
    const err = new Error("Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function SurfaceCard({ title, subtitle, actions, children }) {
  return (
    <div
      style={{
        border: "1px solid #dfe5ef",
        borderRadius: 22,
        padding: 18,
        background: "#fff",
        boxShadow: "0 16px 38px rgba(25, 37, 61, 0.07)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 13, opacity: 0.74, lineHeight: 1.6, marginTop: 6 }}>{subtitle}</div> : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, value, note, accent }) {
  return (
    <div
      style={{
        border: "1px solid #dfe5ef",
        borderRadius: 18,
        padding: 14,
        background: "#fff",
        boxShadow: "0 12px 28px rgba(15, 23, 42, 0.06)",
        borderTop: `4px solid ${accent}`,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>{note}</div>
    </div>
  );
}

function HeaderChip({ label, tone = "#5f6f86", background = "rgba(0, 80, 158, 0.08)" }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 28,
        padding: "4px 10px",
        borderRadius: 999,
        background,
        color: tone,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

function CompletionBar({ label, percent, note, tone = "#1f5eff", onClick }) {
  const body = (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <strong style={{ fontSize: 14 }}>{label}</strong>
        <span style={{ fontSize: 12, fontWeight: 800, color: tone }}>{percent}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: "#eaf0f8", overflow: "hidden" }}>
        <div style={{ width: `${percent}%`, height: "100%", background: tone, borderRadius: 999 }} />
      </div>
      <div style={{ fontSize: 12, opacity: 0.72 }}>{note}</div>
    </>
  );

  if (!onClick) {
    return <div style={{ border: "1px solid #e3e8f2", borderRadius: 16, padding: 12, background: "#fff", display: "grid", gap: 8 }}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ all: "unset", cursor: "pointer", border: "1px solid #e3e8f2", borderRadius: 16, padding: 12, background: "#fff", display: "grid", gap: 8 }}
    >
      {body}
    </button>
  );
}

function FocusActionCard({ title, note, tone, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        borderRadius: 18,
        padding: 14,
        border: active ? `1px solid ${tone}` : "1px solid #dfe5ef",
        background: active ? "rgba(31, 94, 255, 0.06)" : "#fff",
        boxShadow: active ? "0 12px 28px rgba(31, 94, 255, 0.12)" : "0 10px 22px rgba(15, 23, 42, 0.05)",
        display: "grid",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 14, color: tone }}>{title}</strong>
      <span style={{ fontSize: 12, opacity: 0.74, lineHeight: 1.5 }}>{note}</span>
    </button>
  );
}

function LaneButton({ active, label, note, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        borderRadius: 18,
        padding: "14px 16px",
        border: active ? "1px solid #96b5ff" : "1px solid #dfe5ef",
        background: active ? "linear-gradient(180deg, #eef4ff 0%, #f8fbff 100%)" : "#fff",
        boxShadow: active ? "0 12px 28px rgba(31, 94, 255, 0.12)" : "0 10px 22px rgba(15, 23, 42, 0.05)",
        display: "grid",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 14 }}>{label}</strong>
      <span style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.5 }}>{note}</span>
    </button>
  );
}

function StatusPill({ label, tone, background }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        color: tone,
        background,
      }}
    >
      {label}
    </span>
  );
}

export default function Templates({ launch, onConsumeLaunch }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeLane, setActiveLane] = useState("all");

  const [productGroups, setProductGroups] = useState([]);
  const [distributors, setDistributors] = useState([]);
  const [companies, setCompanies] = useState([]);

  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedDistributorId, setSelectedDistributorId] = useState("");
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [selectedTextCompanyId, setSelectedTextCompanyId] = useState("");

  const [groupScopeTemplate, setGroupScopeTemplate] = useState(null);
  const [globalLetterhead, setGlobalLetterhead] = useState(null);
  const [companyLetterhead, setCompanyLetterhead] = useState(null);
  const [distributorLetterhead, setDistributorLetterhead] = useState(null);
  const [coverLetterBody, setCoverLetterBody] = useState("");
  const [coverSaving, setCoverSaving] = useState(false);
  const [quoteTermsBody, setQuoteTermsBody] = useState("");
  const [termsSaving, setTermsSaving] = useState(false);

  const [groupFileKey, setGroupFileKey] = useState(0);
  const [globalFileKey, setGlobalFileKey] = useState(0);
  const [companyFileKey, setCompanyFileKey] = useState(0);
  const [distFileKey, setDistFileKey] = useState(0);
  const [companyDocumentStatus, setCompanyDocumentStatus] = useState([]);

  const sortedGroups = useMemo(() => {
    const arr = Array.isArray(productGroups) ? [...productGroups] : [];
    arr.sort((a, b) => {
      const ac = (a.category_name || "").toLowerCase();
      const bc = (b.category_name || "").toLowerCase();
      if (ac !== bc) return ac.localeCompare(bc);
      return (a.group_name || "").toLowerCase().localeCompare((b.group_name || "").toLowerCase());
    });
    return arr;
  }, [productGroups]);

  const sortedDistributors = useMemo(() => {
    const arr = Array.isArray(distributors) ? [...distributors] : [];
    arr.sort((a, b) => (a.company_name || "").toLowerCase().localeCompare((b.company_name || "").toLowerCase()));
    return arr;
  }, [distributors]);

  const sortedCompanies = useMemo(() => {
    const arr = Array.isArray(companies) ? [...companies] : [];
    arr.sort((a, b) => String(a.company_code || "").localeCompare(String(b.company_code || "")));
    return arr;
  }, [companies]);

  const selectedGroup = useMemo(
    () => sortedGroups.find((item) => String(item.id) === String(selectedGroupId)) || null,
    [sortedGroups, selectedGroupId]
  );
  const selectedDistributor = useMemo(
    () => sortedDistributors.find((item) => String(item.id) === String(selectedDistributorId)) || null,
    [sortedDistributors, selectedDistributorId]
  );
  const selectedCompany = useMemo(
    () => sortedCompanies.find((item) => String(item.id) === String(selectedCompanyId)) || null,
    [sortedCompanies, selectedCompanyId]
  );

  useEffect(() => {
    setLoading(true);
    setError("");
    setNotice("");
    Promise.all([loadAdminData(), loadGlobalLetterhead(), loadCoverLetter(), loadQuoteTerms()])
      .catch((e) => setError(e?.data?.error || "Failed to load templates."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedGroupId) {
      setGroupScopeTemplate(null);
      return;
    }
    loadGroupScope(selectedGroupId).catch(() => {});
  }, [selectedGroupId]);

  useEffect(() => {
    if (!selectedDistributorId) {
      setDistributorLetterhead(null);
      return;
    }
    loadDistributorLetterhead(selectedDistributorId).catch(() => {});
  }, [selectedDistributorId]);

  useEffect(() => {
    if (!selectedCompanyId) {
      setCompanyLetterhead(null);
      return;
    }
    loadCompanyLetterhead(selectedCompanyId).catch(() => {});
  }, [selectedCompanyId]);

  async function loadAdminData() {
    const data = await apiFetchJson("/templates/admin-data");
    const groups = Array.isArray(data?.product_groups) ? data.product_groups : [];
    const dists = Array.isArray(data?.distributors) ? data.distributors : [];
    const cos = Array.isArray(data?.companies) ? data.companies : [];
    setProductGroups(groups);
    setDistributors(dists);
    setCompanies(cos);

    if (!selectedGroupId && groups.length) setSelectedGroupId(String(groups[0].id));
    if (!selectedDistributorId && dists.length) setSelectedDistributorId(String(dists[0].id));
    if (!selectedCompanyId && cos.length) setSelectedCompanyId(String(cos[0].id));
  }

  async function loadGroupScope(groupId) {
    const data = await apiFetchJson(`/templates/product-group-scope/${groupId}`);
    setGroupScopeTemplate(data?.template || null);
  }

  async function loadGlobalLetterhead() {
    const data = await apiFetchJson("/templates/letterhead/global");
    setGlobalLetterhead(data?.template || null);
  }

  async function loadDistributorLetterhead(distributorId) {
    const data = await apiFetchJson(`/templates/letterhead/distributor/${distributorId}`);
    setDistributorLetterhead(data?.template || null);
  }

  async function loadCompanyLetterhead(companyId) {
    const data = await apiFetchJson(`/templates/letterhead/company/${companyId}`);
    setCompanyLetterhead(data?.template || null);
  }

  async function loadCoverLetter(companyId = "") {
    const suffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : "";
    const data = await apiFetchJson(`/templates/quote-cover-letter${suffix}`);
    setCoverLetterBody(typeof data?.template?.template_body === "string" ? data.template.template_body : "");
  }

  async function loadQuoteTerms(companyId = "") {
    const suffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : "";
    const data = await apiFetchJson(`/templates/quote-terms${suffix}`);
    setQuoteTermsBody(typeof data?.template?.template_body === "string" ? data.template.template_body : "");
  }

  useEffect(() => {
    loadCoverLetter(selectedTextCompanyId).catch(() => {});
    loadQuoteTerms(selectedTextCompanyId).catch(() => {});
  }, [selectedTextCompanyId]);

  useEffect(() => {
    let cancelled = false;
    if (!sortedCompanies.length) {
      setCompanyDocumentStatus([]);
      return () => {
        cancelled = true;
      };
    }

    async function loadCompanyStatuses() {
      const rows = await Promise.all(
        sortedCompanies.map(async (company) => {
          const companyId = company?.id;
          const [letterheadData, coverData, termsData] = await Promise.all([
            apiFetchJson(`/templates/letterhead/company/${companyId}`).catch(() => null),
            apiFetchJson(`/templates/quote-cover-letter?company_id=${encodeURIComponent(companyId)}`).catch(() => null),
            apiFetchJson(`/templates/quote-terms?company_id=${encodeURIComponent(companyId)}`).catch(() => null),
          ]);
          return {
            company_id: companyId,
            company_code: company?.company_code || "—",
            display_name: company?.display_name || company?.company_name || company?.legal_name || "Company",
            has_letterhead: Boolean(letterheadData?.template?.file_name),
            has_cover_letter: Boolean(String(coverData?.template?.template_body || "").trim()),
            has_quote_terms: Boolean(String(termsData?.template?.template_body || "").trim()),
          };
        })
      );
      if (!cancelled) setCompanyDocumentStatus(rows);
    }

    loadCompanyStatuses().catch(() => {
      if (!cancelled) setCompanyDocumentStatus([]);
    });
    return () => {
      cancelled = true;
    };
  }, [sortedCompanies]);

  useEffect(() => {
    if (!launch) return;
    if (launch.selectedGroupId) {
      setSelectedGroupId(String(launch.selectedGroupId));
      setActiveLane("scope");
    }
    if (launch.companyId) {
      setSelectedCompanyId(String(launch.companyId));
      setActiveLane("letterheads");
    }
    if (launch.textCompanyId) {
      setSelectedTextCompanyId(String(launch.textCompanyId));
      setActiveLane("text");
    } else if (launch.companyId && launch.syncTextCompany !== false) {
      setSelectedTextCompanyId(String(launch.companyId));
    }
    if (launch.focus === "global_text") {
      setSelectedTextCompanyId("");
      setActiveLane("text");
    }
    if (launch.focus === "company_docs") {
      setActiveLane("company_docs");
    }
    if (launch.focus === "scope") {
      setActiveLane("scope");
    }
    onConsumeLaunch?.();
  }, [launch, onConsumeLaunch]);

  async function saveCoverLetter() {
    setCoverSaving(true);
    setError("");
    try {
      await apiFetchJson("/templates/quote-cover-letter", {
        method: "PUT",
        body: JSON.stringify({ template_body: coverLetterBody, company_id: selectedTextCompanyId || null }),
      });
      setNotice(selectedTextCompanyId ? "Saved company cover letter text." : "Saved global cover letter text.");
      await loadCoverLetter(selectedTextCompanyId);
    } catch (e) {
      setError(e?.data?.error || "Save failed.");
    } finally {
      setCoverSaving(false);
    }
  }

  async function saveQuoteTerms() {
    setTermsSaving(true);
    setError("");
    try {
      await apiFetchJson("/templates/quote-terms", {
        method: "PUT",
        body: JSON.stringify({ template_body: quoteTermsBody, company_id: selectedTextCompanyId || null }),
      });
      setNotice(selectedTextCompanyId ? "Saved company quote terms text." : "Saved global quote terms text.");
      await loadQuoteTerms(selectedTextCompanyId);
    } catch (e) {
      setError(e?.data?.error || "Save failed.");
    } finally {
      setTermsSaving(false);
    }
  }

  async function uploadGroupScope(file) {
    if (!selectedGroupId) return;
    const fd = new FormData();
    fd.append("file", file);
    await apiFetchForm(`/templates/product-group-scope/${selectedGroupId}`, fd, { method: "POST" });
    await loadGroupScope(selectedGroupId);
    setGroupFileKey((x) => x + 1);
    setNotice("Saved product group scope PDF.");
  }

  async function removeGroupScope() {
    if (!selectedGroupId || !groupScopeTemplate?.file_name) return;
    if (
      groupScopeTemplate.scope === "global" &&
      groupScopeTemplate.requested_company_id &&
      !window.confirm(
        `"${groupScopeTemplate.file_name}" is the global scope PDF shared by every company. Remove it for all companies?`
      )
    ) {
      return;
    }
    setNotice("");
    setError("");
    const data = await apiFetchJson(`/templates/product-group-scope/${selectedGroupId}`, { method: "DELETE" });
    setGroupScopeTemplate(data?.template || null);
    setGroupFileKey((x) => x + 1);
    const removedLabel = data?.removed_scope === "global" ? "global" : "company";
    setNotice(
      data?.template?.file_name
        ? `Removed the ${removedLabel} scope PDF. The ${data.template.scope} file "${data.template.file_name}" still applies to this group.`
        : `Removed the ${removedLabel} scope PDF. This group now has no scope PDF.`
    );
  }

  async function uploadGlobalLetterhead(file) {
    const fd = new FormData();
    fd.append("file", file);
    await apiFetchForm("/templates/letterhead/global", fd, { method: "POST" });
    await loadGlobalLetterhead();
    setGlobalFileKey((x) => x + 1);
    setNotice("Saved absstem letterhead PDF.");
  }

  async function removeGlobalLetterhead() {
    await apiFetchJson("/templates/letterhead/global", { method: "DELETE" });
    await loadGlobalLetterhead();
    setNotice("Removed absstem letterhead PDF.");
  }

  async function uploadCompanyLetterhead(file) {
    if (!selectedCompanyId) return;
    const fd = new FormData();
    fd.append("file", file);
    await apiFetchForm(`/templates/letterhead/company/${selectedCompanyId}`, fd, { method: "POST" });
    await loadCompanyLetterhead(selectedCompanyId);
    setCompanyFileKey((x) => x + 1);
    setNotice("Saved company letterhead PDF.");
  }

  async function removeCompanyLetterhead() {
    if (!selectedCompanyId) return;
    await apiFetchJson(`/templates/letterhead/company/${selectedCompanyId}`, { method: "DELETE" });
    await loadCompanyLetterhead(selectedCompanyId);
    setNotice("Removed company letterhead PDF.");
  }

  async function uploadDistributorLetterhead(file) {
    if (!selectedDistributorId) return;
    const fd = new FormData();
    fd.append("file", file);
    await apiFetchForm(`/templates/letterhead/distributor/${selectedDistributorId}`, fd, { method: "POST" });
    await loadDistributorLetterhead(selectedDistributorId);
    setDistFileKey((x) => x + 1);
    setNotice("Saved channel partner letterhead PDF.");
  }

  async function removeDistributorLetterhead() {
    if (!selectedDistributorId) return;
    await apiFetchJson(`/templates/letterhead/distributor/${selectedDistributorId}`, { method: "DELETE" });
    await loadDistributorLetterhead(selectedDistributorId);
    setNotice("Removed channel partner letterhead PDF.");
  }

  if (loading) return <div style={{ padding: 16 }}>Loading…</div>;

  const globalMissingItems = [
    !globalLetterhead?.file_name ? "Global letterhead" : null,
    !String(coverLetterBody || "").trim() ? "Global cover letter" : null,
    !String(quoteTermsBody || "").trim() ? "Global quote terms" : null,
  ].filter(Boolean);
  const selectedCompanyStatus = companyDocumentStatus.find((item) => String(item.company_id) === String(selectedCompanyId)) || null;
  const selectedTextCompanyStatus = companyDocumentStatus.find((item) => String(item.company_id) === String(selectedTextCompanyId)) || null;
  const selectedCompanyMissingItems = selectedCompanyStatus
    ? [
        !selectedCompanyStatus.has_letterhead ? `${selectedCompanyStatus.company_code} letterhead` : null,
        !selectedCompanyStatus.has_cover_letter ? `${selectedCompanyStatus.company_code} cover text` : null,
        !selectedCompanyStatus.has_quote_terms ? `${selectedCompanyStatus.company_code} quote terms` : null,
      ].filter(Boolean)
    : [];
  const incompleteCompanyCount = companyDocumentStatus.filter((item) => !(item.has_letterhead && item.has_cover_letter && item.has_quote_terms)).length;
  const nextIncompleteCompany = companyDocumentStatus.find((item) => !(item.has_letterhead && item.has_cover_letter && item.has_quote_terms)) || null;
  const companyCompletionRows = companyDocumentStatus.map((item) => {
    const readyCount = Number(item.has_letterhead) + Number(item.has_cover_letter) + Number(item.has_quote_terms);
    const percent = Math.round((readyCount / 3) * 100);
    const tone = percent === 100 ? "#14804a" : percent >= 67 ? "#1f5eff" : percent > 0 ? "#d97706" : "#e30513";
    const missing = [
      !item.has_letterhead ? "letterhead" : null,
      !item.has_cover_letter ? "cover text" : null,
      !item.has_quote_terms ? "quote terms" : null,
    ].filter(Boolean);
    return {
      ...item,
      percent,
      tone,
      note: missing.length ? `Missing ${missing.join(", ")}` : "All company document checks are ready",
    };
  });
  const activeTextScopeLabel = selectedTextCompanyId
    ? sortedCompanies.find((item) => String(item.id) === String(selectedTextCompanyId))?.display_name || "Selected company"
    : "Global default";
  const selectedDistributorMissing = !distributorLetterhead?.file_name;
  const selectedGroupMissing = !groupScopeTemplate?.file_name;
  const headerChips = [
    incompleteCompanyCount ? { label: `${incompleteCompanyCount} companies partial`, tone: "#b45309", background: "rgba(217, 119, 6, 0.12)" } : null,
    globalMissingItems.length ? { label: `${globalMissingItems.length} global items missing`, tone: "#e30513", background: "rgba(227, 5, 19, 0.1)" } : { label: "Global defaults ready", tone: "#14804a", background: "rgba(20, 128, 74, 0.1)" },
    selectedCompanyMissingItems.length
      ? { label: `${selectedCompanyStatus?.company_code || "Company"} needs ${selectedCompanyMissingItems.length}`, tone: "#1f5eff", background: "rgba(31, 94, 255, 0.1)" }
      : selectedCompanyStatus
        ? { label: `${selectedCompanyStatus.company_code} company docs ready`, tone: "#14804a", background: "rgba(20, 128, 74, 0.1)" }
        : null,
    activeLane !== "all" ? { label: `${activeLane} lane`, tone: "#1f5eff", background: "rgba(31, 94, 255, 0.1)" } : null,
  ].filter(Boolean);

  const stats = [
    { label: "Product groups", value: sortedGroups.length, note: "scope PDF slots available", accent: "#1f5eff" },
    { label: "Companies", value: sortedCompanies.length, note: "company letterhead slots", accent: "#14804a" },
    { label: "Distributors", value: sortedDistributors.length, note: "partner letterhead slots", accent: "#d97706" },
    {
      label: "Configured assets",
      value:
        Number(Boolean(groupScopeTemplate?.file_name)) +
        Number(Boolean(globalLetterhead?.file_name)) +
        Number(Boolean(companyLetterhead?.file_name)) +
        Number(Boolean(distributorLetterhead?.file_name)),
      note: "current files in active view",
      accent: "#8b5cf6",
    },
  ];

  const laneOptions = [
    { key: "all", label: "All lanes", note: "See scope PDFs, letterheads, and text editors together." },
    { key: "company_docs", label: "Company docs", note: nextIncompleteCompany ? `${incompleteCompanyCount} companies still need document alignment.` : "Company-level document setup is aligned." },
    { key: "letterheads", label: "Letterheads", note: selectedCompanyMissingItems.length || selectedDistributorMissing ? "Company or distributor assets still need PDF coverage." : "Global, company, and distributor PDFs look healthy." },
    { key: "text", label: "Text library", note: globalMissingItems.length || selectedTextCompanyStatus?.has_cover_letter === false || selectedTextCompanyStatus?.has_quote_terms === false ? "Cover or terms text still needs attention." : "Global and company text can be tuned here." },
    { key: "scope", label: "Scope PDFs", note: selectedGroupMissing ? "Active product group still has no scope PDF." : "Product-group scope lane is ready for review." },
  ];

  const focusActions = [
    {
      key: "global-defaults",
      title: "Finish global defaults",
      note: globalMissingItems.length
        ? `${globalMissingItems.join(", ")} still need to be set before company overrides become reliable fallback paths.`
        : "Global cover, terms, and letterhead defaults are already in place.",
      tone: globalMissingItems.length ? "#b00020" : "#14804a",
      active: activeLane === "text" && !selectedTextCompanyId,
      onClick: () => {
        setActiveLane("text");
        setSelectedTextCompanyId("");
      },
    },
    {
      key: "company-stack",
      title: "Finish next company stack",
      note: nextIncompleteCompany
        ? `${nextIncompleteCompany.company_code} still needs ${[
            !nextIncompleteCompany.has_letterhead ? "letterhead" : null,
            !nextIncompleteCompany.has_cover_letter ? "cover text" : null,
            !nextIncompleteCompany.has_quote_terms ? "quote terms" : null,
          ]
            .filter(Boolean)
            .join(", ")}.`
        : "Every visible company has a complete document stack.",
      tone: nextIncompleteCompany ? "#d97706" : "#14804a",
      active: activeLane === "company_docs",
      onClick: () => {
        setActiveLane("company_docs");
        if (nextIncompleteCompany) {
          setSelectedCompanyId(String(nextIncompleteCompany.company_id));
          setSelectedTextCompanyId(String(nextIncompleteCompany.company_id));
        }
      },
    },
    {
      key: "text-scope",
      title: "Review text override scope",
      note: selectedTextCompanyId
        ? `${activeTextScopeLabel} is active for text editing. Use this lane to verify company-specific overrides against the global default.`
        : "Global text scope is active. Switch to a company here only when you need a real override, not a duplicate default."
      ,
      tone: selectedTextCompanyId ? "#234a8f" : "#14804a",
      active: activeLane === "text",
      onClick: () => setActiveLane("text"),
    },
    {
      key: "asset-lane",
      title: "Check active asset lane",
      note: selectedGroupMissing
        ? `${selectedGroup?.group_name || "Selected product group"} still has no scope PDF.`
        : selectedDistributorMissing
          ? `${selectedDistributor?.company_name || "Selected distributor"} still has no shared letterhead PDF.`
          : "Selected scope and distributor assets already have active files.",
      tone: selectedGroupMissing || selectedDistributorMissing ? "#7c3aed" : "#14804a",
      active: activeLane === "scope" || activeLane === "letterheads",
      onClick: () => setActiveLane(selectedGroupMissing ? "scope" : "letterheads"),
    },
  ];

  const showCompanyDocs = activeLane === "all" || activeLane === "company_docs";
  const showLetterheads = activeLane === "all" || activeLane === "letterheads" || activeLane === "company_docs";
  const showText = activeLane === "all" || activeLane === "text" || activeLane === "company_docs";
  const showScope = activeLane === "all" || activeLane === "scope";

  return (
    <div style={{ maxWidth: 1320, width: "100%", display: "grid", gap: 16 }}>
      <section
        style={{
          border: "1px solid #dfe5ef",
          borderRadius: 24,
          padding: 22,
          background: "linear-gradient(135deg, #f7fbff 0%, #ffffff 58%, #f9fbff 100%)",
          boxShadow: "0 18px 42px rgba(25, 37, 61, 0.08)",
        }}
      >
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Document control desk</div>
          <h2 style={{ margin: "8px 0 0", fontSize: 32, lineHeight: 1.15 }}>Templates turned into a clearer document setup control surface.</h2>
          <p style={{ margin: "12px 0 0", fontSize: 14, opacity: 0.76, maxWidth: 760, lineHeight: 1.7 }}>
            Start from the missing global or company document stack, then narrow the desk to the exact lane you want to fix instead of scanning every asset and text editor at once.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
            {headerChips.map((chip) => (
              <HeaderChip key={chip.label} {...chip} />
            ))}
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14 }}>
        {stats.map((item) => (
          <StatCard key={item.label} {...item} />
        ))}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 16, alignItems: "start" }}>
        <SurfaceCard title="Fix now" subtitle="Use these actions to jump directly to the document gap most likely to block quoting consistency.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {focusActions.map((item) => (
              <FocusActionCard key={item.key} {...item} />
            ))}
          </div>
        </SurfaceCard>

        <SurfaceCard title="Review rail" subtitle="A compact audit before you open the next template lane.">
          <div style={{ display: "grid", gap: 10 }}>
            {globalMissingItems.length ? (
              <div style={{ border: "1px solid #ffd8d8", background: "#fff3f3", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#b00020", fontSize: 13 }}>Global defaults incomplete</strong>
                <div style={{ fontSize: 12, opacity: 0.82, marginTop: 4 }}>{globalMissingItems.join(", ")} still need to be configured.</div>
              </div>
            ) : null}
            {nextIncompleteCompany ? (
              <div style={{ border: "1px solid #f2dfb0", background: "#fff9ec", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#8b5a00", fontSize: 13 }}>Company stack incomplete</strong>
                <div style={{ fontSize: 12, opacity: 0.82, marginTop: 4 }}>
                  {nextIncompleteCompany.company_code} still needs {[
                    !nextIncompleteCompany.has_letterhead ? "letterhead" : null,
                    !nextIncompleteCompany.has_cover_letter ? "cover text" : null,
                    !nextIncompleteCompany.has_quote_terms ? "quote terms" : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}.
                </div>
              </div>
            ) : null}
            {selectedGroupMissing ? (
              <div style={{ border: "1px solid #e6ddff", background: "#f6f2ff", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#7c3aed", fontSize: 13 }}>Scope PDF missing</strong>
                <div style={{ fontSize: 12, opacity: 0.82, marginTop: 4 }}>
                  {selectedGroup ? `${selectedGroup.category_name ? `${selectedGroup.category_name} - ` : ""}${selectedGroup.group_name}` : "Selected group"} has no active scope file.
                </div>
              </div>
            ) : null}
            {selectedDistributorMissing ? (
              <div style={{ border: "1px solid #d9e6ff", background: "#eef4ff", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#234a8f", fontSize: 13 }}>Distributor letterhead missing</strong>
                <div style={{ fontSize: 12, opacity: 0.82, marginTop: 4 }}>
                  {selectedDistributor?.company_name || "Selected distributor"} still has no shared letterhead PDF.
                </div>
              </div>
            ) : null}
            {!globalMissingItems.length && !nextIncompleteCompany && !selectedGroupMissing && !selectedDistributorMissing ? (
              <div style={{ border: "1px solid #d6f4df", background: "#f2fff6", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#0a7a35", fontSize: 13 }}>Document baseline is healthy</strong>
                <div style={{ fontSize: 12, opacity: 0.78, marginTop: 4 }}>
                  Global defaults, current company stack, and active asset lanes all look covered. This is a good point for content quality review.
                </div>
              </div>
            ) : null}
          </div>
        </SurfaceCard>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12 }}>
        {laneOptions.map((item) => (
          <LaneButton key={item.key} active={activeLane === item.key} label={item.label} note={item.note} onClick={() => setActiveLane(item.key)} />
        ))}
      </section>

      {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35" }}>{notice}</div> : null}

      {showCompanyDocs ? (
        <SurfaceCard
          title="Company completion"
          subtitle="Each company shows document readiness across letterhead, cover text, and quote terms so AI and AT can be fixed independently."
          actions={<div style={{ fontSize: 12, opacity: 0.68 }}>{companyCompletionRows.filter((item) => item.percent === 100).length}/{companyCompletionRows.length || 0} company templates fully ready</div>}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {companyCompletionRows.map((item) => (
              <CompletionBar
                key={item.company_id}
                label={`${item.company_code} — ${item.display_name}`}
                percent={item.percent}
                tone={item.tone}
                note={item.note}
                onClick={() => {
                  setSelectedCompanyId(String(item.company_id));
                  setSelectedTextCompanyId(String(item.company_id));
                  setActiveLane("company_docs");
                }}
              />
            ))}
          </div>
        </SurfaceCard>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {showScope ? (
          <SurfaceCard
            title="Product group scope PDFs"
            subtitle="Attach the right scope PDF to each product group without hunting across unrelated template assets."
            actions={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <StatusPill
                  label={groupScopeTemplate?.file_name ? "Active file" : "Missing file"}
                  tone={groupScopeTemplate?.file_name ? "#0b7d45" : "#8b5a00"}
                  background={groupScopeTemplate?.file_name ? "#effcf3" : "#fff6e8"}
                />
              </div>
            }
          >
          <Field label="Product Group">
            <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)}>
              {sortedGroups.map((g) => (
                <option key={g.id} value={String(g.id)}>
                  {g.category_name ? `${g.category_name} — ${g.group_name}` : g.group_name}
                </option>
              ))}
            </select>
          </Field>
          <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fbfcff", marginBottom: 12 }}>
            <div style={{ fontWeight: 700 }}>{selectedGroup ? (selectedGroup.category_name ? `${selectedGroup.category_name} — ${selectedGroup.group_name}` : selectedGroup.group_name) : "No group selected"}</div>
            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6 }}>
              Current file: {groupScopeTemplate?.file_name || "Not set"}
              {groupScopeTemplate?.file_name ? (groupScopeTemplate.scope === "global" ? " (global, shared by all companies)" : " (this company only)") : ""}
            </div>
            {groupScopeTemplate?.file_name ? (
              <div style={{ marginTop: 10 }}>
                <a href={`/templates/product-group-scope/${selectedGroupId}/file`} target="_blank" rel="noreferrer">
                  Open current PDF
                </a>
              </div>
            ) : null}
          </div>
          <Field label="Upload / Replace (PDF)">
            <input
              key={groupFileKey}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (f) uploadGroupScope(f).catch((err) => setError(err?.data?.error || "Upload failed."));
              }}
            />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              disabled={!groupScopeTemplate?.file_name}
              onClick={() =>
                removeGroupScope().catch((err) => {
                  setNotice("");
                  setError(
                    err?.data?.error === "SCOPE_PDF_NOT_SET"
                      ? "No scope PDF is set for this group, so nothing was removed."
                      : err?.data?.error || "Remove failed. The scope PDF was not removed."
                  );
                  loadGroupScope(selectedGroupId).catch(() => {});
                })
              }
            >
              Remove
            </button>
          </div>
          </SurfaceCard>
        ) : null}

        {showLetterheads ? (
          <SurfaceCard
            title="Letterheads"
            subtitle="Global, company, and distributor letterheads are grouped into one asset lane."
            actions={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <StatusPill
                  label={globalLetterhead?.file_name ? "Global ready" : "Global missing"}
                  tone={globalLetterhead?.file_name ? "#0b7d45" : "#b00020"}
                  background={globalLetterhead?.file_name ? "#effcf3" : "#fff3f3"}
                />
                <StatusPill
                  label={selectedCompanyStatus?.has_letterhead ? "Company ready" : "Company missing"}
                  tone={selectedCompanyStatus?.has_letterhead ? "#0b7d45" : "#8b5a00"}
                  background={selectedCompanyStatus?.has_letterhead ? "#effcf3" : "#fff6e8"}
                />
                <StatusPill
                  label={distributorLetterhead?.file_name ? "Partner ready" : "Partner missing"}
                  tone={distributorLetterhead?.file_name ? "#0b7d45" : "#234a8f"}
                  background={distributorLetterhead?.file_name ? "#effcf3" : "#eef4ff"}
                />
              </div>
            }
          >
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fbfcff" }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>absstem Letterhead (Global)</div>
              <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 10 }}>Current: {globalLetterhead?.file_name || "Not set"}</div>
              <Field label="Upload / Replace (PDF)">
                <input
                  key={globalFileKey}
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f) uploadGlobalLetterhead(f).catch((err) => setError(err?.data?.error || "Upload failed."));
                  }}
                />
              </Field>
              <button type="button" onClick={() => removeGlobalLetterhead().catch((err) => setError(err?.data?.error || "Remove failed."))}>
                Remove
              </button>
            </div>

            <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fbfcff" }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Company Letterhead</div>
              <Field label="Company">
                <select value={selectedCompanyId} onChange={(e) => setSelectedCompanyId(e.target.value)}>
                  {sortedCompanies.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.company_code} — {c.display_name}
                    </option>
                  ))}
                </select>
              </Field>
              <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 10 }}>
                {selectedCompany ? `${selectedCompany.company_code} — ${selectedCompany.display_name}` : "No company selected"} • Current: {companyLetterhead?.file_name || "Not set"}
              </div>
              <Field label="Upload / Replace (PDF)">
                <input
                  key={companyFileKey}
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f) uploadCompanyLetterhead(f).catch((err) => setError(err?.data?.error || "Upload failed."));
                  }}
                />
              </Field>
              <button type="button" onClick={() => removeCompanyLetterhead().catch((err) => setError(err?.data?.error || "Remove failed."))}>
                Remove
              </button>
            </div>

            <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fbfcff" }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Channel Partner Shared Letterhead</div>
              <Field label="Distributor">
                <select value={selectedDistributorId} onChange={(e) => setSelectedDistributorId(e.target.value)}>
                  {sortedDistributors.map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      {d.company_name}
                    </option>
                  ))}
                </select>
              </Field>
              <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 10 }}>
                {selectedDistributor?.company_name || "No distributor selected"} • Current: {distributorLetterhead?.file_name || "Not set"}
              </div>
              <Field label="Upload / Replace (PDF)">
                <input
                  key={distFileKey}
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f) uploadDistributorLetterhead(f).catch((err) => setError(err?.data?.error || "Upload failed."));
                  }}
                />
              </Field>
              <button
                type="button"
                onClick={() => removeDistributorLetterhead().catch((err) => setError(err?.data?.error || "Remove failed."))}
              >
                Remove
              </button>
            </div>
          </div>
          </SurfaceCard>
        ) : null}

        {showText ? (
          <SurfaceCard
            title="Cover letter text"
            subtitle="Maintain the first-page quote body with global defaults or company-specific overrides."
            actions={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <StatusPill
                  label={selectedTextCompanyId ? "Company override" : "Global default"}
                  tone={selectedTextCompanyId ? "#234a8f" : "#14804a"}
                  background={selectedTextCompanyId ? "#eef4ff" : "#effcf3"}
                />
                <StatusPill
                  label={String(coverLetterBody || "").trim() ? "Body present" : "Body empty"}
                  tone={String(coverLetterBody || "").trim() ? "#0b7d45" : "#8b5a00"}
                  background={String(coverLetterBody || "").trim() ? "#effcf3" : "#fff6e8"}
                />
              </div>
            }
          >
          <Field label="Text Scope">
            <select value={selectedTextCompanyId} onChange={(e) => setSelectedTextCompanyId(e.target.value)}>
              <option value="">Global default</option>
              {sortedCompanies.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.company_code} — {c.display_name}
                </option>
              ))}
            </select>
          </Field>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8, lineHeight: 1.7 }}>
            Variables: <code>{"{{attention_to}}"}</code>, <code>{"{{customer_name}}"}</code>, <code>{"{{quote_number}}"}</code>,{" "}
            <code>{"{{group_names}}"}</code>, <code>{"{{sender_name}}"}</code>, <code>{"{{sender_designation}}"}</code>,{" "}
            <code>{"{{sender_phone}}"}</code>, <code>{"{{sender_email}}"}</code>, <code>{"{{company_name}}"}</code>,{" "}
            <code>{"{{company_website}}"}</code>, <code>{"{{company_contact_email}}"}</code>, <code>{"{{company_contact_phone}}"}</code>.
          </div>
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 10 }}>
            Editing: {activeTextScopeLabel}
          </div>
          <textarea
            value={coverLetterBody}
            onChange={(e) => setCoverLetterBody(e.target.value)}
            rows={13}
            style={{ width: "100%", fontFamily: "inherit" }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <button type="button" onClick={saveCoverLetter} disabled={coverSaving}>
              {coverSaving ? "Saving..." : "Save"}
            </button>
          </div>
          </SurfaceCard>
        ) : null}

        {showText ? (
          <SurfaceCard
            title="Quote terms library"
            subtitle="Default quote terms stay editable here with optional company-specific overrides."
            actions={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <StatusPill
                  label={selectedTextCompanyId ? "Company override" : "Global default"}
                  tone={selectedTextCompanyId ? "#234a8f" : "#14804a"}
                  background={selectedTextCompanyId ? "#eef4ff" : "#effcf3"}
                />
                <StatusPill
                  label={String(quoteTermsBody || "").trim() ? "Terms present" : "Terms empty"}
                  tone={String(quoteTermsBody || "").trim() ? "#0b7d45" : "#8b5a00"}
                  background={String(quoteTermsBody || "").trim() ? "#effcf3" : "#fff6e8"}
                />
              </div>
            }
          >
          <Field label="Text Scope">
            <select value={selectedTextCompanyId} onChange={(e) => setSelectedTextCompanyId(e.target.value)}>
              <option value="">Global default</option>
              {sortedCompanies.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.company_code} — {c.display_name}
                </option>
              ))}
            </select>
          </Field>
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 10 }}>
            Editing: {selectedTextCompanyId ? sortedCompanies.find((item) => String(item.id) === String(selectedTextCompanyId))?.display_name || "Selected company" : "Global default"}
          </div>
          <textarea
            value={quoteTermsBody}
            onChange={(e) => setQuoteTermsBody(e.target.value)}
            rows={15}
            style={{ width: "100%", fontFamily: "inherit" }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <button type="button" onClick={saveQuoteTerms} disabled={termsSaving}>
              {termsSaving ? "Saving..." : "Save"}
            </button>
          </div>
          </SurfaceCard>
        ) : null}
      </div>
    </div>
  );
}
