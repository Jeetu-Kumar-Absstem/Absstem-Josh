function fmtWhen(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export default function OrderFlightLog({ events = [], loading = false }) {
  if (loading) return <div style={{ fontSize: 13, opacity: 0.72 }}>Loading flight log…</div>;
  const rows = Array.isArray(events) ? events : [];
  if (!rows.length) {
    return <div style={{ fontSize: 13, opacity: 0.72 }}>No lifecycle events recorded yet.</div>;
  }

  return (
    <div style={{ display: "grid", gap: 0, position: "relative", paddingLeft: 14 }}>
      <div
        style={{
          position: "absolute",
          left: 5,
          top: 6,
          bottom: 6,
          width: 2,
          background: "#e2e8f0",
          borderRadius: 2,
        }}
      />
      {rows.map((event, index) => (
        <div
          key={`${event.at}-${event.kind}-${event.entity_id || index}`}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gap: 4,
            padding: "10px 0 14px 16px",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: -12,
              top: 14,
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#ffffff",
              border: "2px solid #64748b",
            }}
          />
          <div style={{ fontSize: 11, opacity: 0.62 }}>{fmtWhen(event.at)}</div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{event.label || event.kind || "Event"}</div>
          {event.detail ? <div style={{ fontSize: 13, opacity: 0.78, lineHeight: 1.5 }}>{event.detail}</div> : null}
          {event.page ? (
            <div style={{ fontSize: 11, opacity: 0.55, letterSpacing: "0.06em", textTransform: "uppercase" }}>{event.page}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
