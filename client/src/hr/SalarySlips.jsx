import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function money(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function slipTone(status) {
  if (status === "paid") return { tone: "#effcf3", color: "#0b7d45" };
  return { tone: "#eef4ff", color: "#234a8f" };
}

export default function SalarySlips() {
  const [slips, setSlips] = useState([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [monthFilter, setMonthFilter] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch("/hr/salary-slips");
        if (!active) return;
        setSlips(Array.isArray(data?.slips) ? data.slips : []);
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load salary slips right now."));
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  const visibleSlips = useMemo(() => {
    if (!monthFilter) return slips;
    return slips.filter((item) => String(item.payroll_month || "").slice(0, 7) === monthFilter);
  }, [monthFilter, slips]);

  const stats = useMemo(() => {
    const pending = slips.filter((item) => item.status !== "paid").length;
    const paid = slips.filter((item) => item.status === "paid").length;
    const payout = slips.reduce((sum, item) => sum + Number(item.net_salary || 0), 0);
    return [
      { label: "Generated slips", value: String(slips.length), tone: "#234a8f" },
      { label: "Pending payout", value: String(pending), tone: "#8b5a00" },
      { label: "Paid slips", value: String(paid), tone: "#0b7d45" },
      { label: "Payroll value", value: `INR ${money(payout)}`, tone: "#9f2042" },
    ];
  }, [slips]);

  async function markPaid(id, employee) {
    try {
      const data = await apiFetch(`/hr/salary-slips/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "paid" }),
      });
      setSlips((current) => current.map((item) => (item.id === id ? data.slip : item)));
      setNotice(`Salary marked paid for ${employee}.`);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not mark salary paid right now."));
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Payroll Output"
        title="Salary Slips"
        description="Review generated salary slips, filter them by payroll month, and mark paid slips so payroll closure stays visible."
        stats={stats}
      />

      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gap: 16 }}>
        <DeskCard title="Salary Slip Filter" subtitle="Review slips month by month">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input type="month" value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} />
            <button type="button" onClick={() => setMonthFilter("")}>Clear Filter</button>
          </div>
        </DeskCard>

        <DeskCard title="Salary Slip Queue" subtitle="Generated and paid payroll slips">
          <div style={{ display: "grid", gap: 12 }}>
            {loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading salary slips...</div> : null}
            {visibleSlips.map((item) => {
              const tone = slipTone(item.status);
              return (
                <div key={item.id} style={{ border: "1px solid #e6ebf2", borderRadius: 18, padding: 14, background: "#fff", display: "grid", gap: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{item.employee}</div>
                      <div style={{ marginTop: 4, fontSize: 13, opacity: 0.72 }}>
                        {[String(item.payroll_month || "").slice(0, 7), item.paid_on ? `Paid ${String(item.paid_on).slice(0, 10)}` : "Awaiting payout"].join(" • ")}
                      </div>
                    </div>
                    <DeskChip label={item.status} tone={tone.tone} color={tone.color} />
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    {`Basic ${money(item.basic_amount)} • HRA ${money(item.hra_amount)} • Special ${money(item.special_allowance)} • Deductions ${money(item.deductions_amount)} • Net ${money(item.net_salary)}`}
                  </div>
                  {item.status !== "paid" ? (
                    <div>
                      <button type="button" onClick={() => markPaid(item.id, item.employee)}>Mark Paid</button>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {!loading && !visibleSlips.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No salary slips found.</div> : null}
          </div>
        </DeskCard>
      </div>
    </div>
  );
}
