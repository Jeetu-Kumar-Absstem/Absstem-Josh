import { useEffect, useMemo, useState } from "react";

async function apiFetch(path, options) {
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

function Field({ label, children, help }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
      {help ? <div style={{ marginTop: 4, fontSize: 12, opacity: 0.6 }}>{help}</div> : null}
    </div>
  );
}

function emptyForm() {
  return {
    distributor_code: "",
    distributor_company_name: "",
    distributor_contact_email: "",
    distributor_contact_phone: "",
    distributor_id: "",
    distributor_org_head_user_id: "",
    full_name: "",
    email: "",
    phone: "",
    designation: "",
    role_id: "",
    department_key: "",
    company_name: "",
    company_ids: [],
    primary_company_id: "",
    employee_code: "",
    primary_manager_user_id: "",
    secondary_manager_user_id: "",
    date_of_joining: "",
    local_address: "",
    permanent_address: "",
    discount_threshold_pct: "",
    is_active: true,
    password: "",
  };
}

const MODE_META = {
  internal: {
    title: "Internal Employee",
    detail: "Create an absstem team member with hierarchy, role, password, and commercial control.",
  },
  distributor: {
    title: "Distributor Onboarding",
    detail: "Create distributor company and the organisation head user in one guided flow.",
  },
  distributor_employee: {
    title: "Distributor Employee",
    detail: "Add a team member under an existing distributor and connect them to the org head.",
  },
};

const STEPS = [
  { id: 1, title: "Track", note: "Choose onboarding flow" },
  { id: 2, title: "Identity", note: "Capture company and user details" },
  { id: 3, title: "Hierarchy", note: "Assign access and reporting" },
  { id: 4, title: "Review", note: "Check defaults and create" },
];

