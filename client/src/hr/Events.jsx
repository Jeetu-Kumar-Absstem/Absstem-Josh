import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskStat, NoticeBanner, PageHero, getDeskStatusAppearance } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function statusTone(status) {
  return getDeskStatusAppearance(status, {
    success: ["published"],
    info: ["open", "filling"],
    warning: ["pending"],
    fallbackTone: "#f5f7fb",
  });
}

export default function Events() {
  const [events, setEvents] = useState([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    title: "",
    type: "Company event",
    date: "",
    venue: "",
  });

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch("/hr/events");
        if (!active) return;
        setEvents(Array.isArray(data?.events) ? data.events : []);
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load events right now."));
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
    const open = events.filter((item) => item.status === "registration_open" || item.status === "slots_filling").length;
    const itinerary = events.filter((item) => item.status === "itinerary_pending").length;
    const published = events.filter((item) => item.status === "published").length;
    const headcount = events.reduce((sum, item) => sum + Number(item.participants || 0), 0);
    return { open, itinerary, published, headcount };
  }, [events]);

  async function createEvent() {
    if (!form.title.trim() || !form.date.trim() || !form.venue.trim()) {
      setNotice("Fill title, date, and venue before creating an event.");
      return;
    }
    try {
      const data = await apiFetch("/hr/events", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setEvents((current) => [data.event, ...current]);
      setForm({ title: "", type: "Company event", date: "", venue: "" });
      setNotice("Event created and opened for registration.");
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not create the event right now."));
    }
  }

  async function updateEvent(id, status, message, participantDelta = 0, note = null) {
    try {
      const data = await apiFetch(`/hr/events/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, participant_delta: participantDelta, note }),
      });
      setEvents((current) => current.map((item) => (item.id === id ? data.event : item)));
      setNotice(message);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not update the event right now."));
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Company Calendar"
        title="Events"
        description="Manage company events, training sessions, tournament-style activities, and outstation itinerary publication from one guided workspace."
        stats={[
          { label: "Registration open", value: String(stats.open), tone: "#234a8f" },
          { label: "Itinerary pending", value: String(stats.itinerary), tone: "#8b5a00" },
          { label: "Published", value: String(stats.published), tone: "#147a3d" },
          { label: "Planned headcount", value: String(stats.headcount), tone: "#9f2042" },
        ]}
      />

      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(300px, 0.32fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Create Event" subtitle="Open a company event, training day, or team activity">
          <div style={{ display: "grid", gap: 10 }}>
            <input value={form.title} onChange={(e) => setForm((current) => ({ ...current, title: e.target.value }))} placeholder="Event title" />
            <select value={form.type} onChange={(e) => setForm((current) => ({ ...current, type: e.target.value }))}>
              <option value="Company event">Company event</option>
              <option value="Training">Training</option>
              <option value="Tournament">Tournament</option>
              <option value="Celebration">Celebration</option>
              <option value="Outstation event">Outstation event</option>
            </select>
            <input type="date" value={form.date} onChange={(e) => setForm((current) => ({ ...current, date: e.target.value }))} />
            <input value={form.venue} onChange={(e) => setForm((current) => ({ ...current, venue: e.target.value }))} placeholder="Venue" />
            <button type="button" onClick={createEvent}>Create Event</button>
          </div>
        </DeskCard>

        <DeskCard title="Events Queue" subtitle="Registration, itinerary, and broadcast actions stay visible here">
          <div style={{ display: "grid", gap: 12 }}>
            {loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading events...</div> : null}
            {events.map((item) => {
              const tone = statusTone(item.status);
              return (
                <div
                  key={item.id}
                  style={{
                    border: "1px solid #e6ebf2",
                    borderRadius: 18,
                    padding: 14,
                    background: "#ffffff",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{item.title}</div>
                      <div style={{ marginTop: 4, fontSize: 13, opacity: 0.72 }}>
                        {[item.type, item.date, item.venue, `${item.participants} participants`].filter(Boolean).join(" • ")}
                      </div>
                    </div>
                    <DeskChip label={item.status.replace(/_/g, " ")} tone={tone.tone} color={tone.color} />
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>{item.note}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {item.status === "registration_open" || item.status === "slots_filling" ? (
                      <button
                        type="button"
                        onClick={() =>
                          updateEvent(
                            item.id,
                            "published",
                            `Broadcast reminder published for ${item.title}.`,
                            0,
                            "Broadcast sent to participants"
                          )
                        }
                      >
                        Broadcast
                      </button>
                    ) : null}
                    {item.status === "itinerary_pending" ? (
                      <button
                        type="button"
                        onClick={() =>
                          updateEvent(
                            item.id,
                            "published",
                            `Itinerary published for ${item.title}.`,
                            0,
                            "Itinerary published with hotel and contact details"
                          )
                        }
                      >
                        Publish Itinerary
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        updateEvent(
                          item.id,
                          item.status === "registration_open" ? "slots_filling" : item.status,
                          `Participant added to ${item.title}.`,
                          1
                        )
                      }
                    >
                      Add Participant
                    </button>
                  </div>
                </div>
              );
            })}
            {!loading && !events.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No events yet.</div> : null}
          </div>
        </DeskCard>
      </div>
    </div>
  );
}
