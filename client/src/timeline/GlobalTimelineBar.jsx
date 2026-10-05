import React, { useState } from "react";
import { TIMELINE_PRESETS, presetOptions } from "./globalTimeline";
import { useGlobalTimeline } from "./GlobalTimelineContext";
import "./timeline.css";

export default function GlobalTimelineBar({ compact = true }) {
  const timeline = useGlobalTimeline();
  const [draftFrom, setDraftFrom] = useState(timeline.custom_from || timeline.date_from);
  const [draftTo, setDraftTo] = useState(timeline.custom_to || timeline.date_to);
  const options = presetOptions(timeline.asOf || new Date());

  return (
    <div className={`josh-timeline-bar ${compact ? "josh-timeline-bar-compact" : ""}`} title={timeline.hint || "Global timeline filter"}>
      <label className="josh-timeline-field">
        <span className="josh-timeline-label">Timeline</span>
        <select
          className="shell-input josh-timeline-select"
          value={timeline.preset}
          onChange={(e) => {
            const next = e.target.value;
            timeline.setPreset(next);
            if (next === TIMELINE_PRESETS.CUSTOM) {
              setDraftFrom(timeline.date_from);
              setDraftTo(timeline.date_to);
            }
          }}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {timeline.preset === TIMELINE_PRESETS.CUSTOM ? (
        <div className="josh-timeline-custom">
          <input
            type="date"
            className="shell-input josh-timeline-date"
            value={draftFrom || ""}
            onChange={(e) => setDraftFrom(e.target.value)}
          />
          <span className="josh-timeline-sep">→</span>
          <input
            type="date"
            className="shell-input josh-timeline-date"
            value={draftTo || ""}
            onChange={(e) => setDraftTo(e.target.value)}
          />
          <button
            type="button"
            className="button-ghost compact-button"
            onClick={() => timeline.setCustomRange(draftFrom, draftTo)}
          >
            Apply
          </button>
        </div>
      ) : (
        <div className="josh-timeline-chip" aria-live="polite">
          <span className="josh-timeline-chip-range">{timeline.range_label || `${timeline.date_from} → ${timeline.date_to}`}</span>
          <span className="josh-timeline-chip-hint">{timeline.label}</span>
        </div>
      )}
    </div>
  );
}