export default function OnboardingWizard({ onOpenUserMaster }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState("internal");
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(emptyForm());
  const [bootstrap, setBootstrap] = useState({
    groups: [],
    roles: [],
    departments: [],
    distributors: [],
    managers: [],
    companies: [],
  });
  const [users, setUsers] = useState([]);

  useEffect(() => {
    refreshData().catch(() => {});
  }, []);

  async function refreshData() {
    setLoading(true);
    setError("");
    try {
      const [boot, usersData] = await Promise.all([apiFetch("/users/bootstrap"), apiFetch("/users")]);
      const companies = Array.isArray(boot?.companies) ? boot.companies : [];
      setBootstrap({
        groups: Array.isArray(boot?.user_groups) ? boot.user_groups : [],
        roles: Array.isArray(boot?.roles) ? boot.roles : [],
        departments: Array.isArray(boot?.departments) ? boot.departments : [],
        distributors: Array.isArray(boot?.distributors) ? boot.distributors : [],
        managers: Array.isArray(boot?.managers) ? boot.managers : [],
        companies,
      });
      setUsers(Array.isArray(usersData?.users) ? usersData.users : []);
      setForm((prev) => {
        if (prev.company_ids?.length || prev.primary_company_id) return prev;
        const defaultCompany =
          companies.find((item) => String(item.company_code || "").toUpperCase() === "AT") || companies[0] || null;
        if (!defaultCompany) return prev;
        return {
          ...prev,
          company_ids: [String(defaultCompany.id)],
          primary_company_id: String(defaultCompany.id),
        };
      });
    } catch (e) {
      setError(e?.data?.error || "Failed to load onboarding data.");
    } finally {
      setLoading(false);
    }
  }

  const selectedDistributor = useMemo(
    () => bootstrap.distributors.find((item) => String(item.id) === String(form.distributor_id)) || null,
    [bootstrap.distributors, form.distributor_id]
  );

  const staffGroup = useMemo(
    () =>
      bootstrap.groups.find((item) => item.group_name === "Staff") ||
      bootstrap.groups.find((item) => item.group_name === "Absstem") ||
      null,
    [bootstrap.groups]
  );
  const distributorGroup = useMemo(
    () => bootstrap.groups.find((item) => item.group_name === "Distributor") || null,
    [bootstrap.groups]
  );
  const distributorRole = useMemo(
    () => bootstrap.roles.find((item) => item.role_name === "Distributor") || null,
    [bootstrap.roles]
  );

  const internalRoleOptions = useMemo(
    () => bootstrap.roles.filter((item) => !["SuperAdmin", "Distributor"].includes(item.role_name)),
    [bootstrap.roles]
  );
  const selectedInternalRole = useMemo(
    () => internalRoleOptions.find((item) => String(item.id) === String(form.role_id)) || null,
    [internalRoleOptions, form.role_id]
  );
  const selectedDepartment = useMemo(
    () => bootstrap.departments.find((item) => String(item.department_key) === String(form.department_key)) || null,
    [bootstrap.departments, form.department_key]
  );

  const internalManagerOptions = useMemo(
    () => users.filter((user) => user.group_name !== "Distributor" && user.email !== form.email),
    [users, form.email]
  );

  const distributorOrgHeadOptions = useMemo(() => {
    if (!form.distributor_id) return [];
    return users.filter(
      (user) =>
        user.group_name === "Distributor" &&
        String(user.distributor_id || "") === String(form.distributor_id) &&
        user.email !== form.email
    );
  }, [users, form.distributor_id, form.email]);

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const [profileSuggestion, setProfileSuggestion] = useState(null);
  useEffect(() => {
    if (mode !== "internal" || (!form.department_key && !String(form.designation || "").trim())) {
      setProfileSuggestion(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (form.department_key) params.set("department_key", form.department_key);
      if (String(form.designation || "").trim()) params.set("designation", String(form.designation).trim());
      if (form.primary_company_id) params.set("company_id", form.primary_company_id);
      // 404 while the Access Profiles flag is off; then there is simply no suggestion.
      apiFetch(`/permissions/access/baseline-rules/suggest?${params}`)
        .then((data) => {
          if (cancelled) return;
          const raw = data?.suggestion || null;
          const suggestion =
            raw && internalRoleOptions.some((item) => String(item.id) === String(raw.role_id)) ? raw : null;
          setProfileSuggestion(suggestion);
          if (suggestion) setForm((prev) => (prev.role_id ? prev : { ...prev, role_id: String(suggestion.role_id) }));
        })
        .catch(() => !cancelled && setProfileSuggestion(null));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, form.department_key, form.designation, form.primary_company_id, internalRoleOptions]);

  function resetWizard(nextMode = mode) {
    setMode(nextMode);
    setStep(1);
    setForm(emptyForm());
    setError("");
    setNotice("");
  }

  function applyMode(nextMode) {
    resetWizard(nextMode);
  }

  function validateIdentity() {
    if (mode === "distributor") {
      return Boolean(form.distributor_company_name.trim() && form.full_name.trim() && form.email.trim());
    }
    if (mode === "distributor_employee") {
      return Boolean(form.distributor_id && form.full_name.trim() && form.email.trim());
    }
    return Boolean(form.full_name.trim() && form.email.trim());
  }

  function validateHierarchy() {
    if (mode === "internal") {
      return Boolean(form.role_id && staffGroup?.id && form.company_ids?.length && form.primary_company_id);
    }
    if (mode === "distributor") {
      return Boolean(distributorGroup?.id && distributorRole?.id && form.primary_manager_user_id);
    }
    return Boolean(distributorGroup?.id && distributorRole?.id && form.distributor_org_head_user_id);
  }

  function requiredMessage(forStep) {
    if (forStep === 2) {
      if (mode === "distributor") return "Please fill: Distributor Company Name, Org Head Full Name, Org Head Email.";
      if (mode === "distributor_employee") return "Please fill: Distributor, Full Name, Email.";
      return "Please fill: Full Name and Email.";
    }
    if (forStep === 3) {
      if (mode === "internal") return "Please select: Role, Works For company, and Primary company.";
      if (mode === "distributor") return "Please select: Internal Reporting Head.";
      return "Please select: Distributor Org Head.";
    }
    return "Please complete the required fields for this step.";
  }

  function nextStep() {
    if (step === 1) {
      setError("");
      setStep(2);
      return;
    }
    if (step === 2 && !validateIdentity()) {
      setError(requiredMessage(2));
      return;
    }
    if (step === 3 && !validateHierarchy()) {
      setError(requiredMessage(3));
      return;
    }
    setError("");
    setStep((prev) => Math.min(4, prev + 1));
  }

  function previousStep() {
    setError("");
    setStep((prev) => Math.max(1, prev - 1));
  }

  async function submit() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      let distributorId = form.distributor_id ? Number(form.distributor_id) : null;

      if (mode === "distributor") {
        const createdDistributor = await apiFetch("/admin-masters/distributors", {
          method: "POST",
          body: JSON.stringify({
            distributor_code: form.distributor_code || null,
            company_name: form.distributor_company_name,
            contact_email: form.distributor_contact_email || form.email || null,
            contact_phone: form.distributor_contact_phone || form.phone || null,
            is_active: Boolean(form.is_active),
          }),
        });
        distributorId = createdDistributor?.distributor?.id || null;
      }

      const payload = {
        full_name: form.full_name,
        email: form.email,
        phone: form.phone,
        designation: form.designation,
        group_id: mode === "internal" ? staffGroup?.id || null : distributorGroup?.id || null,
        role_id: mode === "internal" ? Number(form.role_id) || null : distributorRole?.id || null,
        department_key: mode === "internal" ? form.department_key || null : null,
        company_name:
          mode === "distributor"
            ? form.distributor_company_name
            : mode === "distributor_employee"
              ? selectedDistributor?.company_name || ""
              : form.company_name,
        company_ids:
          mode === "internal"
            ? (Array.isArray(form.company_ids) ? form.company_ids : []).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
            : [],
        primary_company_id: mode === "internal" && form.primary_company_id ? Number(form.primary_company_id) : null,
        employment_company_id: mode === "internal" && form.primary_company_id ? Number(form.primary_company_id) : null,
        distributor_id: mode === "internal" ? null : distributorId,
        employee_code: form.employee_code,
        primary_manager_user_id:
          mode === "distributor_employee"
            ? Number(form.distributor_org_head_user_id) || null
            : form.primary_manager_user_id
              ? Number(form.primary_manager_user_id)
              : null,
        secondary_manager_user_id:
          mode === "distributor_employee"
            ? form.secondary_manager_user_id
              ? Number(form.secondary_manager_user_id)
              : null
            : form.secondary_manager_user_id
              ? Number(form.secondary_manager_user_id)
              : null,
        date_of_joining: form.date_of_joining || null,
        local_address: form.local_address,
        permanent_address: form.permanent_address,
        discount_threshold_pct: form.discount_threshold_pct === "" ? null : Number(form.discount_threshold_pct),
        is_active: Boolean(form.is_active),
        is_approved: true,
        password: form.password,
      };

      await apiFetch("/users", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      await refreshData();
      setNotice(
        mode === "distributor"
          ? "Distributor and org head created. Role rights and current document defaults apply automatically."
          : "User onboarding completed. Role rights and current document defaults apply automatically."
      );
      setStep(4);
      setForm(emptyForm());
    } catch (e) {
      const code = e?.data?.error;
      if (code === "DUPLICATE_USER") setError("A user with this email already exists.");
      else if (code === "DUPLICATE_DISTRIBUTOR") setError("This distributor already exists. Use Distributor Employee onboarding for additional team members.");
      else if (code === "COMPANY_NAME_REQUIRED") setError("Distributor company name is required.");
      else setError(code || "Failed to complete onboarding.");
    } finally {
      setSaving(false);
    }
  }

  const reviewRows = [
    { label: "Flow", value: MODE_META[mode].title },
    { label: "User", value: form.full_name || "—" },
    { label: "Email", value: form.email || "—" },
    { label: "Designation", value: form.designation || "—" },
    { label: "Access profile", value: mode === "internal" ? selectedInternalRole?.role_name || "—" : distributorRole?.role_name || "Distributor" },
    { label: "Department", value: mode === "internal" ? selectedDepartment?.department_name || "—" : "—" },
    {
      label: "Works For",
      value:
        mode === "internal"
          ? (form.company_ids || [])
              .map((id) => bootstrap.companies.find((c) => String(c.id) === String(id))?.company_name || id)
              .filter(Boolean)
              .join(", ") || "—"
          : mode === "distributor"
            ? form.distributor_company_name || "—"
            : selectedDistributor?.company_name || "—",
    },
    {
      label: "Primary company",
      value:
        mode === "internal"
          ? bootstrap.companies.find((c) => String(c.id) === String(form.primary_company_id))?.company_name || "—"
          : "—",
    },
    {
      label: "Business label",
      value:
        mode === "distributor"
          ? form.distributor_company_name || "—"
          : mode === "distributor_employee"
            ? selectedDistributor?.company_name || "—"
            : form.company_name || "absstem / selected business unit",
    },
    {
      label: "Reporting",
      value:
        mode === "distributor_employee"
          ? distributorOrgHeadOptions.find((item) => String(item.id) === String(form.distributor_org_head_user_id))?.full_name || "—"
          : internalManagerOptions.find((item) => String(item.id) === String(form.primary_manager_user_id))?.full_name || "—",
    },
  ];

  return (
    <div style={{ maxWidth: 1240, width: "100%" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ margin: 0 }}>Onboarding Wizard</h2>
          <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4 }}>
            Create internal employees, distributor org heads, and distributor team members through a guided setup instead of raw master entry.
          </div>
        </div>
        <button onClick={() => resetWizard()} disabled={saving}>
          Start Fresh
        </button>
        <button onClick={() => onOpenUserMaster?.()} disabled={saving}>
          Open User Master
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginBottom: 10 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginBottom: 10 }}>{notice}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        {STEPS.map((item) => {
          const active = item.id === step;
          const done = item.id < step;
          return (
            <div
              key={item.id}
              style={{
                border: active ? "1px solid #3c87d7" : "1px solid #e5e5e5",
                background: active ? "#f4f8ff" : "#fff",
                borderRadius: 14,
                padding: 14,
                opacity: done || active ? 1 : 0.78,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.72 }}>Step {item.id}</div>
              <div style={{ fontWeight: 800, marginTop: 4 }}>{item.title}</div>
              <div style={{ fontSize: 12, opacity: 0.68, marginTop: 4 }}>{item.note}</div>
            </div>
          );
        })}
      </div>

      {step === 1 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
          {Object.entries(MODE_META).map(([key, meta]) => {
            const active = key === mode;
            return (
              <button
                key={key}
                type="button"
                onClick={() => applyMode(key)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  border: active ? "1px solid #3c87d7" : "1px solid #e5e5e5",
                  background: active ? "#f4f8ff" : "#fff",
                  borderRadius: 16,
                  padding: 18,
                  boxShadow: active ? "0 10px 20px rgba(60, 135, 215, 0.08)" : "none",
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.72 }}>Onboarding Track</div>
                <div style={{ fontWeight: 800, fontSize: 18, marginTop: 6 }}>{meta.title}</div>
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.74, lineHeight: 1.6 }}>{meta.detail}</div>
              </button>
            );
          })}
        </div>
      ) : null}

      {step === 2 ? (
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 14, padding: 16 }}>
          {mode === "distributor" ? (
            <>
              <div style={{ fontWeight: 800, marginBottom: 12 }}>Distributor Business + Org Head</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
                <div>
                  <Field label="Distributor Company Name">
                    <input value={form.distributor_company_name} onChange={(e) => setField("distributor_company_name", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Distributor Code">
                    <input value={form.distributor_code} onChange={(e) => setField("distributor_code", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Company Email">
                    <input value={form.distributor_contact_email} onChange={(e) => setField("distributor_contact_email", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Company Phone">
                    <input value={form.distributor_contact_phone} onChange={(e) => setField("distributor_contact_phone", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                </div>
                <div>
                  <Field label="Org Head Full Name">
                    <input value={form.full_name} onChange={(e) => setField("full_name", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Org Head Email">
                    <input value={form.email} onChange={(e) => setField("email", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Org Head Phone">
                    <input value={form.phone} onChange={(e) => setField("phone", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Designation">
                    <input value={form.designation} onChange={(e) => setField("designation", e.target.value)} placeholder="Distributor Head / Director / Owner" style={{ width: "100%" }} />
                  </Field>
                </div>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 800, marginBottom: 12 }}>
                {mode === "internal" ? "Employee Identity" : "Distributor Employee Identity"}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
                <div>
                  {mode === "distributor_employee" ? (
                    <Field label="Distributor">
                      <select value={form.distributor_id} onChange={(e) => setField("distributor_id", e.target.value)} style={{ width: "100%" }}>
                        <option value="">-- Select distributor --</option>
                        {bootstrap.distributors.map((item) => (
                          <option key={item.id} value={String(item.id)}>
                            {item.company_name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : (
                    <Field label="Company / Business Unit" help="For internal staff, this can stay as business unit or department name.">
                      <input value={form.company_name} onChange={(e) => setField("company_name", e.target.value)} style={{ width: "100%" }} />
                    </Field>
                  )}
                  <Field label="Full Name">
                    <input value={form.full_name} onChange={(e) => setField("full_name", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Email">
                    <input value={form.email} onChange={(e) => setField("email", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Phone">
                    <input value={form.phone} onChange={(e) => setField("phone", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                </div>
                <div>
                  {mode === "internal" ? (
                    <Field label="Department">
                      <select value={form.department_key} onChange={(e) => setField("department_key", e.target.value)} style={{ width: "100%" }}>
                        <option value="">-- Select department --</option>
                        {bootstrap.departments.map((item) => (
                          <option key={item.department_key} value={String(item.department_key)}>
                            {item.department_name}
                            {item.default_workspace_family ? ` (${item.default_workspace_family})` : ""}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : null}
                  <Field label="Designation">
                    <input value={form.designation} onChange={(e) => setField("designation", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Employee Code">
                    <input value={form.employee_code} onChange={(e) => setField("employee_code", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Date of Joining">
                    <input type="date" value={form.date_of_joining} onChange={(e) => setField("date_of_joining", e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Discount Threshold %">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={form.discount_threshold_pct}
                      onChange={(e) => setField("discount_threshold_pct", e.target.value)}
                      style={{ width: "100%" }}
                    />
                  </Field>
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}

      {step === 3 ? (
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 14, padding: 16 }}>
          <div style={{ fontWeight: 800, marginBottom: 12 }}>Hierarchy, Access, and Login</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
            {mode === "internal" ? (
              <Field
                label="Access profile"
                help={
                  profileSuggestion
                    ? String(form.role_id) === String(profileSuggestion.role_id)
                      ? `Suggested by org rules for this department and designation.`
                      : `Org rules suggest ${profileSuggestion.role_name}.`
                    : undefined
                }
              >
                <select value={form.role_id} onChange={(e) => setField("role_id", e.target.value)} style={{ width: "100%" }}>
                  <option value="">-- Select access profile --</option>
                  {internalRoleOptions.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      {item.role_name}
                      {item.default_workspace_family ? ` (${item.default_workspace_family})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            {mode === "internal" ? (
              <Field
                label="Works For (companies)"
                help={`Assigned to ${staffGroup?.group_name || "Staff/Absstem"} group. Pick at least one operating company.`}
              >
                <div style={{ display: "grid", gap: 8, border: "1px solid #e5e5e5", borderRadius: 10, padding: 10 }}>
                  {bootstrap.companies.length ? (
                    bootstrap.companies.map((company) => {
                      const checked = (form.company_ids || []).some((id) => String(id) === String(company.id));
                      return (
                        <label key={company.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const nextIds = e.target.checked
                                ? Array.from(new Set([...(form.company_ids || []), String(company.id)]))
                                : (form.company_ids || []).filter((id) => String(id) !== String(company.id));
                              setForm((prev) => ({
                                ...prev,
                                company_ids: nextIds,
                                primary_company_id:
                                  prev.primary_company_id && nextIds.includes(String(prev.primary_company_id))
                                    ? prev.primary_company_id
                                    : nextIds[0] || "",
                              }));
                            }}
                          />
                          <span>
                            {company.company_code ? `${company.company_code} — ` : ""}
                            {company.company_name}
                          </span>
                        </label>
                      );
                    })
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.68 }}>No active companies found. Create one in Admin Masters first.</div>
                  )}
                </div>
              </Field>
            ) : null}

            {mode === "internal" ? (
              <Field label="Primary company">
                <select
                  value={form.primary_company_id}
                  onChange={(e) => setField("primary_company_id", e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="">-- Select primary --</option>
                  {(form.company_ids || []).map((id) => {
                    const company = bootstrap.companies.find((c) => String(c.id) === String(id));
                    return (
                      <option key={id} value={String(id)}>
                        {company ? `${company.company_code || ""} ${company.company_name}`.trim() : id}
                      </option>
                    );
                  })}
                </select>
              </Field>
            ) : null}

            {mode === "distributor_employee" ? (
              <Field label="Distributor Org Head" help="This becomes the direct reporting manager for the distributor employee.">
                <select value={form.distributor_org_head_user_id} onChange={(e) => setField("distributor_org_head_user_id", e.target.value)} style={{ width: "100%" }}>
                  <option value="">-- Select org head --</option>
                  {distributorOrgHeadOptions.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      {(item.full_name || item.email) + (item.user_code ? ` (${item.user_code})` : "")}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field
                label={mode === "distributor" ? "Internal Reporting Head" : "Primary Manager"}
                help={mode === "distributor" ? "Distributor org head reports internally here." : undefined}
              >
                <select value={form.primary_manager_user_id} onChange={(e) => setField("primary_manager_user_id", e.target.value)} style={{ width: "100%" }}>
                  <option value="">-- Select manager --</option>
                  {internalManagerOptions.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      {(item.full_name || item.email) + (item.user_code ? ` (${item.user_code})` : "")}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label={mode === "distributor_employee" ? "Secondary Internal Manager" : "Secondary Manager"}>
              <select value={form.secondary_manager_user_id} onChange={(e) => setField("secondary_manager_user_id", e.target.value)} style={{ width: "100%" }}>
                <option value="">-- Optional --</option>
                {internalManagerOptions.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {(item.full_name || item.email) + (item.user_code ? ` (${item.user_code})` : "")}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Initial Password" help="Only needed for local-login users. Google users can keep this blank.">
              <input type="password" value={form.password} onChange={(e) => setField("password", e.target.value)} style={{ width: "100%" }} />
            </Field>

            <Field label="Local Address">
              <textarea rows={3} value={form.local_address} onChange={(e) => setField("local_address", e.target.value)} style={{ width: "100%" }} />
            </Field>

            <Field label="Permanent Address">
              <textarea rows={3} value={form.permanent_address} onChange={(e) => setField("permanent_address", e.target.value)} style={{ width: "100%" }} />
            </Field>
          </div>

          <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setField("is_active", e.target.checked)} />
              Active user on create
            </label>
            <div style={{ fontSize: 12, opacity: 0.68 }}>
              Rights will come from selected role. Document templates continue to follow current shared setup.
            </div>
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(280px, 0.9fr)", gap: 16 }}>
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 14, padding: 16 }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Review Before Create</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {reviewRows.map((row) => (
                <div key={row.label} style={{ border: "1px solid #edf1f8", borderRadius: 12, padding: 12, background: "#fafcff" }}>
                  <div style={{ fontSize: 12, opacity: 0.68 }}>{row.label}</div>
                  <div style={{ fontWeight: 700, marginTop: 4 }}>{row.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ border: "1px solid #e5e5e5", borderRadius: 14, padding: 16, background: "#fcfdff" }}>
            <div style={{ fontWeight: 800 }}>Defaults Applied</div>
            <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.7, opacity: 0.76 }}>
              <div>Role rights inherit from the selected role and existing rights matrix.</div>
              <div>Workspace family resolves from Role first, then Department, then the app fallback classifier.</div>
              <div>Commercial threshold inherits from your value or the group fallback.</div>
              <div>Document/template behaviour continues to follow current shared template setup.</div>
              <div>Distributor flows create or link the company first, then create the user with the correct channel-partner association.</div>
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, opacity: 0.68, paddingTop: 10 }}>
          {loading ? "Loading onboarding data..." : MODE_META[mode].detail}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={previousStep} disabled={step === 1 || saving}>
            Back
          </button>
          {step < 4 ? (
            <button type="button" onClick={nextStep} disabled={saving}>
              Next
            </button>
          ) : (
            <button type="button" onClick={submit} disabled={saving || !validateIdentity() || !validateHierarchy()}>
              {saving ? "Creating..." : "Create From Wizard"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
