import { useEffect, useMemo, useState } from "react";
import { DeskCard, NoticeBanner, PageHero } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

export default function Holidays() {
  const [holidays, setHolidays] = useState([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    holiday_name: "",
    holiday_date: "",
    holiday_type: "Company holiday",
    note: "",
  });

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch("/hr/holidays");
        if (!active) return;
        setHolidays(Array.isArray(data?.holidays) ? data.holidays : []);
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load holidays right now."));
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  const stats = useMemo(
    () => [
      { label: "Holiday count", value: String(holidays.length), tone: "#234a8f" },
      { label: "Calendar mode", value: "Company", tone: "#0b7d45" },
      { label: "Use", value: "Leave planning", tone: "#8b5a00" },
    ],
    [holidays.length]
  );

  async function saveHoliday() {
    if (!form.holiday_name.trim() || !form.holiday_date) {
      setNotice("Fill holiday name and date before saving.");
      return;
    }
    try {
      const data = await apiFetch("/hr/holidays", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setHolidays((current) => {
        const others = current.filter((item) => item.id !== data.holiday.id);
        return [...others, data.holiday].sort((a, b) => String(a.holiday_date).localeCompare(String(b.holiday_date)));
      });
      setForm({ holiday_name: "", holiday_date: "", holiday_type: "Company holiday", note: "" });
      setNotice("Holiday saved.");
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not save holiday right now."));
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Holiday Calendar"
        title="Holidays"
        description="Maintain the company holiday calendar so leave, attendance planning, and HR communication stay aligned."
        stats={stats}
      />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(300px, 0.34fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Add Holiday" subtitle="National, festival, plant shutdown, or company holiday">
          <div style={{ display: "grid", gap: 10 }}>
            <input value={form.holiday_name} onChange={(e) => setForm((current) => ({ ...current, holiday_name: e.target.value }))} placeholder="Holiday name" />
            <input type="date" value={form.holiday_date} onChange={(e) => setForm((current) => ({ ...current, holiday_date: e.target.value }))} />
            <select value={form.holiday_type} onChange={(e) => setForm((current) => ({ ...current, holiday_type: e.target.value }))}>
              <option value="Company holiday">Company holiday</option>
              <option value="Festival">Festival</option>
              <option value="National">National</option>
              <option value="Shutdown">Shutdown</option>
            </select>
            <textarea rows={4} value={form.note} onChange={(e) => setForm((current) => ({ ...current, note: e.target.value }))} placeholder="Optional note" />
            <button type="button" onClick={saveHoliday}>Save Holiday</button>
          </div>
        </DeskCard>

        <DeskCard title="Holiday Calendar" subtitle="Visible calendar list for HR operations">
          <div style={{ display: "grid", gap: 12 }}>
            {loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading holidays...</div> : null}
            {holidays.map((item) => (
              <div key={item.id} style={{ border: "1px solid #e6ebf2", borderRadius: 16, padding: 12, background: "#fff" }}>
                <div style={{ fontWeight: 800 }}>{item.holiday_name}</div>
                <div style={{ marginTop: 4, fontSize: 13, opacity: 0.72 }}>
                  {[item.holiday_date?.slice?.(0, 10) || item.holiday_date, item.holiday_type].filter(Boolean).join(" • ")}
                </div>
                {item.note ? <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>{item.note}</div> : null}
              </div>
            ))}
            {!loading && !holidays.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No holidays added yet.</div> : null}
          </div>
        </DeskCard>
      </div>
    </div>
  );
}
