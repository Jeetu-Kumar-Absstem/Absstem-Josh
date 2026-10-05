import { useEffect, useMemo, useState } from "react";
import {
  DeskActionRails,
  DeskPilotBanner,
  HeaderChip,
  NoticeBanner,
  PageHero,
  saveLastDeskFix,
} from "../shared/joshUi";

async function apiFetch(path, options = {}) {
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  const { headers: optHeaders, ...rest } = options;
  const res = await fetch(path, {
    credentials: "include",
    ...rest,
    headers: isForm ? optHeaders : { "Content-Type": "application/json", ...(optHeaders || {}) },
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

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatDate(value) {
  if (!value) return "No due date";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function requestTypeLabel(value) {
  if (value === "client_datasheet") return "Client Datasheet";
  if (value === "npd") return "NPD";
  if (value === "drawing") return "Drawing";
  if (value === "technical_data") return "Technical Data";
  if (value === "bom_release") return "BOM Release";
  return String(value || "Request");
}

function requestStatusLabel(value) {
  if (value === "in_review") return "In Review";
  if (value === "waiting_input") return "Waiting Input";
  if (value === "ready") return "Ready";
  if (value === "closed") return "Closed";
  if (value === "cancelled") return "Cancelled";
  return "New";
}

function sourceDeskLabel(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "sales") return "Sales Intake";
  if (raw === "engineering") return "Engineering";
  if (raw === "manufacturing") return "Manufacturing";
  if (raw === "quality") return "Quality";
  if (raw === "service") return "Service";
  if (raw === "purchase") return "Purchase";
  if (raw === "admin") return "Admin";
  return "Other";
}

function requestTone(type) {
  if (type === "client_datasheet") return { background: "rgba(31, 94, 255, 0.1)", color: "#1f5eff", border: "#c7d7ff" };
  if (type === "npd") return { background: "rgba(20, 128, 74, 0.1)", color: "#14804a", border: "#c8efd6" };
  if (type === "drawing") return { background: "rgba(217, 119, 6, 0.12)", color: "#b45309", border: "#f2dfb0" };
  if (type === "technical_data") return { background: "rgba(124, 58, 237, 0.1)", color: "#7c3aed", border: "#e6ddff" };
  if (type === "bom_release") return { background: "rgba(35, 74, 143, 0.1)", color: "#234a8f", border: "#d9e6ff" };
  return { background: "#f5f6fa", color: "#5d6782", border: "#e3e8f2" };
}

function statusTone(status) {
  if (status === "ready") return { background: "rgba(20, 128, 74, 0.1)", color: "#14804a", border: "#c8efd6" };
  if (status === "in_review") return { background: "rgba(31, 94, 255, 0.1)", color: "#1f5eff", border: "#c7d7ff" };
  if (status === "waiting_input") return { background: "rgba(217, 119, 6, 0.12)", color: "#b45309", border: "#f2dfb0" };
  if (status === "closed") return { background: "#f2fff6", color: "#0a7a35", border: "#d6f4df" };
  if (status === "cancelled") return { background: "#fff2f3", color: "#9f2042", border: "#ffd0d6" };
  return { background: "#f5f6fa", color: "#5d6782", border: "#e3e8f2" };
}

function priorityTone(priority) {
  if (priority === "critical") return { background: "#fff2f3", color: "#9f2042", border: "#ffd0d6" };
  if (priority === "high") return { background: "rgba(217, 119, 6, 0.12)", color: "#b45309", border: "#f2dfb0" };
  if (priority === "low") return { background: "rgba(31, 94, 255, 0.08)", color: "#234a8f", border: "#d9e6ff" };
  return { background: "#f5f6fa", color: "#5d6782", border: "#e3e8f2" };
}

function sourceDeskTone(sourceDesk) {
  if (sourceDesk === "sales") return { background: "rgba(31, 94, 255, 0.1)", color: "#1f5eff", border: "#c7d7ff" };
  if (sourceDesk === "engineering") return { background: "rgba(20, 128, 74, 0.1)", color: "#14804a", border: "#c8efd6" };
  if (sourceDesk === "manufacturing") return { background: "rgba(217, 119, 6, 0.12)", color: "#b45309", border: "#f2dfb0" };
  if (sourceDesk === "quality") return { background: "rgba(124, 58, 237, 0.1)", color: "#7c3aed", border: "#e6ddff" };
  return { background: "#f5f6fa", color: "#5d6782", border: "#e3e8f2" };
}

function chipStyle(tone) {
  return {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    border: `1px solid ${tone.border}`,
    background: tone.background,
    color: tone.color,
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  };
}

function buttonStyle({ active = false, tone = "neutral" } = {}) {
  if (tone === "primary") {
    return {
      appearance: "none",
      border: "1px solid #1f5eff",
      borderRadius: 10,
      minHeight: 34,
      padding: "0 12px",
      background: "#1f5eff",
      color: "#ffffff",
      fontSize: 12,
      fontWeight: 800,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      cursor: "pointer",
    };
  }
  return {
    appearance: "none",
    border: active ? "1px solid #96b5ff" : "1px solid #dfe5ef",
    borderRadius: 10,
    minHeight: 34,
    padding: "0 12px",
    background: active ? "#eef4ff" : "#ffffff",
    color: active ? "#1f5eff" : "#17304d",
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    cursor: "pointer",
  };
}

function fieldStyle() {
  return {
    width: "100%",
    minHeight: 36,
    borderRadius: 10,
    border: "1px solid #dfe5ef",
    background: "#ffffff",
    color: "#17304d",
    padding: "0 10px",
    boxSizing: "border-box",
    outline: "none",
  };
}

function textAreaStyle(minHeight = 88) {
  return {
    ...fieldStyle(),
    minHeight,
    padding: "10px",
    resize: "vertical",
  };
}

function createComposer() {
  return {
    request_type: "bom_release",
    request_priority: "high",
    source_desk: "engineering",
    request_title: "",
    customer_name: "",
    product_id: "",
    product_code: "",
    product_name: "",
    reference_no: "",
    requested_due_date: "",
    attachment_note: "",
    request_details: "",
  };
}

function buildSalesIntakeDraft() {
  return {
    request_type: "client_datasheet",
    request_priority: "high",
    source_desk: "sales",
    request_title: "",
    customer_name: "",
    product_id: "",
    product_code: "",
    product_name: "",
    reference_no: "",
    requested_due_date: "",
    attachment_note: "",
    request_details: "",
  };
}

function nextActionForRequest(row) {
  const status = String(row?.request_status || "").toLowerCase();
  const type = String(row?.request_type || "").toLowerCase();
  const source = String(row?.source_desk || "").toLowerCase();
  const overdue = Boolean(row?.overdue);
  if (status === "waiting_input") {
    return {
      label: source === "sales" ? "Awaiting Sales Input" : "Awaiting Input",
      note: "Clear the missing client/file/spec gap before engineering can close the loop.",
      tone: statusTone("waiting_input"),
    };
  }
  if (status === "ready") {
    if (type === "bom_release" || type === "npd") {
      return {
        label: "Ready — Open BOM Desk",
        note: "Hand off to Manufacturing BOMs for the linked finished good and release the recipe.",
        tone: statusTone("ready"),
      };
    }
    return {
      label: "Ready For Handoff",
      note: "Definition work is complete and downstream action can move.",
      tone: statusTone("ready"),
    };
  }
  if (overdue) {
    return {
      label: "Overdue Review",
      note: "This request has crossed its due date and needs immediate triage.",
      tone: priorityTone("critical"),
    };
  }
  if (type === "client_datasheet") {
    return {
      label: "Complete Datasheet",
      note: "Fill technical fields, capture gaps, and send back a ready client-facing sheet.",
      tone: requestTone("client_datasheet"),
    };
  }
  if (type === "drawing") {
    return {
      label: "Release Drawing Scope",
      note: "Confirm layout/dimensions/approval expectation and route the drawing pack.",
      tone: requestTone("drawing"),
    };
  }
  if (type === "npd") {
    return {
      label: "Define NPD Path",
      note: "Clarify the development brief, ownership, and the first engineering milestone.",
      tone: requestTone("npd"),
    };
  }
  if (type === "bom_release") {
    return {
      label: "Release BOM Structure",
      note: "Confirm FG in Product Master, then open Manufacturing BOMs and publish an active recipe.",
      tone: requestTone("bom_release"),
    };
  }
  if (type === "technical_data") {
    return {
      label: "Resolve Technical Gap",
      note: "Close the specification or compliance ambiguity blocking progress.",
      tone: requestTone("technical_data"),
    };
  }
  return {
    label: "Review And Assign",
    note: "Confirm ownership, due date, and the next engineering action.",
    tone: statusTone(status || "new"),
  };
}

const BUCKETS = [
  ["all", "All"],
  ["open", "Open"],
  ["waiting_input", "Waiting Input"],
  ["datasheet", "Datasheets"],
  ["npd", "NPD"],
  ["bom_release", "BOM Release"],
  ["drawings", "Drawings"],
  ["technical", "Tech Data"],
  ["urgent", "Urgent"],
];

const SIDE_MODES = [
  ["sales_intake", "Sales Intake"],
  ["engineering_workbench", "Engineering Workbench"],
];

export default function EngineeringDesk({
  launch = null,
  onConsumeLaunch = null,
  onOpenQuote = null,
  onOpenManufacturingBoms = null,
  onOpenJobCardsAudit = null,
  onOpenJobCardsStores = null,
  onOpenQualityControl = null,
  onOpenProductMaster = null,
  canOpenQualityControl = false,
  canOpenProductMaster = false,
} = {}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bucket, setBucket] = useState("open");
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState(null);
  const [requests, setRequests] = useState([]);
  const [assignees, setAssignees] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [pendingLaunchRequestId, setPendingLaunchRequestId] = useState(null);
  const [editor, setEditor] = useState(null);
  const [composer, setComposer] = useState(buildSalesIntakeDraft());
  const [sideMode, setSideMode] = useState("sales_intake");
  const [productLookupQuery, setProductLookupQuery] = useState("");
  const [productLookupItems, setProductLookupItems] = useState([]);
  const [productLookupLoading, setProductLookupLoading] = useState(false);
  const [responseFile, setResponseFile] = useState(null);
  const [responseBusy, setResponseBusy] = useState(false);
  const [ops, setOps] = useState({
    readiness: [],
    material: null,
    release: null,
    qualityRework: null,
    qualityCapa: null,
  });

  function openBomForRequest(row = selectedRequest) {
    if (typeof onOpenManufacturingBoms !== "function") return;
    const productId =
      Number(editor?.product_id || row?.payload?.product_id || row?.product_id || 0) || null;
    const launch = {
      finished_good_product_id: productId || undefined,
      finished_good_item_code: editor?.product_code || row?.product_code || undefined,
      focus: productId ? undefined : "bom_gaps",
    };
    saveLastDeskFix({
      page: "manufacturing_boms",
      label: productId ? `BOM for ${launch.finished_good_item_code || productId}` : "BOM gaps from Engineering",
      manufacturingBomsLaunch: launch,
    });
    onOpenManufacturingBoms(launch);
  }

  useEffect(() => {
    const q = String(productLookupQuery || "").trim();
    if (q.length < 2) {
      setProductLookupItems([]);
      setProductLookupLoading(false);
      return undefined;
    }
    let active = true;
    setProductLookupLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch(`/manufacturing-boms/product-lookup?q=${encodeURIComponent(q)}`);
        if (!active) return;
        setProductLookupItems(Array.isArray(data?.products) ? data.products : []);
      } catch {
        if (!active) return;
        setProductLookupItems([]);
      } finally {
        if (active) setProductLookupLoading(false);
      }
    }, 220);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [productLookupQuery]);

  async function loadDesk(nextQuery = query, nextBucket = bucket, focusRequestId = null) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (nextQuery) params.set("q", nextQuery);
      if (nextBucket) params.set("bucket", nextBucket);
      params.set("limit", "120");

      const [deskResult, readinessResult, materialResult, releaseResult, reworkResult, capaResult] = await Promise.allSettled([
        apiFetch(`/engineering-desk/bootstrap?${params.toString()}`),
        apiFetch("/manufacturing-boms/bootstrap"),
        apiFetch("/job-cards/material-readiness-summary"),
        apiFetch("/job-cards/planning-release-summary"),
        apiFetch("/quality-controls/rework-summary"),
        apiFetch("/quality-controls/capa-summary"),
      ]);

      if (deskResult.status !== "fulfilled") throw deskResult.reason;

      const deskData = deskResult.value || {};
      const nextRequests = Array.isArray(deskData?.requests) ? deskData.requests : [];
      setSummary(deskData?.summary || null);
      setRequests(nextRequests);
      setAssignees(Array.isArray(deskData?.assignees) ? deskData.assignees : []);
      const focusId = Number(focusRequestId || pendingLaunchRequestId);
      setSelectedId((prev) => {
        if (Number.isFinite(focusId) && focusId > 0) {
          return focusId;
        }
        return nextRequests.some((row) => Number(row.id) === Number(prev)) ? prev : nextRequests[0]?.id || null;
      });
      if (Number.isFinite(focusId) && focusId > 0) {
        setPendingLaunchRequestId(null);
        setSideMode("engineering_workbench");
        if (!nextRequests.some((row) => Number(row.id) === focusId)) {
          setNotice(`Request #${focusId} is outside the current queue page — switch buckets or search if it does not appear.`);
        }
      }

      setOps({
        readiness: readinessResult.status === "fulfilled" && Array.isArray(readinessResult.value?.readiness) ? readinessResult.value.readiness : [],
        material: materialResult.status === "fulfilled" ? materialResult.value?.summary || null : null,
        release: releaseResult.status === "fulfilled" ? releaseResult.value?.summary || null : null,
        qualityRework: reworkResult.status === "fulfilled" ? reworkResult.value?.summary || null : null,
        qualityCapa: capaResult.status === "fulfilled" ? capaResult.value?.summary || null : null,
      });
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load Engineering Desk."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDesk().catch(() => {});
  }, []);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const requestId = Number(launch.request_id || launch.requestId || launch.id);
    const launchBucket = typeof launch.bucket === "string" ? launch.bucket.trim() : "";
    const hasRequest = Number.isFinite(requestId) && requestId > 0;
    const hasBucket = BUCKETS.some(([key]) => key === launchBucket);

    if (!hasRequest && !hasBucket) {
      if (typeof onConsumeLaunch === "function") onConsumeLaunch();
      return;
    }

    if (hasRequest) {
      setPendingLaunchRequestId(requestId);
      setBucket(hasBucket ? launchBucket : "all");
      setSideMode("engineering_workbench");
      loadDesk(query, hasBucket ? launchBucket : "all", requestId).catch(() => {});
    } else if (hasBucket) {
      setBucket(launchBucket);
      setSideMode("engineering_workbench");
      loadDesk(query, launchBucket).catch(() => {});
    }

    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    const selected = requests.find((row) => Number(row.id) === Number(selectedId)) || null;
    setEditor(
      selected
        ? {
            request_title: selected.request_title || "",
            request_status: selected.request_status || "new",
            request_priority: selected.request_priority || "normal",
            source_desk: selected.source_desk || "engineering",
            assigned_to_user_id: selected.assigned_to_user_id ? String(selected.assigned_to_user_id) : "",
            customer_name: selected.customer_name || "",
            product_id: selected.payload?.product_id ? String(selected.payload.product_id) : "",
            product_code: selected.product_code || "",
            product_name: selected.product_name || "",
            reference_no: selected.reference_no || "",
            requested_due_date: selected.requested_due_date || "",
            attachment_note: selected.attachment_note || "",
            request_details: selected.request_details || "",
          }
        : null
    );
  }, [selectedId, requests]);

  const selectedRequest = useMemo(() => requests.find((row) => Number(row.id) === Number(selectedId)) || null, [requests, selectedId]);

  const readinessStats = useMemo(() => {
    const rows = Array.isArray(ops.readiness) ? ops.readiness : [];
    const gaps = rows.filter((row) => !row?.ready_for_job);
    return {
      totalFg: rows.length,
      setupGaps: gaps.length,
      missingPrefix: gaps.filter((row) => row?.readiness_status === "missing_prefix").length,
      bomGaps: gaps.filter((row) => ["missing_active_bom", "empty_bom"].includes(String(row?.readiness_status || "").toLowerCase())).length,
    };
  }, [ops.readiness]);

  const topMetrics = useMemo(
    () => [
      { label: "Open Requests", value: String(count(summary?.open_requests)), tone: "#1f5eff", note: "live demand into engineering" },
      { label: "Datasheets", value: String(count(summary?.datasheet_open)), tone: "#14804a", note: "sales-origin intake waiting action" },
      { label: "Release Blocks", value: String(count(ops.release?.releaseBlockedSetup) + count(readinessStats.setupGaps)), tone: "#b45309", note: "setup and BOM gaps" },
      { label: "CAPA / Rework", value: String(count(ops.qualityCapa?.actionOverdue) + count(ops.qualityRework?.reworkPending)), tone: "#9f2042", note: "quality-linked engineering pull" },
    ],
    [summary, ops.release, ops.qualityCapa, ops.qualityRework, readinessStats]
  );

  const queueCounts = useMemo(
    () => ({
      all: requests.length,
      overdue: requests.filter((row) => row.overdue).length,
      waitingInput: requests.filter((row) => row.request_status === "waiting_input").length,
      ready: requests.filter((row) => row.request_status === "ready").length,
    }),
    [requests]
  );

  function applySearch(nextQuery = query, nextBucket = bucket) {
    loadDesk(nextQuery, nextBucket).catch(() => {});
  }

  async function submitRequest(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        ...composer,
        payload: composer.product_id
          ? {
              product_id: Number(composer.product_id),
              product_code: composer.product_code || null,
              product_name: composer.product_name || null,
            }
          : {},
      };
      const data = await apiFetch("/engineering-desk/requests", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setNotice(`${requestTypeLabel(data?.request?.request_type)} request sent to Engineering.`);
      setComposer(sideMode === "engineering_workbench" ? createComposer() : buildSalesIntakeDraft());
      setProductLookupQuery("");
      await loadDesk(query, bucket);
      if (data?.request?.id) {
        setSelectedId(data.request.id);
        setSideMode("engineering_workbench");
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to create engineering request."));
    } finally {
      setSaving(false);
    }
  }

  async function saveSelected() {
    if (!selectedRequest || !editor) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        ...editor,
        assigned_to_user_id: editor.assigned_to_user_id ? Number(editor.assigned_to_user_id) : null,
        payload: {
          ...(selectedRequest.payload && typeof selectedRequest.payload === "object" ? selectedRequest.payload : {}),
          product_id: editor.product_id ? Number(editor.product_id) : null,
          product_code: editor.product_code || null,
          product_name: editor.product_name || null,
        },
      };
      await apiFetch(`/engineering-desk/requests/${selectedRequest.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setNotice("Engineering request updated.");
      await loadDesk(query, bucket);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to update engineering request."));
    } finally {
      setSaving(false);
    }
  }

  async function uploadResponseDatasheet() {
    if (!selectedRequest?.id || !responseFile) return;
    setResponseBusy(true);
    setError("");
    setNotice("");
    try {
      const body = new FormData();
      body.append("file", responseFile);
      body.append("mark_ready", "true");
      await apiFetch(`/engineering-desk/requests/${selectedRequest.id}/response-datasheet`, {
        method: "POST",
        body,
      });
      setResponseFile(null);
      setNotice("Engineering datasheet returned to Sales.");
      await loadDesk(query, bucket);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to upload response datasheet."));
    } finally {
      setResponseBusy(false);
    }
  }

  const laneCards = [
    {
      key: "datasheet",
      label: "Client Datasheet Intake",
      value: count(summary?.datasheet_open),
      note: "Sales can push any client datasheet here for engineering completion.",
      action: () => {
        setBucket("datasheet");
        loadDesk(query, "datasheet").catch(() => {});
      },
    },
    {
      key: "npd",
      label: "NPD Requests",
      value: count(summary?.npd_open),
      note: "New development demands needing product definition and cross-functional handoff.",
      action: () => {
        setBucket("npd");
        loadDesk(query, "npd").catch(() => {});
      },
    },
    {
      key: "bom_release",
      label: "BOM Release",
      value: count(summary?.bom_release_open),
      note: "Engineering release work that should close into Manufacturing BOMs.",
      action: () => {
        setBucket("bom_release");
        loadDesk(query, "bom_release").catch(() => {});
      },
    },
    {
      key: "drawings",
      label: "Drawing Requests",
      value: count(summary?.drawing_open),
      note: "Layout, dimensional, and approval drawings waiting engineering release.",
      action: () => {
        setBucket("drawings");
        loadDesk(query, "drawings").catch(() => {});
      },
    },
    {
      key: "technical",
      label: "Technical Data",
      value: count(summary?.technical_open),
      note: "Specs, compliance, and technical clarifications requiring fast desk response.",
      action: () => {
        setBucket("technical");
        loadDesk(query, "technical").catch(() => {});
      },
    },
  ];

  const fixItems = [
    {
      key: "datasheets",
      title: `${count(summary?.datasheet_open)} datasheets open`,
      note: "Complete and return client-facing sheets.",
      tone: "#1f5eff",
      onClick: () => {
        setBucket("datasheet");
        loadDesk(query, "datasheet").catch(() => {});
      },
    },
    {
      key: "bom",
      title: `${count(summary?.bom_release_open) + count(readinessStats.bomGaps)} BOM release gaps`,
      note: "Bind FG and open Manufacturing BOMs.",
      tone: "#b45309",
      onClick: () => {
        saveLastDeskFix({ page: "manufacturing_boms", label: "BOM gaps from Engineering", manufacturingBomsLaunch: { focus: "bom_gaps" } });
        openBomForRequest();
      },
    },
    {
      key: "ready",
      title: `${queueCounts.ready} ready for handoff`,
      note: "Move Ready requests into BOM / factory.",
      tone: "#14804a",
      onClick: () => {
        setBucket("open");
        loadDesk(query, "open").catch(() => {});
      },
    },
  ];

  const reviewItems = [
    readinessStats.setupGaps
      ? { key: "setup", title: "FG setup gaps", body: `${readinessStats.setupGaps} finished goods still need prefix or BOM before jobs.`, tone: "#8b5a00", background: "#fff9ec", border: "#f2dfb0" }
      : null,
    count(ops.qualityCapa?.actionOverdue)
      ? { key: "capa", title: "CAPA overdue", body: `${count(ops.qualityCapa?.actionOverdue)} quality actions need engineering attention.`, tone: "#9f2042", background: "#fff2f3", border: "#ffd0d6" }
      : null,
    queueCounts.overdue
      ? { key: "overdue", title: "Overdue requests", body: `${queueCounts.overdue} engineering requests past due date.`, tone: "#9f2042", background: "#fff2f3", border: "#ffd0d6" }
      : null,
  ].filter(Boolean);

  return (
    <div style={{ maxWidth: 1540, width: "100%", display: "grid", gap: 16, color: "#17304d" }}>
      <PageHero
        eyebrow="Engineering desk"
        title="Intake, release blockers, and BOM handoff in one place"
        description="Sales routes datasheets here; engineering triages NPD, drawings, and BOM release; factory readiness stays visible so product definition stays linked to execution."
        actions={
          <>
            <button type="button" style={buttonStyle({ tone: "primary" })} onClick={() => loadDesk().catch(() => {})}>
              {loading ? "Refreshing" : "Refresh Desk"}
            </button>
            {typeof onOpenManufacturingBoms === "function" ? (
              <button type="button" style={buttonStyle({ active: true })} onClick={() => openBomForRequest()}>
                Open BOMs
              </button>
            ) : null}
            {typeof onOpenJobCardsAudit === "function" ? (
              <button type="button" style={buttonStyle({ active: true })} onClick={() => onOpenJobCardsAudit("ready_for_release")}>
                Release Audit
              </button>
            ) : null}
          </>
        }
        stats={topMetrics.map((item) => ({ label: item.label, value: item.value, tone: item.tone }))}
      />

      <DeskPilotBanner
        title="Pilot scope"
        body="Engineering Desk = definition intake. Manufacturing BOMs = recipe release. Job Cards = factory execution."
        tone="info"
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <HeaderChip label={`${queueCounts.all} in queue`} />
            <HeaderChip label={`${readinessStats.setupGaps} FG gaps`} tone="#b45309" background="rgba(217, 119, 6, 0.12)" />
          </div>
        }
      />

      <DeskActionRails
        fixSubtitle="Start with the request or release gap most likely to block Absstem jobs."
        fixItems={fixItems}
        reviewSubtitle="Keep factory and quality signals in view before editing."
        reviewItems={reviewItems}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.45fr) minmax(360px, 0.95fr)", gap: 14, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ border: "1px solid #dfe5ef", borderRadius: 22, padding: 14, background: "#ffffff", boxShadow: "0 12px 28px rgba(17, 32, 56, 0.05)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#1f5eff", fontWeight: 900 }}>Engineering Queue</div>
                <div style={{ marginTop: 4, fontSize: 13, color: "#5d6782" }}>Work the intake by request type, urgency, or ready state without losing execution context.</div>
              </div>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") applySearch(event.currentTarget.value, bucket);
                }}
                placeholder="Search title, customer, product, reference"
                style={{ ...fieldStyle(), width: 300 }}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle({ active: true })} onClick={() => applySearch()}>
                  Apply Search
                </button>
                <button
                  type="button"
                  style={buttonStyle()}
                  onClick={() => {
                    setQuery("");
                    applySearch("", bucket);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {BUCKETS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  style={buttonStyle({ active: bucket === value })}
                  onClick={() => {
                    setBucket(value);
                    applySearch(query, value);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              {loading ? (
                <div style={{ padding: 16, borderRadius: 16, border: "1px solid #e3e8f2", background: "#ffffff", color: "#5d6782" }}>Loading engineering queue...</div>
              ) : requests.length ? (
                requests.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(row.id);
                      setSideMode("engineering_workbench");
                    }}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      border: Number(selectedId) === Number(row.id) ? "1px solid #96b5ff" : "1px solid #dfe5ef",
                      borderRadius: 18,
                      padding: 12,
                      background: Number(selectedId) === Number(row.id) ? "linear-gradient(180deg, #eef4ff 0%, #eef4ff 100%)" : "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
                      boxShadow: Number(selectedId) === Number(row.id) ? "0 12px 28px rgba(22, 82, 156, 0.18)" : "none",
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    {row.overdue ? (
                      <div style={{ ...chipStyle(priorityTone("critical")), justifySelf: "start" }}>Overdue</div>
                    ) : null}
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: "#17304d" }}>{row.request_title}</div>
                        <div style={{ marginTop: 4, fontSize: 12, color: "#5d6782" }}>
                          {[row.customer_name, row.product_code, row.product_name].filter(Boolean).join(" | ") || "General engineering request"}
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: row.overdue ? "#9f2042" : "#5d6782", fontWeight: 800 }}>{formatDate(row.requested_due_date)}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <span style={chipStyle(requestTone(row.request_type))}>{requestTypeLabel(row.request_type)}</span>
                      <span style={chipStyle(statusTone(row.request_status))}>{requestStatusLabel(row.request_status)}</span>
                      <span style={chipStyle(priorityTone(row.request_priority))}>{row.request_priority || "normal"}</span>
                      <span style={chipStyle(sourceDeskTone(row.source_desk))}>{sourceDeskLabel(row.source_desk)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, color: "#5d6782", flexWrap: "wrap" }}>
                      <span>Requester: {row.requester_name || "Unassigned source"}</span>
                      <span>Owner: {row.assignee_name || "Engineering pool"}</span>
                    </div>
                    <div
                      style={{
                        border: `1px solid ${nextActionForRequest(row).tone.border}`,
                        borderRadius: 12,
                        padding: "8px 10px",
                        background: nextActionForRequest(row).tone.background,
                        color: nextActionForRequest(row).tone.color,
                        display: "grid",
                        gap: 4,
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase" }}>{nextActionForRequest(row).label}</div>
                      <div style={{ fontSize: 12, lineHeight: 1.5 }}>{nextActionForRequest(row).note}</div>
                    </div>
                    {row.request_details ? <div style={{ fontSize: 12, color: "#5d6782", lineHeight: 1.6 }}>{row.request_details}</div> : null}
                  </button>
                ))
              ) : (
                <div style={{ padding: 16, borderRadius: 16, border: "1px solid #e3e8f2", background: "#ffffff", color: "#5d6782" }}>No engineering requests match the current bucket.</div>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
            {laneCards.map((lane) => (
              <button
                key={lane.key}
                type="button"
                onClick={lane.action}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  border: "1px solid #dfe5ef",
                  borderRadius: 18,
                  padding: 14,
                  background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "#87bcff", fontWeight: 900 }}>{lane.label}</div>
                <div style={{ fontSize: 28, fontWeight: 900, color: "#17304d" }}>{lane.value}</div>
                <div style={{ fontSize: 12, color: "#5d6782", lineHeight: 1.6 }}>{lane.note}</div>
              </button>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            <div style={{ border: "1px solid #dfe5ef", borderRadius: 18, padding: 14, background: "linear-gradient(180deg, #ffffff 0%, #fbfcff 100%)" }}>
              <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#1f5eff", fontWeight: 900 }}>Factory Release Radar</div>
              <div style={{ marginTop: 12, display: "grid", gap: 8, fontSize: 12, color: "#a0b3ce" }}>
                <div>FG setup gaps: <strong style={{ color: "#17304d" }}>{count(ops.material?.fgSetupGaps || readinessStats.setupGaps)}</strong></div>
                <div>Missing prefixes: <strong style={{ color: "#17304d" }}>{count(ops.material?.missingPrefix || readinessStats.missingPrefix)}</strong></div>
                <div>BOM gaps: <strong style={{ color: "#17304d" }}>{count(ops.material?.bomGaps || readinessStats.bomGaps)}</strong></div>
                <div>Ready for release: <strong style={{ color: "#17304d" }}>{count(ops.release?.readyForRelease)}</strong></div>
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {typeof onOpenJobCardsAudit === "function" ? (
                  <button type="button" style={buttonStyle({ active: true })} onClick={() => onOpenJobCardsAudit("release_blocked_setup")}>
                    Open Release Blocks
                  </button>
                ) : null}
                {typeof onOpenManufacturingBoms === "function" ? (
                  <button type="button" style={buttonStyle()} onClick={onOpenManufacturingBoms}>
                    BOM Workspace
                  </button>
                ) : null}
              </div>
            </div>

            <div style={{ border: "1px solid #dfe5ef", borderRadius: 18, padding: 14, background: "linear-gradient(180deg, #ffffff 0%, #fbfcff 100%)" }}>
              <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#1f5eff", fontWeight: 900 }}>Material Control</div>
              <div style={{ marginTop: 12, display: "grid", gap: 8, fontSize: 12, color: "#a0b3ce" }}>
                <div>Shortage not raised: <strong style={{ color: "#17304d" }}>{count(ops.material?.shortageNotRaised)}</strong></div>
                <div>Procurement in flight: <strong style={{ color: "#17304d" }}>{count(ops.material?.procurementInFlight)}</strong></div>
                <div>Blocked supply: <strong style={{ color: "#17304d" }}>{count(ops.material?.blockedSupply)}</strong></div>
                <div>Jobs pending material: <strong style={{ color: "#17304d" }}>{count(ops.material?.jobsPendingMaterial)}</strong></div>
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {typeof onOpenJobCardsStores === "function" ? (
                  <button type="button" style={buttonStyle({ active: true })} onClick={() => onOpenJobCardsStores("shortage_not_raised")}>
                    Open Material Desk
                  </button>
                ) : null}
              </div>
            </div>

            <div style={{ border: "1px solid #dfe5ef", borderRadius: 18, padding: 14, background: "linear-gradient(180deg, #ffffff 0%, #fbfcff 100%)" }}>
              <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#1f5eff", fontWeight: 900 }}>Quality Pull</div>
              <div style={{ marginTop: 12, display: "grid", gap: 8, fontSize: 12, color: "#a0b3ce" }}>
                <div>Awaiting disposition: <strong style={{ color: "#17304d" }}>{count(ops.qualityRework?.awaitingDisposition)}</strong></div>
                <div>Rework pending: <strong style={{ color: "#17304d" }}>{count(ops.qualityRework?.reworkPending)}</strong></div>
                <div>Action overdue: <strong style={{ color: "#17304d" }}>{count(ops.qualityCapa?.actionOverdue)}</strong></div>
                <div>Verification due: <strong style={{ color: "#17304d" }}>{count(ops.qualityCapa?.verificationDue)}</strong></div>
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {canOpenQualityControl && typeof onOpenQualityControl === "function" ? (
                  <button type="button" style={buttonStyle({ active: true })} onClick={() => onOpenQualityControl("action_overdue")}>
                    Open Quality Desk
                  </button>
                ) : null}
                {canOpenProductMaster && typeof onOpenProductMaster === "function" ? (
                  <button type="button" style={buttonStyle()} onClick={onOpenProductMaster}>
                    Product Master
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ border: "1px solid #dfe5ef", borderRadius: 22, padding: 14, background: "linear-gradient(180deg, #ffffff 0%, #fbfcff 100%)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#1f5eff", fontWeight: 900 }}>Operator Rail</div>
                <div style={{ marginTop: 4, fontSize: 13, color: "#5d6782" }}>
                  Separate request raising from engineering execution so each mode stays focused.
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {SIDE_MODES.map(([value, label]) => (
                  <button key={value} type="button" style={buttonStyle({ active: sideMode === value })} onClick={() => setSideMode(value)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
              <div style={{ border: "1px solid #dfe5ef", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                <div style={{ fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>Queue Size</div>
                <div style={{ marginTop: 4, fontSize: 22, fontWeight: 900 }}>{queueCounts.all}</div>
              </div>
              <div style={{ border: "1px solid #dfe5ef", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                <div style={{ fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>Overdue</div>
                <div style={{ marginTop: 4, fontSize: 22, fontWeight: 900, color: "#9f2042" }}>{queueCounts.overdue}</div>
              </div>
              <div style={{ border: "1px solid #dfe5ef", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                <div style={{ fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>Waiting Input</div>
                <div style={{ marginTop: 4, fontSize: 22, fontWeight: 900, color: "#ffd089" }}>{queueCounts.waitingInput}</div>
              </div>
              <div style={{ border: "1px solid #dfe5ef", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                <div style={{ fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>Ready</div>
                <div style={{ marginTop: 4, fontSize: 22, fontWeight: 900, color: "#14804a" }}>{queueCounts.ready}</div>
              </div>
            </div>
          </div>

          {sideMode === "sales_intake" ? (
            <form onSubmit={submitRequest} style={{ border: "1px solid #dfe5ef", borderRadius: 22, padding: 14, background: "linear-gradient(180deg, #ffffff 0%, #fbfcff 100%)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#1f5eff", fontWeight: 900 }}>Sales Intake</div>
                  <div style={{ marginTop: 6, fontSize: 13, color: "#5d6782", lineHeight: 1.6 }}>
                    Use this narrower mode for client-facing engineering asks. Source stays fixed to Sales and the intake stays simpler.
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span style={chipStyle(sourceDeskTone("sales"))}>Sales Intake</span>
                  <span style={chipStyle(requestTone(composer.request_type))}>{requestTypeLabel(composer.request_type)}</span>
                </div>
              </div>
              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Request Type
                  <select value={composer.request_type} onChange={(event) => setComposer((prev) => ({ ...prev, request_type: event.target.value }))} style={fieldStyle()}>
                    <option value="client_datasheet">Client Datasheet</option>
                    <option value="drawing">Drawing</option>
                    <option value="technical_data">Technical Data</option>
                    <option value="npd">NPD</option>
                    <option value="bom_release">BOM Release</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Priority
                  <select value={composer.request_priority} onChange={(event) => setComposer((prev) => ({ ...prev, request_priority: event.target.value }))} style={fieldStyle()}>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="normal">Normal</option>
                    <option value="low">Low</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Due Date
                  <input type="date" value={composer.requested_due_date} onChange={(event) => setComposer((prev) => ({ ...prev, requested_due_date: event.target.value }))} style={fieldStyle()} />
                </label>
                <div style={{ border: "1px solid #dfe5ef", borderRadius: 12, padding: 10, background: "#ffffff", color: "#5d6782", fontSize: 12, lineHeight: 1.6 }}>
                  Include quote/SO reference, product context, and what Engineering must return to Sales.
                </div>
              </div>
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                <input placeholder="Request title" value={composer.request_title} onChange={(event) => setComposer((prev) => ({ ...prev, request_title: event.target.value }))} style={fieldStyle()} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  <input placeholder="Customer" value={composer.customer_name} onChange={(event) => setComposer((prev) => ({ ...prev, customer_name: event.target.value }))} style={fieldStyle()} />
                  <input placeholder="Reference / Quote / SO No." value={composer.reference_no} onChange={(event) => setComposer((prev) => ({ ...prev, reference_no: event.target.value }))} style={fieldStyle()} />
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  <input
                    placeholder="Search Product Master (code / name)"
                    value={productLookupQuery}
                    onChange={(event) => setProductLookupQuery(event.target.value)}
                    style={fieldStyle()}
                  />
                  {composer.product_id ? (
                    <div style={{ fontSize: 12, color: "#14804a" }}>
                      Linked FG: <strong>{composer.product_code || composer.product_id}</strong> {composer.product_name ? `• ${composer.product_name}` : ""}
                      <button
                        type="button"
                        style={{ ...buttonStyle(), marginLeft: 8, padding: "4px 8px" }}
                        onClick={() => setComposer((prev) => ({ ...prev, product_id: "", product_code: "", product_name: "" }))}
                      >
                        Clear
                      </button>
                    </div>
                  ) : null}
                  {productLookupLoading ? <div style={{ fontSize: 12, color: "#5d6782" }}>Searching products…</div> : null}
                  {!productLookupLoading && productLookupItems.length ? (
                    <div style={{ display: "grid", gap: 6, maxHeight: 140, overflow: "auto" }}>
                      {productLookupItems.slice(0, 8).map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          style={buttonStyle()}
                          onClick={() => {
                            setComposer((prev) => ({
                              ...prev,
                              product_id: String(item.id),
                              product_code: item.item_code || "",
                              product_name: item.item_name || "",
                              request_title: prev.request_title || `BOM release — ${item.item_code || item.item_name}`,
                            }));
                            setProductLookupQuery("");
                            setProductLookupItems([]);
                          }}
                        >
                          {item.item_code} • {item.item_name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <input placeholder="Product code" value={composer.product_code} onChange={(event) => setComposer((prev) => ({ ...prev, product_code: event.target.value }))} style={fieldStyle()} />
                    <input placeholder="Product name" value={composer.product_name} onChange={(event) => setComposer((prev) => ({ ...prev, product_name: event.target.value }))} style={fieldStyle()} />
                  </div>
                </div>
                <input placeholder="Incoming file / attachment note" value={composer.attachment_note} onChange={(event) => setComposer((prev) => ({ ...prev, attachment_note: event.target.value }))} style={fieldStyle()} />
                <textarea placeholder="What Engineering must fill, clarify, draw, or return to Sales" value={composer.request_details} onChange={(event) => setComposer((prev) => ({ ...prev, request_details: event.target.value }))} style={textAreaStyle(110)} />
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle()} onClick={() => setComposer(buildSalesIntakeDraft())}>
                  Clear
                </button>
                <button type="submit" style={buttonStyle({ tone: "primary" })} disabled={saving}>
                  {saving ? "Sending" : "Send To Engineering"}
                </button>
              </div>
            </form>
          ) : (
            <div style={{ border: "1px solid #dfe5ef", borderRadius: 22, padding: 14, background: "linear-gradient(180deg, #ffffff 0%, #fbfcff 100%)" }}>
              <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#1f5eff", fontWeight: 900 }}>Engineering Workbench</div>
              {!selectedRequest || !editor ? (
                <div style={{ marginTop: 12, fontSize: 13, color: "#5d6782" }}>Select a request from the queue to assign, re-prioritize, and move it through engineering.</div>
              ) : (
                <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
                    <div style={{ border: "1px solid #dfe5ef", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                      <div style={{ fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>Type</div>
                      <div style={{ marginTop: 4, fontWeight: 800 }}>{requestTypeLabel(selectedRequest.request_type)}</div>
                    </div>
                    <div style={{ border: "1px solid #dfe5ef", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                      <div style={{ fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>Source</div>
                      <div style={{ marginTop: 4, fontWeight: 800 }}>{sourceDeskLabel(selectedRequest.source_desk)}</div>
                    </div>
                    <div style={{ border: "1px solid #dfe5ef", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                      <div style={{ fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>Owner</div>
                      <div style={{ marginTop: 4, fontWeight: 800 }}>{selectedRequest.assignee_name || "Engineering pool"}</div>
                    </div>
                    <div style={{ border: "1px solid #dfe5ef", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                      <div style={{ fontSize: 11, color: "#5d6782", textTransform: "uppercase", letterSpacing: "0.08em" }}>Due</div>
                      <div style={{ marginTop: 4, fontWeight: 800, color: selectedRequest.overdue ? "#9f2042" : "#17304d" }}>{formatDate(selectedRequest.requested_due_date)}</div>
                    </div>
                  </div>
                  <div
                    style={{
                      border: `1px solid ${nextActionForRequest(selectedRequest).tone.border}`,
                      borderRadius: 14,
                      padding: 12,
                      background: nextActionForRequest(selectedRequest).tone.background,
                      color: nextActionForRequest(selectedRequest).tone.color,
                      display: "grid",
                      gap: 4,
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase" }}>Current Focus</div>
                    <div style={{ fontSize: 15, fontWeight: 800 }}>{nextActionForRequest(selectedRequest).label}</div>
                    <div style={{ fontSize: 12, lineHeight: 1.6 }}>{nextActionForRequest(selectedRequest).note}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span style={chipStyle(requestTone(selectedRequest.request_type))}>{requestTypeLabel(selectedRequest.request_type)}</span>
                    <span style={chipStyle(statusTone(selectedRequest.request_status))}>{requestStatusLabel(selectedRequest.request_status)}</span>
                    <span style={chipStyle(priorityTone(selectedRequest.request_priority))}>{selectedRequest.request_priority}</span>
                    <span style={chipStyle(sourceDeskTone(selectedRequest.source_desk))}>{sourceDeskLabel(selectedRequest.source_desk)}</span>
                  </div>
                  <input value={editor.request_title} onChange={(event) => setEditor((prev) => ({ ...prev, request_title: event.target.value }))} style={fieldStyle()} />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <select value={editor.request_status} onChange={(event) => setEditor((prev) => ({ ...prev, request_status: event.target.value }))} style={fieldStyle()}>
                      <option value="new">New</option>
                      <option value="in_review">In Review</option>
                      <option value="waiting_input">Waiting Input</option>
                      <option value="ready">Ready</option>
                      <option value="closed">Closed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                    <select value={editor.request_priority} onChange={(event) => setEditor((prev) => ({ ...prev, request_priority: event.target.value }))} style={fieldStyle()}>
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="normal">Normal</option>
                      <option value="low">Low</option>
                    </select>
                    <select value={editor.source_desk} onChange={(event) => setEditor((prev) => ({ ...prev, source_desk: event.target.value }))} style={fieldStyle()}>
                      <option value="sales">Sales</option>
                      <option value="engineering">Engineering</option>
                      <option value="manufacturing">Manufacturing</option>
                      <option value="quality">Quality</option>
                      <option value="service">Service</option>
                      <option value="purchase">Purchase</option>
                      <option value="admin">Admin</option>
                      <option value="other">Other</option>
                    </select>
                    <select value={editor.assigned_to_user_id} onChange={(event) => setEditor((prev) => ({ ...prev, assigned_to_user_id: event.target.value }))} style={fieldStyle()}>
                      <option value="">Engineering pool</option>
                      {assignees.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.full_name}{row.department_key ? ` (${row.department_key})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <input placeholder="Customer" value={editor.customer_name} onChange={(event) => setEditor((prev) => ({ ...prev, customer_name: event.target.value }))} style={fieldStyle()} />
                    <input placeholder="Reference" value={editor.reference_no} onChange={(event) => setEditor((prev) => ({ ...prev, reference_no: event.target.value }))} style={fieldStyle()} />
                    <input placeholder="Product code" value={editor.product_code} onChange={(event) => setEditor((prev) => ({ ...prev, product_code: event.target.value }))} style={fieldStyle()} />
                    <input placeholder="Product name" value={editor.product_name} onChange={(event) => setEditor((prev) => ({ ...prev, product_name: event.target.value }))} style={fieldStyle()} />
                    <input type="date" value={editor.requested_due_date || ""} onChange={(event) => setEditor((prev) => ({ ...prev, requested_due_date: event.target.value }))} style={fieldStyle()} />
                    <input placeholder="Attachment note" value={editor.attachment_note} onChange={(event) => setEditor((prev) => ({ ...prev, attachment_note: event.target.value }))} style={fieldStyle()} />
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    <input
                      placeholder="Bind Product Master (search code / name)"
                      value={productLookupQuery}
                      onChange={(event) => setProductLookupQuery(event.target.value)}
                      style={fieldStyle()}
                    />
                    {editor.product_id ? (
                      <div style={{ fontSize: 12, color: "#14804a" }}>
                        Linked product id {editor.product_id}
                        <button
                          type="button"
                          style={{ ...buttonStyle(), marginLeft: 8, padding: "4px 8px" }}
                          onClick={() => setEditor((prev) => ({ ...prev, product_id: "" }))}
                        >
                          Unbind
                        </button>
                      </div>
                    ) : null}
                    {!productLookupLoading && productLookupItems.length ? (
                      <div style={{ display: "grid", gap: 6, maxHeight: 120, overflow: "auto" }}>
                        {productLookupItems.slice(0, 6).map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            style={buttonStyle()}
                            onClick={() => {
                              setEditor((prev) => ({
                                ...prev,
                                product_id: String(item.id),
                                product_code: item.item_code || prev.product_code,
                                product_name: item.item_name || prev.product_name,
                              }));
                              setProductLookupQuery("");
                              setProductLookupItems([]);
                            }}
                          >
                            {item.item_code} • {item.item_name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <textarea value={editor.request_details} onChange={(event) => setEditor((prev) => ({ ...prev, request_details: event.target.value }))} style={textAreaStyle(120)} />
                  {selectedRequest.quote_header_id || selectedRequest.quote_number ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ fontSize: 12, color: "#234a8f" }}>
                        Linked quote: {selectedRequest.quote_number || `#${selectedRequest.quote_header_id}`}
                      </div>
                      {typeof onOpenQuote === "function" && selectedRequest.quote_header_id ? (
                        <button type="button" style={buttonStyle()} onClick={() => onOpenQuote(selectedRequest.quote_header_id)}>
                          Open quote
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {(selectedRequest.attachments || []).length ? (
                    <div style={{ display: "grid", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#5d6782" }}>Datasheets</div>
                      {selectedRequest.attachments.map((att) => (
                        <a
                          key={att.id}
                          href={`/engineering-desk/requests/${selectedRequest.id}/attachments/${att.id}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 12 }}
                        >
                          {att.direction === "engineering_return" ? "Returned" : "Customer"}: {att.file_name}
                        </a>
                      ))}
                    </div>
                  ) : null}
                  <div style={{ display: "grid", gap: 8, border: "1px solid #dfe5ef", borderRadius: 14, padding: 12, background: "#fbfcff" }}>
                    <div style={{ fontSize: 12, fontWeight: 800 }}>Return completed standard datasheet</div>
                    <input type="file" onChange={(event) => setResponseFile(event.target.files?.[0] || null)} />
                    <button type="button" style={buttonStyle({ tone: "primary" })} onClick={uploadResponseDatasheet} disabled={responseBusy || !responseFile}>
                      {responseBusy ? "Uploading" : "Upload Response Datasheet"}
                    </button>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontSize: 12, color: "#5d6782" }}>
                      Raised by <strong style={{ color: "#17304d" }}>{selectedRequest.requester_name || "Unknown"}</strong> • owner <strong style={{ color: "#17304d" }}>{selectedRequest.assignee_name || "Engineering pool"}</strong>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {typeof onOpenManufacturingBoms === "function" &&
                      (selectedRequest.request_status === "ready" ||
                        selectedRequest.request_type === "bom_release" ||
                        selectedRequest.request_type === "npd" ||
                        editor.product_id ||
                        selectedRequest.product_code) ? (
                        <button type="button" style={buttonStyle({ tone: "primary" })} onClick={() => openBomForRequest(selectedRequest)}>
                          Open Linked BOM
                        </button>
                      ) : null}
                      <button type="button" style={buttonStyle()} onClick={() => setSideMode("sales_intake")}>
                        New Intake
                      </button>
                      <button type="button" style={buttonStyle({ tone: "primary" })} onClick={saveSelected} disabled={saving}>
                        {saving ? "Saving" : "Save Request"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
