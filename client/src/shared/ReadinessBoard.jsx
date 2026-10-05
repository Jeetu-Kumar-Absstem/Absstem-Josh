export default function ReadinessBoard({ sections = [], className = "" }) {
  const visibleSections = Array.isArray(sections) ? sections.filter((section) => section && (section.items?.length || section.title)) : [];

  if (!visibleSections.length) return null;

  return (
    <div className={`readiness-board ${className}`.trim()}>
      {visibleSections.map((section) => (
        <section key={section.title} className="surface-card readiness-panel">
          <div className="readiness-panel-head">
            <div>
              {section.eyebrow ? <div className="panel-kicker">{section.eyebrow}</div> : null}
              <h3>{section.title}</h3>
              {section.description ? <p>{section.description}</p> : null}
            </div>
          </div>
          {section.items?.length ? (
            <div className="readiness-card-list">
              {section.items.map((item) => (
                <article key={`${section.title}-${item.title}`} className="readiness-card" data-tone={item.tone || "neutral"}>
                  <div className="readiness-card-head">
                    {item.badge ? <span className="readiness-card-badge">{item.badge}</span> : <span className="readiness-card-badge">{section.eyebrow}</span>}
                    {item.value ? <strong>{item.value}</strong> : null}
                  </div>
                  <h4>{item.title}</h4>
                  {item.note ? <p>{item.note}</p> : null}
                  {item.actionLabel ? (
                    <button type="button" className="button-ghost compact-button readiness-card-action" onClick={item.onClick}>
                      {item.actionLabel}
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="readiness-empty-state">{section.emptyMessage}</div>
          )}
        </section>
      ))}
    </div>
  );
}
