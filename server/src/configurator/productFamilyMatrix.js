const PRODUCT_FAMILY_MATRIX = [
  {
    family_key: "NGEN",
    family_name: "nGEN",
    origin: "absstem",
    gas_domain: "nitrogen",
    quote_mode: "configurator",
    positioning: "Premium industrial nitrogen family",
    proposal_profile_key: "industrial_premium",
    presentation_company_code: "AI",
    selector_model: {
      family_step: true,
      variant_axis: ["HF", "SH", "UH"],
      inputs: ["required_flow_nm3_hr", "purity_pct", "package_mode", "automation_preference"],
    },
    proposal_blocks: {
      executive_summary: ["application_problem", "solution_fit", "performance_highlights"],
      scope_summary: ["generator", "controls", "air_receiver", "gas_storage", "remarks"],
      proof_points: ["purity_stability", "automation", "industrial_reliability"],
    },
    annexure_policy: "optional_family_annexure",
    notes: "Use variant-led messaging: HF for high flow, SH for standard high performance, UH for ultra high purity.",
  },
  {
    family_key: "NGENX",
    family_name: "nGENX",
    origin: "absstem",
    gas_domain: "nitrogen",
    quote_mode: "configurator",
    positioning: "Compact value nitrogen family",
    proposal_profile_key: "industrial_compact",
    presentation_company_code: "AI",
    selector_model: {
      family_step: true,
      variant_axis: [],
      inputs: ["required_flow_nm3_hr", "purity_pct", "package_mode", "installation_environment"],
    },
    proposal_blocks: {
      executive_summary: ["application_problem", "compact_solution_fit", "operating_simplicity"],
      scope_summary: ["generator", "digital_controller", "air_receiver", "gas_storage", "remarks"],
      proof_points: ["footprint", "ease_of_use", "value_positioning"],
    },
    annexure_policy: "optional_family_annexure",
    notes: "Keep messaging cleaner and more value-focused than nGEN.",
  },
  {
    family_key: "IDOS",
    family_name: "IDOS",
    origin: "absstem",
    gas_domain: "industrial_oxygen",
    quote_mode: "configurator",
    positioning: "Industrial oxygen family",
    proposal_profile_key: "oxygen_industrial",
    presentation_company_code: "AI",
    selector_model: {
      family_step: true,
      variant_axis: [],
      inputs: ["required_flow_nm3_hr", "purity_pct", "package_mode", "end_use"],
    },
    proposal_blocks: {
      executive_summary: ["application_problem", "process_oxygen_fit", "operating_reliability"],
      scope_summary: ["generator", "controls", "air_receiver", "oxygen_storage", "remarks"],
      proof_points: ["process_continuity", "oxygen_availability", "industrial_safety"],
    },
    annexure_policy: "optional_family_annexure",
    notes: "Use process/production language instead of clinical language.",
  },
  {
    family_key: "IDOS_C",
    family_name: "IDOS C",
    origin: "absstem",
    gas_domain: "industrial_oxygen",
    quote_mode: "configurator",
    positioning: "Compact industrial oxygen family",
    proposal_profile_key: "oxygen_industrial_compact",
    presentation_company_code: "AI",
    selector_model: {
      family_step: true,
      variant_axis: [],
      inputs: ["required_flow_nm3_hr", "purity_pct", "package_mode", "installation_environment"],
    },
    proposal_blocks: {
      executive_summary: ["application_problem", "compact_solution_fit", "operating_simplicity"],
      scope_summary: ["generator", "digital_controller", "air_receiver", "oxygen_storage", "remarks"],
      proof_points: ["compactness", "faster_installation", "value_positioning"],
    },
    annexure_policy: "optional_family_annexure",
    notes: "Keep this as the lighter, faster industrial oxygen proposal path.",
  },
  {
    family_key: "MEDO",
    family_name: "MedO",
    origin: "absstem",
    gas_domain: "medical_oxygen",
    quote_mode: "configurator",
    positioning: "Medical oxygen family",
    proposal_profile_key: "oxygen_medical",
    presentation_company_code: "AT",
    selector_model: {
      family_step: true,
      variant_axis: [],
      inputs: ["required_flow_nm3_hr", "purity_pct", "package_mode", "facility_type", "bed_count_or_load"],
    },
    proposal_blocks: {
      executive_summary: ["clinical_need", "healthcare_solution_fit", "continuity_of_supply"],
      scope_summary: ["generator", "controls", "air_receiver", "oxygen_storage", "remarks"],
      proof_points: ["healthcare_positioning", "continuity_of_supply", "operator_simplicity"],
    },
    annexure_policy: "optional_family_annexure",
    notes: "Medical oxygen proposals must present on AT healthcare letterhead.",
  },
  {
    family_key: "MEDO_C",
    family_name: "MedO C",
    origin: "absstem",
    gas_domain: "medical_oxygen",
    quote_mode: "configurator",
    positioning: "Compact medical oxygen family",
    proposal_profile_key: "oxygen_medical_compact",
    presentation_company_code: "AT",
    selector_model: {
      family_step: true,
      variant_axis: [],
      inputs: ["required_flow_nm3_hr", "purity_pct", "package_mode", "facility_type", "space_constraint"],
    },
    proposal_blocks: {
      executive_summary: ["clinical_need", "compact_healthcare_fit", "continuity_of_supply"],
      scope_summary: ["generator", "digital_controller", "air_receiver", "oxygen_storage", "remarks"],
      proof_points: ["compactness", "operator_simplicity", "healthcare_positioning"],
    },
    annexure_policy: "optional_family_annexure",
    notes: "Use AT healthcare presentation profile even when the quote starts in a mixed sales context.",
  },
];

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function buildLineSearchText(line) {
  return normalizeText(
    [
      line?.item_code,
      line?.item_name,
      line?.product_item_code,
      line?.product_item_name,
      line?.product_group_name,
      line?.product_description,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function inferNgenVariant(searchText) {
  if (/\bHF\b/.test(searchText)) return "HF";
  if (/\bSH\b/.test(searchText)) return "SH";
  if (/\bUH\b/.test(searchText)) return "UH";
  return null;
}

function detectProductFamily(searchText) {
  if (!searchText) return null;
  if (/\bMEDO\s*C\b|\bMEDICAL OXYGEN\b.*\bCOMPACT\b|\bCUSTOM PSA MEDICAL OXYGEN\b/.test(searchText)) return "MEDO_C";
  if (/\bMEDO\b|\bMEDICAL OXYGEN\b|\bPSA MEDICAL OXYGEN\b/.test(searchText)) return "MEDO";
  if (/\bIDOS\s*C\b|\bIDOS\d+(?:\.\d+)?C\b|\bCUSTOM PSA INDUSTRIAL OXYGEN\b/.test(searchText)) return "IDOS_C";
  if (/\bIDOS\b|\bINDUSTRIAL OXYGEN\b|\bPSA INDUSTRIAL OXYGEN\b/.test(searchText)) return "IDOS";
  if (/\bNGENX\b|\bCOMPACT PSA NITROGEN\b/.test(searchText)) return "NGENX";
  if (/\bNGEN\b|\bPSA INDUSTRIAL NITROGEN\b/.test(searchText)) return "NGEN";
  return null;
}

function getProductFamilyRule(familyKey) {
  return PRODUCT_FAMILY_MATRIX.find((row) => row.family_key === familyKey) || null;
}

function classifyProductLine(line) {
  const searchText = buildLineSearchText(line);
  const explicitFamily = normalizeText(line?.product_family_key || line?.family_key).replace(/\s+/g, "_");
  const familyKey =
    (PRODUCT_FAMILY_MATRIX.some((row) => row.family_key === explicitFamily) ? explicitFamily : null) ||
    detectProductFamily(searchText);
  const familyRule = getProductFamilyRule(familyKey);
  const explicitVariant = normalizeText(line?.product_variant_key || line?.variant_key);
  const variantKey =
    familyKey === "NGEN"
      ? (["HF", "SH", "UH"].includes(explicitVariant) ? explicitVariant : inferNgenVariant(searchText))
      : null;
  const explicitModule = String(line?.product_module_role || line?.module_role || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return {
    family_key: familyKey,
    family_rule: familyRule,
    variant_key: variantKey,
    module_role: explicitModule || null,
    search_text: searchText,
    is_mapped_family: Boolean(familyRule),
  };
}

function summarizeQuoteConfiguratorContext(lines) {
  const classified = (Array.isArray(lines) ? lines : []).map((line) => ({
    line,
    ...classifyProductLine(line),
  }));

  const familyKeys = Array.from(new Set(classified.map((row) => row.family_key).filter(Boolean)));
  const familyRules = familyKeys.map((key) => getProductFamilyRule(key)).filter(Boolean);
  const containsMedicalOxygen = familyKeys.includes("MEDO") || familyKeys.includes("MEDO_C");
  const containsIndustrialFamily = familyRules.some((row) => row.gas_domain !== "medical_oxygen");
  const primaryFamily = familyRules[0] || null;

  return {
    classified_lines: classified,
    family_keys: familyKeys,
    family_rules: familyRules,
    primary_family_key: primaryFamily?.family_key || null,
    primary_family_name: primaryFamily?.family_name || null,
    default_quote_mode: familyRules.length ? "configurator" : "scope_upload",
    contains_medical_oxygen: containsMedicalOxygen,
    mixed_branding_risk: containsMedicalOxygen && containsIndustrialFamily,
  };
}

function resolveQuotePresentationPolicy({ quote, lines }) {
  const summary = summarizeQuoteConfiguratorContext(lines);
  const fallbackCompanyCode = normalizeText(quote?.company_code) || "AI";

  if (summary.contains_medical_oxygen) {
    return {
      ...summary,
      presentation_company_code: "AT",
      route_reason: "Medical oxygen families use the AT healthcare presentation profile and letterhead.",
      recommended_split_quote: summary.mixed_branding_risk,
    };
  }

  const primaryRule = getProductFamilyRule(summary.primary_family_key);
  return {
    ...summary,
    presentation_company_code: primaryRule?.presentation_company_code || fallbackCompanyCode,
    route_reason: primaryRule
      ? `${primaryRule.family_name} follows the ${primaryRule.presentation_company_code || fallbackCompanyCode} presentation profile.`
      : "No mapped Absstem family detected, so the quote stays on the current company profile and upload-based scope flow.",
    recommended_split_quote: false,
  };
}

module.exports = {
  PRODUCT_FAMILY_MATRIX,
  classifyProductLine,
  getProductFamilyRule,
  resolveQuotePresentationPolicy,
  summarizeQuoteConfiguratorContext,
};
