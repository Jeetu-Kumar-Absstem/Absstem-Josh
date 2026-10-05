import { useEffect, useMemo, useState } from "react";
import { DeskCard, NoticeBanner, PageHero } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function money(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

export default function Salary() {
  const [profiles, setProfiles] = useState([]);
  const [generatedCount, setGeneratedCount] = useState(0);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [payrollMonth, setPayrollMonth] = useState(new Date().toISOString().slice(0, 7));
  const [form, setForm] = useState({
    employee: "",
    department: "HR",
    monthly_ctc: "",
    basic_amount: "",
    hra_amount: "",
    special_allowance: "",
    deductions_amount: "",
    net_salary: "",
  });

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch("/hr/salary");
        if (!active) return;
        setProfiles(Array.isArray(data?.profiles) ? data.profiles : []);
        setGeneratedCount(Number(data?.generated_count || 0));
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load salary setup right now."));
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  const stats = useMemo(() => {
    const activeProfiles = profiles.filter((item) => item.is_active !== false).length;
    const payrollBase = profiles.reduce((sum, item) => sum + Number(item.net_salary || 0), 0);
    return [
      { label: "Salary profiles", value: String(activeProfiles), tone: "#234a8f" },
      { label: "Payroll base", value: `INR ${money(payrollBase)}`, tone: "#8b5a00" },
      { label: "Generated slips", value: String(generatedCount), tone: "#0b7d45" },
    ];
  }, [generatedCount, profiles]);

  async function saveProfile() {
    if (!form.employee.trim() || !form.monthly_ctc) {
      setNotice("Fill employee and monthly CTC before saving salary.");
      return;
    }
    try {
      const data = await apiFetch("/hr/salary", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setProfiles((current) => [data.profile, ...current]);
      setForm({
        employee: "",
        department: "HR",
        monthly_ctc: "",
        basic_amount: "",
        hra_amount: "",
        special_allowance: "",
        deductions_amount: "",
        net_salary: "",
      });
      setNotice("Salary profile saved.");
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not save salary profile right now."));
    }
  }

  async function runPayroll() {
    if (!payrollMonth) {
      setNotice("Select payroll month before running salary.");
      return;
    }
    try {
      await apiFetch("/hr/salary/run", {
        method: "POST",
        body: JSON.stringify({ payroll_month: `${payrollMonth}-01` }),
      });
      const refresh = await apiFetch("/hr/salary");
      setProfiles(Array.isArray(refresh?.profiles) ? refresh.profiles : []);
      setGeneratedCount(Number(refresh?.generated_count || 0));
      setNotice(`Payroll generated for ${payrollMonth}.`);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not run payroll right now."));
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Payroll Setup"
        title="Salary"
        description="Maintain employee salary profiles and trigger payroll generation so salary slips can be created from an operational HR surface."
        stats={stats}
      />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(320px, 0.35fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Salary Profile" subtitle="Employee salary breakup and payroll-ready setup">
          <div style={{ display: "grid", gap: 10 }}>
            <input value={form.employee} onChange={(e) => setForm((current) => ({ ...current, employee: e.target.value }))} placeholder="Employee name" />
            <select value={form.department} onChange={(e) => setForm((current) => ({ ...current, department: e.target.value }))}>
              <option value="HR">HR</option>
              <option value="Sales">Sales</option>
              <option value="Service">Service</option>
              <option value="Accounts">Accounts</option>
              <option value="Manufacturing">Manufacturing</option>
            </select>
            <input value={form.monthly_ctc} onChange={(e) => setForm((current) => ({ ...current, monthly_ctc: e.target.value }))} placeholder="Monthly CTC" />
            <input value={form.basic_amount} onChange={(e) => setForm((current) => ({ ...current, basic_amount: e.target.value }))} placeholder="Basic" />
            <input value={form.hra_amount} onChange={(e) => setForm((current) => ({ ...current, hra_amount: e.target.value }))} placeholder="HRA" />
            <input value={form.special_allowance} onChange={(e) => setForm((current) => ({ ...current, special_allowance: e.target.value }))} placeholder="Special allowance" />
            <input value={form.deductions_amount} onChange={(e) => setForm((current) => ({ ...current, deductions_amount: e.target.value }))} placeholder="Deductions" />
            <input value={form.net_salary} onChange={(e) => setForm((current) => ({ ...current, net_salary: e.target.value }))} placeholder="Net salary (optional auto-calc fallback)" />
            <button type="button" onClick={saveProfile}>Save Salary Profile</button>
          </div>

          <div style={{ marginTop: 16, borderTop: "1px solid #eef1f6", paddingTop: 14, display: "grid", gap: 10 }}>
            <div style={{ fontWeight: 800 }}>Run Payroll</div>
            <input type="month" value={payrollMonth} onChange={(e) => setPayrollMonth(e.target.value)} />
            <button type="button" onClick={runPayroll}>Generate Salary Slips</button>
          </div>
        </DeskCard>

        <DeskCard title="Salary Profiles" subtitle="Payroll-ready employee setup">
          <div style={{ display: "grid", gap: 12 }}>
            {loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading salary profiles...</div> : null}
            {profiles.map((item) => (
              <div key={item.id} style={{ border: "1px solid #e6ebf2", borderRadius: 18, padding: 14, background: "#fff", display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 800 }}>{item.employee}</div>
                <div style={{ fontSize: 13, opacity: 0.72 }}>
                  {[item.department, `CTC INR ${money(item.monthly_ctc)}`, item.is_active === false ? "Inactive" : "Active"].join(" • ")}
                </div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {`Basic ${money(item.basic_amount)} • HRA ${money(item.hra_amount)} • Special ${money(item.special_allowance)} • Deductions ${money(item.deductions_amount)} • Net ${money(item.net_salary)}`}
                </div>
              </div>
            ))}
            {!loading && !profiles.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No salary profiles yet.</div> : null}
          </div>
        </DeskCard>
      </div>
    </div>
  );
}
