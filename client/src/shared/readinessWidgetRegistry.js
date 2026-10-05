const READINESS_TONE_PRIORITY = {
  danger: 0,
  warning: 1,
  neutral: 2,
  success: 3,
};

export function severityToReadinessTone(severity) {
  if (severity === "high") return "danger";
  if (severity === "medium") return "warning";
  if (severity === "success") return "success";
  return "neutral";
}

export function sortReadinessItems(items = []) {
  return [...items].sort((left, right) => {
    const leftPriority = READINESS_TONE_PRIORITY[left?.tone] ?? READINESS_TONE_PRIORITY.neutral;
    const rightPriority = READINESS_TONE_PRIORITY[right?.tone] ?? READINESS_TONE_PRIORITY.neutral;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return String(left?.title || "").localeCompare(String(right?.title || ""));
  });
}

export function pickReadinessItems(items = [], limit = null) {
  const sorted = sortReadinessItems(items.filter(Boolean));
  if (limit == null || !Number.isFinite(Number(limit)) || Number(limit) <= 0) return sorted;
  return sorted.slice(0, Number(limit));
}

/** Keep every danger item; optionally cap warnings/neutral for secondary rails. */
export function pickDangerFirstReadinessItems(items = [], { warningLimit = null } = {}) {
  const sorted = sortReadinessItems(items.filter(Boolean));
  const dangers = sorted.filter((item) => item?.tone === "danger");
  const warnings = sorted.filter((item) => item?.tone === "warning");
  const rest = sorted.filter((item) => item?.tone !== "danger" && item?.tone !== "warning");
  const cappedWarnings =
    warningLimit == null || !Number.isFinite(Number(warningLimit)) || Number(warningLimit) <= 0
      ? warnings
      : warnings.slice(0, Number(warningLimit));
  return [...dangers, ...cappedWarnings, ...rest];
}

export function buildReadinessSection({
  eyebrow,
  title,
  description,
  items = [],
  emptyMessage = "Everything in this block is currently under control.",
} = {}) {
  return {
    eyebrow,
    title,
    description,
    items: Array.isArray(items) ? items.filter(Boolean) : [],
    emptyMessage,
  };
}
