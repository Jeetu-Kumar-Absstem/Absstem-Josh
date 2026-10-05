import { useEffect, useMemo, useRef, useState } from "react";
import SlideOverDrawer from "../components/SlideOverDrawer";
import {
  DEFAULT_PRICE_TYPES,
  EMPTY_APPROVAL,
  EMPTY_MAIL_BOOTSTRAP,
  apiFetch,
  apiFetchForm,
  dateInputValueFromToday,
  daysUntilDate,
  getApiErrorMessage,
  getPriceListMultiplier,
  normalizePriceTypes,
  parseDraftNumber,
  resolvePriceTypeKey,
  runQuietly,
  toDateInputValue,
  validateDraftLines,
} from "./quoteShared";

function getPriceTypeLabel(priceTypes, priceTypeKey) {
  const options = normalizePriceTypes(priceTypes);
  const key = resolvePriceTypeKey(options, priceTypeKey);
  return options.find((item) => item.key === key)?.label || key;
}

function roundPricing(value, scale = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** scale;
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

function convertBaseAmountToQuote(baseAmount, exchangeRate) {
  const base = Number(baseAmount);
  const rate = Number(exchangeRate);
  if (!Number.isFinite(base)) return 0;
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return roundPricing(base, 2);
  return roundPricing(base / rate, 2);
}

function resolveQuoteExchangeRate(exchangeRates, baseCurrencyId, quoteCurrencyId) {
  const baseId = String(baseCurrencyId || "").trim();
  const quoteId = String(quoteCurrencyId || "").trim();
  if (!baseId || !quoteId || baseId === quoteId) return 1;
  const match = (Array.isArray(exchangeRates) ? exchangeRates : []).find(
    (item) =>
      String(item?.from_currency_id || "").trim() === baseId &&
      String(item?.to_currency_id || "").trim() === quoteId &&
      Number(item?.rate_value) > 0
  );
  return match ? Number(match.rate_value) : 1;
}

function getFallbackDraftLineQuotePrice(product, draftLines) {
  if (!product || !Array.isArray(draftLines) || !draftLines.length) return 0;
  const matched = draftLines.find((line) => {
    if (product.id && line.product_id && String(line.product_id) === String(product.id)) return true;
    if (product.item_code && line.item_code && String(line.item_code).trim().toLowerCase() === String(product.item_code).trim().toLowerCase()) return true;
    return false;
  });
  if (!matched) return 0;
  return Math.max(
    0,
    toNumber(matched.source_list_price, 0),
    toNumber(matched.gross_unit_price_quote, 0),
    toNumber(matched.unit_price_quote, 0)
  );
}

const EMPTY_NEW_CUSTOMER = {
  customer_name: "",
  phone: "",
  email: "",
  contact_name: "",
  contact_email: "",
  contact_phone: "",
  country_id: "",
  state: "",
  city: "",
  address_line1: "",
  pincode: "",
  gstin: "",
};

function shouldReplaceMailValue(currentValue, previousDefault) {
  const current = String(currentValue || "").trim();
  const prior = String(previousDefault || "").trim();
  return !current || current === prior;
}

function statesForCountry(states, countryId) {
  const key = String(countryId || "").trim();
  return (Array.isArray(states) ? states : []).filter((item) => key && String(item.country_id) === key);
}

function citiesForState(cities, stateId) {
  const key = String(stateId || "").trim();
  return (Array.isArray(cities) ? cities : []).filter((item) => key && String(item.state_id) === key);
}

function findStateId(states, countryId, stateName) {
  const name = String(stateName || "").trim().toLowerCase();
  if (!name) return "";
  const match = statesForCountry(states, countryId).find((item) => String(item.state_name || "").trim().toLowerCase() === name);
  return match ? String(match.id) : "";
}

function findCityId(cities, stateId, cityName) {
  const name = String(cityName || "").trim().toLowerCase();
  if (!name) return "";
  const match = citiesForState(cities, stateId).find((item) => String(item.city_name || "").trim().toLowerCase() === name);
  return match ? String(match.id) : "";
}

function appendCityOption(cities, city) {
  if (!city?.id) return Array.isArray(cities) ? cities : [];
  const list = Array.isArray(cities) ? cities : [];
  if (list.some((item) => String(item.id) === String(city.id))) return list;
  return [...list, city].sort((a, b) => {
    const stateCompare = String(a?.state_name || "").localeCompare(String(b?.state_name || ""));
    if (stateCompare !== 0) return stateCompare;
    return String(a?.city_name || "").localeCompare(String(b?.city_name || ""));
  });
}

function findIndiaCountryId(countries) {
  const list = Array.isArray(countries) ? countries : [];
  const direct = list.find((item) => String(item?.iso_code || "").trim().toUpperCase() === "IN");
  if (direct?.id !== undefined && direct?.id !== null) return String(direct.id);
  const byName = list.find((item) => String(item?.country_name || "").trim().toLowerCase() === "india");
  return byName?.id !== undefined && byName?.id !== null ? String(byName.id) : "";
}

function isHealthcareConfiguratorFamilyKey(value) {
  const key = String(value || "").trim().toUpperCase();
  return key === "MEDO" || key === "MEDO_C";
}

function normalizeLookupText(value) {
  return String(value || "").trim().toLowerCase();
}

function findDefaultPaymentTermId(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const exactCode = list.find((item) => normalizeLookupText(item?.term_code) === "adv50");
  if (exactCode?.id !== undefined && exactCode?.id !== null) return String(exactCode.id);
  const fallback = list.find((item) => {
    const text = `${normalizeLookupText(item?.term_code)} ${normalizeLookupText(item?.term_name)}`;
    return text.includes("adv50") || text.includes("50% advance") || text.includes("50 advance");
  });
  return fallback?.id !== undefined && fallback?.id !== null ? String(fallback.id) : "";
}

function findDefaultFreightTermId(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const fallback = list.find((item) => {
    const text = `${normalizeLookupText(item?.term_code)} ${normalizeLookupText(item?.term_name)}`;
    return text.includes("extra at actual") || (text.includes("extra") && text.includes("actual"));
  });
  return fallback?.id !== undefined && fallback?.id !== null ? String(fallback.id) : "";
}

function findDefaultIncotermId(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const exactCode = list.find((item) => normalizeLookupText(item?.incoterm_code) === "exw");
  if (exactCode?.id !== undefined && exactCode?.id !== null) return String(exactCode.id);
  const fallback = list.find((item) => {
    const text = `${normalizeLookupText(item?.incoterm_code)} ${normalizeLookupText(item?.incoterm_name)}`;
    return text.includes("exw") || text.includes("ex works");
  });
  return fallback?.id !== undefined && fallback?.id !== null ? String(fallback.id) : "";
}

function findDefaultPAndFTermId(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const exactCode = list.find((item) => normalizeLookupText(item?.term_code) === "extra");
  if (exactCode?.id !== undefined && exactCode?.id !== null) return String(exactCode.id);
  const fallback = list.find((item) => {
    const text = `${normalizeLookupText(item?.term_code)} ${normalizeLookupText(item?.term_name)}`;
    return text.includes("extra at actual") || text.includes("packing") || text.includes("forwarding");
  });
  return fallback?.id !== undefined && fallback?.id !== null ? String(fallback.id) : "";
}

function getManagedCommercialTermKind(value) {
  const caption = normalizeLookupText(value).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  if (caption === "incoterm" || caption === "incoterms") return "incoterm";
  if (caption === "payment term" || caption === "payment terms") return "payment_term";
  if (caption === "freight term" || caption === "freight terms" || caption === "freight") return "freight_term";
  if (caption === "p f" || caption === "p f terms" || caption === "packing forwarding" || caption === "packing and forwarding") {
    return "p_and_f_term";
  }
  return "";
}

function isManagedCommercialTerm(value) {
  return Boolean(getManagedCommercialTermKind(value));
}

const CONFIGURATOR_FAMILIES = [
  {
    key: "NGEN",
    label: "nGEN",
    gas: "nitrogen",
    company: "AI",
    image_url: "https://absstem.com/wp-content/uploads/2026/05/nGEN-image.webp",
    proposalProfileKey: "industrial_premium",
    title: "Premium industrial nitrogen",
    note: "Uses the nitrogen sizing engine with premium family positioning.",
    variants: "HF / SH / UH",
    packageHint: "Best for premium nitrogen packages and higher-spec proposal stories.",
    proofPoints: ["Purity stability tuned for industrial duty", "Automation-friendly package philosophy", "Premium positioning for reliability-focused proposals"],
  },
  {
    key: "NGENX",
    label: "nGENX",
    gas: "nitrogen",
    company: "AI",
    image_url: "https://absstem.com/wp-content/uploads/2026/05/ngenx-image-new.webp",
    proposalProfileKey: "industrial_compact",
    title: "Compact value nitrogen",
    note: "Uses the nitrogen sizing engine with a lighter compact/value proposal tone.",
    variants: "Compact line",
    packageHint: "Best for value-focused nitrogen packages with smaller footprint emphasis.",
    proofPoints: ["Compact layout positioning", "Simpler adoption story for operators", "Value-led proposal framing"],
  },
  {
    key: "IDOS",
    label: "IDOS",
    gas: "oxygen",
    company: "AI",
    image_url: "https://absstem.com/wp-content/uploads/2026/05/idos-new-img.webp",
    proposalProfileKey: "oxygen_industrial",
    title: "Industrial oxygen",
    note: "Uses the oxygen sizing engine with industrial process positioning.",
    variants: "Main line",
    packageHint: "Best for process oxygen packages in production environments.",
    proofPoints: ["Process continuity positioning", "On-site oxygen availability for plant use", "Industrial duty language instead of clinical framing"],
  },
  {
    key: "IDOS_C",
    label: "IDOS C",
    gas: "oxygen",
    company: "AI",
    image_url: "https://absstem.com/wp-content/uploads/2026/05/idos-c.webp",
    proposalProfileKey: "oxygen_industrial_compact",
    title: "Compact industrial oxygen",
    note: "Uses the oxygen sizing engine with compact deployment positioning.",
    variants: "Compact line",
    packageHint: "Best for compact oxygen packages and faster-deployment use cases.",
    proofPoints: ["Compact footprint story", "Faster deployment framing", "Lean industrial oxygen package positioning"],
  },
  {
    key: "MEDO",
    label: "MedO",
    gas: "oxygen",
    company: "AT",
    image_url: "https://absstem.com/wp-content/uploads/2026/05/absstem-medo-plant-front.webp",
    proposalProfileKey: "oxygen_medical",
    title: "Medical oxygen",
    note: "Uses the oxygen sizing engine and routes the proposal to AT healthcare presentation.",
    variants: "Healthcare line",
    packageHint: "Best for hospital and healthcare continuity-of-supply proposals.",
    proofPoints: ["Healthcare continuity-of-supply positioning", "Operator simplicity for staff usage", "AT healthcare presentation profile"],
  },
  {
    key: "MEDO_C",
    label: "MedO C",
    gas: "oxygen",
    company: "AT",
    image_url: "https://absstem.com/wp-content/uploads/2026/05/medO-custom.webp",
    proposalProfileKey: "oxygen_medical_compact",
    title: "Compact medical oxygen",
    note: "Uses the oxygen sizing engine with AT healthcare presentation and compact healthcare framing.",
    variants: "Compact healthcare",
    packageHint: "Best for smaller healthcare footprints and compact medical oxygen projects.",
    proofPoints: ["Compact healthcare fit", "Operator-friendly medical oxygen framing", "AT healthcare presentation profile"],
  },
];

function pickConfiguratorModel(rec, selectedModel) {
  if (!rec || typeof rec !== "object") return null;
  const selected = Array.isArray(rec.options) ? rec.options.find((option) => option?.model === selectedModel) : null;
  return selected || rec.recommended || null;
}

function dedupeStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function inferNgenVariantFromValue(value) {
  const text = normalizeConfiguratorSearchText(value);
  if (!text) return "";
  if (/\bUH\b/.test(text)) return "UH";
  if (/\bSH\b/.test(text)) return "SH";
  if (/\bHF\b/.test(text)) return "HF";
  return "";
}

function describeConfiguratorVariant({ family, selectedPackage }) {
  const activeFamily = family || CONFIGURATOR_FAMILIES[0];
  const selectedModel = String(selectedPackage?.model || "").trim();
  if (activeFamily.key === "NGEN") {
    const variant = inferNgenVariantFromValue(selectedModel);
    if (variant === "HF") {
      return {
        key: "HF",
        label: "HF",
        story: "High-flow premium nitrogen positioning",
        proofPoints: [
          "Higher flow-oriented package story",
          "Premium nitrogen framing for continuous industrial duty",
          "Better fit where throughput matters more than ultra-high purity positioning",
        ],
      };
    }
    if (variant === "SH") {
      return {
        key: "SH",
        label: "SH",
        story: "Standard high-performance nitrogen positioning",
        proofPoints: [
          "Balanced premium nitrogen positioning",
          "Stronger all-round industrial proposal story",
          "Good fit for mainstream high-performance nitrogen applications",
        ],
      };
    }
    if (variant === "UH") {
      return {
        key: "UH",
        label: "UH",
        story: "Ultra-high-purity nitrogen positioning",
        proofPoints: [
          "Purity-led premium nitrogen positioning",
          "Stronger emphasis on quality-sensitive applications",
          "Use a more exacting performance and control story",
        ],
      };
    }
  }
  if (activeFamily.key === "NGENX") {
    return {
      key: "COMPACT_VALUE",
      label: "Compact value",
      story: "Value-focused compact nitrogen positioning",
      proofPoints: [
        "Smaller footprint and simpler adoption story",
        "Commercial framing stays lighter than nGEN",
        "Best when practicality and value matter more than premium narrative depth",
      ],
    };
  }
  if (activeFamily.key === "IDOS_C") {
    return {
      key: "COMPACT_OXYGEN",
      label: "Compact industrial oxygen",
      story: "Footprint-aware industrial oxygen positioning",
      proofPoints: [
        "Compact deployment and faster installation emphasis",
        "Lean industrial oxygen story for site-conscious projects",
        "Best where process oxygen is needed with tighter space constraints",
      ],
    };
  }
  if (activeFamily.key === "MEDO") {
    return {
      key: "HEALTHCARE_CONTINUITY",
      label: "Healthcare continuity",
      story: "Hospital-facing continuity-of-supply positioning",
      proofPoints: [
        "Healthcare continuity and operator simplicity emphasis",
        "AT healthcare presentation remains primary",
        "Best for hospital and clinical oxygen continuity narratives",
      ],
    };
  }
  if (activeFamily.key === "MEDO_C") {
    return {
      key: "COMPACT_HEALTHCARE",
      label: "Compact healthcare",
      story: "Space-aware healthcare oxygen positioning",
      proofPoints: [
        "Compact hospital or clinic deployment story",
        "Operator-friendly medical oxygen framing",
        "Best for smaller healthcare footprints with AT presentation",
      ],
    };
  }
  return { key: "", label: "", story: "", proofPoints: [] };
}

function buildConfiguratorNarrative({
  family,
  lines,
  rec,
  selectedModel,
  packageMode,
  customerName,
  siteName,
}) {
  const activeFamily = family || CONFIGURATOR_FAMILIES[0];
  const selectedPackage = pickConfiguratorModel(rec, selectedModel);
  const variantDescriptor = describeConfiguratorVariant({ family: activeFamily, selectedPackage });
  const includedLines = (Array.isArray(lines) ? lines : []).filter((line) => String(line?.scope_type || "included") === "included");
  const deliverables = includedLines.map((line) => ({
    model: String(line?.item_name || line?.item_code || "").trim(),
    description: String(line?.product_group_name || line?.group_name || line?.product_description || "").trim(),
    qty: toNumber(line?.qty, 0) || 0,
    remarks: String(line?.remarks || "").trim(),
  }));
  const packageDescriptor = selectedPackage?.model ? `${activeFamily.label} package based on ${selectedPackage.model}` : `${activeFamily.label} package`;
  const siteDescriptor = siteName ? ` for ${siteName}` : "";
  const customerDescriptor = customerName ? ` for ${customerName}` : "";

  let problem = "On-site gas generation is required with a controlled, proposal-ready package.";
  let solution = `${packageDescriptor} is proposed${customerDescriptor}${siteDescriptor} to match the stated duty and reduce dependence on external supply logistics.`;
  let note = `${activeFamily.label} follows the ${activeFamily.company} presentation profile.`;
  let assumptions = [
    "Final performance confirmation remains subject to approved operating conditions, utility availability, and final layout review.",
  ];
  let exclusions = ["Civil work, electrical cabling beyond equipment limits, and statutory approvals remain outside this quote unless listed separately."];
  let acceptance = ["Performance demonstration will be aligned to the selected flow and purity basis under agreed operating conditions."];
  let responsibilities = [
    { party: "absstem", responsibility: "Supply the quoted package and standard documentation as listed in the deliverables." },
    { party: "Client", responsibility: "Provide utilities, installation space, and all site-side readiness required for commissioning." },
  ];

  if (activeFamily.key === "NGEN") {
    problem = "The application needs dependable nitrogen availability with stronger purity and automation expectations.";
    solution = `${packageDescriptor} is proposed${customerDescriptor}${siteDescriptor} to deliver premium on-site nitrogen generation with a stronger technical and reliability story.`;
    note = "Use premium industrial language with emphasis on purity stability, controls, and reliability.";
    if (variantDescriptor.key === "HF") {
      problem = "The application needs dependable nitrogen generation with stronger flow-oriented package planning.";
      solution = `${packageDescriptor} is proposed${customerDescriptor}${siteDescriptor} with HF positioning for higher-throughput nitrogen demand and premium industrial reliability.`;
      note = "Use premium flow-led language with emphasis on throughput, continuity, and industrial duty.";
    } else if (variantDescriptor.key === "SH") {
      note = "Use balanced premium industrial language with equal emphasis on performance, controls, and reliability.";
    } else if (variantDescriptor.key === "UH") {
      problem = "The application needs dependable nitrogen generation with stronger purity-sensitive positioning.";
      solution = `${packageDescriptor} is proposed${customerDescriptor}${siteDescriptor} with UH positioning for purity-led industrial use cases and tighter performance expectations.`;
      note = "Use purity-led premium language with emphasis on exacting performance, controls, and stability.";
    }
    assumptions = [
      "Nitrogen duty basis and purity expectation are assumed as per the selected configurator inputs.",
      "Final package confirmation remains subject to approved utilities, ambient conditions, and layout review.",
    ];
  } else if (activeFamily.key === "NGENX") {
    problem = "The application needs a compact and value-oriented nitrogen generation package without free-text customization.";
    solution = `${packageDescriptor} is proposed${customerDescriptor}${siteDescriptor} to provide a cleaner, smaller-footprint nitrogen solution with simpler commercial framing.`;
    note = "Use value-focused language with cleaner deliverables and faster deployment tone.";
    assumptions = [
      "Compact package suitability is assumed based on current flow and purity inputs.",
      "Final scope remains subject to space confirmation and utility readiness.",
    ];
  } else if (activeFamily.key === "IDOS") {
    problem = "The process requires dependable on-site oxygen availability for production or plant use.";
    solution = `${packageDescriptor} is proposed${customerDescriptor}${siteDescriptor} to support industrial oxygen continuity with process-oriented proposal language.`;
    note = "Keep proposal tone industrial and production-focused, not clinical.";
    assumptions = [
      "Oxygen demand basis is assumed as per the selected duty inputs.",
      "Final package confirmation remains subject to utility conditions and site integration review.",
    ];
  } else if (activeFamily.key === "IDOS_C") {
    problem = "The application needs industrial oxygen generation with a footprint-aware and faster-deployment package approach.";
    solution = `${packageDescriptor} is proposed${customerDescriptor}${siteDescriptor} to provide compact industrial oxygen generation with leaner deployment framing.`;
    note = "Use compact industrial language with emphasis on installation ease and footprint.";
    assumptions = [
      "Compact package fit is assumed based on current flow and layout expectations.",
      "Final scope remains subject to site readiness and utility review.",
    ];
  } else if (activeFamily.key === "MEDO") {
    problem = "The facility needs dependable medical oxygen continuity with healthcare-facing presentation and operator-friendly operation.";
    solution = `${packageDescriptor} is proposed${customerDescriptor}${siteDescriptor} to support on-site medical oxygen continuity under the AT healthcare presentation profile.`;
    note = "Medical oxygen proposals must stay on AT healthcare presentation with continuity-of-supply language.";
    assumptions = [
      "Clinical oxygen demand and operating profile are assumed from the selected configurator inputs.",
      "Final package confirmation remains subject to facility utilities, space, and site approval requirements.",
    ];
    exclusions = ["Pipeline interfacing, civil work, electrical cabling beyond equipment limits, and statutory approvals remain outside this quote unless listed separately."];
    responsibilities = [
      { party: "absstem", responsibility: "Supply the quoted medical oxygen package and standard documentation listed in the deliverables." },
      { party: "Client", responsibility: "Provide utilities, installation space, and hospital-side readiness needed for commissioning." },
    ];
  } else if (activeFamily.key === "MEDO_C") {
    problem = "The facility needs a compact medical oxygen solution with healthcare-ready presentation and easier operator adoption.";
    solution = `${packageDescriptor} is proposed${customerDescriptor}${siteDescriptor} for smaller or space-aware healthcare environments under the AT healthcare presentation profile.`;
    note = "Use compact healthcare language while preserving AT medical presentation.";
    assumptions = [
      "Compact healthcare package fit is assumed from the selected duty and site expectations.",
      "Final scope remains subject to facility utilities, space, and installation review.",
    ];
    exclusions = ["Pipeline interfacing, civil work, electrical cabling beyond equipment limits, and statutory approvals remain outside this quote unless listed separately."];
    responsibilities = [
      { party: "absstem", responsibility: "Supply the quoted compact medical oxygen package and standard documentation listed in the deliverables." },
      { party: "Client", responsibility: "Provide utilities, installation space, and healthcare-side readiness needed for commissioning." },
    ];
  }

  if (packageMode === "psa_only") {
    exclusions = dedupeStrings([
      ...exclusions,
      activeFamily.gas === "nitrogen"
        ? "Compressor package and downstream accessories remain in client scope unless explicitly added from Product Master."
        : "Compressor package and balance accessories remain in client scope unless explicitly added from Product Master.",
    ]);
    responsibilities = dedupeStrings([
      ...responsibilities.map((row) => `${row.party}|${row.responsibility}`),
      "Client|Provide all balance-of-plant items required outside the PSA-only package.",
    ]).map((value) => {
      const [party, responsibility] = value.split("|");
      return { party, responsibility };
    });
  }

  const highlights = dedupeStrings([
    variantDescriptor.label ? `Story delta: ${variantDescriptor.label}` : "",
    selectedPackage?.model ? `Recommended model: ${selectedPackage.model}` : "",
    selectedPackage?.flow ? `Configured flow basis: ${selectedPackage.flow}` : "",
    selectedPackage?.airRequirement ? `Air requirement reference: ${selectedPackage.airRequirement} CFM` : "",
    selectedPackage?.storageVolume ? `Suggested storage reference: ${selectedPackage.storageVolume} L` : "",
    ...(variantDescriptor.proofPoints.length ? variantDescriptor.proofPoints : activeFamily.proofPoints || []),
  ]);

  const techHighlights = dedupeStrings([
    variantDescriptor.story ? variantDescriptor.story : "",
    selectedPackage?.model ? `${selectedPackage.model} selected as the nearest package basis from the configurator.` : "",
    packageMode === "psa_only" ? "Package mode is PSA only." : "Package mode includes PSA with bundled package components as applicable.",
    ...deliverables.slice(0, 4).map((row) => `${row.model} included in quoted deliverables.`),
    ...(variantDescriptor.proofPoints.length ? variantDescriptor.proofPoints : activeFamily.proofPoints || []),
  ]);

  return {
    executive_summary: {
      problem,
      solution,
      highlights,
      note,
    },
    scope_summary: {
      deliverables,
      tech_highlights: techHighlights,
      exclusions,
      assumptions,
      acceptance,
      responsibilities,
    },
  };
}

function normalizeConfiguratorSearchText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function detectConfiguratorFamilyKeyFromText(value) {
  const text = normalizeConfiguratorSearchText(value);
  if (!text) return "";
  if (/\bMEDO\s*C\b|\bMEDICAL OXYGEN\b.*\bCOMPACT\b|\bCUSTOM PSA MEDICAL OXYGEN\b/.test(text)) return "MEDO_C";
  if (/\bMEDO\b|\bMEDICAL OXYGEN\b|\bPSA MEDICAL OXYGEN\b/.test(text)) return "MEDO";
  if (/\bIDOS\s*C\b|\bIDOS\d+(?:\.\d+)?C\b|\bCUSTOM PSA INDUSTRIAL OXYGEN\b/.test(text)) return "IDOS_C";
  if (/\bIDOS\b|\bINDUSTRIAL OXYGEN\b|\bPSA INDUSTRIAL OXYGEN\b/.test(text)) return "IDOS";
  if (/\bNGENX\b|\bCOMPACT PSA NITROGEN\b/.test(text)) return "NGENX";
  if (/\bNGEN\b|\bPSA INDUSTRIAL NITROGEN\b/.test(text)) return "NGEN";
  return "";
}

function detectConfiguratorFamilyKeyFromLine(line) {
  return detectConfiguratorFamilyKeyFromText(
    [line?.item_code, line?.item_name, line?.remarks]
      .filter(Boolean)
      .join(" ")
  );
}

function summarizeDraftConfiguratorFamilies(lines) {
  const familyKeys = Array.from(
    new Set(
      (Array.isArray(lines) ? lines : [])
        .map((line) => detectConfiguratorFamilyKeyFromLine(line))
        .filter(Boolean)
    )
  );
  const familyRecords = familyKeys
    .map((key) => CONFIGURATOR_FAMILIES.find((family) => family.key === key) || null)
    .filter(Boolean);
  const containsMedical = familyRecords.some((family) => family.company === "AT");
  const containsIndustrial = familyRecords.some((family) => family.company === "AI");
  return {
    familyKeys,
    familyRecords,
    mixedBrandingRisk: containsMedical && containsIndustrial,
  };
}

function buildConfiguratorRecommendationCard({ family, rec, selectedModel, packageMode, lines }) {
  const activeFamily = family || CONFIGURATOR_FAMILIES[0];
  const selectedPackage = pickConfiguratorModel(rec, selectedModel);
  const variantDescriptor = describeConfiguratorVariant({ family: activeFamily, selectedPackage });
  const draftSummary = summarizeDraftConfiguratorFamilies(lines);
  const otherFamilies = draftSummary.familyRecords.filter((item) => item.key !== activeFamily.key);
  const routeReason =
    activeFamily.company === "AT"
      ? `${activeFamily.label} routes this proposal to AT healthcare presentation.`
      : `${activeFamily.label} routes this proposal to AI industrial presentation.`;
  const warnings = [];
  if (draftSummary.mixedBrandingRisk) {
    warnings.push("Current draft already mixes medical and industrial families. Split-quote review is recommended.");
  }
  if (otherFamilies.length) {
    warnings.push(`Current draft also contains: ${otherFamilies.map((item) => item.label).join(", ")}.`);
  }
  if (packageMode === "psa_only") {
    warnings.push("PSA only mode keeps balance-of-plant scope outside the configurator package unless added separately from Product Master.");
  }
  return {
    familyLabel: activeFamily.label,
    familyTitle: activeFamily.title,
    proposalProfileKey: activeFamily.proposalProfileKey,
    company: activeFamily.company,
    variantKey: variantDescriptor.key,
    variantLabel: variantDescriptor.label,
    variantStory: variantDescriptor.story,
    selectedModel: selectedPackage?.model || selectedModel || rec?.recommended?.model || "",
    selectedFlow: selectedPackage?.flow || "",
    selectedAirRequirement: selectedPackage?.airRequirement ?? rec?.recommended?.airRequirement ?? "",
    selectedStorageVolume: selectedPackage?.storageVolume ?? rec?.recommended?.storageVolume ?? "",
    routeReason,
    proofPoints: variantDescriptor.proofPoints.length ? variantDescriptor.proofPoints : activeFamily.proofPoints || [],
    warnings,
    draftFamiliesLabel: draftSummary.familyRecords.map((item) => item.label).join(", "),
    draftFamilyKeys: draftSummary.familyKeys,
    mixedBrandingRisk: draftSummary.mixedBrandingRisk,
    recommendedSplitQuote: draftSummary.mixedBrandingRisk,
  };
}

function buildConfiguratorContextPayload({ family, rec, selectedModel, packageMode, lines, preview }) {
  const activeCard = buildConfiguratorRecommendationCard({ family, rec, selectedModel, packageMode, lines });
  const executive = preview?.executive_summary || {};
  const scope = preview?.scope_summary || {};
  return {
    source: activeCard.selectedModel || activeCard.familyLabel ? "ui_configurator" : "none",
    family_key: family?.key || null,
    family_label: activeCard.familyLabel || family?.label || null,
    family_title: activeCard.familyTitle || family?.title || null,
    proposal_profile_key: activeCard.proposalProfileKey || null,
    presentation_company_code: activeCard.company || null,
    variant_key: activeCard.variantKey || null,
    variant_label: activeCard.variantLabel || null,
    variant_story: activeCard.variantStory || "",
    selected_model: activeCard.selectedModel || null,
    selected_flow: activeCard.selectedFlow || null,
    selected_air_requirement: activeCard.selectedAirRequirement || null,
    selected_storage_volume: activeCard.selectedStorageVolume || null,
    package_mode: packageMode || "",
    route_reason: activeCard.routeReason || "",
    proof_points: Array.isArray(activeCard.proofPoints) ? activeCard.proofPoints : [],
    warnings: Array.isArray(activeCard.warnings) ? activeCard.warnings : [],
    family_keys: Array.isArray(activeCard.draftFamilyKeys) ? activeCard.draftFamilyKeys : [],
    mixed_branding_risk: activeCard.mixedBrandingRisk === true,
    recommended_split_quote: activeCard.recommendedSplitQuote === true,
    preview_problem: executive.problem || "",
    preview_solution: executive.solution || "",
    preview_deliverable_count: Array.isArray(scope.deliverables) ? scope.deliverables.length : 0,
  };
}

async function createCityMaster({ countryId, stateId, cityName }) {
  const data = await apiFetch("/customers/location-masters/cities", {
    method: "POST",
    body: JSON.stringify({
      country_id: countryId,
      state_id: stateId,
      city_name: cityName,
    }),
  });
  return data?.city || null;
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12, minWidth: 0 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function CustomerChip({ label, tone = "#eef4ff", color = "#2354d5", borderColor = "rgba(35,84,213,0.14)" }) {
  if (!label) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderRadius: 999,
        background: tone,
        color,
        border: `1px solid ${borderColor}`,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.01em",
      }}
    >
      {label}
    </span>
  );
}

function CustomerStatCard({ label, value, accent = "#2354d5" }) {
  const isAffirmative = String(value).toLowerCase() === "yes";
  return (
    <div
      style={{
        border: "1px solid rgba(152,174,219,0.28)",
        borderRadius: 14,
        padding: 12,
        background: "linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(245,248,255,0.94) 100%)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.82)",
        transition: "transform 160ms ease, box-shadow 160ms ease",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ marginTop: 8, fontSize: 20, fontWeight: 800, color: accent }}>{value}</div>
      {label === "Mail Ready" ? (
        <div style={{ marginTop: 6, fontSize: 11, opacity: 0.64 }}>{isAffirmative ? "Recipient flow looks ready" : "Recipient email still needed"}</div>
      ) : null}
    </div>
  );
}

function DraftLineCard({
  line,
  isAdvancedOpen,
  onToggleAdvanced,
  onMove,
  onDuplicate,
  onRemove,
  onChange,
  lineTotal,
  priceTypeOptions,
  priceHint = null,
  floorHint = null,
}) {
  return (
    <div style={{ border: "1px solid #efefef", borderRadius: 12, padding: 12, background: "#fff" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {line.item_name || "Manual Item"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, lineHeight: 1.5 }}>
            {[
              line.item_code || "Manual",
              line.hsn_no ? `HSN ${line.hsn_no}` : null,
              `GST ${toNumber(line.gst_pct, 0).toFixed(2)}%`,
              line.scope_type || "included",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={() => onMove("up")}>
            Up
          </button>
          <button type="button" onClick={() => onMove("down")}>
            Down
          </button>
          <button type="button" onClick={onDuplicate}>
            Duplicate
          </button>
          <button type="button" onClick={onToggleAdvanced}>
            {isAdvancedOpen ? "Hide Advanced" : "Advanced Settings"}
          </button>
          <button type="button" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <Field label="Qty">
          <input
            type="number"
            value={line.qty}
            onChange={(e) => onChange({ qty: e.target.value }, "disc_pct")}
            min={1}
            step={1}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="Scope">
          <select value={line.scope_type} onChange={(e) => onChange({ scope_type: e.target.value })} style={{ width: "100%" }}>
            <option value="included">Included</option>
            <option value="client_scope">Client Scope</option>
            <option value="quoted_separately">Quoted Separately</option>
          </select>
        </Field>
        <Field label="Net Unit">
          <input
            type="number"
            value={line.unit_price_quote}
            min={0}
            step={0.01}
            readOnly
            style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
          />
          {priceHint ? (
            <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.55, opacity: 0.8 }}>
              <div>
                {priceHint.last_quoted_unit != null
                  ? `Last quoted ${Number(priceHint.last_quoted_unit).toFixed(2)}${
                      priceHint.last_quoted_number ? ` (${priceHint.last_quoted_number})` : ""
                    }${priceHint.last_quoted_at ? ` · ${String(priceHint.last_quoted_at).slice(0, 10)}` : ""}`
                  : "No prior quote"}
              </div>
              {priceHint.last_sold_unit != null ? (
                <div>
                  Last sold {Number(priceHint.last_sold_unit).toFixed(2)}
                  {priceHint.last_sold_number ? ` (${priceHint.last_sold_number})` : ""}
                  {priceHint.last_sold_at ? ` · ${String(priceHint.last_sold_at).slice(0, 10)}` : ""}
                </div>
              ) : null}
            </div>
          ) : null}
          {floorHint ? (
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                lineHeight: 1.5,
                color: floorHint.breached ? "#9f2042" : "#31539d",
                opacity: 0.9,
              }}
            >
              Floor {Number(floorHint.floor).toFixed(2)} ({Number(floorHint.minPct).toFixed(0)}% of list)
              {floorHint.breached ? " — below company floor" : ""}
            </div>
          ) : null}
        </Field>
        <Field label="Line Total">
          <div style={{ padding: "10px 0", fontWeight: 700 }}>{lineTotal}</div>
        </Field>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, alignItems: "end" }}>
        <Field label="Customer Part Code">
          <input
            value={line.customer_item_code || ""}
            onChange={(e) => onChange({ customer_item_code: e.target.value })}
            placeholder="SAP / customer item code"
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="Customer Part Description">
          <input
            value={line.customer_item_description || ""}
            onChange={(e) => onChange({ customer_item_description: e.target.value })}
            placeholder="Customer material description"
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="Remarks">
          <input
            value={line.remarks}
            onChange={(e) => onChange({ remarks: e.target.value })}
            placeholder="Line remarks or commercial note"
            style={{ width: "100%" }}
          />
        </Field>
      </div>

      {isAdvancedOpen ? (
        <div style={{ marginTop: 10, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#f8fbff" }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#2354d5" }}>Manual Override</div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
            Use only when you need an exception to the standard recommended pricing flow.
          </div>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <Field label="Gross Unit">
              <input
                type="number"
                value={line.gross_unit_price_quote}
                min={0}
                step={0.01}
                readOnly
                style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
              />
            </Field>
            <Field label="Disc %">
              <input
                type="number"
                value={line.discount_pct}
                onChange={(e) => onChange({ discount_pct: e.target.value, discount_amt: "" }, "disc_pct")}
                min={0}
                step={0.01}
                style={{ width: "100%" }}
              />
            </Field>
            <Field label="Disc Amt">
              <input
                type="number"
                value={line.discount_amt}
                min={0}
                step={0.01}
                readOnly
                style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
              />
            </Field>
            <Field label="GST%">
              <input
                type="number"
                value={line.gst_pct}
                onChange={(e) => onChange({ gst_pct: e.target.value })}
                min={0}
                max={100}
                step={0.01}
                style={{ width: "100%" }}
              />
            </Field>
            <Field label="Price List">
              <select value={resolvePriceTypeKey(priceTypeOptions, line.price_list)} onChange={(e) => onChange({ price_list: e.target.value })} style={{ width: "100%" }}>
                {priceTypeOptions.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SidebarMetricCard({ label, value, note, accent = "#2354d5" }) {
  return (
    <div
      style={{
        border: "1px solid rgba(166,185,224,0.22)",
        borderRadius: 16,
        padding: 12,
        background: "linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(244,248,255,0.92) 100%)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9)",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.58, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ marginTop: 8, fontSize: 18, fontWeight: 800, color: accent }}>{value}</div>
      {note ? <div style={{ marginTop: 6, fontSize: 11, opacity: 0.64, lineHeight: 1.5 }}>{note}</div> : null}
    </div>
  );
}

function SidebarKeyValueRow({ label, value, emphasis = false }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)",
        gap: 12,
        alignItems: "start",
        padding: "8px 0",
        borderBottom: "1px solid rgba(223,229,241,0.78)",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ fontSize: emphasis ? 14 : 12, fontWeight: emphasis ? 800 : 600, textAlign: "right", lineHeight: 1.45 }}>{value}</div>
    </div>
  );
}

function HistoryTable({ headers, columns, rows, loading, loadingLabel, emptyLabel }) {
  return (
    <div style={{ border: "1px solid rgba(225,231,242,0.96)", borderRadius: 16, overflow: "hidden", background: "#fff", boxShadow: "0 12px 30px rgba(22,36,70,0.04)" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: columns,
          gap: 12,
          padding: "12px 14px",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#5c6881",
          background: "linear-gradient(180deg, #f8fbff 0%, #f3f7fd 100%)",
          borderBottom: "1px solid rgba(225,231,242,0.96)",
        }}
      >
        {headers.map((header) => (
          <div key={header}>{header}</div>
        ))}
      </div>
      {loading ? (
        <div style={{ padding: "14px 16px", fontSize: 12, opacity: 0.7 }}>{loadingLabel}</div>
      ) : rows.length ? (
        rows.map((row, rowIndex) => (
          <div
            key={row.id}
            style={{
              display: "grid",
              gridTemplateColumns: columns,
              gap: 12,
              padding: "13px 14px",
              borderBottom: rowIndex === rows.length - 1 ? "none" : "1px solid rgba(236,240,247,0.96)",
              fontSize: 12,
              alignItems: "start",
              background: rowIndex % 2 ? "rgba(249,251,255,0.68)" : "#fff",
            }}
          >
            {row.cells.map((cell, cellIndex) => (
              <div key={`${row.id}-${cellIndex}`} style={{ minWidth: 0, lineHeight: 1.55 }}>
                {cell}
              </div>
            ))}
          </div>
        ))
      ) : (
        <div style={{ padding: "14px 16px", fontSize: 12, opacity: 0.72 }}>{emptyLabel}</div>
      )}
    </div>
  );
}

function CustomerResultCard({ customer, onSelect }) {
  const [hovered, setHovered] = useState(false);
  const location = [customer?.city, customer?.state].filter(Boolean).join(", ");
  return (
    <div
      role="option"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onSelect?.(customer)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(customer);
        }
      }}
      tabIndex={0}
      style={{
        border: hovered ? "1px solid rgba(94,133,225,0.7)" : "1px solid rgba(214,224,244,0.92)",
        background: "#fff",
        borderRadius: 12,
        padding: "10px 12px",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        cursor: "pointer",
        boxShadow: hovered ? "0 8px 18px rgba(61,88,142,0.08)" : "none",
        transition: "box-shadow 140ms ease, border-color 140ms ease",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 750, fontSize: 14, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {customer?.customer_name}
          {customer?.customer_code ? (
            <span style={{ marginLeft: 8, fontWeight: 600, fontSize: 12, opacity: 0.62 }}>{customer.customer_code}</span>
          ) : null}
        </div>
        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {[location || null, customer?.gstin || null].filter(Boolean).join(" · ") || "No city / GSTIN on file"}
        </div>
      </div>
      <button
        type="button"
        className="button-primary"
        onClick={(e) => {
          e.stopPropagation();
          onSelect?.(customer);
        }}
        style={{ flexShrink: 0, padding: "8px 14px", fontWeight: 700 }}
      >
        Select
      </button>
    </div>
  );
}

function SelectedCustomerCard({ customer, contactCount, siteCount, onChange }) {
  if (!customer) return null;
  const location = [customer.city, customer.state].filter(Boolean).join(", ");
  return (
    <div
      style={{
        border: "1px solid rgba(173,198,255,0.84)",
        borderRadius: 14,
        padding: 14,
        background: "linear-gradient(135deg, #edf4ff 0%, #ffffff 100%)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.58 }}>Selected customer</div>
          <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800, lineHeight: 1.2 }}>{customer.customer_name}</div>
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {customer.customer_code ? <CustomerChip label={customer.customer_code} tone="#f8fbff" color="#31539d" borderColor="rgba(49,83,157,0.12)" /> : null}
            {location ? <CustomerChip label={location} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" /> : null}
            {customer.gstin ? <CustomerChip label={customer.gstin} tone="#f3fbf5" color="#1a7f47" borderColor="rgba(26,127,71,0.14)" /> : null}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            {contactCount} contact{contactCount === 1 ? "" : "s"} · {siteCount} quote site{siteCount === 1 ? "" : "s"}
          </div>
        </div>
        {onChange ? (
          <button type="button" onClick={onChange}>
            Change Customer
          </button>
        ) : null}
      </div>
    </div>
  );
}

function isBlockingDuplicateLevel(row) {
  const level = row?.duplicate_confidence?.level;
  return level === "high" || level === "medium";
}

function DuplicateWarningBanner({
  duplicates,
  allowDuplicate,
  onAllowChange,
  onUseExisting,
  disabled,
  title = "Possible duplicates found",
  requireAllow = true,
  advisoryOnly = false,
}) {
  if (!Array.isArray(duplicates) || !duplicates.length) return null;
  return (
    <div
      style={{
        border: advisoryOnly ? "1px solid rgba(154,90,0,0.28)" : "1px solid #f0d6db",
        borderRadius: 14,
        padding: 14,
        background: advisoryOnly
          ? "linear-gradient(180deg, #fffaf0 0%, #fffdf8 100%)"
          : "linear-gradient(180deg, #fff8fa 0%, #fffdfd 100%)",
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: 8 }}>{title}</div>
      {advisoryOnly ? (
        <div style={{ fontSize: 12, opacity: 0.78, marginBottom: 10, lineHeight: 1.6 }}>
          This is advisory only and does not block starting the draft.
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 10 }}>
        {duplicates.map((dup) => (
          <div
            key={dup.id}
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "space-between",
              alignItems: "flex-start",
              border: "1px solid rgba(240,214,219,0.9)",
              borderRadius: 12,
              padding: 12,
              background: "#fff",
            }}
          >
            <div style={{ fontSize: 13, opacity: 0.86, lineHeight: 1.6, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{dup.customer_name}</div>
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }}>
                {[dup.customer_code, dup.city, dup.state, dup.gstin].filter(Boolean).join(" · ")}
              </div>
              <div style={{ fontSize: 12, color: advisoryOnly ? "#9a5a00" : "#9f2042" }}>
                {(dup.reasons || []).join(", ") || dup.duplicate_confidence?.label || "Possible overlap"}
              </div>
            </div>
            {onUseExisting ? (
              <button type="button" onClick={() => onUseExisting?.(dup)} disabled={disabled}>
                Use Existing
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {requireAllow && !advisoryOnly ? (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 12 }}>
          <input type="checkbox" checked={allowDuplicate === true} onChange={(e) => onAllowChange?.(e.target.checked)} disabled={disabled} />
          Create anyway, this is a genuinely new customer
        </label>
      ) : null}
    </div>
  );
}

function ProductResultCard({ product, selected, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "block",
        padding: 14,
        borderRadius: 16,
        border: selected ? "1px solid #2354d5" : hovered ? "1px solid rgba(94,133,225,0.72)" : "1px solid rgba(223,229,241,0.95)",
        background: selected
          ? "linear-gradient(135deg, rgba(235,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
        boxShadow: selected ? "0 16px 34px rgba(35,84,213,0.12)" : hovered ? "0 14px 28px rgba(31,41,55,0.08)" : "0 8px 18px rgba(31,41,55,0.04)",
        transform: hovered && !selected ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "start" }}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>{product.item_name}</div>
            {selected ? <CustomerChip label="Selected" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" /> : null}
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {product.item_code ? <CustomerChip label={product.item_code} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" /> : null}
            {product.group_name ? <CustomerChip label={product.group_name} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" /> : null}
            {product.category_name ? <CustomerChip label={product.category_name} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" /> : null}
          </div>
        </div>
        <div
          style={{
            minWidth: 150,
            border: "1px solid rgba(219,228,244,0.9)",
            borderRadius: 14,
            padding: "10px 12px",
            background: "rgba(255,255,255,0.82)",
            fontSize: 12,
            lineHeight: 1.75,
            textAlign: "right",
            color: "#56657f",
          }}
        >
          <div>GST {toNumber(product.gst_pct, 0).toFixed(2)}%</div>
          <div>List {toNumber(product.list_price, 0).toFixed(2)}</div>
          <div>{product.uom || "No UOM"}</div>
        </div>
      </div>
    </button>
  );
}

function formatProposalProfileLabel(key) {
  const value = String(key || "").trim();
  if (!value) return "";
  const map = {
    industrial_premium: "Industrial Premium",
    industrial_compact: "Industrial Compact",
    oxygen_industrial: "Industrial Oxygen",
    oxygen_industrial_compact: "Industrial Oxygen Compact",
    oxygen_medical: "Medical Oxygen",
    oxygen_medical_compact: "Medical Oxygen Compact",
  };
  const resolved = map[value] || value.replaceAll("_", " ");
  return `Proposal profile: ${resolved}`;
}

function ConfiguratorFamilyCard({ family, selected, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        all: "unset",
        cursor: "pointer",
        textAlign: "left",
        border: selected ? "1px solid #2354d5" : hovered ? "1px solid rgba(94,133,225,0.72)" : "1px solid rgba(214,224,244,0.92)",
        background: selected
          ? "radial-gradient(circle at top right, rgba(141,180,255,0.2), transparent 34%), linear-gradient(135deg, rgba(235,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
        borderRadius: 18,
        padding: 14,
        display: "block",
        boxShadow: selected ? "0 18px 36px rgba(35,84,213,0.14)" : hovered ? "0 16px 30px rgba(31,41,55,0.08)" : "0 8px 18px rgba(31,41,55,0.04)",
        transform: hovered && !selected ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease",
        minHeight: 332,
      }}
    >
      <div
        style={{
          position: "relative",
          height: 152,
          borderRadius: 16,
          overflow: "hidden",
          background: family.image_url
            ? `linear-gradient(180deg, rgba(11,24,46,0.08) 0%, rgba(11,24,46,0.42) 100%), url(${family.image_url}) center/cover no-repeat`
            : "linear-gradient(135deg, rgba(226,236,255,0.9) 0%, rgba(245,248,255,1) 100%)",
          boxShadow: selected ? "0 16px 30px rgba(16,38,79,0.14)" : "0 10px 22px rgba(16,38,79,0.08)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: selected
              ? "linear-gradient(180deg, rgba(12,24,49,0.02) 0%, rgba(17,40,84,0.42) 100%)"
              : "linear-gradient(180deg, rgba(19,42,88,0.02) 0%, rgba(19,42,88,0.34) 100%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: "auto auto 12px 12px",
            width: 88,
            height: 88,
            borderRadius: 999,
            background: selected ? "radial-gradient(circle, rgba(87,131,255,0.32) 0%, rgba(87,131,255,0) 72%)" : "radial-gradient(circle, rgba(255,255,255,0.24) 0%, rgba(255,255,255,0) 72%)",
            filter: "blur(2px)",
          }}
        />
        <div style={{ position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start", padding: 14 }}>
          <CustomerChip
            label={family.company}
            tone={selected ? "rgba(35,84,213,0.92)" : "rgba(255,255,255,0.84)"}
            color={selected ? "#fff" : "#31539d"}
            borderColor={selected ? "rgba(35,84,213,0.22)" : "rgba(255,255,255,0.18)"}
          />
          {selected ? <CustomerChip label="Selected" tone="rgba(18,107,60,0.92)" color="#fff" borderColor="rgba(18,107,60,0.22)" /> : null}
        </div>
        <div style={{ position: "absolute", left: 14, right: 14, bottom: 14, zIndex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 20, color: "#ffffff", textShadow: "0 2px 10px rgba(0,0,0,0.24)" }}>{family.label}</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,0.92)", lineHeight: 1.5, textShadow: "0 1px 6px rgba(0,0,0,0.24)" }}>{family.title}</div>
        </div>
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <CustomerChip
          label={formatProposalProfileLabel(family.proposalProfileKey)}
          tone={selected ? "#eef4ff" : "#f7f9fd"}
          color={selected ? "#2354d5" : "#4d5b73"}
          borderColor={selected ? "rgba(35,84,213,0.14)" : "rgba(70,83,107,0.12)"}
        />
      </div>
      <div style={{ marginTop: 12, fontSize: 14, fontWeight: 700, color: "#24324a", lineHeight: 1.55 }}>{family.packageHint}</div>
      <div style={{ fontSize: 11, opacity: 0.66, marginTop: 8, lineHeight: 1.7 }}>{family.note}</div>
    </button>
  );
}

function ConfiguratorOptionCard({ option, selected, onClick, familyLabel, familyKey, proposalProfileKey, variantLabel }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        all: "unset",
        cursor: "pointer",
        border: selected ? "1px solid #2354d5" : hovered ? "1px solid rgba(94,133,225,0.72)" : "1px solid rgba(214,224,244,0.92)",
        background: selected
          ? "radial-gradient(circle at top right, rgba(141,180,255,0.18), transparent 34%), linear-gradient(135deg, rgba(235,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)"
          : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
        borderRadius: 16,
        padding: 14,
        display: "block",
        boxShadow: selected ? "0 16px 34px rgba(35,84,213,0.12)" : hovered ? "0 14px 28px rgba(31,41,55,0.08)" : "0 8px 18px rgba(31,41,55,0.04)",
        transform: hovered && !selected ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: 15 }}>{option.model}</div>
        {selected ? <CustomerChip label="Selected" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" /> : null}
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <CustomerChip label={familyLabel} tone="#f8fbff" color="#31539d" borderColor="rgba(49,83,157,0.12)" />
        {familyKey === "NGEN" && variantLabel ? <CustomerChip label={variantLabel} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" /> : null}
        <CustomerChip label={proposalProfileKey} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" />
      </div>
      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8, lineHeight: 1.7 }}>
        Flow {option.flow} • Air {option.airRequirement ?? "—"} CFM • Storage {option.storageVolume ?? "—"} L
      </div>
      <div style={{ marginTop: 8, fontSize: 11, opacity: 0.68 }}>{selected ? "Selected model for application" : "Use this as nearest alternative"}</div>
    </button>
  );
}

function safeParseMeta(desc) {
  if (typeof desc !== "string" || !desc.trim()) return null;
  try {
    const value = JSON.parse(desc);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePricingFields({ qty, grossUnit, discPct, discAmt, netUnit, changed }) {
  const q = Math.max(0, toNumber(qty, 0));
  const gross = Math.max(0, toNumber(grossUnit, 0));
  const grossTotal = gross * q;
  let pct = Math.max(0, toNumber(discPct, 0));
  let amt = Math.max(0, toNumber(discAmt, 0));
  let net = Math.max(0, toNumber(netUnit, 0));

  if (changed === "disc_pct") {
    amt = grossTotal > 0 ? (grossTotal * pct) / 100 : 0;
  } else if (changed === "disc_amt") {
    pct = grossTotal > 0 ? (amt / grossTotal) * 100 : 0;
  } else if (changed === "net_unit") {
    amt = Math.max(0, grossTotal - net * q);
    pct = grossTotal > 0 ? (amt / grossTotal) * 100 : 0;
  }

  if (grossTotal > 0 && amt > grossTotal) amt = grossTotal;
  const netTotal = Math.max(0, grossTotal - amt);
  net = q > 0 ? netTotal / q : 0;
  pct = grossTotal > 0 ? (amt / grossTotal) * 100 : 0;

  return {
    qty: q,
    grossUnit: gross,
    discPct: pct,
    discAmt: amt,
    netUnit: net,
    netTotal,
  };
}

function normalizeEditableLinePricing(line, priceTypes = DEFAULT_PRICE_TYPES) {
  const qty = Math.max(1, parseDraftNumber(line?.qty, 1));
  const netUnit = Math.max(0, toNumber(line?.unit_price_quote, 0));
  const priceList = resolvePriceTypeKey(priceTypes, line?.price_list);
  const multiplier = getPriceListMultiplier(priceTypes, priceList) || 1;
  const discountPct = Math.max(0, toNumber(line?.discount_pct, 0));
  const discountAmtValue = Math.max(0, toNumber(line?.discount_amt, 0));

  let grossUnit = netUnit;
  if (discountPct > 0 && discountPct < 100) {
    grossUnit = netUnit / (1 - discountPct / 100);
  } else if (discountAmtValue > 0 && qty > 0) {
    grossUnit = netUnit + discountAmtValue / qty;
  }

  grossUnit = roundPricing(grossUnit, 2);
  const netTotal = roundPricing(netUnit * qty, 2);
  const grossTotal = roundPricing(grossUnit * qty, 2);
  const discountAmt = roundPricing(Math.max(0, grossTotal - netTotal), 2);
  const sourceListPrice = roundPricing(multiplier > 0 ? grossUnit / multiplier : grossUnit, 2);

  return {
    ...line,
    qty: String(qty),
    price_list: priceList,
    source_list_price: String(sourceListPrice),
    gross_unit_price_quote: String(grossUnit),
    discount_pct: String(roundPricing(discountPct, 4)),
    discount_amt: String(discountAmt),
    unit_price_quote: String(roundPricing(netUnit, 2)),
  };
}

function toEditableLine(line, priceTypes = DEFAULT_PRICE_TYPES) {
  const meta = safeParseMeta(line.line_description);
  const listSnapshot = toNumber(line.list_price_snapshot, toNumber(meta?.source_list_price, 0));
  const unitQuote = toNumber(line.unit_price_quote, 0);
  return normalizeEditableLinePricing({
    key: line.id ? `id:${line.id}` : `new:${Math.random().toString(16).slice(2)}`,
    id: line.id || null,
    product_id: line.product_id ?? null,
    item_code: line.item_code || "",
    item_name: line.item_name || "",
    hsn_no: line.hsn_no || "",
    qty: String(line.qty ?? 1),
    gross_unit_price_quote: String(toNumber(line.gross_unit_price_quote, toNumber(meta?.gross_unit_price_quote, unitQuote || listSnapshot))),
    discount_pct: String(toNumber(line.discount_pct, toNumber(meta?.discount_pct, 0))),
    discount_amt: String(toNumber(line.discount_amt, toNumber(meta?.discount_amt, 0))),
    price_list: typeof meta?.price_list === "string" ? meta.price_list : "list",
    source_list_price: String(listSnapshot > 0 ? listSnapshot : unitQuote),
    remarks: typeof meta?.remarks === "string" ? meta.remarks : "",
    unit_price_quote: String(unitQuote),
    gst_pct: String(line.gst_pct ?? 0),
    product_group_id: line.product_group_id ?? line.group_id ?? null,
    product_group_name: String(line.product_group_name || line.group_name || "").trim(),
    product_description: String(line.product_description || "").trim(),
    scope_type: line.scope_type || "included",
    line_description: typeof line.line_description === "string" ? line.line_description : "",
    customer_item_code: String(line.customer_item_code || "").trim(),
    customer_item_description: String(line.customer_item_description || "").trim(),
  }, priceTypes);
}

function mapServerLinesToDraft(lines, priceTypes = DEFAULT_PRICE_TYPES) {
  return Array.isArray(lines) ? lines.map((line) => toEditableLine(line, priceTypes)) : [];
}

function buildLineMeta(line) {
  return JSON.stringify({
    price_list: line.price_list || "list",
    source_list_price: toNumber(line.source_list_price, 0),
    gross_unit_price_quote: toNumber(line.gross_unit_price_quote, 0),
    discount_pct: toNumber(line.discount_pct, 0),
    discount_amt: toNumber(line.discount_amt, 0),
    remarks: line.remarks || "",
  });
}

function calcLineNetTotal(line) {
  return toNumber(line.qty, 0) * toNumber(line.unit_price_quote, 0);
}

function calcLineTaxTotal(line) {
  return (calcLineNetTotal(line) * toNumber(line.gst_pct, 0)) / 100;
}

function cloneDraftLine(line) {
  return {
    ...line,
    key: `new:${Math.random().toString(16).slice(2)}`,
    id: null,
  };
}

function matchClientGuardrail(guardrails, productGroupId) {
  const list = Array.isArray(guardrails) ? guardrails : [];
  const gid = Number(productGroupId);
  if (Number.isFinite(gid) && gid > 0) {
    const exact = list.find((row) => Number(row.product_group_id) === gid);
    if (exact) return exact;
  }
  return list.find((row) => row.product_group_id == null || row.product_group_id === "") || null;
}

function buildLineFloorHint(line, guardrails) {
  const guardrail = matchClientGuardrail(guardrails, line?.product_group_id);
  const minPct = Number(guardrail?.min_net_pct_of_list || 0);
  if (!(minPct > 0)) return null;
  const listSnapshot = toNumber(line?.source_list_price, toNumber(line?.gross_unit_price_quote, 0));
  if (!(listSnapshot > 0)) return null;
  const floor = (listSnapshot * minPct) / 100;
  const net = toNumber(line?.unit_price_quote, 0);
  return {
    minPct,
    floor,
    breached: net + 0.0001 < floor,
  };
}

function buildAftermarketContext(initialLaunch) {
  const launch = initialLaunch && typeof initialLaunch === "object" ? initialLaunch : {};
  return {
    service_warranty_case_id:
      launch.service_warranty_case_id === null || launch.service_warranty_case_id === undefined || launch.service_warranty_case_id === ""
        ? ""
        : String(launch.service_warranty_case_id),
    amc_contract_id:
      launch.amc_contract_id === null || launch.amc_contract_id === undefined || launch.amc_contract_id === ""
        ? ""
        : String(launch.amc_contract_id),
    quote_origin: typeof launch.quote_origin === "string" && launch.quote_origin.trim() ? launch.quote_origin.trim() : "standard",
    source_label: typeof launch.source_label === "string" ? launch.source_label.trim() : "",
    source_note: typeof launch.source_note === "string" ? launch.source_note.trim() : "",
  };
}

export default function SmartQuoteBuilder({
  onCancel,
  onOpenDetail,
  onOpenSalesOrder,
  onOpenLead,
  onQuoteChanged,
  me,
  initialQuoteId,
  initialLaunch = null,
}) {
  const steps = [
    { key: "customer", label: "Customer", hint: "Choose customer and start draft" },
    { key: "offer", label: "Build Offer", hint: "Recommended package first, extras only if needed" },
    { key: "review", label: "Review", hint: "Scope, commercials, validity, and proposal framing" },
    { key: "deliver", label: "Deliver", hint: "Approve, issue, then send" },
  ];

  const [step, setStep] = useState(0);
  const [quoteId, setQuoteId] = useState(null);
  const [quote, setQuote] = useState(null);
  const [revision, setRevision] = useState(null);
  const [lines, setLines] = useState([]);
  const [terms, setTerms] = useState([]);
  const [aftermarketContext, setAftermarketContext] = useState(() => buildAftermarketContext(initialLaunch));
  const [quoteRoute, setQuoteRoute] = useState(() => {
    const seededRoute = String(initialLaunch?.quote_route || "").trim().toLowerCase();
    if (seededRoute === "healthcare" || seededRoute === "industrial") return seededRoute;
    return isHealthcareConfiguratorFamilyKey(initialLaunch?.configurator_family_key || initialLaunch?.family_key) ? "healthcare" : "industrial";
  });
  const [customerQ, setCustomerQ] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [selectedCustomerRecord, setSelectedCustomerRecord] = useState(null);
  const [customerDetail, setCustomerDetail] = useState(null);
  const [customerContacts, setCustomerContacts] = useState([]);
  const [customerSites, setCustomerSites] = useState([]);
  const [jobAssets, setJobAssets] = useState([]);
  const [jobAssetsLoading, setJobAssetsLoading] = useState(false);
  const [selectedJobAssetId, setSelectedJobAssetId] = useState("");
  const [selectedJobAssetDetail, setSelectedJobAssetDetail] = useState(null);
  const [recommendedJobSpares, setRecommendedJobSpares] = useState([]);
  const [recommendedJobSparesLoading, setRecommendedJobSparesLoading] = useState(false);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [showCustomerCreate, setShowCustomerCreate] = useState(false);
  const [customerCreateDismissed, setCustomerCreateDismissed] = useState(false);
  const [showCustomerOptional, setShowCustomerOptional] = useState(false);
  const [customerCreating, setCustomerCreating] = useState(false);
  const [newCustomerForm, setNewCustomerForm] = useState(EMPTY_NEW_CUSTOMER);
  const [newCustomerChecking, setNewCustomerChecking] = useState(false);
  const [newCustomerChecked, setNewCustomerChecked] = useState(false);
  const [newCustomerDuplicates, setNewCustomerDuplicates] = useState([]);
  const [newCustomerAllowDuplicate, setNewCustomerAllowDuplicate] = useState(false);
  const [draftDuplicateAdvisory, setDraftDuplicateAdvisory] = useState([]);
  const [newCustomerAddCityOpen, setNewCustomerAddCityOpen] = useState(false);
  const [newCustomerAddCityName, setNewCustomerAddCityName] = useState("");
  const [newCustomerSavingCity, setNewCustomerSavingCity] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState("");
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [showContactCreate, setShowContactCreate] = useState(false);
  const [showSiteCreate, setShowSiteCreate] = useState(false);
  const [contactCreating, setContactCreating] = useState(false);
  const [siteCreating, setSiteCreating] = useState(false);
  const [newContactForm, setNewContactForm] = useState({
    full_name: "",
    email: "",
    phone: "",
    designation: "",
  });
  const [newSiteForm, setNewSiteForm] = useState({
    site_name: "",
    site_type: "plant",
    address_line1: "",
    city: "",
    state: "",
    pincode: "",
    country_id: "",
  });
  const [attentionTo, setAttentionTo] = useState("");
  const [draftLines, setDraftLines] = useState([]);
  const [priceHints, setPriceHints] = useState({});
  const [advancedLineKey, setAdvancedLineKey] = useState("");
  const [productCategories, setProductCategories] = useState([]);
  const [productGroups, setProductGroups] = useState([]);
  const [addCategoryId, setAddCategoryId] = useState("");
  const [addGroupId, setAddGroupId] = useState("");
  const [addProductQ, setAddProductQ] = useState("");
  const [addProductResults, setAddProductResults] = useState([]);
  const [addSelectedProduct, setAddSelectedProduct] = useState(null);
  const [itemsLane, setItemsLane] = useState("configurator");
  const [selectedConfiguratorFamilyKey, setSelectedConfiguratorFamilyKey] = useState("NGEN");
  const [addPriceList, setAddPriceList] = useState("list");
  const [addQty, setAddQty] = useState("1");
  const [addGrossUnit, setAddGrossUnit] = useState("");
  const [addDiscPct, setAddDiscPct] = useState("");
  const [addDiscAmt, setAddDiscAmt] = useState("");
  const [addRemarks, setAddRemarks] = useState("");
  const [quoteBootstrap, setQuoteBootstrap] = useState({
    pricing_modes: [],
    allow_manual_line_entry: false,
    require_catalog_products_for_lines: true,
    allow_distributor_external_items: false,
    distributor_item_sourcing_mode: "",
    price_types: [],
    pricing_guardrails: [],
    currencies: [],
    exchange_rates: [],
    incoterms: [],
    payment_terms: [],
    freight_terms: [],
    p_and_f_terms: [],
    countries: [],
    states: [],
    cities: [],
  });
  const [commercialForm, setCommercialForm] = useState({
    attention_to: "",
    pricing_display_mode: "detailed",
    is_export: false,
    incoterm_id: "",
    base_currency_id: "",
    quote_currency_id: "",
    payment_term_id: "",
    freight_term_id: "",
    p_and_f_term_id: "",
    delivery_lead_time_days: "",
    warranty_months: "",
    order_flow: "direct",
    fulfillment_mode: "direct_customer",
    buyer_po_number: "",
    buyer_po_date: "",
    po_exception_reason: "",
    end_customer_name: "",
    end_customer_po_number: "",
    end_customer_po_date: "",
    ship_to_customer_site_id: "",
    bill_to_name: "",
    bill_to_address: "",
    ship_to_name: "",
    ship_to_address: "",
  });
  const [cadenceForm, setCadenceForm] = useState({
    quote_valid_till: dateInputValueFromToday(30),
    next_follow_up_at: "",
    quote_kind: "firm",
  });
  const [quoteSummary, setQuoteSummary] = useState({
    revision_id: null,
    merge_annexures: true,
    executive_summary: { problem: "", solution: "", highlights: [], note: "" },
    scope_summary: { deliverables: [], tech_highlights: [], exclusions: [], assumptions: [], acceptance: [], responsibilities: [] },
    configurator_context: {},
    is_locked: false,
    locked_at: null,
    locked_by: null,
    can_edit: false,
    can_lock: false,
    can_unlock: false,
  });
  const [annexures, setAnnexures] = useState([]);
  const [summarySaving, setSummarySaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [nitroPurity, setNitroPurity] = useState("99.99");
  const [nitroFlow, setNitroFlow] = useState("");
  const [nitroRec, setNitroRec] = useState(null);
  const [nitroModel, setNitroModel] = useState("");
  const [nitroApplyMode, setNitroApplyMode] = useState("replace");
  const [nitroPackageMode, setNitroPackageMode] = useState("full_package");
  const [nitroWorking, setNitroWorking] = useState(false);
  const [nitroPurities, setNitroPurities] = useState(["99.99", "99.995", "99.999"]);
  const [oxygenPurity, setOxygenPurity] = useState("95");
  const [oxygenFlow, setOxygenFlow] = useState("");
  const [oxygenRec, setOxygenRec] = useState(null);
  const [oxygenModel, setOxygenModel] = useState("");
  const [oxygenApplyMode, setOxygenApplyMode] = useState("replace");
  const [oxygenPackageMode, setOxygenPackageMode] = useState("full_package");
  const [oxygenWorking, setOxygenWorking] = useState(false);
  const [mailBootstrap, setMailBootstrap] = useState(EMPTY_MAIL_BOOTSTRAP);
  const [mailForm, setMailForm] = useState({
    to: "",
    cc: "",
    bcc: "",
    preset_key: "",
    subject: "",
    body: "",
    clubbed: false,
  });
  const [mailLoading, setMailLoading] = useState(false);
  const [mailSending, setMailSending] = useState(false);
  const [mailNotice, setMailNotice] = useState("");
  const [mailAttachments, setMailAttachments] = useState([]);
  const [mailAttachmentUploading, setMailAttachmentUploading] = useState(false);
  const [mailComposerOpen, setMailComposerOpen] = useState(false);
  const [approval, setApproval] = useState(EMPTY_APPROVAL);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [creatingSalesOrder, setCreatingSalesOrder] = useState(false);
  const [showExportControls, setShowExportControls] = useState(false);
  const mailAttachmentInputRef = useRef(null);
  const newCustomerDupeTimerRef = useRef(null);
  const newCustomerDupeSeqRef = useRef(0);
  const autoExpandedQueryRef = useRef("");
  const isExistingDraft = Number.isFinite(Number(quoteId)) && Number(quoteId) > 0;

  const quoteChangeSignature = [
    quote?.quote_status || "",
    quote?.updated_at || "",
    quote?.quote_valid_till || "",
    quote?.next_follow_up_at || "",
    revision?.revision_no || "",
    revision?.revision_status || "",
  ].join("|");
  useEffect(() => {
    if (!quote || typeof onQuoteChanged !== "function") return;
    onQuoteChanged();
  }, [quoteChangeSignature]);

  const selectedCustomer = useMemo(() => {
    const id = customerId ? Number(customerId) : null;
    if (!id) return null;
    if (selectedCustomerRecord && Number(selectedCustomerRecord.id) === id) return selectedCustomerRecord;
    const fromResults = customerResults.find((c) => Number(c.id) === id);
    if (fromResults) return fromResults;
    if (customerDetail && Number(customerDetail.id) === id) return customerDetail;
    if (quote?.customer_id && Number(quote.customer_id) === id) {
      return {
        id,
        customer_name: quote.customer_name || `Customer #${id}`,
        customer_code: quote.customer_code || "",
        gstin: quote.customer_gstin || "",
        city: quote.customer_city || "",
        state: quote.customer_state || "",
      };
    }
    return null;
  }, [customerId, selectedCustomerRecord, customerResults, customerDetail, quote?.customer_id, quote?.customer_name, quote?.customer_code, quote?.customer_gstin, quote?.customer_city, quote?.customer_state]);

  const selectedContact = useMemo(() => {
    const id = selectedContactId ? Number(selectedContactId) : null;
    return id ? customerContacts.find((c) => Number(c.id) === id) || null : null;
  }, [selectedContactId, customerContacts]);

  const selectedSite = useMemo(() => {
    const id = selectedSiteId ? Number(selectedSiteId) : null;
    return id ? customerSites.find((site) => Number(site.id) === id) || null : null;
  }, [selectedSiteId, customerSites]);
  const selectedJobAsset = useMemo(() => {
    const id = selectedJobAssetId ? Number(selectedJobAssetId) : null;
    if (!id) return null;
    return jobAssets.find((asset) => Number(asset.id) === id) || selectedJobAssetDetail || null;
  }, [selectedJobAssetId, jobAssets, selectedJobAssetDetail]);

  const customerSearchQuery = customerQ.trim();
  const customerResultsSummary = useMemo(() => {
    if (customerSearching) return "Searching live Customer Master...";
    if (!customerSearchQuery) return "Type a company name, code, phone, email, city, or GST to search live.";
    if (!customerResults.length) return `No existing customer matched "${customerSearchQuery}".`;
    return `${customerResults.length} matching customer${customerResults.length === 1 ? "" : "s"} found.`;
  }, [customerSearching, customerResults.length, customerSearchQuery]);

  const quotableCustomerSites = useMemo(
    () => customerSites.filter((site) => site && site.is_active !== false && site.can_quote !== false),
    [customerSites]
  );
  const newCustomerBlockingDuplicates = useMemo(
    () => (Array.isArray(newCustomerDuplicates) ? newCustomerDuplicates.filter(isBlockingDuplicateLevel) : []),
    [newCustomerDuplicates]
  );
  const newCustomerAdvisoryDuplicates = useMemo(
    () => (Array.isArray(newCustomerDuplicates) ? newCustomerDuplicates.filter((row) => !isBlockingDuplicateLevel(row)) : []),
    [newCustomerDuplicates]
  );
  const totalRecommendedJobSpareQty = useMemo(
    () =>
      recommendedJobSpares.reduce((sum, item) => sum + toNumber(item?.qty_recommended, 0), 0),
    [recommendedJobSpares]
  );
  const jobAssetSummary = useMemo(() => {
    if (jobAssetsLoading) return "Loading deployed Job Assets...";
    if (!customerId) return "Select a customer to load deployed assets / serial numbers.";
    if (!jobAssets.length) return "No deployed Job Asset is linked to this customer yet.";
    return `${jobAssets.length} linked Job Asset${jobAssets.length === 1 ? "" : "s"} found for this customer.`;
  }, [jobAssetsLoading, customerId, jobAssets.length]);
  const newCustomerStateOptions = useMemo(
    () => statesForCountry(quoteBootstrap.states, newCustomerForm.country_id),
    [quoteBootstrap.states, newCustomerForm.country_id]
  );
  const newCustomerSelectedStateId = useMemo(
    () => findStateId(quoteBootstrap.states, newCustomerForm.country_id, newCustomerForm.state),
    [quoteBootstrap.states, newCustomerForm.country_id, newCustomerForm.state]
  );
  const newCustomerCityOptions = useMemo(
    () => citiesForState(quoteBootstrap.cities, newCustomerSelectedStateId),
    [quoteBootstrap.cities, newCustomerSelectedStateId]
  );
  const newCustomerSelectedCityId = useMemo(
    () => findCityId(quoteBootstrap.cities, newCustomerSelectedStateId, newCustomerForm.city),
    [quoteBootstrap.cities, newCustomerSelectedStateId, newCustomerForm.city]
  );
  const defaultIndiaCountryId = useMemo(() => findIndiaCountryId(quoteBootstrap.countries), [quoteBootstrap.countries]);

  const filteredGroups = useMemo(() => {
    const cid = addCategoryId ? Number(addCategoryId) : null;
    if (!Number.isFinite(cid)) return productGroups;
    return productGroups.filter((g) => Number(g.category_id) === cid);
  }, [addCategoryId, productGroups]);
  const isBrowsingProducts = Boolean(addCategoryId || addGroupId);
  const visibleConfiguratorFamilies = useMemo(
    () =>
      CONFIGURATOR_FAMILIES.filter((item) =>
        quoteRoute === "healthcare" ? isHealthcareConfiguratorFamilyKey(item.key) : !isHealthcareConfiguratorFamilyKey(item.key)
      ),
    [quoteRoute]
  );
  const selectedConfiguratorFamily = useMemo(
    () => visibleConfiguratorFamilies.find((item) => item.key === selectedConfiguratorFamilyKey) || visibleConfiguratorFamilies[0] || CONFIGURATOR_FAMILIES[0],
    [selectedConfiguratorFamilyKey, visibleConfiguratorFamilies]
  );
  const activeConfiguratorRec = useMemo(
    () => (selectedConfiguratorFamily.gas === "nitrogen" ? nitroRec : oxygenRec),
    [selectedConfiguratorFamily.gas, nitroRec, oxygenRec]
  );
  const activeConfiguratorModel = useMemo(
    () => (selectedConfiguratorFamily.gas === "nitrogen" ? nitroModel : oxygenModel),
    [selectedConfiguratorFamily.gas, nitroModel, oxygenModel]
  );
  const activeConfiguratorPackageMode = useMemo(
    () => (selectedConfiguratorFamily.gas === "nitrogen" ? nitroPackageMode : oxygenPackageMode),
    [selectedConfiguratorFamily.gas, nitroPackageMode, oxygenPackageMode]
  );
  const activeConfiguratorCard = useMemo(
    () =>
      buildConfiguratorRecommendationCard({
        family: selectedConfiguratorFamily,
        rec: activeConfiguratorRec,
        selectedModel: activeConfiguratorModel,
        packageMode: activeConfiguratorPackageMode,
        lines: draftLines,
      }),
    [selectedConfiguratorFamily, activeConfiguratorRec, activeConfiguratorModel, activeConfiguratorPackageMode, draftLines]
  );
  const activeConfiguratorPreview = useMemo(
    () =>
      buildConfiguratorNarrative({
        family: selectedConfiguratorFamily,
        lines: draftLines,
        rec: activeConfiguratorRec,
        selectedModel: activeConfiguratorModel,
        packageMode: activeConfiguratorPackageMode,
        customerName: customerDetail?.customer_name || quote?.customer_name || "",
        siteName: selectedSite?.site_name || "",
      }),
    [
      selectedConfiguratorFamily,
      draftLines,
      activeConfiguratorRec,
      activeConfiguratorModel,
      activeConfiguratorPackageMode,
      customerDetail?.customer_name,
      quote?.customer_name,
      selectedSite?.site_name,
    ]
  );
  const liveConfiguratorContext = useMemo(
    () =>
      buildConfiguratorContextPayload({
        family: selectedConfiguratorFamily,
        rec: activeConfiguratorRec,
        selectedModel: activeConfiguratorModel,
        packageMode: activeConfiguratorPackageMode,
        lines: draftLines,
        preview: activeConfiguratorPreview,
      }),
    [selectedConfiguratorFamily, activeConfiguratorRec, activeConfiguratorModel, activeConfiguratorPackageMode, draftLines, activeConfiguratorPreview]
  );
  const reviewConfiguratorContext = useMemo(() => {
    const summaryContext = quoteSummary?.configurator_context;
    if (summaryContext && typeof summaryContext === "object" && (summaryContext.family_key || summaryContext.selected_model || summaryContext.source === "ui_configurator")) {
      return summaryContext;
    }
    const mailContext = mailBootstrap?.configurator_context;
    if (mailContext && typeof mailContext === "object" && (mailContext.family_key || mailContext.selected_model)) {
      return mailContext;
    }
    return liveConfiguratorContext;
  }, [quoteSummary?.configurator_context, mailBootstrap?.configurator_context, liveConfiguratorContext]);
  const reviewConfiguratorWarnings = useMemo(() => {
    const items = [];
    const ctx = reviewConfiguratorContext && typeof reviewConfiguratorContext === "object" ? reviewConfiguratorContext : {};
    const warningList = Array.isArray(ctx.warnings) ? ctx.warnings.map((item) => String(item || "").trim()).filter(Boolean) : [];
    if (ctx.mixed_branding_risk === true || ctx.recommended_split_quote === true) {
      items.push("This revision mixes medical and industrial branding context. Split-quote review is recommended before release.");
    }
    if (ctx.presentation_company_code === "AT") {
      items.push("This proposal is routed on AT healthcare presentation. Confirm the quote should stay on the healthcare seller identity before issue.");
    }
    return Array.from(new Set([...items, ...warningList]));
  }, [reviewConfiguratorContext]);

  const { subtotal, taxTotal, discountTotal, grandTotal } = useMemo(() => {
    const totals = draftLines.reduce(
      (acc, line) => {
        acc.subtotal += calcLineNetTotal(line);
        acc.taxTotal += calcLineTaxTotal(line);
        acc.discountTotal += toNumber(line.discount_amt, 0);
        return acc;
      },
      { subtotal: 0, taxTotal: 0, discountTotal: 0, grandTotal: 0 }
    );
    totals.grandTotal = totals.subtotal + totals.taxTotal;
    return totals;
  }, [draftLines]);
  const inrCurrency = useMemo(
    () => (quoteBootstrap.currencies || []).find((item) => String(item.currency_code || "").trim().toUpperCase() === "INR") || null,
    [quoteBootstrap.currencies]
  );
  const defaultPaymentTermId = useMemo(() => findDefaultPaymentTermId(quoteBootstrap.payment_terms), [quoteBootstrap.payment_terms]);
  const defaultFreightTermId = useMemo(() => findDefaultFreightTermId(quoteBootstrap.freight_terms), [quoteBootstrap.freight_terms]);
  const defaultIncotermId = useMemo(() => findDefaultIncotermId(quoteBootstrap.incoterms), [quoteBootstrap.incoterms]);
  const defaultPAndFTermId = useMemo(() => findDefaultPAndFTermId(quoteBootstrap.p_and_f_terms), [quoteBootstrap.p_and_f_terms]);
  const canSelectForeignQuoteCurrency = commercialForm.is_export;
  const currentStepIndex = Math.max(0, Math.min(steps.length - 1, Number(step) || 0));
  const selectedGroupNames = useMemo(() => {
    const groups = new Set();
    for (const line of draftLines) {
      if (line.item_name) groups.add(line.item_name);
    }
    return Array.from(groups).slice(0, 5);
  }, [draftLines]);
  const approvalHistoryPreview = useMemo(() => (Array.isArray(approval.approvals) ? approval.approvals.slice(0, 6) : []), [approval.approvals]);
  const mailHistoryPreview = useMemo(() => (Array.isArray(mailBootstrap.history) ? mailBootstrap.history.slice(0, 5) : []), [mailBootstrap.history]);
  const selectedMailPreset = useMemo(() => {
    const presets = Array.isArray(mailBootstrap.mail_presets) ? mailBootstrap.mail_presets : [];
    const key = String(mailForm.preset_key || mailBootstrap.default_preset_key || "").trim();
    return presets.find((preset) => String(preset?.key || "").trim() === key) || null;
  }, [mailForm.preset_key, mailBootstrap.default_preset_key, mailBootstrap.mail_presets]);
  const topLineItemsPreview = useMemo(() => draftLines.slice(0, 3), [draftLines]);
  const baseCurrencyLabel = useMemo(() => {
    const match = (quoteBootstrap.currencies || []).find((item) => String(item.id) === String(commercialForm.base_currency_id));
    return match ? `${match.currency_code} - ${match.currency_name}` : "—";
  }, [quoteBootstrap.currencies, commercialForm.base_currency_id]);
  const quoteCurrencyLabel = useMemo(() => {
    const match = (quoteBootstrap.currencies || []).find((item) => String(item.id) === String(commercialForm.quote_currency_id));
    return match ? `${match.currency_code} - ${match.currency_name}` : "—";
  }, [quoteBootstrap.currencies, commercialForm.quote_currency_id]);
  const activeQuoteExchangeRate = useMemo(
    () => resolveQuoteExchangeRate(quoteBootstrap.exchange_rates, commercialForm.base_currency_id, commercialForm.quote_currency_id),
    [quoteBootstrap.exchange_rates, commercialForm.base_currency_id, commercialForm.quote_currency_id]
  );
  const paymentTermLabel = useMemo(() => {
    const match = (quoteBootstrap.payment_terms || []).find((item) => String(item.id) === String(commercialForm.payment_term_id));
    return match ? `${match.term_code} - ${match.term_name}` : "—";
  }, [quoteBootstrap.payment_terms, commercialForm.payment_term_id]);
  const freightTermLabel = useMemo(() => {
    const match = (quoteBootstrap.freight_terms || []).find((item) => String(item.id) === String(commercialForm.freight_term_id));
    return match ? `${match.term_code} - ${match.term_name}` : "—";
  }, [quoteBootstrap.freight_terms, commercialForm.freight_term_id]);
  const pAndFTermLabel = useMemo(() => {
    const match = (quoteBootstrap.p_and_f_terms || []).find((item) => String(item.id) === String(commercialForm.p_and_f_term_id));
    return match ? `${match.term_code} - ${match.term_name}` : "—";
  }, [quoteBootstrap.p_and_f_terms, commercialForm.p_and_f_term_id]);
  const incotermLabel = useMemo(() => {
    const match = (quoteBootstrap.incoterms || []).find((item) => String(item.id) === String(commercialForm.incoterm_id));
    return match ? `${match.incoterm_code} - ${match.incoterm_name}` : "—";
  }, [quoteBootstrap.incoterms, commercialForm.incoterm_id]);
  const libraryTerms = useMemo(
    () => terms.filter((term) => !isManagedCommercialTerm(term?.caption)),
    [terms]
  );
  const managedCommercialTerms = useMemo(() => {
    const managedByKind = new Map();
    for (const term of terms) {
      const kind = getManagedCommercialTermKind(term?.caption);
      if (kind && !managedByKind.has(kind)) managedByKind.set(kind, term);
    }
    return [
      { kind: "incoterm", defaultCaption: "Incoterm", description: incotermLabel },
      { kind: "payment_term", defaultCaption: "Payment Term", description: paymentTermLabel },
      { kind: "freight_term", defaultCaption: "Freight Term", description: freightTermLabel },
      { kind: "p_and_f_term", defaultCaption: "P&F Term", description: pAndFTermLabel },
    ].map((item) => {
      const existing = managedByKind.get(item.kind);
      return {
        id: existing?.id || `managed:${item.kind}`,
        caption: existing?.caption || item.defaultCaption,
        description: item.description || "—",
        is_selected: true,
      };
    });
  }, [terms, incotermLabel, paymentTermLabel, freightTermLabel, pAndFTermLabel]);
  const selectedLibraryTermsCount = useMemo(() => libraryTerms.filter((t) => t && t.is_selected).length, [libraryTerms]);
  const readiness = useMemo(() => {
    const blockers = [];
    const warnings = [];
    const lineValidation = validateDraftLines(draftLines, { requireAtLeastOne: true });

    if (!quoteId) blockers.push({ key: "draft", label: "Draft quote is not created yet.", step: 0 });
    if (!selectedCustomer && !quote?.customer_name) blockers.push({ key: "customer", label: "Customer is missing.", step: 0 });
    if (!lineValidation.ok) blockers.push({ key: "items", label: lineValidation.message, step: 1 });
    if (!commercialForm.attention_to && !attentionTo) warnings.push({ key: "attention", label: "Attention To is blank.", step: 0 });
    if (quotableCustomerSites.length && !selectedSite) {
      warnings.push({ key: "site", label: "Quote site / plant is not selected.", step: 0 });
    }
    if (selectedSite?.gst_status === "pending") {
      warnings.push({ key: "site_gst", label: "Selected site is GST pending.", step: 0 });
    }
    if (!quoteCurrencyLabel || quoteCurrencyLabel === "—") blockers.push({ key: "quote_currency", label: "Quote currency is not selected.", step: 2 });
    if (!baseCurrencyLabel || baseCurrencyLabel === "—") warnings.push({ key: "base_currency", label: "Base currency is not selected.", step: 2 });
    if (!paymentTermLabel || paymentTermLabel === "—") blockers.push({ key: "payment", label: "Payment term is not selected.", step: 2 });
    if (!freightTermLabel || freightTermLabel === "—") warnings.push({ key: "freight", label: "Freight term is not selected.", step: 2 });
    if (!pAndFTermLabel || pAndFTermLabel === "—") warnings.push({ key: "p_and_f", label: "P&F term is not selected.", step: 2 });
    if (!incotermLabel || incotermLabel === "—") warnings.push({ key: "incoterm", label: "Incoterm is not selected.", step: 2 });
    if (!cadenceForm.quote_valid_till) blockers.push({ key: "validity", label: "Quote validity date is required before issue.", step: 2 });
    if (quoteRoute === "industrial" && (reviewConfiguratorContext?.mixed_branding_risk === true || reviewConfiguratorContext?.recommended_split_quote === true)) {
      warnings.push({ key: "config_split_quote", label: "Configurator context suggests a split-quote review due to mixed branding.", step: 2 });
    }
    if (!(selectedContact?.email || customerDetail?.email || mailForm.to)) warnings.push({ key: "email", label: "Customer email is missing for send flow.", step: 3 });
    if (!mailBootstrap.mail_source?.effective_sender?.connected) warnings.push({ key: "mailbox", label: "No effective sender mailbox is configured.", step: 3 });

    return { blockers, warnings };
  }, [
    quoteId,
    selectedCustomer,
    quote?.customer_name,
    draftLines,
    commercialForm.attention_to,
    attentionTo,
    quotableCustomerSites.length,
    selectedSite,
    quoteCurrencyLabel,
    baseCurrencyLabel,
    paymentTermLabel,
    freightTermLabel,
    pAndFTermLabel,
    incotermLabel,
    cadenceForm.quote_valid_till,
    quoteRoute,
    reviewConfiguratorContext?.mixed_branding_risk,
    reviewConfiguratorContext?.recommended_split_quote,
    selectedContact?.email,
    customerDetail?.email,
    mailForm.to,
    mailBootstrap.mail_source?.effective_sender?.connected,
  ]);

  useEffect(() => {
    if (!inrCurrency?.id) return;
    setCommercialForm((prev) => {
      const fixedInrId = String(inrCurrency.id);
      const nextQuoteCurrencyId = canSelectForeignQuoteCurrency ? prev.quote_currency_id || fixedInrId : fixedInrId;
      if (prev.base_currency_id === fixedInrId && prev.quote_currency_id === nextQuoteCurrencyId) return prev;
      return {
        ...prev,
        base_currency_id: fixedInrId,
        quote_currency_id: nextQuoteCurrencyId,
      };
    });
  }, [inrCurrency, canSelectForeignQuoteCurrency]);
  useEffect(() => {
    const firstFamily = visibleConfiguratorFamilies[0];
    if (!firstFamily) return;
    if (visibleConfiguratorFamilies.some((item) => item.key === selectedConfiguratorFamilyKey)) return;
    setSelectedConfiguratorFamilyKey(firstFamily.key);
  }, [visibleConfiguratorFamilies, selectedConfiguratorFamilyKey]);

  useEffect(() => {
    if (!commercialForm.is_export) return;
    setShowExportControls(true);
  }, [commercialForm.is_export]);

  useEffect(() => {
    if (
      commercialForm.payment_term_id &&
      commercialForm.freight_term_id &&
      commercialForm.p_and_f_term_id &&
      commercialForm.incoterm_id &&
      commercialForm.base_currency_id &&
      commercialForm.quote_currency_id
    ) {
      return;
    }
    setCommercialForm((prev) => {
      let changed = false;
      const next = { ...prev };
      if (!next.base_currency_id && inrCurrency?.id) {
        next.base_currency_id = String(inrCurrency.id);
        changed = true;
      }
      if (!next.quote_currency_id && inrCurrency?.id) {
        next.quote_currency_id = String(inrCurrency.id);
        changed = true;
      }
      if (!next.payment_term_id && defaultPaymentTermId) {
        next.payment_term_id = defaultPaymentTermId;
        changed = true;
      }
      if (!next.freight_term_id && defaultFreightTermId) {
        next.freight_term_id = defaultFreightTermId;
        changed = true;
      }
      if (!next.p_and_f_term_id && defaultPAndFTermId) {
        next.p_and_f_term_id = defaultPAndFTermId;
        changed = true;
      }
      if (!next.incoterm_id && defaultIncotermId) {
        next.incoterm_id = defaultIncotermId;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [
    commercialForm.payment_term_id,
    commercialForm.freight_term_id,
    commercialForm.p_and_f_term_id,
    commercialForm.incoterm_id,
    commercialForm.base_currency_id,
    commercialForm.quote_currency_id,
    defaultPaymentTermId,
    defaultFreightTermId,
    defaultPAndFTermId,
    defaultIncotermId,
    inrCurrency?.id,
  ]);

  const progressPct = Math.round(((currentStepIndex + 1) / steps.length) * 100);
  const revisionState = revision?.revision_status || "draft";
  const revisionStateLabel = String(revisionState).replaceAll("_", " ");
  const issueBlockedByApproval = Boolean(approval.approval_required) && revisionState === "draft";
  const canIssueAndSend =
    ["draft", "approved"].includes(revisionState) &&
    !issueBlockedByApproval &&
    approval.can_issue !== false;
  const sendRequiresIssue = canIssueAndSend;
  const canApproveQuotes = Boolean(
    me?.group_name === "SuperAdmin" || me?.permissions?.screens?.quotes?.can_approve || me?.permissions?.modules?.quotes?.can_approve
  );
  const lifecycleBadge = useMemo(() => {
    if (readiness.blockers.length) {
      return {
        label: "Blocked",
        background: "#fff1f1",
        border: "1px solid #f3c7c7",
        color: "#a33d3d",
      };
    }
    if (readiness.warnings.length) {
      return {
        label: "Needs Review",
        background: "#fff9ee",
        border: "1px solid #ead7a1",
        color: "#8a6708",
      };
    }
    return {
      label: "Ready",
      background: "#f2fbf5",
      border: "1px solid #cfe7d6",
      color: "#0b6b38",
    };
  }, [readiness.blockers.length, readiness.warnings.length]);
  const checklistItems = useMemo(
    () => [
      {
        key: "customer",
        label: "Customer selected",
        detail: selectedCustomer || quote?.customer_name ? "Customer context is set." : "Pick or create the customer first.",
        done: Boolean(selectedCustomer || quote?.customer_name),
        step: 0,
      },
      {
        key: "draft",
        label: "Draft started",
        detail: quoteId ? `Draft ${quote?.quote_number || "ready"} is live.` : "Start the draft after customer selection.",
        done: Boolean(quoteId),
        step: 0,
      },
      {
        key: "items",
        label: "Offer built",
        detail: draftLines.length ? `${draftLines.length} quoted line${draftLines.length === 1 ? "" : "s"} added.` : "Apply package and add any approved extras.",
        done: draftLines.length > 0,
        step: 1,
      },
      {
        key: "commercials",
        label: "Review ready",
        detail:
          quoteCurrencyLabel &&
          quoteCurrencyLabel !== "—" &&
          paymentTermLabel !== "—" &&
          cadenceForm.quote_valid_till
            ? "Core proposal and commercial fields are in place."
            : "Finish payment term, validity, and required commercial fields.",
        done: Boolean(
          quoteCurrencyLabel &&
            quoteCurrencyLabel !== "—" &&
            paymentTermLabel &&
            paymentTermLabel !== "—" &&
            cadenceForm.quote_valid_till
        ),
        step: 2,
      },
      {
        key: "issue",
        label: "Ready to deliver",
        detail: readiness.blockers.length ? "Resolve blockers before issue." : "No issue blockers remain.",
        done: readiness.blockers.length === 0,
        step: 3,
      },
    ],
    [
      selectedCustomer,
      quote?.customer_name,
      quoteId,
      quote?.quote_number,
      draftLines.length,
      quoteCurrencyLabel,
      paymentTermLabel,
      cadenceForm.quote_valid_till,
      readiness.blockers.length,
    ]
  );
  const recommendedNextAction = useMemo(() => {
    if (!selectedCustomer && !quote?.customer_name) {
      return {
        title: "Choose the customer",
        body: "Search an existing customer first. If nothing matches, create the customer inline and then start the draft.",
        step: 0,
        ctaLabel: "Go to customer",
      };
    }
    if (!quoteId) {
      return {
        title: "Start the draft quote",
        body: "Once the customer is selected, start the draft so the builder can attach items, scope, and commercials to a live revision.",
        step: 0,
        ctaLabel: "Start the draft",
      };
    }
    if (!draftLines.length) {
      return {
        title: "Build the offer from the recommended package",
        body: "Start with the route-specific package recommendation first, then open extra item lanes only if the customer needs approved additions.",
        step: 1,
        ctaLabel: "Go to offer build",
      };
    }
    if (step < 2) {
      return {
        title: "Review the proposal in one place",
        body: "Confirm scope, summary, validity, and standard commercial framing together before moving to final delivery.",
        step: 2,
        ctaLabel: "Open review",
      };
    }
    if (step === 2) {
      return {
        title: "Finish the review defaults",
        body: "Keep the domestic quote on INR, ADV50, Extra at actuals, and EXW unless this is a deliberate export or exception case. Confirm validity before issue.",
        step: 2,
        ctaLabel: "Finish review",
      };
    }
    if (revisionState !== "issued") {
      return {
        title: approval.approval_required ? "Submit or issue in the right order" : "Issue the quote",
        body: approval.approval_required
          ? "This revision needs approval before issue. Follow the approval path first, then issue and send."
          : "Preview the final quote, issue it, and only then move to customer send.",
        step: 3,
        ctaLabel: approval.approval_required ? "Review approval path" : "Go to issue",
      };
    }
    return {
      title: "Send the final quote",
      body: "The quote is issued. Preview the correct PDF mode, confirm recipient details, and send the mail handoff.",
      step: 3,
      ctaLabel: "Go to send",
    };
  }, [
    selectedCustomer,
    quote?.customer_name,
    quoteId,
    draftLines.length,
    step,
    readiness.warnings,
    revisionState,
    approval.approval_required,
  ]);
  const primaryFlowAction = useMemo(() => {
    if (readiness.blockers.length) {
      return {
        label: "Complete missing details",
        tone: "#fff1f1",
        color: "#9f3f3f",
        borderColor: "rgba(243,199,199,0.95)",
      };
    }
    if (revisionState === "issued") {
      return {
        label: "Ready to send",
        tone: "#f2fbf5",
        color: "#0b6b38",
        borderColor: "rgba(207,231,214,0.95)",
      };
    }
    if (approval.approval_required) {
      return {
        label: revisionState === "pending_approval" ? "Waiting for approval" : "Send for approval",
        tone: revisionState === "pending_approval" ? "#eef4ff" : "#fff7e8",
        color: revisionState === "pending_approval" ? "#2354d5" : "#8a6708",
        borderColor: revisionState === "pending_approval" ? "rgba(170,194,242,0.95)" : "rgba(234,215,161,0.95)",
      };
    }
    return {
      label: "Issue PDF",
      tone: "#eef4ff",
      color: "#2354d5",
      borderColor: "rgba(170,194,242,0.95)",
    };
  }, [approval.approval_required, readiness.blockers.length, revisionState]);

  const sidebarCommercialRows = useMemo(
    () => [
      { label: "Pricing mode", value: commercialForm.pricing_display_mode || "—" },
      { label: "Export", value: commercialForm.is_export ? "Yes" : "No" },
      { label: "Revision", value: revision?.revision_no || "—" },
      { label: "Base currency", value: baseCurrencyLabel },
      { label: "Quote currency", value: quoteCurrencyLabel },
      { label: "Payment term", value: paymentTermLabel },
      { label: "Freight term", value: freightTermLabel },
      { label: "P&F term", value: pAndFTermLabel },
      { label: "Incoterm", value: incotermLabel },
      { label: "Valid till", value: cadenceForm.quote_valid_till ? toDateInputValue(cadenceForm.quote_valid_till) : "Not set" },
      { label: "Follow-up", value: cadenceForm.next_follow_up_at ? toDateInputValue(cadenceForm.next_follow_up_at) : "Not set" },
    ],
    [
      commercialForm.pricing_display_mode,
      commercialForm.is_export,
      revision?.revision_no,
      baseCurrencyLabel,
      quoteCurrencyLabel,
      paymentTermLabel,
      freightTermLabel,
      pAndFTermLabel,
      incotermLabel,
      cadenceForm.quote_valid_till,
      cadenceForm.next_follow_up_at,
    ]
  );
  const cadenceValidityNote = useMemo(() => {
    if (!cadenceForm.quote_valid_till) {
      return { label: "Validity not set", tone: "#fff4e8", color: "#9a5a00", borderColor: "rgba(154,90,0,0.14)" };
    }
    const days = daysUntilDate(cadenceForm.quote_valid_till);
    if (days === null) {
      return { label: "Validity not set", tone: "#fff4e8", color: "#9a5a00", borderColor: "rgba(154,90,0,0.14)" };
    }
    if (days < 0) {
      return { label: `Expired ${Math.abs(days)}d ago`, tone: "#fff1f1", color: "#9f3f3f", borderColor: "rgba(243,199,199,0.95)" };
    }
    if (days === 0) {
      return { label: "Expires today", tone: "#fff4e8", color: "#9a5a00", borderColor: "rgba(154,90,0,0.14)" };
    }
    return { label: `Valid ${days} day${days === 1 ? "" : "s"}`, tone: "#f2fbf5", color: "#0b6b38", borderColor: "rgba(207,231,214,0.95)" };
  }, [cadenceForm.quote_valid_till]);
  const approvalHistoryRows = useMemo(
    () =>
      approvalHistoryPreview.map((entry) => ({
        id: entry.id,
        cells: [
          entry.approval_cycle_no || "—",
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "4px 8px",
              borderRadius: 999,
              background: "#f4f7fd",
              border: "1px solid rgba(171,188,221,0.28)",
              fontSize: 11,
              fontWeight: 700,
              color: "#385282",
              textTransform: "capitalize",
            }}
          >
            {String(entry.approval_status || "—").replaceAll("_", " ")}
          </span>,
          entry.approver_name || entry.approver_email || "—",
          fmtDateTime(entry.approved_at || entry.created_at),
          <span style={{ opacity: 0.82 }}>{entry.remarks || "—"}</span>,
        ],
      })),
    [approvalHistoryPreview]
  );
  const mailHistoryRows = useMemo(
    () =>
      mailHistoryPreview.map((entry) => ({
        id: entry.id,
        cells: [
          fmtDateTime(entry.sent_at),
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "4px 8px",
              borderRadius: 999,
              background: entry.send_status === "failed" ? "#fff4e8" : entry.opened_at ? "#edf9f0" : "#eef4ff",
              border:
                entry.send_status === "failed"
                  ? "1px solid rgba(194,110,37,0.18)"
                  : entry.opened_at
                    ? "1px solid rgba(42,138,77,0.18)"
                    : "1px solid rgba(138,165,221,0.24)",
              fontSize: 11,
              fontWeight: 700,
              color: entry.send_status === "failed" ? "#9a4f10" : entry.opened_at ? "#1f7a43" : "#2954aa",
              textTransform: "capitalize",
            }}
          >
            {entry.send_status === "failed"
              ? "Failed"
              : entry.opened_at
                ? Number(entry.open_count || 0) > 1
                  ? `Opened ${Number(entry.open_count || 0)}x`
                  : "Opened"
                : "Sent"}
          </span>,
          <span style={{ overflowWrap: "anywhere" }}>{entry.recipient_to || "—"}</span>,
          <span style={{ opacity: 0.82 }}>
            {entry.subject || "—"}
            {entry.opened_at ? ` • Opened ${fmtDateTime(entry.last_opened_at || entry.opened_at)}` : ""}
          </span>,
        ],
      })),
    [mailHistoryPreview]
  );
  const pricingSnapshotCards = useMemo(
    () => [
      { label: "Items", value: draftLines.length, note: "Product Master-backed lines", accent: "#1f4db8" },
      { label: "Supporting Clauses", value: selectedLibraryTermsCount, note: "Additional clauses included", accent: "#255d7a" },
      { label: "Discount", value: discountTotal.toFixed(2), note: "Combined line discount", accent: "#8f4a12" },
      { label: "Grand total", value: grandTotal.toFixed(2), note: quoteCurrencyLabel === "—" ? "Quote currency pending" : quoteCurrencyLabel, accent: "#144c9c" },
    ],
    [draftLines.length, selectedLibraryTermsCount, discountTotal, grandTotal, quoteCurrencyLabel]
  );
  const priceTypeOptions = useMemo(() => normalizePriceTypes(quoteBootstrap.price_types), [quoteBootstrap.price_types]);
  const pricingGuardrails = useMemo(
    () => (Array.isArray(quoteBootstrap.pricing_guardrails) ? quoteBootstrap.pricing_guardrails : []),
    [quoteBootstrap.pricing_guardrails]
  );
  const selectedProductBasePrice = useMemo(
    () => Math.max(0, toNumber(addSelectedProduct?.list_price, 0)),
    [addSelectedProduct]
  );
  const selectedProductQuoteListPrice = useMemo(
    () =>
      Math.max(
        convertBaseAmountToQuote(selectedProductBasePrice, activeQuoteExchangeRate),
        getFallbackDraftLineQuotePrice(addSelectedProduct, draftLines)
      ),
    [selectedProductBasePrice, activeQuoteExchangeRate, addSelectedProduct, draftLines]
  );
  const hasQuoteItems = draftLines.length > 0;

  useEffect(() => {
    if (!defaultIndiaCountryId) return;
    setNewCustomerForm((prev) => {
      if (String(prev.country_id || "").trim()) return prev;
      return { ...prev, country_id: defaultIndiaCountryId };
    });
  }, [defaultIndiaCountryId]);

  useEffect(() => {
    apiFetch("/products/categories")
      .then((data) => setProductCategories(Array.isArray(data?.categories) ? data.categories : []))
      .catch(() => setProductCategories([]));

    apiFetch("/products/groups")
      .then((data) => setProductGroups(Array.isArray(data?.groups) ? data.groups : []))
      .catch(() => setProductGroups([]));

    apiFetch("/quotes/bootstrap")
      .then((data) =>
        setQuoteBootstrap({
          pricing_modes: Array.isArray(data?.pricing_modes) ? data.pricing_modes : [],
          allow_manual_line_entry: data?.allow_manual_line_entry === true,
          require_catalog_products_for_lines: data?.require_catalog_products_for_lines !== false,
          allow_distributor_external_items: data?.allow_distributor_external_items === true,
          distributor_item_sourcing_mode: data?.distributor_item_sourcing_mode || "",
          price_types: Array.isArray(data?.price_types) ? data.price_types : [],
          currencies: Array.isArray(data?.currencies) ? data.currencies : [],
          exchange_rates: Array.isArray(data?.exchange_rates) ? data.exchange_rates : [],
          incoterms: Array.isArray(data?.incoterms) ? data.incoterms : [],
          payment_terms: Array.isArray(data?.payment_terms) ? data.payment_terms : [],
          freight_terms: Array.isArray(data?.freight_terms) ? data.freight_terms : [],
          p_and_f_terms: Array.isArray(data?.p_and_f_terms) ? data.p_and_f_terms : [],
          countries: Array.isArray(data?.countries) ? data.countries : [],
          states: Array.isArray(data?.states) ? data.states : [],
          cities: Array.isArray(data?.cities) ? data.cities : [],
        })
      )
      .catch(() =>
        setQuoteBootstrap({
          pricing_modes: [],
          allow_manual_line_entry: false,
          require_catalog_products_for_lines: true,
          allow_distributor_external_items: false,
          distributor_item_sourcing_mode: "",
          price_types: [],
          currencies: [],
          exchange_rates: [],
          incoterms: [],
          payment_terms: [],
          freight_terms: [],
          p_and_f_terms: [],
          countries: [],
          states: [],
          cities: [],
        })
      );
  }, []);

  useEffect(() => {
    const id = Number(initialQuoteId);
    if (!Number.isFinite(id) || id <= 0) return;
    setQuoteId(id);
    setStep(1);
    setNotice("Loaded existing draft. Update items and commercial settings, then issue when ready.");
  }, [initialQuoteId]);

  useEffect(() => {
    if (!initialLaunch || typeof initialLaunch !== "object") return;
    if (quoteId) return;

    const nextCustomerId =
      initialLaunch.customer_id === null || initialLaunch.customer_id === undefined || initialLaunch.customer_id === ""
        ? null
        : Number(initialLaunch.customer_id);
    const nextJobAssetId =
      initialLaunch.job_asset_id === null || initialLaunch.job_asset_id === undefined || initialLaunch.job_asset_id === ""
        ? null
        : Number(initialLaunch.job_asset_id);
    const nextCustomerName = typeof initialLaunch.customer_name === "string" ? initialLaunch.customer_name.trim() : "";
    const nextAttentionTo = typeof initialLaunch.attention_to === "string" ? initialLaunch.attention_to.trim() : "";
    const nextSourceLabel = typeof initialLaunch.source_label === "string" ? initialLaunch.source_label.trim() : "Aftermarket quote";
    const nextSourceNote = typeof initialLaunch.source_note === "string" ? initialLaunch.source_note.trim() : "";

    setAftermarketContext(buildAftermarketContext(initialLaunch));
    if (Number.isFinite(nextCustomerId) && nextCustomerId > 0) {
      setCustomerId(String(nextCustomerId));
      setSelectedCustomerRecord({
        id: nextCustomerId,
        customer_name: nextCustomerName || `Customer #${nextCustomerId}`,
      });
    }
    if (nextCustomerName) setCustomerQ(nextCustomerName);
    if (Number.isFinite(nextJobAssetId) && nextJobAssetId > 0) {
      setSelectedJobAssetId(String(nextJobAssetId));
      setItemsLane("absstem_shield");
    } else {
      setItemsLane("product_master");
    }
    if (nextAttentionTo) {
      setAttentionTo(nextAttentionTo);
      setCommercialForm((prev) => ({ ...prev, attention_to: prev.attention_to || nextAttentionTo }));
    }
    if (nextSourceNote || nextSourceLabel) {
      setNotice([nextSourceLabel, nextSourceNote].filter(Boolean).join(" • "));
    }
  }, [initialLaunch, quoteId]);

  useEffect(() => {
    if (!quoteId) return;
    loadQuoteContext(quoteId).catch(() => {});
  }, [quoteId]);

  useEffect(() => {
    if (!quoteId) return;
    setNitroPurities(["99.99", "99.995", "99.999"]);
    apiFetch(`/quotes/configurator/nitrogen/purities`)
      .then((data) => {
        const purities = Array.isArray(data?.purities) ? data.purities.map((x) => String(x)) : [];
        if (!purities.length) return;
        setNitroPurities(purities);
        if (!purities.includes(String(nitroPurity))) {
          setNitroPurity(purities[purities.length - 1]);
        }
      })
      .catch(() => {});
  }, [quoteId]);

  useEffect(() => {
    if (selectedConfiguratorFamily.gas === "nitrogen") {
      setNitroRec(null);
      setNitroModel("");
      setNitroApplyMode("replace");
      if (!nitroPurities.includes(String(nitroPurity)) && nitroPurities.length) {
        setNitroPurity(nitroPurities[0]);
      }
      return;
    }
    setOxygenRec(null);
    setOxygenModel("");
    setOxygenApplyMode("replace");
    setOxygenPurity("95");
  }, [selectedConfiguratorFamily, nitroPurities, nitroPurity]);

  useEffect(() => {
    if (!quoteId) return;
    refreshMailBootstrap(quoteId).catch(() => {});
  }, [quoteId]);

  useEffect(() => {
    if (!quoteId) return;
    refreshApprovalStatus(quoteId).catch(() => {});
  }, [quoteId]);

  useEffect(() => {
    if (!quoteId || step !== 3) return;
    refreshApprovalStatus(quoteId).catch(() => {});
  }, [quoteId, step]);

  useEffect(() => {
    if (step !== 0) return;
    const q = customerQ.trim();
    // Mark searching immediately so auto-expand waits for the settled result, not a stale empty list.
    if (q.length) setCustomerSearching(true);
    const t = setTimeout(() => {
      setCustomerSearching(true);
      const qp = q.length ? `?q=${encodeURIComponent(q)}` : "";
      apiFetch(`/customers${qp}`)
        .then((data) => setCustomerResults(Array.isArray(data?.customers) ? data.customers : []))
        .catch(() => setCustomerResults([]))
        .finally(() => setCustomerSearching(false));
    }, q.length ? 220 : 0);
    return () => clearTimeout(t);
  }, [step, customerQ]);

  // Reset create-form dismissal whenever the search query changes so auto-expand can fire again.
  useEffect(() => {
    setCustomerCreateDismissed(false);
    autoExpandedQueryRef.current = "";
  }, [customerQ]);

  // Auto-expand create on settled zero results (≥3 chars), once per query unless dismissed.
  useEffect(() => {
    if (step !== 0) return;
    if (customerId) return;
    if (customerSearching) return;
    if (showCustomerCreate) return;
    const q = customerQ.trim();
    if (q.length < 3) return;
    if (customerResults.length > 0) return;
    if (customerCreateDismissed) return;
    if (autoExpandedQueryRef.current === q) return;
    autoExpandedQueryRef.current = q;
    openCustomerCreate(q);
  }, [step, customerId, customerSearching, customerQ, customerResults.length, customerCreateDismissed, showCustomerCreate]);

  useEffect(() => {
    if (customerDetail?.id && String(customerDetail.id) === String(customerId)) {
      setSelectedCustomerRecord((prev) => ({ ...(prev || {}), ...customerDetail }));
    }
  }, [customerDetail, customerId]);

  useEffect(() => {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) {
      setCustomerDetail(null);
      setCustomerContacts([]);
      setCustomerSites([]);
      setJobAssets([]);
      setSelectedJobAssetId("");
      setSelectedJobAssetDetail(null);
      setRecommendedJobSpares([]);
      setSelectedContactId("");
      setSelectedSiteId("");
      return;
    }
    apiFetch(`/customers/${id}`)
      .then((data) => {
        setCustomerDetail(data?.customer || null);
        const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
        const sites = Array.isArray(data?.sites) ? data.sites : [];
        setCustomerContacts(contacts);
        setCustomerSites(sites);
        const primary = contacts.find((c) => c.is_primary) || contacts[0] || null;
        setSelectedContactId(primary ? String(primary.id) : "");
        const currentSiteId = Number(selectedSiteId);
        const activeSite =
          (Number.isFinite(currentSiteId) &&
            sites.find(
              (site) => Number(site.id) === currentSiteId && site.is_active !== false && site.can_quote !== false
            )) ||
          sites.find((site) => site.is_default_quote_site && site.is_active !== false && site.can_quote !== false) ||
          sites.find((site) => site.is_active !== false && site.can_quote !== false) ||
          null;
        setSelectedSiteId(activeSite ? String(activeSite.id) : "");
        if (!attentionTo && primary?.full_name) {
          const nextAttention = [primary.salutation || null, primary.full_name || null].filter(Boolean).join(" ");
          setAttentionTo(nextAttention);
          setCommercialForm((prev) => (prev.attention_to ? prev : { ...prev, attention_to: nextAttention }));
        }
      })
      .catch(() => {
        setCustomerDetail(null);
        setCustomerContacts([]);
        setCustomerSites([]);
        setJobAssets([]);
        setSelectedJobAssetId("");
        setSelectedJobAssetDetail(null);
        setRecommendedJobSpares([]);
        setSelectedContactId("");
        setSelectedSiteId("");
      });
  }, [customerId]);

  useEffect(() => {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) {
      setJobAssets([]);
      setSelectedJobAssetId("");
      setSelectedJobAssetDetail(null);
      setRecommendedJobSpares([]);
      return;
    }
    setJobAssetsLoading(true);
    apiFetch(`/quotes/customers/${id}/job-assets`)
      .then((data) => {
        const rows = Array.isArray(data?.job_assets) ? data.job_assets : [];
        setJobAssets(rows);
        setSelectedJobAssetId((prev) => {
          if (prev && rows.some((item) => String(item.id) === String(prev))) return prev;
          if (rows.length === 1) return String(rows[0].id);
          return "";
        });
      })
      .catch(() => {
        setJobAssets([]);
        setSelectedJobAssetId("");
      })
      .finally(() => setJobAssetsLoading(false));
  }, [customerId]);

  useEffect(() => {
    const id = Number(selectedJobAssetId);
    if (!Number.isFinite(id) || id <= 0) {
      setSelectedJobAssetDetail(null);
      setRecommendedJobSpares([]);
      return;
    }
    setRecommendedJobSparesLoading(true);
    Promise.all([apiFetch(`/quotes/job-assets/${id}`), apiFetch(`/quotes/job-assets/${id}/recommended-spares`)])
      .then(([assetData, spareData]) => {
        setSelectedJobAssetDetail(assetData?.job_asset || spareData?.job_asset || null);
        setRecommendedJobSpares(Array.isArray(spareData?.recommended_spares) ? spareData.recommended_spares : []);
      })
      .catch(() => {
        setSelectedJobAssetDetail(null);
        setRecommendedJobSpares([]);
      })
      .finally(() => setRecommendedJobSparesLoading(false));
  }, [selectedJobAssetId]);

  useEffect(() => {
    if (!selectedContact?.full_name) return;
    if (attentionTo && attentionTo.trim().length) return;
    const nextAttention = [selectedContact.salutation || null, selectedContact.full_name || null].filter(Boolean).join(" ");
    setAttentionTo(nextAttention);
    setCommercialForm((prev) => (prev.attention_to ? prev : { ...prev, attention_to: nextAttention }));
  }, [selectedContactId, selectedContact?.full_name]);

  useEffect(() => {
    if (!addSelectedProduct) return;
    const gross = selectedProductQuoteListPrice * getPriceListMultiplier(priceTypeOptions, addPriceList);
    setAddGrossUnit(String(gross));
    setAddDiscPct("");
    setAddDiscAmt("");
  }, [addSelectedProduct, addPriceList, priceTypeOptions, selectedProductQuoteListPrice]);

  useEffect(() => {
    setAddPriceList((prev) => resolvePriceTypeKey(priceTypeOptions, prev));
  }, [priceTypeOptions]);

  const priceHintProductKey = useMemo(
    () =>
      (Array.isArray(draftLines) ? draftLines : [])
        .map((line) => Number(line?.product_id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .sort((a, b) => a - b)
        .join(","),
    [draftLines]
  );

  useEffect(() => {
    const cid = Number(customerId);
    const productIds = priceHintProductKey
      ? priceHintProductKey.split(",").map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    if (!Number.isFinite(cid) || cid <= 0 || !productIds.length) {
      setPriceHints({});
      return;
    }
    const params = new URLSearchParams();
    params.set("customer_id", String(cid));
    params.set("product_ids", productIds.join(","));
    let active = true;
    apiFetch(`/quotes/price-reference?${params.toString()}`)
      .then((data) => {
        if (!active) return;
        setPriceHints(data?.hints && typeof data.hints === "object" ? data.hints : {});
      })
      .catch(() => {
        if (active) setPriceHints({});
      });
    return () => {
      active = false;
    };
  }, [customerId, priceHintProductKey]);

  useEffect(() => {
    if (!quoteId || step !== 1) return;
    const q = addProductQ.trim();
    if (!q.length && !addCategoryId && !addGroupId) {
      setAddProductResults([]);
      return;
    }
    const t = setTimeout(() => {
      const params = new URLSearchParams();
      if (q.length) params.set("q", q);
      if (addCategoryId) params.set("category_id", addCategoryId);
      if (addGroupId) params.set("group_id", addGroupId);
      apiFetch(`/products?${params.toString()}`)
        .then((data) => setAddProductResults(Array.isArray(data?.products) ? data.products : []))
        .catch(() => setAddProductResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [quoteId, step, addProductQ, addCategoryId, addGroupId]);

  useEffect(() => {
    if (!addGroupId) return;
    const exists = filteredGroups.some((group) => String(group.id) === String(addGroupId));
    if (!exists) setAddGroupId("");
  }, [addGroupId, filteredGroups]);

  async function loadQuoteContext(id) {
    const data = await apiFetch(`/quotes/${id}`);
    const termsData = await apiFetch(`/quotes/${id}/terms`).catch(() => ({ terms: [] }));
    const summaryData = await apiFetch(`/quotes/${id}/summary`).catch(() => null);
    const annexureData = await apiFetch(`/quotes/${id}/annexures`).catch(() => ({ annexures: [] }));
    const mailAttachmentData = await apiFetch(`/quotes/${id}/mail-attachments`).catch(() => ({ attachments: [] }));
    setQuote(data?.quote || null);
    setRevision(data?.revision || null);
    setLines(Array.isArray(data?.lines) ? data.lines : []);
    setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
    setTerms(Array.isArray(termsData?.terms) ? termsData.terms : []);
    if (summaryData && summaryData.ok !== false) {
      setQuoteSummary({
        revision_id: summaryData?.revision_id ?? null,
        merge_annexures: summaryData?.merge_annexures !== false,
        executive_summary: summaryData?.executive_summary || {},
        scope_summary: summaryData?.scope_summary || {},
        configurator_context: summaryData?.configurator_context || {},
        is_locked: summaryData?.is_locked === true,
        locked_at: summaryData?.locked_at || null,
        locked_by: summaryData?.locked_by || null,
        can_edit: summaryData?.can_edit === true,
        can_lock: summaryData?.can_lock === true,
        can_unlock: summaryData?.can_unlock === true,
      });
    }
    setAnnexures(Array.isArray(annexureData?.annexures) ? annexureData.annexures : []);
    setMailAttachments(Array.isArray(mailAttachmentData?.attachments) ? mailAttachmentData.attachments : []);
    setCustomerId(data?.quote?.customer_id ? String(data.quote.customer_id) : "");
    if (data?.quote?.customer_id) {
      setSelectedCustomerRecord({
        id: data.quote.customer_id,
        customer_name: data.quote.customer_name || `Customer #${data.quote.customer_id}`,
      });
    } else {
      setSelectedCustomerRecord(null);
    }
    setCustomerQ(data?.quote?.customer_name || "");
    setSelectedSiteId(data?.quote?.customer_site_id ? String(data.quote.customer_site_id) : "");
    setSelectedJobAssetId(data?.quote?.job_asset_id ? String(data.quote.job_asset_id) : "");
    setAttentionTo(data?.quote?.attention_to || "");
    setCommercialForm({
      attention_to: data?.quote?.attention_to || "",
      pricing_display_mode: data?.revision?.pricing_display_mode || "detailed",
      is_export: Boolean(data?.revision?.is_export),
      incoterm_id: data?.revision?.incoterm_id ? String(data.revision.incoterm_id) : "",
      base_currency_id: data?.revision?.base_currency_id ? String(data.revision.base_currency_id) : "",
      quote_currency_id: data?.revision?.quote_currency_id ? String(data.revision.quote_currency_id) : "",
      payment_term_id: data?.revision?.payment_term_id ? String(data.revision.payment_term_id) : "",
      freight_term_id: data?.revision?.freight_term_id ? String(data.revision.freight_term_id) : "",
      p_and_f_term_id: data?.revision?.p_and_f_term_id ? String(data.revision.p_and_f_term_id) : "",
      delivery_lead_time_days:
        data?.revision?.delivery_lead_time_days === null || data?.revision?.delivery_lead_time_days === undefined
          ? ""
          : String(data.revision.delivery_lead_time_days),
      warranty_months:
        data?.revision?.warranty_months === null || data?.revision?.warranty_months === undefined
          ? ""
          : String(data.revision.warranty_months),
      order_flow: data?.quote?.order_flow || (data?.quote?.distributor_id ? "distributor" : "direct"),
      fulfillment_mode: data?.quote?.fulfillment_mode || (data?.quote?.distributor_id ? "stock_sale" : "direct_customer"),
      buyer_po_number: data?.quote?.buyer_po_number || "",
      buyer_po_date: data?.quote?.buyer_po_date || "",
      po_exception_reason: data?.quote?.po_exception_reason || "",
      end_customer_name: data?.quote?.end_customer_name || "",
      end_customer_po_number: data?.quote?.end_customer_po_number || "",
      end_customer_po_date: data?.quote?.end_customer_po_date || "",
      ship_to_customer_site_id: data?.quote?.ship_to_customer_site_id ? String(data.quote.ship_to_customer_site_id) : "",
      bill_to_name: data?.quote?.bill_to_name || "",
      bill_to_address: data?.quote?.bill_to_address || "",
      ship_to_name: data?.quote?.ship_to_name || "",
      ship_to_address: data?.quote?.ship_to_address || "",
    });
    setCadenceForm({
      quote_valid_till: toDateInputValue(data?.quote?.quote_valid_till) || dateInputValueFromToday(30),
      next_follow_up_at: toDateInputValue(data?.quote?.next_follow_up_at),
      quote_kind: data?.quote?.quote_kind === "budgetary" ? "budgetary" : "firm",
    });
  }

  async function refreshMailBootstrap(activeQuoteId = quoteId) {
    if (!activeQuoteId) return;
    setMailLoading(true);
    try {
      const data = await apiFetch(`/quotes/${activeQuoteId}/mail-bootstrap`);
      const previousBootstrap = mailBootstrap;
      setMailBootstrap({
        mail_enabled: Boolean(data?.mail_enabled),
        group_names: Array.isArray(data?.group_names) ? data.group_names : [],
        sender: data?.sender || null,
        cc_users: Array.isArray(data?.cc_users) ? data.cc_users : [],
        default_to: data?.default_to || "",
        default_cc: data?.default_cc || "",
        default_subject: data?.default_subject || "",
        default_body: data?.default_body || "",
        default_preset_key: data?.default_preset_key || "",
        mail_presets: Array.isArray(data?.mail_presets) ? data.mail_presets : [],
        history: Array.isArray(data?.history) ? data.history : [],
        mail_source: data?.mail_source || EMPTY_MAIL_BOOTSTRAP.mail_source,
      });
      setMailForm((prev) => ({
        ...prev,
        to: shouldReplaceMailValue(prev.to, previousBootstrap.default_to) ? selectedContact?.email || data?.default_to || "" : prev.to,
        cc: shouldReplaceMailValue(prev.cc, previousBootstrap.default_cc) ? data?.default_cc || "" : prev.cc,
        preset_key: prev.preset_key || data?.default_preset_key || "",
        subject: shouldReplaceMailValue(prev.subject, previousBootstrap.default_subject) ? data?.default_subject || "" : prev.subject,
        body: shouldReplaceMailValue(prev.body, previousBootstrap.default_body) ? data?.default_body || "" : prev.body,
      }));
    } catch {
      setMailBootstrap(EMPTY_MAIL_BOOTSTRAP);
    } finally {
      setMailLoading(false);
    }
  }

  function resolveMailPreset(presetKey) {
    const presets = Array.isArray(mailBootstrap.mail_presets) ? mailBootstrap.mail_presets : [];
    const key = String(presetKey || "").trim();
    return presets.find((preset) => String(preset?.key || "").trim() === key) || null;
  }

  function applyMailPreset(presetKey) {
    const preset = resolveMailPreset(presetKey);
    if (!preset) return;
    setMailForm((prev) => ({
      ...prev,
      preset_key: preset.key || "",
      subject: preset.subject || "",
      body: preset.body || "",
    }));
    setMailNotice(`Mail style set to ${preset.label || "selected preset"}.`);
  }

  async function openMailComposer() {
    if (!quoteId) return;
    setMailComposerOpen(true);
    setMailNotice("");
    await Promise.all([refreshMailBootstrap(quoteId), refreshMailAttachments(quoteId)]);
  }

  async function refreshMailAttachments(activeQuoteId = quoteId) {
    if (!activeQuoteId) return;
    try {
      const data = await apiFetch(`/quotes/${activeQuoteId}/mail-attachments`);
      setMailAttachments(Array.isArray(data?.attachments) ? data.attachments : []);
    } catch {
      setMailAttachments([]);
    }
  }

  async function handleMailAttachmentUpload(event) {
    const files = Array.from(event?.target?.files || []);
    if (!quoteId || !files.length) return;
    const totalBytes = files.reduce((sum, file) => sum + (Number(file?.size) || 0), 0);
    const totalLimitBytes = 20 * 1024 * 1024;
    if (totalBytes > totalLimitBytes) {
      setError("Please keep the total selected attachment size within 20 MB.");
      if (event?.target) event.target.value = "";
      return;
    }
    setMailAttachmentUploading(true);
    setError("");
    setMailNotice("");
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        await apiFetchForm(`/quotes/${quoteId}/mail-attachments`, formData, { method: "POST" });
      }
      await refreshMailAttachments(quoteId);
      setMailNotice(files.length === 1 ? `${files[0].name} attached for mail.` : `${files.length} files attached for mail.`);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to attach additional files."));
    } finally {
      setMailAttachmentUploading(false);
      if (event?.target) event.target.value = "";
    }
  }

  function openMailAttachmentPicker() {
    if (mailAttachmentUploading || !quoteId) return;
    mailAttachmentInputRef.current?.click();
  }

  async function refreshApprovalStatus(activeQuoteId = quoteId) {
    if (!activeQuoteId) return EMPTY_APPROVAL;
    setApprovalLoading(true);
    try {
      const data = await apiFetch(`/quotes/${activeQuoteId}/approval-status`);
      const nextApproval = data?.approval || EMPTY_APPROVAL;
      setApproval(nextApproval);
      return nextApproval;
    } catch {
      setApproval(EMPTY_APPROVAL);
      return EMPTY_APPROVAL;
    } finally {
      setApprovalLoading(false);
    }
  }

  async function persistDraftLines({ requireAtLeastOne = true } = {}) {
    if (!quoteId) return null;
    const validation = validateDraftLines(draftLines, { requireAtLeastOne });
    if (!validation.ok) {
      setError(validation.message);
      const err = new Error(validation.message);
      err.data = { error: "INVALID_DRAFT_LINES", detail: validation.message };
      throw err;
    }
    const data = await apiFetch(`/quotes/${quoteId}/lines`, {
      method: "PUT",
      body: JSON.stringify({
        lines: validation.actionable
          .map(({ line }) => ({
            id: line.id,
            product_id: line.product_id === null || line.product_id === undefined ? null : Number(line.product_id),
            item_name: line.item_name || null,
            qty: toNumber(line.qty, 0),
            unit_price_quote: toNumber(line.unit_price_quote, 0),
            gst_pct: toNumber(line.gst_pct, 0),
            discount_pct: toNumber(line.discount_pct, 0),
            discount_amt: toNumber(line.discount_amt, 0),
            gross_unit_price_quote: toNumber(line.gross_unit_price_quote, 0),
            list_price_snapshot: toNumber(line.source_list_price, 0),
            scope_type: line.scope_type || "included",
            line_description: buildLineMeta(line),
            customer_item_code: line.customer_item_code || null,
            customer_item_description: line.customer_item_description || null,
          })),
      }),
    }).catch((e) => {
      if (e?.data?.error === "PRICE_FLOOR_BREACH") {
        const detail = Array.isArray(e?.data?.lines)
          ? e.data.lines.map((line) => `${line.item_name || `Line ${line.line_no}`} below ${Number(line.min_net_pct_of_list || 0).toFixed(0)}% of list`).join("; ")
          : "A line is below the company price floor.";
        setError(detail);
      }
      throw e;
    });
    setQuote(data?.quote || quote);
    setRevision(data?.revision || revision);
    setLines(Array.isArray(data?.lines) ? data.lines : []);
    setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
    runQuietly(() => refreshApprovalStatus(quoteId));
    return data;
  }

  async function searchCustomers() {
    setError("");
    try {
      const qp = customerQ.trim().length ? `?q=${encodeURIComponent(customerQ.trim())}` : "";
      const data = await apiFetch(`/customers${qp}`);
      setCustomerResults(Array.isArray(data?.customers) ? data.customers : []);
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to search customers.");
    }
  }

  function selectCustomer(customer) {
    if (!customer) return;
    const isChanged = String(customer.id) !== String(customerId || "");
    setCustomerId(String(customer.id));
    setSelectedCustomerRecord(customer);
    setShowCustomerCreate(false);
    setCustomerCreateDismissed(false);
    setShowCustomerOptional(false);
    if (isChanged) {
      setCustomerDetail(null);
      setCustomerContacts([]);
      setCustomerSites([]);
      setSelectedContactId("");
      setSelectedSiteId("");
      setAttentionTo("");
      setCommercialForm((prev) => ({ ...prev, attention_to: "" }));
      setMailForm((prev) => ({
        ...prev,
        to: "",
        cc: "",
        subject: "",
        body: "",
      }));
    }
    if ((customer.primary_contact_name || customer.contact_name) && (!attentionTo || isChanged)) {
      setAttentionTo([customer.primary_contact_salutation || null, customer.primary_contact_name || customer.contact_name || null].filter(Boolean).join(" "));
    }
  }

  function clearCustomerSelection() {
    setCustomerId("");
    setSelectedCustomerRecord(null);
    setCustomerDetail(null);
    setCustomerContacts([]);
    setCustomerSites([]);
    setSelectedContactId("");
    setSelectedSiteId("");
    setAttentionTo("");
    setShowCustomerCreate(false);
    setCustomerCreateDismissed(false);
    setShowCustomerOptional(false);
    autoExpandedQueryRef.current = "";
  }

  function openCustomerCreate(seedName = "") {
    const nextSeed = String(seedName || customerQ || "").trim();
    setShowCustomerCreate(true);
    setCustomerCreateDismissed(false);
    setNewCustomerForm((prev) => ({
      ...prev,
      customer_name: prev.customer_name && prev.customer_name.trim() ? prev.customer_name : nextSeed,
    }));
    setNewCustomerChecked(false);
    setNewCustomerDuplicates([]);
    setNewCustomerAllowDuplicate(false);
  }

  function dismissCustomerCreate() {
    setShowCustomerCreate(false);
    setCustomerCreateDismissed(true);
    setShowCustomerOptional(false);
  }

  function useContactForAttention(contact) {
    if (!contact) return;
    if (contact.id) setSelectedContactId(String(contact.id));
    const nextAttention = [contact.salutation || null, contact.full_name || null].filter(Boolean).join(" ");
    setAttentionTo(nextAttention);
    setCommercialForm((prev) => ({ ...prev, attention_to: nextAttention }));
  }

  useEffect(() => {
    if (!showCustomerCreate) return undefined;
    const customerName = String(newCustomerForm.customer_name || "").trim();
    const email = String(newCustomerForm.email || "").trim();
    const phone = String(newCustomerForm.phone || "").trim();
    const contactName = String(newCustomerForm.contact_name || "").trim();
    const gstin = String(newCustomerForm.gstin || "").trim();
    const city = String(newCustomerForm.city || "").trim();
    const state = String(newCustomerForm.state || "").trim();
    setNewCustomerChecked(false);
    setNewCustomerDuplicates([]);
    setNewCustomerAllowDuplicate(false);
    if (newCustomerDupeTimerRef.current) {
      clearTimeout(newCustomerDupeTimerRef.current);
      newCustomerDupeTimerRef.current = null;
    }
    if (customerName.length < 3) {
      setNewCustomerChecking(false);
      return undefined;
    }
    const seq = ++newCustomerDupeSeqRef.current;
    setNewCustomerChecking(true);
    newCustomerDupeTimerRef.current = setTimeout(() => {
      (async () => {
        try {
          const data = await apiFetch("/customers/duplicate-check", {
            method: "POST",
            body: JSON.stringify({
              customer_name: customerName,
              email,
              phone,
              contact_name: contactName,
              contact_email: email,
              contact_phone: phone,
              gstin,
              city,
              state,
              country_id: newCustomerForm.country_id || null,
            }),
          });
          if (seq !== newCustomerDupeSeqRef.current) return;
          setNewCustomerDuplicates(Array.isArray(data?.duplicates) ? data.duplicates : []);
          setNewCustomerChecked(true);
          setNewCustomerAllowDuplicate(false);
        } catch {
          if (seq !== newCustomerDupeSeqRef.current) return;
          setNewCustomerDuplicates([]);
          setNewCustomerChecked(false);
          setNewCustomerAllowDuplicate(false);
        } finally {
          if (seq === newCustomerDupeSeqRef.current) setNewCustomerChecking(false);
        }
      })().catch(() => {});
    }, 400);
    return () => {
      if (newCustomerDupeTimerRef.current) {
        clearTimeout(newCustomerDupeTimerRef.current);
        newCustomerDupeTimerRef.current = null;
      }
    };
  }, [
    showCustomerCreate,
    newCustomerForm.customer_name,
    newCustomerForm.email,
    newCustomerForm.phone,
    newCustomerForm.contact_name,
    newCustomerForm.gstin,
    newCustomerForm.city,
    newCustomerForm.state,
    newCustomerForm.country_id,
  ]);

  async function createInlineCustomer() {
    if (!newCustomerForm.customer_name.trim()) {
      setError("Customer name is required.");
      return;
    }
    if (newCustomerChecking || !newCustomerChecked) {
      setError("Wait for the duplicate check to finish.");
      return;
    }
    setCustomerCreating(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        customer_name: newCustomerForm.customer_name.trim(),
        phone: String(newCustomerForm.phone || "").trim(),
        email: String(newCustomerForm.email || "").trim(),
        contact_name: String(newCustomerForm.contact_name || "").trim(),
        contact_email: String(newCustomerForm.contact_email || newCustomerForm.email || "").trim(),
        contact_phone: String(newCustomerForm.contact_phone || newCustomerForm.phone || "").trim(),
        country_id: newCustomerForm.country_id || null,
        state: String(newCustomerForm.state || "").trim(),
        city: String(newCustomerForm.city || "").trim(),
        address_line1: String(newCustomerForm.address_line1 || "").trim(),
        pincode: String(newCustomerForm.pincode || "").trim(),
        gstin: String(newCustomerForm.gstin || "").trim(),
        allow_duplicate: newCustomerAllowDuplicate === true,
      };
      const data = await apiFetch("/customers", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const customer = data?.customer || null;
      if (!customer?.id) throw new Error("create failed");
      selectCustomer({
        ...customer,
        contact_name: payload.contact_name || "",
      });
      if (data?.site?.id) {
        setSelectedSiteId(String(data.site.id));
      }
      setNewCustomerForm({ ...EMPTY_NEW_CUSTOMER, country_id: defaultIndiaCountryId || "" });
      setNewCustomerChecked(false);
      setNewCustomerDuplicates([]);
      setNewCustomerAllowDuplicate(false);
      setNewCustomerAddCityOpen(false);
      setNewCustomerAddCityName("");
      setShowCustomerCreate(false);
      setNotice(
        data?.site?.id
          ? "Customer created with a quotable plant/site and selected for this quote."
          : "Customer created and selected. Add a plant/site below if you still need one."
      );
      await searchCustomers();
    } catch (e) {
      if (e?.data?.error === "POSSIBLE_DUPLICATE_CUSTOMER") {
        setNewCustomerDuplicates(Array.isArray(e?.data?.duplicates) ? e.data.duplicates : []);
        setNewCustomerChecked(true);
        setNewCustomerAllowDuplicate(false);
        setError("Possible duplicate customer found. Please select an existing master or confirm create anyway.");
      } else {
        setError(e?.data?.error === "FORBIDDEN" ? "You do not have rights to create customers." : "Failed to create customer.");
      }
    } finally {
      setCustomerCreating(false);
    }
  }

  async function refreshCustomerMaster(activeCustomerId = customerId) {
    const id = Number(activeCustomerId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const data = await apiFetch(`/customers/${id}`);
    const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
    const sites = Array.isArray(data?.sites) ? data.sites : [];
    setCustomerDetail(data?.customer || null);
    setCustomerContacts(contacts);
    setCustomerSites(sites);
    return { contacts, sites, customer: data?.customer || null };
  }

  async function createInlineContact() {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) {
      setError("Select a customer first.");
      return;
    }
    if (!String(newContactForm.full_name || "").trim()) {
      setError("Contact name is required.");
      return;
    }
    setContactCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/customers/${id}/contacts`, {
        method: "POST",
        body: JSON.stringify({
          full_name: String(newContactForm.full_name || "").trim(),
          email: String(newContactForm.email || "").trim() || null,
          phone: String(newContactForm.phone || "").trim() || null,
          designation: String(newContactForm.designation || "").trim() || null,
          is_primary: customerContacts.length === 0,
          roles: ["sales_enquiry", "quote_recipient"],
        }),
      });
      const contact = data?.contact || null;
      const refreshed = await refreshCustomerMaster(id);
      if (contact?.id) {
        setSelectedContactId(String(contact.id));
        useContactForAttention(contact);
      } else if (refreshed?.contacts?.length) {
        const primary = refreshed.contacts.find((c) => c.is_primary) || refreshed.contacts[0];
        if (primary?.id) setSelectedContactId(String(primary.id));
      }
      setNewContactForm({ full_name: "", email: "", phone: "", designation: "" });
      setShowContactCreate(false);
      setNotice("Contact added without leaving the quote.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to add contact."));
    } finally {
      setContactCreating(false);
    }
  }

  async function createInlineSite() {
    const id = Number(customerId);
    if (!Number.isFinite(id) || id <= 0) {
      setError("Select a customer first.");
      return;
    }
    if (!String(newSiteForm.site_name || "").trim()) {
      setError("Site / plant name is required.");
      return;
    }
    setSiteCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/customers/${id}/sites`, {
        method: "POST",
        body: JSON.stringify({
          site_name: String(newSiteForm.site_name || "").trim(),
          site_type: newSiteForm.site_type || "plant",
          address_line1: String(newSiteForm.address_line1 || "").trim() || null,
          city: String(newSiteForm.city || "").trim() || null,
          state: String(newSiteForm.state || "").trim() || null,
          pincode: String(newSiteForm.pincode || "").trim() || null,
          country_id: newSiteForm.country_id || customerDetail?.country_id || defaultIndiaCountryId || null,
          can_quote: true,
          can_dispatch: true,
          can_bill: true,
          is_default_quote_site: quotableCustomerSites.length === 0,
          is_default_ship_to: quotableCustomerSites.length === 0,
          is_active: true,
        }),
      });
      const site = data?.site || null;
      const refreshed = await refreshCustomerMaster(id);
      if (site?.id) {
        setSelectedSiteId(String(site.id));
      } else if (refreshed?.sites?.length) {
        const next =
          refreshed.sites.find((row) => row.is_default_quote_site && row.can_quote !== false) ||
          refreshed.sites.find((row) => row.can_quote !== false) ||
          refreshed.sites[0];
        if (next?.id) setSelectedSiteId(String(next.id));
      }
      setNewSiteForm({
        site_name: "",
        site_type: "plant",
        address_line1: "",
        city: "",
        state: "",
        pincode: "",
        country_id: defaultIndiaCountryId || "",
      });
      setShowSiteCreate(false);
      setNotice("Plant / site added and selected for this quote.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to add plant/site."));
    } finally {
      setSiteCreating(false);
    }
  }

  async function handleAddNewCustomerCity() {
    if (!newCustomerForm.country_id || !newCustomerSelectedStateId) {
      setError("Select country and state before adding a city.");
      return;
    }
    setNewCustomerSavingCity(true);
    setError("");
    setNotice("");
    try {
      const city = await createCityMaster({
        countryId: newCustomerForm.country_id,
        stateId: newCustomerSelectedStateId,
        cityName: newCustomerAddCityName,
      });
      setQuoteBootstrap((prev) => ({ ...prev, cities: appendCityOption(prev.cities, city) }));
      setNewCustomerForm((prev) => ({ ...prev, city: city?.city_name || prev.city }));
      setNewCustomerAddCityName("");
      setNewCustomerAddCityOpen(false);
      setNotice(`City ${city?.city_name || ""} added.`);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to add city."));
    } finally {
      setNewCustomerSavingCity(false);
    }
  }

  async function startDraftQuote() {
    if (!customerId) {
      setError("Select a customer first.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    setDraftDuplicateAdvisory([]);
    try {
      let advisoryNotice = "";
      // Soft integrity check: advisory only — never blocks draft creation.
      try {
        const master = customerDetail || selectedCustomer || {};
        const soft = await apiFetch("/customers/duplicate-check", {
          method: "POST",
          body: JSON.stringify({
            customer_name: master.customer_name || "",
            email: master.email || "",
            phone: master.phone || "",
            gstin: master.gstin || "",
            pan: master.pan || "",
            contact_email: selectedContact?.email || master.email || "",
            contact_phone: selectedContact?.phone || master.phone || "",
            exclude_customer_id: Number(customerId),
          }),
        });
        const blocking =
          Array.isArray(soft?.blocking_duplicates) && soft.blocking_duplicates.length
            ? soft.blocking_duplicates
            : Array.isArray(soft?.duplicates)
              ? soft.duplicates.filter(isBlockingDuplicateLevel)
              : [];
        if (blocking.length) {
          setDraftDuplicateAdvisory(blocking);
          advisoryNotice = `Advisory: ${blocking.length} similar customer master${blocking.length === 1 ? "" : "s"} found. Draft still started.`;
        }
      } catch {
        // Soft check failures must not prevent drafting.
      }

      const data = await apiFetch("/quotes", {
        method: "POST",
        body: JSON.stringify({
          customer_id: Number(customerId),
          customer_site_id: selectedSiteId ? Number(selectedSiteId) : null,
          job_asset_id: selectedJobAssetId ? Number(selectedJobAssetId) : null,
          service_warranty_case_id: aftermarketContext.service_warranty_case_id ? Number(aftermarketContext.service_warranty_case_id) : null,
          amc_contract_id: aftermarketContext.amc_contract_id ? Number(aftermarketContext.amc_contract_id) : null,
          attention_to: attentionTo || [selectedContact?.salutation || null, selectedContact?.full_name || null].filter(Boolean).join(" ") || null,
          lines: [],
        }),
      });
      setQuoteId(data?.quote?.id || null);
      setStep(1);
      setNotice(advisoryNotice || "Draft quote created. Now add items.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to start draft quote."));
    } finally {
      setSaving(false);
    }
  }

  function setDraftLine(lineKey, patch, pricingChanged) {
    setDraftLines((prev) =>
      prev.map((line) => {
        if (line.key !== lineKey) return line;
        const merged = { ...line, ...patch };
        const priceListChanged = Object.prototype.hasOwnProperty.call(patch || {}, "price_list");
        if (priceListChanged) {
          merged.price_list = resolvePriceTypeKey(priceTypeOptions, merged.price_list);
          const sourceListPriceRaw = toNumber(merged.source_list_price, 0);
          const currentGrossUnit = toNumber(merged.gross_unit_price_quote, toNumber(line.gross_unit_price_quote, 0));
          const previousPriceListKey = resolvePriceTypeKey(priceTypeOptions, line.price_list);
          const previousMultiplier = getPriceListMultiplier(priceTypeOptions, previousPriceListKey) || 1;
          const sourceListPrice =
            sourceListPriceRaw > 0
              ? sourceListPriceRaw
              : previousMultiplier > 0
                ? currentGrossUnit / previousMultiplier
                : currentGrossUnit;
          merged.source_list_price = String(sourceListPrice);
          if (sourceListPrice > 0) {
            merged.gross_unit_price_quote = String(sourceListPrice * getPriceListMultiplier(priceTypeOptions, merged.price_list));
            pricingChanged = String(merged.discount_amt || "").trim() && toNumber(merged.discount_amt, 0) > 0 ? "disc_amt" : "disc_pct";
          }
        }
        const norm = normalizePricingFields({
          qty: merged.qty,
          grossUnit: merged.gross_unit_price_quote,
          discPct: merged.discount_pct,
          discAmt: merged.discount_amt,
          netUnit: merged.unit_price_quote,
          changed: pricingChanged || null,
        });
        const next = {
          ...merged,
          qty: String(norm.qty || 0),
          gross_unit_price_quote: String(norm.grossUnit || 0),
          discount_pct: String(norm.discPct || 0),
          discount_amt: String(norm.discAmt || 0),
          unit_price_quote: String(norm.netUnit || 0),
        };
        next.line_description = buildLineMeta(next);
        return next;
      })
    );
  }

  function removeDraftLine(lineKey) {
    setDraftLines((prev) => prev.filter((line) => line.key !== lineKey));
  }

  function duplicateDraftLine(lineKey) {
    setDraftLines((prev) => {
      const index = prev.findIndex((line) => line.key === lineKey);
      if (index < 0) return prev;
      const copy = cloneDraftLine(prev[index]);
      const next = [...prev];
      next.splice(index + 1, 0, copy);
      return next;
    });
  }

  function moveDraftLine(lineKey, direction) {
    setDraftLines((prev) => {
      const index = prev.findIndex((line) => line.key === lineKey);
      if (index < 0) return prev;
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [line] = next.splice(index, 1);
      next.splice(target, 0, line);
      return next;
    });
  }

  function resetFastAdd(keepSelection = false) {
    setAddProductQ(keepSelection && addSelectedProduct ? addSelectedProduct.item_name || "" : "");
    setAddProductResults([]);
    if (!keepSelection) setAddSelectedProduct(null);
    setAddQty("1");
    setAddGrossUnit(keepSelection && addSelectedProduct ? addGrossUnit : "");
    setAddDiscPct("");
    setAddDiscAmt("");
    setAddRemarks("");
  }

  function selectProductForAdd(product) {
    const selected = product && typeof product === "object" ? product : null;
    const quoteListPrice = Math.max(
      convertBaseAmountToQuote(Math.max(0, toNumber(selected?.list_price, 0)), activeQuoteExchangeRate),
      getFallbackDraftLineQuotePrice(selected, draftLines)
    );
    setAddSelectedProduct(selected);
    setAddProductQ(selected?.item_name || "");
    setAddGrossUnit(String(quoteListPrice * getPriceListMultiplier(priceTypeOptions, addPriceList)));
    setAddDiscPct("");
    setAddDiscAmt("");
  }

  function buildDraftLineFromProduct(product, { qty = 1, remarks = "", priceList = addPriceList } = {}) {
    const sourceListPrice = Math.max(0, convertBaseAmountToQuote(Math.max(0, toNumber(product?.list_price, 0)), activeQuoteExchangeRate));
    const resolvedPriceList = resolvePriceTypeKey(priceTypeOptions, priceList);
    const norm = normalizePricingFields({
      qty,
      grossUnit: sourceListPrice * getPriceListMultiplier(priceTypeOptions, resolvedPriceList),
      discPct: 0,
      discAmt: 0,
      netUnit: 0,
      changed: "disc_pct",
    });
    const next = {
      key: `new:${Math.random().toString(16).slice(2)}`,
      id: null,
      product_id: product?.product_id || product?.id || null,
      item_code: product?.item_code || "",
      item_name: product?.item_name || "",
      product_group_name: String(product?.group_name || "").trim(),
      qty: String(qty),
      source_list_price: String(sourceListPrice),
      gross_unit_price_quote: String(norm.grossUnit),
      discount_pct: String(norm.discPct),
      discount_amt: String(norm.discAmt),
      price_list: resolvedPriceList,
      remarks: remarks || "",
      unit_price_quote: String(norm.netUnit),
      gst_pct: String(toNumber(product?.gst_pct, 0)),
      scope_type: "included",
      line_description: "",
      customer_item_code: "",
      customer_item_description: "",
    };
    next.line_description = buildLineMeta(next);
    return next;
  }

  function openProductMasterLane() {
    setItemsLane("product_master");
    setAddProductQ("");
    setAddProductResults([]);
    setAddSelectedProduct(null);
  }

  function openAbsstemShieldLane() {
    if (!selectedJobAssetId) {
      setNotice("Select the deployed Job Asset / Serial No first.");
      return;
    }
    setItemsLane("absstem_shield");
  }

  function returnToPackageBuilder() {
    setItemsLane("configurator");
  }

  function addSelectedItem(keepSelection = false) {
    if (!addSelectedProduct) return;
    const qty = Math.max(1, toNumber(addQty, 1));
    const computedGross = selectedProductQuoteListPrice * getPriceListMultiplier(priceTypeOptions, addPriceList);
    const gross = Math.max(0, toNumber(addGrossUnit, computedGross));
    const norm = normalizePricingFields({
      qty,
      grossUnit: gross,
      discPct: addDiscPct,
      discAmt: addDiscAmt,
      netUnit: 0,
      changed: addDiscAmt && String(addDiscAmt).trim().length ? "disc_amt" : "disc_pct",
    });
    const next = {
      key: `new:${Math.random().toString(16).slice(2)}`,
      id: null,
      product_id: addSelectedProduct.id,
      item_code: addSelectedProduct.item_code || "",
      item_name: addSelectedProduct.item_name || "",
      hsn_no: addSelectedProduct.hsn_no || "",
      product_group_id: addSelectedProduct.group_id ?? null,
      product_group_name: String(addSelectedProduct.group_name || "").trim(),
      qty: String(qty),
      source_list_price: String(selectedProductQuoteListPrice),
      gross_unit_price_quote: String(norm.grossUnit),
      discount_pct: String(norm.discPct),
      discount_amt: String(norm.discAmt),
      price_list: addPriceList || "list",
      unit_price_quote: String(norm.netUnit),
      gst_pct: String(toNumber(addSelectedProduct.gst_pct, 0)),
      scope_type: "included",
      remarks: addRemarks || "",
      line_description: "",
      customer_item_code: "",
      customer_item_description: "",
    };
    next.line_description = buildLineMeta(next);
    setDraftLines((prev) => [...prev, next]);
    resetFastAdd(keepSelection);
  }

  function addRecommendedJobSpare(spare) {
    if (!spare) return;
    const qtyRecommended = Math.max(1, toNumber(spare?.qty_recommended, 1));
    const sourceCodes = Array.isArray(spare?.source_lines)
      ? Array.from(new Set(spare.source_lines.map((line) => String(line?.installed_item_code || "").trim()).filter(Boolean))).join(", ")
      : "";
    const assetLabel = selectedJobAsset?.serial_no || selectedJobAsset?.job_id || "";
    const remarks = [
      "Absstem Shield recommended spare",
      assetLabel ? `Asset ${assetLabel}` : "",
      sourceCodes ? `Installed item ${sourceCodes}` : "",
    ]
      .filter(Boolean)
      .join(" • ");
    const next = buildDraftLineFromProduct(spare, { qty: qtyRecommended, remarks, priceList: addPriceList });
    setDraftLines((prev) => [...prev, next]);
    setNotice(`${spare?.item_name || "Recommended spare"} added from Absstem Shield.`);
    setError("");
  }

  async function saveItemsAndContinue() {
    if (!quoteId) return;
    setSaving(true);
    setError("");
    try {
      await persistDraftLines();
      setStep(2);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save items."));
    } finally {
      setSaving(false);
    }
  }

  function parseBulletLines(value) {
    return String(value || "")
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function bulletsToText(list) {
    return (Array.isArray(list) ? list : []).map((x) => String(x || "").trim()).filter(Boolean).join("\n");
  }

  function setExecutiveSummaryField(key, value) {
    setQuoteSummary((prev) => ({ ...prev, executive_summary: { ...(prev.executive_summary || {}), [key]: value } }));
  }

  function setScopeSummaryField(key, value) {
    setQuoteSummary((prev) => ({ ...prev, scope_summary: { ...(prev.scope_summary || {}), [key]: value } }));
  }

  function setScopeBulletField(key, textValue) {
    setScopeSummaryField(key, parseBulletLines(textValue));
  }

  function generateSummaryFromConfigurator() {
    const activeRec = selectedConfiguratorFamily.gas === "nitrogen" ? nitroRec : oxygenRec;
    const activeModel = selectedConfiguratorFamily.gas === "nitrogen" ? nitroModel : oxygenModel;
    const activePackageMode = selectedConfiguratorFamily.gas === "nitrogen" ? nitroPackageMode : oxygenPackageMode;
    const generated = buildConfiguratorNarrative({
      family: selectedConfiguratorFamily,
      lines: draftLines,
      rec: activeRec,
      selectedModel: activeModel,
      packageMode: activePackageMode,
      customerName: customerDetail?.customer_name || quote?.customer_name || "",
      siteName: selectedSite?.site_name || "",
    });
    setQuoteSummary((prev) => ({
      ...prev,
      executive_summary: generated.executive_summary,
      scope_summary: generated.scope_summary,
      configurator_context: liveConfiguratorContext,
    }));
    setNotice(`${selectedConfiguratorFamily.label} proposal draft generated from configurator context.`);
    setError("");
  }

  function resolveConfiguratorContextForSave() {
    const existing = quoteSummary?.configurator_context;
    if (existing && typeof existing === "object" && (existing.family_key || existing.selected_model || existing.source === "ui_configurator")) {
      return existing;
    }
    if (liveConfiguratorContext && (liveConfiguratorContext.selected_model || liveConfiguratorContext.family_key)) {
      return liveConfiguratorContext;
    }
    return {};
  }

  function renderConfiguratorPreviewBlocks() {
    const scope = activeConfiguratorPreview?.scope_summary || {};
    const deliverables = Array.isArray(scope.deliverables) ? scope.deliverables : [];
    const techHighlights = Array.isArray(scope.tech_highlights) ? scope.tech_highlights : [];

    return (
      <div style={{ border: "1px solid #edf1f7", borderRadius: 10, padding: 10, background: "#fff" }}>
        <div style={{ fontSize: 11, opacity: 0.68 }}>Scope Summary Preview</div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.82 }}>
          Deliverables: {deliverables.length ? deliverables.slice(0, 3).map((row) => row.model).filter(Boolean).join(" • ") : "—"}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.82 }}>Included lines preview: {deliverables.length}</div>
        {techHighlights.length ? (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.82, lineHeight: 1.6 }}>{techHighlights.slice(0, 3).join(" • ")}</div>
        ) : null}
        {activeConfiguratorCard.draftFamiliesLabel ? (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72 }}>Draft family mix: {activeConfiguratorCard.draftFamiliesLabel}</div>
        ) : null}
      </div>
    );
  }

  function setDeliverableRow(index, patch) {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.deliverables) ? current.deliverables.slice() : [];
      if (index < 0 || index >= rows.length) return prev;
      rows[index] = { ...(rows[index] || {}), ...(patch || {}) };
      return { ...prev, scope_summary: { ...current, deliverables: rows } };
    });
  }

  function addDeliverableRow() {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.deliverables) ? current.deliverables.slice() : [];
      rows.push({ model: "", description: "", qty: 1, remarks: "" });
      return { ...prev, scope_summary: { ...current, deliverables: rows } };
    });
  }

  function removeDeliverableRow(index) {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.deliverables) ? current.deliverables.slice() : [];
      rows.splice(index, 1);
      return { ...prev, scope_summary: { ...current, deliverables: rows } };
    });
  }

  function setResponsibilityRow(index, patch) {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.responsibilities) ? current.responsibilities.slice() : [];
      if (index < 0 || index >= rows.length) return prev;
      rows[index] = { ...(rows[index] || {}), ...(patch || {}) };
      return { ...prev, scope_summary: { ...current, responsibilities: rows } };
    });
  }

  function addResponsibilityRow() {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.responsibilities) ? current.responsibilities.slice() : [];
      rows.push({ party: "", responsibility: "" });
      return { ...prev, scope_summary: { ...current, responsibilities: rows } };
    });
  }

  function removeResponsibilityRow(index) {
    setQuoteSummary((prev) => {
      const current = prev.scope_summary && typeof prev.scope_summary === "object" ? prev.scope_summary : {};
      const rows = Array.isArray(current.responsibilities) ? current.responsibilities.slice() : [];
      rows.splice(index, 1);
      return { ...prev, scope_summary: { ...current, responsibilities: rows } };
    });
  }

  async function refreshSummary(activeQuoteId = quoteId) {
    if (!activeQuoteId) return;
    const data = await apiFetch(`/quotes/${activeQuoteId}/summary`);
    setQuoteSummary({
      revision_id: data?.revision_id ?? null,
      merge_annexures: data?.merge_annexures !== false,
      executive_summary: data?.executive_summary || {},
      scope_summary: data?.scope_summary || {},
      configurator_context: data?.configurator_context || {},
      is_locked: data?.is_locked === true,
      locked_at: data?.locked_at || null,
      locked_by: data?.locked_by || null,
      can_edit: data?.can_edit === true,
      can_lock: data?.can_lock === true,
      can_unlock: data?.can_unlock === true,
    });
  }

  async function saveSummary() {
    if (!quoteId) return;
    setSummarySaving(true);
    setError("");
    try {
      await apiFetch(`/quotes/${quoteId}/summary`, {
        method: "PUT",
        body: JSON.stringify({
          scope_summary: quoteSummary.scope_summary || {},
          configurator_context: resolveConfiguratorContextForSave(),
        }),
      });
      await refreshSummary(quoteId);
      setNotice("Scope summary saved.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save scope summary."));
    } finally {
      setSummarySaving(false);
    }
  }

  async function updateMergeAnnexures(nextValue) {
    if (!quoteId) return;
    setSummarySaving(true);
    setError("");
    try {
      await apiFetch(`/quotes/${quoteId}/summary`, { method: "PUT", body: JSON.stringify({ merge_annexures: nextValue === false ? false : true }) });
      await refreshSummary(quoteId);
      setNotice("PDF annexure preference saved.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save annexure preference."));
    } finally {
      setSummarySaving(false);
    }
  }

  async function lockSummary() {
    if (!quoteId) return;
    setSummarySaving(true);
    setError("");
    try {
      await apiFetch(`/quotes/${quoteId}/summary/lock`, { method: "POST" });
      await refreshSummary(quoteId);
      setNotice("Scope summary locked.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to lock scope summary."));
    } finally {
      setSummarySaving(false);
    }
  }

  async function unlockSummary() {
    if (!quoteId) return;
    setSummarySaving(true);
    setError("");
    try {
      await apiFetch(`/quotes/${quoteId}/summary/unlock`, { method: "POST" });
      await refreshSummary(quoteId);
      setNotice("Scope summary unlocked.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to unlock scope summary."));
    } finally {
      setSummarySaving(false);
    }
  }

  function setTerm(termId, patch) {
    setTerms((prev) => prev.map((term) => (term.id === termId ? { ...term, ...patch } : term)));
  }

  function addTerm() {
    setTerms((prev) => [
      ...prev,
      {
        id: `new:${Math.random().toString(16).slice(2)}`,
        caption: "Remarks",
        description: "",
        is_selected: true,
      },
    ]);
  }

  function removeTerm(termId) {
    setTerms((prev) => prev.filter((term) => term.id !== termId));
  }

  async function persistTermsAndCommercial() {
    if (!quoteId) return null;
    const commercialData = await apiFetch(`/quotes/${quoteId}/commercial`, {
      method: "PUT",
      body: JSON.stringify({
        customer_id: customerId ? Number(customerId) : null,
        customer_site_id: selectedSiteId ? Number(selectedSiteId) : null,
        job_asset_id: selectedJobAssetId ? Number(selectedJobAssetId) : null,
        attention_to: commercialForm.attention_to,
        pricing_display_mode: commercialForm.pricing_display_mode,
        is_export: commercialForm.is_export,
        incoterm_id: commercialForm.incoterm_id ? Number(commercialForm.incoterm_id) : null,
        base_currency_id: commercialForm.base_currency_id ? Number(commercialForm.base_currency_id) : null,
        quote_currency_id: commercialForm.quote_currency_id ? Number(commercialForm.quote_currency_id) : null,
        payment_term_id: commercialForm.payment_term_id ? Number(commercialForm.payment_term_id) : null,
        freight_term_id: commercialForm.freight_term_id ? Number(commercialForm.freight_term_id) : null,
        p_and_f_term_id: commercialForm.p_and_f_term_id ? Number(commercialForm.p_and_f_term_id) : null,
        delivery_lead_time_days: commercialForm.delivery_lead_time_days === "" ? null : Number(commercialForm.delivery_lead_time_days),
        warranty_months: commercialForm.warranty_months === "" ? null : Number(commercialForm.warranty_months),
      }),
    });
    const cadenceData = await apiFetch(`/quotes/${quoteId}/cadence`, {
      method: "PATCH",
      body: JSON.stringify({
        quote_valid_till: cadenceForm.quote_valid_till || null,
        next_follow_up_at: cadenceForm.next_follow_up_at || null,
        quote_kind: cadenceForm.quote_kind || "firm",
      }),
    });
    const termsData = await apiFetch(`/quotes/${quoteId}/terms`, {
      method: "PUT",
      body: JSON.stringify({
        terms: libraryTerms.map((term, idx) => ({
          id: typeof term.id === "number" ? term.id : null,
          caption: term.caption || "",
          description: term.description || "",
          is_selected: Boolean(term.is_selected),
          sort_order: idx + 1,
        })),
      }),
    });
    const savedQuote = commercialData?.quote || quote;
    setQuote(
      cadenceData?.quote
        ? {
            ...savedQuote,
            quote_valid_till: cadenceData.quote.quote_valid_till,
            next_follow_up_at: cadenceData.quote.next_follow_up_at,
            quote_kind: cadenceData.quote.quote_kind,
          }
        : savedQuote
    );
    setRevision(commercialData?.revision || revision);
    if (Array.isArray(commercialData?.lines)) {
      setLines(commercialData.lines);
      setDraftLines(mapServerLinesToDraft(commercialData.lines, quoteBootstrap.price_types));
    }
    setTerms(Array.isArray(termsData?.terms) ? termsData.terms : []);
    runQuietly(() => refreshMailBootstrap(quoteId));
    return { commercialData, cadenceData, termsData };
  }

  async function saveTermsAndCommercial(nextStep = 3) {
    if (!quoteId) return;
    setSaving(true);
    setError("");
    try {
      await persistTermsAndCommercial();
      setStep(nextStep);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save terms and commercial settings."));
    } finally {
      setSaving(false);
    }
  }

  async function recommendNitrogen() {
    if (!quoteId || !nitroFlow) return;
    setNitroWorking(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/recommend/nitrogen`, {
        method: "POST",
        body: JSON.stringify({ purity: nitroPurity, flow: Number(nitroFlow), family_key: selectedConfiguratorFamily.key }),
      });
      setNitroRec(data || null);
      setNitroModel(data?.recommended?.model || "");
      // Keep the user's replace/append choice across re-recommendations.
    } catch (e) {
      setNitroRec(null);
      setNitroModel("");
      setError(e?.data?.error === "NO_DATA" ? "Nitrogen data not configured on server." : "Failed to recommend model.");
    } finally {
      setNitroWorking(false);
    }
  }

  async function applyNitrogen() {
    if (!quoteId || !nitroRec) return;
    setNitroWorking(true);
    setError("");
    setNotice("");
    try {
      await persistDraftLines({ requireAtLeastOne: false });
      const data = await apiFetch(`/quotes/${quoteId}/apply/nitrogen`, {
        method: "POST",
        body: JSON.stringify({
          purity: nitroPurity,
          flow: Number(nitroFlow),
          family_key: selectedConfiguratorFamily.key,
          model: nitroModel || null,
          replace: nitroApplyMode === "replace",
          package_mode: nitroPackageMode,
        }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      const skipped = Array.isArray(data?.skipped_unmapped_items) ? data.skipped_unmapped_items : [];
      const modeLabel = nitroApplyMode === "replace" ? "replaced existing lines with" : "appended";
      setNotice(
        skipped.length
          ? `Nitrogen package ${modeLabel} the draft. Skipped unmapped items: ${skipped.join(", ")}. Add extras from Product Master if needed.`
          : `Nitrogen package ${modeLabel} the draft. Tax/HSN and list pricing were preserved. Add extras from Product Master if needed.`
      );
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to apply nitrogen package."));
    } finally {
      setNitroWorking(false);
    }
  }

  async function recommendOxygen() {
    if (!quoteId || !oxygenFlow) return;
    setOxygenWorking(true);
    setError("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/recommend/oxygen`, {
        method: "POST",
        body: JSON.stringify({ purity: oxygenPurity, flow: Number(oxygenFlow), family_key: selectedConfiguratorFamily.key }),
      });
      setOxygenRec(data || null);
      setOxygenModel(data?.recommended?.model || "");
      // Keep the user's replace/append choice across re-recommendations.
    } catch (e) {
      setOxygenRec(null);
      setOxygenModel("");
      setError(e?.data?.error === "NO_DATA" ? "Oxygen data not configured on server." : "Failed to recommend oxygen model.");
    } finally {
      setOxygenWorking(false);
    }
  }

  async function applyOxygen() {
    if (!quoteId || !oxygenRec) return;
    setOxygenWorking(true);
    setError("");
    setNotice("");
    try {
      await persistDraftLines({ requireAtLeastOne: false });
      const data = await apiFetch(`/quotes/${quoteId}/apply/oxygen`, {
        method: "POST",
        body: JSON.stringify({
          purity: oxygenPurity,
          flow: Number(oxygenFlow),
          family_key: selectedConfiguratorFamily.key,
          model: oxygenModel || null,
          replace: oxygenApplyMode === "replace",
          package_mode: oxygenPackageMode,
        }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      const skipped = Array.isArray(data?.skipped_unmapped_items) ? data.skipped_unmapped_items : [];
      const modeLabel = oxygenApplyMode === "replace" ? "replaced existing lines with" : "appended";
      setNotice(
        skipped.length
          ? `Oxygen package ${modeLabel} the draft. Skipped unmapped items: ${skipped.join(", ")}. Add extras from Product Master if needed.`
          : `Oxygen package ${modeLabel} the draft. Tax/HSN and list pricing were preserved. Add extras from Product Master if needed.`
      );
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to apply oxygen package."));
    } finally {
      setOxygenWorking(false);
    }
  }

  async function issueRevision(options = {}) {
    const { promptText = "", successNotice = "Revision issued successfully.", skipConfirm = false } = options;
    if (!quoteId || !["draft", "approved"].includes(revision?.revision_status || "")) return false;
    if (readiness.blockers.length) {
      setError(`Complete required items before issue: ${readiness.blockers.map((item) => item.label).join(" ")}`);
      setStep(readiness.blockers[0].step);
      return false;
    }
    if (issueBlockedByApproval || approval.can_issue === false) {
      setError("This revision exceeds the autonomous discount threshold. Submit it for approval first.");
      return false;
    }
    const issuePrompt = [
      promptText || (revision?.revision_status === "approved" ? "Issue this approved revision now?" : "Issue and lock this revision now?"),
      reviewConfiguratorWarnings.length
        ? `\n\nConfigurator review:\n${reviewConfiguratorWarnings.join(" ")}`
        : "",
    ].join("");
    if (!skipConfirm) {
      const ok = window.confirm(issuePrompt);
      if (!ok) return false;
    }
    setSaving(true);
    setError("");
    try {
      await persistDraftLines();
      await persistTermsAndCommercial();
      const latestApproval = await refreshApprovalStatus(quoteId);
      if (latestApproval?.approval_required && String(revision?.revision_status || "") === "draft") {
        setApproval(latestApproval);
        setError("This revision exceeds the autonomous discount threshold. Submit it for approval first.");
        return false;
      }
      if (latestApproval?.can_issue === false) {
        setApproval(latestApproval);
        setError("This revision cannot be issued until discount approval is complete.");
        return false;
      }
      const data = await apiFetch(`/quotes/${quoteId}/issue`, { method: "POST" });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      setApproval(data?.approval || approval);
      if (successNotice) setNotice(successNotice);
      runQuietly(() => refreshMailBootstrap(quoteId));
      return true;
    } catch (e) {
      if (e?.data?.approval) setApproval(e.data.approval);
      if (e?.data?.error === "APPROVAL_REQUIRED") {
        setError("This revision exceeds the autonomous discount threshold. Submit it for approval first.");
      } else if (e?.data?.error === "ISSUE_READINESS_FAILED" && Array.isArray(e?.data?.blockers) && e.data.blockers.length) {
        setError(`Complete required items before issue: ${e.data.blockers.map((item) => item?.label || "Missing requirement.").join(" ")}`);
      } else if (e?.data?.error === "REVISION_NOT_ISSUABLE") {
        setError("This revision cannot be issued in its current state.");
      } else {
        setError(getApiErrorMessage(e, "Failed to issue revision."));
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submitForApproval() {
    if (!quoteId || revision?.revision_status !== "draft") return;
    if (readiness.blockers.length) {
      setError(`Complete required items before submission: ${readiness.blockers.map((item) => item.label).join(" ")}`);
      setStep(readiness.blockers[0].step);
      return;
    }
    const submitPrompt = [
      "Submit this revision into the approval workflow?",
      reviewConfiguratorWarnings.length
        ? `\n\nConfigurator review:\n${reviewConfiguratorWarnings.join(" ")}`
        : "",
    ].join("");
    const ok = window.confirm(submitPrompt);
    if (!ok) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await persistDraftLines();
      await persistTermsAndCommercial();
      const data = await apiFetch(`/quotes/${quoteId}/submit-approval`, { method: "POST" });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      setApproval(data?.approval || approval);
      setNotice("Revision submitted for approval.");
    } catch (e) {
      if (e?.data?.approval) setApproval(e.data.approval);
      if (e?.data?.error === "APPROVAL_NOT_REQUIRED") {
        setError("Approval is not required for this revision. You can issue it directly.");
      } else if (e?.data?.error === "APPROVER_NOT_CONFIGURED") {
        setError("Approval chain is not configured. Assign manager approvers with quote approval rights.");
      } else {
        setError(getApiErrorMessage(e, "Failed to submit for approval."));
      }
    } finally {
      setSaving(false);
    }
  }

  async function approveRevision() {
    if (!quoteId || !approval.can_actor_approve || !canApproveQuotes) return;
    const remarks = window.prompt("Approval remarks (optional):", "");
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/approve`, {
        method: "POST",
        body: JSON.stringify({ remarks: remarks || "" }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      setApproval(data?.approval || approval);
      setNotice(data?.revision?.revision_status === "approved" ? "Revision approved." : "Approval recorded and routed to the next approver.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to approve revision."));
    } finally {
      setSaving(false);
    }
  }

  async function rejectRevision() {
    if (!quoteId || !approval.can_actor_approve || !canApproveQuotes) return;
    const remarks = window.prompt("Rejection remarks:", "");
    if (remarks === null) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/reject`, {
        method: "POST",
        body: JSON.stringify({ remarks: remarks || "" }),
      });
      setQuote(data?.quote || quote);
      setRevision(data?.revision || revision);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setDraftLines(mapServerLinesToDraft(data?.lines, quoteBootstrap.price_types));
      setApproval(data?.approval || approval);
      setNotice("Revision rejected. Create a new revision to make changes.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to reject revision."));
    } finally {
      setSaving(false);
    }
  }

  async function startNewRevision() {
    if (!quoteId) return;
    const currentState = String(revision?.revision_status || "").toLowerCase();
    if (!["issued", "rejected"].includes(currentState)) return;
    const amendmentReason = window.prompt("What is changing in this revision? (optional)", "");
    if (amendmentReason === null) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/quotes/${quoteId}/revisions`, {
        method: "POST",
        body: JSON.stringify({ amendment_reason: amendmentReason || "" }),
      });
      await loadQuoteContext(quoteId);
      await refreshApprovalStatus(quoteId);
      runQuietly(() => refreshMailBootstrap(quoteId));
      setStep(1);
      setNotice("New revision opened. Amend the offer, then move through Review to reissue.");
    } catch (e) {
      if (e?.data?.error === "ALREADY_DRAFT") {
        setError("A draft revision already exists on this quote. Continue editing that revision instead of creating another.");
      } else {
        setError(getApiErrorMessage(e, "Failed to create a new revision."));
      }
    } finally {
      setSaving(false);
    }
  }

  async function createSalesOrder() {
    if (!quoteId || revision?.revision_status !== "issued") return;
    const ok = window.confirm("Create Sales Order from this issued quote revision?");
    if (!ok) return;
    setCreatingSalesOrder(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/sales-orders/from-quote/${quoteId}`, { method: "POST" });
      const salesOrderId = data?.sales_order?.id;
      if (salesOrderId && onOpenSalesOrder) {
        onOpenSalesOrder(salesOrderId);
      } else {
        setNotice("Sales order created successfully.");
      }
    } catch (e) {
      if (e?.data?.error === "SALES_ORDER_ALREADY_EXISTS" && e?.data?.sales_order_id && onOpenSalesOrder) {
        onOpenSalesOrder(e.data.sales_order_id);
        return;
      }
      if (e?.data?.error === "QUOTE_NOT_ISSUED") {
        setError("Only issued quote revisions can be converted into sales orders.");
      } else {
        setError(getApiErrorMessage(e, "Failed to create sales order."));
      }
    } finally {
      setCreatingSalesOrder(false);
    }
  }

  async function sendQuoteMail({ issueAndSend = false } = {}) {
    if (!quoteId) return;
    if (readiness.blockers.length) {
      setError(`Complete required items before sending: ${readiness.blockers.map((item) => item.label).join(" ")}`);
      setStep(readiness.blockers[0].step);
      return;
    }
    const currentRevisionState = String(revision?.revision_status || "").toLowerCase();
    if (currentRevisionState !== "issued") {
      if (!issueAndSend) {
        setError("Issue the quote first. Sending is a separate customer handoff after the commercial lock.");
        return;
      }
      if (!["draft", "approved"].includes(currentRevisionState)) {
        setError("Only issue-ready revisions can be sent from this screen.");
        return;
      }
      if (issueBlockedByApproval || approval.can_issue === false) {
        setError("This revision exceeds the autonomous discount threshold. Submit it for approval first.");
        return;
      }
      const issued = await issueRevision({
        promptText: currentRevisionState === "approved" ? "Issue this approved revision and send it now?" : "Issue, lock, and send this revision now?",
        successNotice: "",
      });
      if (!issued) return;
    }
    setMailSending(true);
    setMailNotice("");
    setError("");
    try {
      const data = await apiFetch(`/quotes/${quoteId}/send-mail`, {
        method: "POST",
        body: JSON.stringify({
          to: mailForm.to,
          cc: mailForm.cc,
          bcc: mailForm.bcc,
          subject: mailForm.subject,
          body: mailForm.body,
          clubbed: mailForm.clubbed,
          manual_attachment_ids: mailAttachments.map((item) => Number(item.attachment_id || item.id)).filter(Number.isFinite),
        }),
      });
      setMailBootstrap((prev) => ({
        ...prev,
        history: Array.isArray(data?.history) ? data.history : prev.history,
      }));
      setMailNotice(currentRevisionState === "issued" ? "Quote mail sent successfully." : "Revision issued and quote mail sent successfully.");
      setMailComposerOpen(false);
    } catch (e) {
      if (Array.isArray(e?.data?.history)) {
        setMailBootstrap((prev) => ({
          ...prev,
          history: e.data.history,
        }));
      } else {
        refreshMailBootstrap(quoteId).catch(() => {});
      }
      if (e?.data?.error === "REVISION_NOT_ISSUED") {
        setError("Issue the revision before sending it to the customer.");
      } else if (e?.data?.error === "MAIL_ACCOUNT_NOT_CONFIGURED") {
        setError("Connect your mailbox or configure distributor/company fallback first.");
      } else if (e?.data?.error === "NO_RECIPIENT") {
        setError("Recipient email is required.");
      } else if (e?.data?.error === "MAIL_SEND_FAILED") {
        const details = e?.data?.mail_error?.message ? ` ${e.data.mail_error.message}` : "";
        setError(`Failed to send quote mail.${details}`);
      } else {
        setError("Failed to send quote mail.");
      }
    } finally {
      setMailSending(false);
    }
  }

  function fmtDateTime(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }

  function StepBadge({ index, item }) {
    const active = index === currentStepIndex;
    const complete = index < currentStepIndex;
    return (
      <button
        type="button"
        onClick={() => setStep(index)}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          width: "100%",
          padding: "12px 14px",
          borderRadius: 16,
          border: `1px solid ${active ? "#2354d5" : "#dcdcdc"}`,
          background: active ? "#edf3ff" : complete ? "#f6faf6" : "#fff",
          color: active ? "#143f9f" : "#333",
          minWidth: 0,
          boxShadow: active ? "0 12px 30px rgba(35,84,213,0.10)" : "none",
          textAlign: "left",
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 999,
            display: "grid",
            placeItems: "center",
            background: active ? "#2354d5" : complete ? "#0b6b38" : "#e8e8e8",
            color: active || complete ? "#fff" : "#555",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {complete ? "✓" : index + 1}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Step {index + 1}</div>
          <div style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</div>
          <div style={{ fontSize: 11, opacity: 0.68, marginTop: 2 }}>{item.hint}</div>
        </div>
      </button>
    );
  }

  return (
    <>
    <div className="smart-quote-builder-shell" style={{ maxWidth: 1240 }}>
      <style>{`
        .smart-quote-builder-shell button {
          border: 1px solid rgba(210, 220, 239, 0.92);
          background: linear-gradient(180deg, #ffffff 0%, #f7faff 100%);
          color: #20324d;
          padding: 10px 14px;
          border-radius: 12px;
          box-shadow: 0 6px 16px rgba(31, 41, 55, 0.04);
          font-weight: 700;
        }
        .smart-quote-builder-shell button:hover:not(:disabled) {
          border-color: rgba(115, 145, 214, 0.72);
        }
        .smart-quote-builder-shell button:disabled {
          opacity: 0.55;
          cursor: not-allowed;
          box-shadow: none;
        }
        .smart-quote-builder-shell input,
        .smart-quote-builder-shell select,
        .smart-quote-builder-shell textarea {
          border: 1px solid rgba(210, 220, 239, 0.92);
          border-radius: 12px;
          background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
          color: #22324a;
          padding: 11px 12px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.82);
        }
        .smart-quote-builder-shell input:focus,
        .smart-quote-builder-shell select:focus,
        .smart-quote-builder-shell textarea:focus {
          outline: none;
          border-color: rgba(35, 84, 213, 0.6);
          box-shadow: 0 0 0 3px rgba(35, 84, 213, 0.10);
          background: #fff;
        }
        .builder-layout-grid {
          display: grid;
          grid-template-columns: minmax(220px, 250px) minmax(0, 1fr) minmax(280px, 320px);
          gap: 18px;
          align-items: start;
        }
        .builder-four-stat-grid,
        .builder-action-grid,
        .builder-mail-meta {
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)) !important;
        }
        .builder-mail-grid,
        .builder-two-col {
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)) !important;
        }
        @media (max-width: 1520px) {
          .builder-layout-grid {
            grid-template-columns: minmax(0, 1fr);
          }
          .builder-left-rail,
          .builder-sidebar {
            position: static !important;
            top: auto !important;
          }
        }
      `}</style>
      <div
        style={{
          border: "1px solid #dfe6f4",
          borderRadius: 18,
          padding: 18,
          background: "linear-gradient(180deg, #f8fbff 0%, #ffffff 100%)",
          boxShadow: "0 18px 40px rgba(18, 41, 88, 0.06)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="button" onClick={onCancel}>
            Back
          </button>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0 }}>Smart Quote Builder</h2>
            <div style={{ fontSize: 12, opacity: 0.72 }}>
              Autopilot quote flow for sales teams. Standard industrial quotes stay simple, while healthcare quoting remains an explicit alternate route.
            </div>
          </div>
          <div
            style={{
              fontSize: 12,
              padding: "7px 10px",
              borderRadius: 999,
              background: revisionState === "draft" ? "#fff6e8" : "#eef8ff",
              border: revisionState === "draft" ? "1px solid #efd59a" : "1px solid #cfe3f7",
            }}
          >
            Revision {revision?.revision_no || "—"} • {revisionStateLabel}
          </div>
          <div
            style={{
              fontSize: 12,
              padding: "7px 10px",
              borderRadius: 999,
              background: lifecycleBadge.background,
              border: lifecycleBadge.border,
              color: lifecycleBadge.color,
            }}
          >
            {lifecycleBadge.label}
          </div>
          {quoteId ? (
            <button type="button" onClick={() => onOpenDetail(quoteId)}>
              Open Full Quote Desk
            </button>
          ) : null}
          {quote?.lead_id && typeof onOpenLead === "function" ? (
            <button type="button" onClick={() => onOpenLead(Number(quote.lead_id))}>
              Open Lead
            </button>
          ) : null}
        </div>
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center" }}>
          <div>
            <div style={{ height: 8, borderRadius: 999, background: "#e9eef8", overflow: "hidden" }}>
              <div
                style={{
                  width: `${progressPct}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #2354d5 0%, #5e8cff 100%)",
                }}
              />
            </div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
              {quote?.quote_number ? `Working on ${quote.quote_number}` : "Draft not created yet"} • Step {currentStepIndex + 1} of {steps.length}
            </div>
          </div>
          <div style={{ fontSize: 12, opacity: 0.72 }}>
            {progressPct}% complete
          </div>
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setQuoteRoute("industrial")}
            style={{
              background: quoteRoute === "industrial" ? "#edf3ff" : undefined,
              borderColor: quoteRoute === "industrial" ? "#2354d5" : undefined,
              color: quoteRoute === "industrial" ? "#143f9f" : undefined,
            }}
          >
            Industrial Quote
          </button>
          <button
            type="button"
            onClick={() => setQuoteRoute("healthcare")}
            style={{
              background: quoteRoute === "healthcare" ? "#edf7f0" : undefined,
              borderColor: quoteRoute === "healthcare" ? "#1a7f47" : undefined,
              color: quoteRoute === "healthcare" ? "#13592f" : undefined,
            }}
          >
            Healthcare Quote
          </button>
        </div>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0b6b38", marginTop: 12 }}>{notice}</div> : null}
      {draftDuplicateAdvisory.length ? (
        <div style={{ marginTop: 12 }}>
          <DuplicateWarningBanner
            duplicates={draftDuplicateAdvisory}
            advisoryOnly
            requireAllow={false}
            title="Similar customer masters found"
            onUseExisting={(dup) => {
              selectCustomer(dup);
              setDraftDuplicateAdvisory([]);
              setStep(0);
            }}
          />
          <button type="button" style={{ marginTop: 8 }} onClick={() => setDraftDuplicateAdvisory([])}>
            Dismiss advisory
          </button>
        </div>
      ) : null}

      <div className="builder-layout-grid" style={{ marginTop: 16 }}>
        <div className="builder-left-rail" style={{ position: "sticky", top: 16 }}>
          <div
            style={{
              border: "1px solid rgba(201,214,240,0.82)",
              borderRadius: 20,
              padding: 14,
              background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(247,250,255,0.98) 100%)",
              boxShadow: "0 20px 42px rgba(18,41,88,0.08)",
            }}
          >
            <div
              style={{
                borderRadius: 16,
                padding: 14,
                background: "radial-gradient(circle at top left, rgba(111,147,255,0.2), transparent 45%), linear-gradient(135deg, #112a5c 0%, #1d4ca8 52%, #7ba1ff 130%)",
                color: "#fff",
              }}
            >
              <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.8 }}>Quote flow</div>
              <div style={{ marginTop: 8, fontSize: 18, fontWeight: 800, lineHeight: 1.2 }}>{steps[currentStepIndex]?.label || "Quote Builder"}</div>
              <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.65, opacity: 0.84 }}>
                One decision stays open at a time so the builder feels guided instead of crowded.
              </div>
            </div>

            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              {steps.map((item, index) => (
                <StepBadge key={item.key} index={index} item={item} />
              ))}
            </div>

            <div style={{ marginTop: 12, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 14, padding: 12, background: "rgba(255,255,255,0.88)" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 6 }}>Recommended next</div>
              <div style={{ fontWeight: 800, fontSize: 14 }}>{recommendedNextAction.title}</div>
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.76, lineHeight: 1.65 }}>{recommendedNextAction.body}</div>
              <div style={{ marginTop: 10 }}>
                <button type="button" onClick={() => setStep(recommendedNextAction.step)} style={{ width: "100%", justifyContent: "center" }}>
                  Open {steps[recommendedNextAction.step]?.label || "section"}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <div
            style={{
              marginBottom: 14,
              border: "1px solid rgba(214,224,244,0.92)",
              borderRadius: 16,
              padding: 14,
              background: "radial-gradient(circle at top right, rgba(141,180,255,0.12), transparent 34%), linear-gradient(135deg, #f8fbff 0%, #ffffff 100%)",
              boxShadow: "0 14px 30px rgba(31,41,55,0.05)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Current section</div>
                <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800 }}>{steps[currentStepIndex]?.label || "Quote flow"}</div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                  {steps[currentStepIndex]?.hint || "Work one section at a time."}
                </div>
              </div>
              <CustomerChip label={`Current focus: ${steps[currentStepIndex]?.label || "Quote flow"}`} tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
            </div>
          </div>
          {step === 0 ? (
            <div style={{ marginTop: 18, border: "1px solid #dfe6f4", borderRadius: 20, padding: 20, background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)", boxShadow: "0 16px 36px rgba(25,45,84,0.05)" }}>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>Step 1</div>
                <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>Customer</div>
                <div style={{ marginTop: 6, fontSize: 13, opacity: 0.72, lineHeight: 1.7 }}>
                  Search Customer Master first. Create only when needed, then confirm contact and site.
                </div>
              </div>

              <div style={{ display: "grid", gap: 16 }}>
                {selectedCustomer ? (
                  <>
                    <SelectedCustomerCard
                      customer={{
                        ...selectedCustomer,
                        city: customerDetail?.city || selectedCustomer.city,
                        state: customerDetail?.state || selectedCustomer.state,
                        gstin: customerDetail?.gstin || selectedCustomer.gstin,
                        customer_code: customerDetail?.customer_code || selectedCustomer.customer_code,
                      }}
                      contactCount={customerContacts.length}
                      siteCount={quotableCustomerSites.length}
                      onChange={clearCustomerSelection}
                    />

                    <div style={{ border: "1px solid #efefef", borderRadius: 14, padding: 14, background: "#fff" }}>
                      <div style={{ fontWeight: 700, marginBottom: 8 }}>Recipient And Site</div>
                      <div style={{ display: "grid", gap: 12 }}>
                        <Field label="Customer Contact">
                          <div style={{ display: "grid", gap: 8 }}>
                            {customerContacts.length ? (
                              <select value={selectedContactId} onChange={(e) => setSelectedContactId(e.target.value)}>
                                <option value="">Select contact</option>
                                {customerContacts.map((contact) => (
                                  <option key={contact.id} value={String(contact.id)}>
                                    {[contact.salutation || null, contact.full_name || null].filter(Boolean).join(" ")}
                                    {contact.designation ? ` - ${contact.designation}` : ""}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div style={{ fontSize: 12, opacity: 0.72 }}>No contacts yet.</div>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setShowContactCreate((prev) => !prev);
                                setShowSiteCreate(false);
                                setNewContactForm({
                                  full_name: "",
                                  email: customerDetail?.email || "",
                                  phone: customerDetail?.phone || "",
                                  designation: "",
                                });
                              }}
                            >
                              {showContactCreate ? "Hide contact form" : "+ Add contact"}
                            </button>
                            {showContactCreate ? (
                              <div style={{ border: "1px solid #e7ebf3", borderRadius: 12, padding: 12, background: "#fbfcff", display: "grid", gap: 10 }}>
                                <Field label="Full name">
                                  <input
                                    value={newContactForm.full_name}
                                    onChange={(e) => setNewContactForm((prev) => ({ ...prev, full_name: e.target.value }))}
                                    placeholder="Contact name"
                                  />
                                </Field>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
                                  <Field label="Email">
                                    <input
                                      value={newContactForm.email}
                                      onChange={(e) => setNewContactForm((prev) => ({ ...prev, email: e.target.value }))}
                                      placeholder="email@company.com"
                                    />
                                  </Field>
                                  <Field label="Phone">
                                    <input
                                      value={newContactForm.phone}
                                      onChange={(e) => setNewContactForm((prev) => ({ ...prev, phone: e.target.value }))}
                                      placeholder="Phone"
                                    />
                                  </Field>
                                  <Field label="Designation">
                                    <input
                                      value={newContactForm.designation}
                                      onChange={(e) => setNewContactForm((prev) => ({ ...prev, designation: e.target.value }))}
                                      placeholder="Optional"
                                    />
                                  </Field>
                                </div>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  <button type="button" className="button-primary" onClick={createInlineContact} disabled={contactCreating}>
                                    {contactCreating ? "Saving…" : "Save contact"}
                                  </button>
                                  <button type="button" onClick={() => setShowContactCreate(false)} disabled={contactCreating}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </Field>
                        {selectedContact ? (
                          <div style={{ marginTop: -4, fontSize: 12, opacity: 0.78, lineHeight: 1.6 }}>
                            <div>{selectedContact.email || "—"}</div>
                            <div>{selectedContact.phone || "—"}</div>
                            <button type="button" onClick={() => useContactForAttention(selectedContact)} style={{ marginTop: 8 }}>
                              Use Contact For Attention To
                            </button>
                          </div>
                        ) : null}

                        <Field label="Quote Site / Plant">
                          <div style={{ display: "grid", gap: 8 }}>
                            {quotableCustomerSites.length ? (
                              <select value={selectedSiteId} onChange={(e) => setSelectedSiteId(e.target.value)}>
                                <option value="">Select site / plant</option>
                                {quotableCustomerSites.map((site) => (
                                  <option key={site.id} value={String(site.id)}>
                                    {site.site_name}
                                    {site.site_code ? ` - ${site.site_code}` : ""}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div style={{ fontSize: 12, opacity: 0.72 }}>No quotable plant/site yet.</div>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setShowSiteCreate((prev) => !prev);
                                setShowContactCreate(false);
                                setNewSiteForm({
                                  site_name: customerDetail?.city ? `${customerDetail.city} Plant` : "",
                                  site_type: "plant",
                                  address_line1: customerDetail?.address_line1 || "",
                                  city: customerDetail?.city || "",
                                  state: customerDetail?.state || "",
                                  pincode: customerDetail?.pincode || "",
                                  country_id: customerDetail?.country_id ? String(customerDetail.country_id) : defaultIndiaCountryId || "",
                                });
                              }}
                            >
                              {showSiteCreate ? "Hide site form" : "+ Add plant / site"}
                            </button>
                            {showSiteCreate ? (
                              <div style={{ border: "1px solid #e7ebf3", borderRadius: 12, padding: 12, background: "#fbfcff", display: "grid", gap: 10 }}>
                                <Field label="Site / plant name">
                                  <input
                                    value={newSiteForm.site_name}
                                    onChange={(e) => setNewSiteForm((prev) => ({ ...prev, site_name: e.target.value }))}
                                    placeholder="e.g. Pune Plant"
                                  />
                                </Field>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
                                  <Field label="Address">
                                    <input
                                      value={newSiteForm.address_line1}
                                      onChange={(e) => setNewSiteForm((prev) => ({ ...prev, address_line1: e.target.value }))}
                                      placeholder="Optional"
                                    />
                                  </Field>
                                  <Field label="City">
                                    <input
                                      value={newSiteForm.city}
                                      onChange={(e) => setNewSiteForm((prev) => ({ ...prev, city: e.target.value }))}
                                      placeholder="City"
                                    />
                                  </Field>
                                  <Field label="State">
                                    <input
                                      value={newSiteForm.state}
                                      onChange={(e) => setNewSiteForm((prev) => ({ ...prev, state: e.target.value }))}
                                      placeholder="State"
                                    />
                                  </Field>
                                  <Field label="Pincode">
                                    <input
                                      value={newSiteForm.pincode}
                                      onChange={(e) => setNewSiteForm((prev) => ({ ...prev, pincode: e.target.value }))}
                                      placeholder="Pincode"
                                    />
                                  </Field>
                                </div>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  <button type="button" className="button-primary" onClick={createInlineSite} disabled={siteCreating}>
                                    {siteCreating ? "Saving…" : "Save plant / site"}
                                  </button>
                                  <button type="button" onClick={() => setShowSiteCreate(false)} disabled={siteCreating}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </Field>
                        {selectedSite ? (
                          <div style={{ marginTop: -4, fontSize: 12, opacity: 0.78, lineHeight: 1.6 }}>
                            <div>{[selectedSite.site_type || null, selectedSite.city || null, selectedSite.state || null].filter(Boolean).join(" • ") || "Site selected"}</div>
                            <div>
                              GST Status: {selectedSite.gst_status === "available" ? selectedSite.tax_gstin || "Available" : selectedSite.gst_status || "pending"}
                            </div>
                          </div>
                        ) : null}

                        <Field label="Job Asset / Serial No">
                          {jobAssets.length ? (
                            <select value={selectedJobAssetId} onChange={(e) => setSelectedJobAssetId(e.target.value)}>
                              <option value="">Select deployed Job Asset</option>
                              {jobAssets.map((asset) => (
                                <option key={asset.id} value={String(asset.id)}>
                                  {[asset.serial_no || null, asset.job_id || null, asset.so_number ? `SO ${asset.so_number}` : null].filter(Boolean).join(" • ")}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <div style={{ fontSize: 12, opacity: 0.72 }}>{jobAssetSummary}</div>
                          )}
                        </Field>
                        {selectedJobAsset ? (
                          <div style={{ marginTop: -4, fontSize: 12, opacity: 0.78, lineHeight: 1.6 }}>
                            <div>
                              {[selectedJobAsset.serial_no || null, selectedJobAsset.job_id || null, selectedJobAsset.asset_name || selectedJobAsset.finished_good_item_name || null]
                                .filter(Boolean)
                                .join(" • ") || "Selected deployed asset"}
                            </div>
                            <div>
                              Recommended mapped spares: {recommendedJobSparesLoading ? "Loading..." : recommendedJobSpares.length || 0}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div style={{ border: "1px solid #efefef", borderRadius: 14, padding: 14, background: "#fff" }}>
                      <div style={{ fontWeight: 800, marginBottom: 10 }}>Quote Header</div>
                      <Field label="Attention To">
                        <input
                          value={attentionTo}
                          onChange={(e) => setAttentionTo(e.target.value)}
                          placeholder="Customer recipient for this quote"
                        />
                      </Field>
                      {selectedContact && !attentionTo ? (
                        <div style={{ fontSize: 12, opacity: 0.72, marginTop: -2 }}>
                          Defaulting to selected contact: {selectedContact.full_name}
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ border: "1px solid #d9e3fb", borderRadius: 16, padding: 16, background: "#fff" }}>
                      <Field label="Search Customer Master">
                        <input
                          value={customerQ}
                          onChange={(e) => setCustomerQ(e.target.value)}
                          placeholder="Company name, code, phone, email, city, or GST"
                          style={{ width: "100%", fontSize: 16, padding: "12px 14px" }}
                          autoFocus
                        />
                      </Field>
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>{customerResultsSummary}</div>

                      <div style={{ marginTop: 14, display: "grid", gap: 8, maxHeight: 360, overflow: "auto", paddingRight: 2 }}>
                        {customerResults.map((c) => (
                          <CustomerResultCard key={c.id} customer={c} onSelect={selectCustomer} />
                        ))}
                        {!customerSearching && customerSearchQuery.length >= 3 && !customerResults.length ? (
                          <div style={{ fontSize: 13, opacity: 0.72, padding: "8px 2px" }}>
                            No match for &ldquo;{customerSearchQuery}&rdquo;. Create a new customer below, or refine the search.
                          </div>
                        ) : null}
                        {!customerSearching && !customerSearchQuery ? (
                          <div style={{ fontSize: 13, opacity: 0.72, padding: "8px 2px" }}>
                            Start typing to search the live Customer Master.
                          </div>
                        ) : null}
                      </div>

                      <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        {!showCustomerCreate ? (
                          <button type="button" onClick={() => openCustomerCreate(customerSearchQuery)}>
                            + Create New Customer
                          </button>
                        ) : (
                          <button type="button" onClick={dismissCustomerCreate}>
                            Hide create form
                          </button>
                        )}
                      </div>
                    </div>

                    {showCustomerCreate ? (
                      <div
                        style={{
                          border: "1px solid rgba(218,226,241,0.92)",
                          borderRadius: 16,
                          padding: 16,
                          background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)",
                        }}
                      >
                        <div style={{ fontWeight: 800, fontSize: 16 }}>Create New Customer</div>
                        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7, lineHeight: 1.6 }}>
                          Company, contact, email, and phone are enough to start. Location and GSTIN are optional.
                        </div>
                        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                          <Field label="Company Name">
                            <input
                              value={newCustomerForm.customer_name}
                              onChange={(e) => {
                                const v = e.target.value;
                                setNewCustomerForm((prev) => ({ ...prev, customer_name: v }));
                              }}
                              placeholder="Company / hospital / plant name"
                              autoFocus
                            />
                          </Field>
                          <Field label="Contact Person">
                            <input
                              value={newCustomerForm.contact_name}
                              onChange={(e) => setNewCustomerForm((prev) => ({ ...prev, contact_name: e.target.value }))}
                              placeholder="Primary contact"
                            />
                          </Field>
                          <Field label="Email">
                            <input
                              value={newCustomerForm.email}
                              onChange={(e) => {
                                const v = e.target.value;
                                setNewCustomerForm((prev) => ({ ...prev, email: v, contact_email: v }));
                              }}
                              placeholder="Email"
                            />
                          </Field>
                          <Field label="Phone">
                            <input
                              value={newCustomerForm.phone}
                              onChange={(e) => {
                                const v = e.target.value;
                                setNewCustomerForm((prev) => ({ ...prev, phone: v, contact_phone: v }));
                              }}
                              placeholder="Phone"
                            />
                          </Field>
                        </div>

                        <div style={{ marginTop: 12 }}>
                          <button type="button" onClick={() => setShowCustomerOptional((prev) => !prev)}>
                            {showCustomerOptional ? "Hide optional details" : "More details (location / GSTIN)"}
                          </button>
                        </div>

                        {showCustomerOptional ? (
                          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                            <Field label="Country (optional)">
                              <select
                                value={newCustomerForm.country_id}
                                onChange={(e) =>
                                  setNewCustomerForm((prev) => ({
                                    ...prev,
                                    country_id: e.target.value,
                                    state: "",
                                    city: "",
                                  }))
                                }
                              >
                                <option value="">Select country</option>
                                {(quoteBootstrap.countries || []).map((country) => (
                                  <option key={country.id} value={String(country.id)}>
                                    {country.iso_code} - {country.country_name}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="State (optional)">
                              <select
                                value={newCustomerSelectedStateId}
                                onChange={(e) => {
                                  const next = newCustomerStateOptions.find((item) => String(item.id) === e.target.value) || null;
                                  setNewCustomerForm((prev) => ({
                                    ...prev,
                                    state: next?.state_name || "",
                                    city: "",
                                  }));
                                }}
                                disabled={!newCustomerForm.country_id}
                              >
                                <option value="">Select state</option>
                                {newCustomerStateOptions.map((state) => (
                                  <option key={state.id} value={String(state.id)}>
                                    {state.state_code} - {state.state_name}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="City (optional)">
                              <select
                                value={newCustomerSelectedCityId}
                                onChange={(e) => {
                                  const next = newCustomerCityOptions.find((item) => String(item.id) === e.target.value) || null;
                                  setNewCustomerForm((prev) => ({ ...prev, city: next?.city_name || "" }));
                                }}
                                disabled={!newCustomerSelectedStateId}
                              >
                                <option value="">Select city</option>
                                {newCustomerCityOptions.map((city) => (
                                  <option key={city.id} value={String(city.id)}>
                                    {city.city_name}
                                  </option>
                                ))}
                              </select>
                              <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  onClick={() => setNewCustomerAddCityOpen((prev) => !prev)}
                                  disabled={!newCustomerSelectedStateId || newCustomerSavingCity}
                                >
                                  {newCustomerAddCityOpen ? "Cancel Add City" : "Add City"}
                                </button>
                              </div>
                              {newCustomerAddCityOpen ? (
                                <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                  <input
                                    value={newCustomerAddCityName}
                                    onChange={(e) => setNewCustomerAddCityName(e.target.value)}
                                    placeholder="Enter city name"
                                    style={{ minWidth: 220 }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleAddNewCustomerCity()}
                                    disabled={newCustomerSavingCity || !newCustomerAddCityName.trim()}
                                  >
                                    {newCustomerSavingCity ? "Adding..." : "Save City"}
                                  </button>
                                </div>
                              ) : null}
                            </Field>
                            <Field label="GSTIN (optional)">
                              <input
                                value={newCustomerForm.gstin}
                                onChange={(e) => setNewCustomerForm((prev) => ({ ...prev, gstin: e.target.value }))}
                                placeholder="Optional GSTIN"
                              />
                            </Field>
                            <Field label="Address (optional)">
                              <input
                                value={newCustomerForm.address_line1}
                                onChange={(e) => setNewCustomerForm((prev) => ({ ...prev, address_line1: e.target.value }))}
                                placeholder="Address"
                              />
                            </Field>
                            <Field label="PIN Code (optional)">
                              <input
                                value={newCustomerForm.pincode}
                                onChange={(e) => setNewCustomerForm((prev) => ({ ...prev, pincode: e.target.value }))}
                                placeholder="PIN Code"
                              />
                            </Field>
                          </div>
                        ) : null}

                        {newCustomerChecking ? (
                          <div style={{ marginTop: 12, fontSize: 13, opacity: 0.76 }}>Checking for duplicates…</div>
                        ) : newCustomerChecked ? (
                          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                            {newCustomerBlockingDuplicates.length ? (
                              <DuplicateWarningBanner
                                duplicates={newCustomerBlockingDuplicates}
                                allowDuplicate={newCustomerAllowDuplicate}
                                onAllowChange={setNewCustomerAllowDuplicate}
                                onUseExisting={selectCustomer}
                                disabled={customerCreating || newCustomerChecking}
                              />
                            ) : null}
                            {!newCustomerBlockingDuplicates.length && newCustomerAdvisoryDuplicates.length ? (
                              <DuplicateWarningBanner
                                duplicates={newCustomerAdvisoryDuplicates}
                                advisoryOnly
                                requireAllow={false}
                                title="Low-confidence overlaps (advisory)"
                                disabled={customerCreating || newCustomerChecking}
                                onUseExisting={selectCustomer}
                              />
                            ) : null}
                            {!newCustomerBlockingDuplicates.length && !newCustomerAdvisoryDuplicates.length ? (
                              <div style={{ fontSize: 13, opacity: 0.84, padding: 12, borderRadius: 12, background: "#f4fbf5", border: "1px solid #d6ead9" }}>
                                No duplicates detected. Ready to create.
                              </div>
                            ) : null}
                          </div>
                        ) : newCustomerForm.customer_name.trim().length >= 3 ? (
                          <div style={{ marginTop: 12, fontSize: 13, opacity: 0.76 }}>
                            Duplicate check runs as you update company name, email, phone, GSTIN, or location.
                          </div>
                        ) : null}

                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                          <button type="button" onClick={dismissCustomerCreate} disabled={customerCreating}>
                            Back to search
                          </button>
                          <button
                            type="button"
                            onClick={() => setNewCustomerForm({ ...EMPTY_NEW_CUSTOMER, country_id: defaultIndiaCountryId || "" })}
                            disabled={customerCreating}
                          >
                            Reset
                          </button>
                          <button
                            type="button"
                            className="button-primary"
                            onClick={createInlineCustomer}
                            disabled={
                              customerCreating ||
                              newCustomerChecking ||
                              !newCustomerForm.customer_name.trim() ||
                              !newCustomerChecked ||
                              (newCustomerBlockingDuplicates.length > 0 && !newCustomerAllowDuplicate)
                            }
                          >
                            {customerCreating ? "Creating..." : "Create & Use Customer"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
                {draftDuplicateAdvisory.length ? (
                  <DuplicateWarningBanner
                    duplicates={draftDuplicateAdvisory}
                    advisoryOnly
                    requireAllow={false}
                    title="Similar customer masters found"
                    onUseExisting={(dup) => {
                      selectCustomer(dup);
                      setDraftDuplicateAdvisory([]);
                    }}
                  />
                ) : null}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button type="button" onClick={startDraftQuote} disabled={saving || !customerId}>
                    {saving ? (isExistingDraft ? "Continuing..." : "Starting...") : isExistingDraft ? "Continue Draft Quote" : "Start Draft Quote"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {step === 1 ? (
              <div style={{ marginTop: 18, border: "1px solid #dfe6f4", borderRadius: 20, padding: 20, background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)", boxShadow: "0 16px 36px rgba(25,45,84,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>Step 2</div>
                  <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>Build Offer</div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {selectedJobAssetId ? (
                    <button type="button" onClick={openAbsstemShieldLane}>
                      Open Absstem Shield
                    </button>
                  ) : null}
                  <button type="button" onClick={openProductMasterLane}>
                    Open Product Master
                  </button>
                  <button type="button" onClick={() => setStep(0)} disabled={saving}>
                    Back to Customer
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 0.9fr) minmax(0, 0.9fr)", gap: 12 }}>
                <div
                  style={{
                    border: "1px solid rgba(19,107,60,0.16)",
                    borderRadius: 16,
                    padding: 14,
                    background: "linear-gradient(180deg, #f3fbf6 0%, #ffffff 100%)",
                    boxShadow: "0 10px 22px rgba(19,107,60,0.06)",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <CustomerChip label="Step 1" tone="#eefaf2" color="#136b3c" borderColor="rgba(19,107,60,0.14)" />
                    <CustomerChip label="Main path" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                  </div>
                  <div style={{ marginTop: 10, fontSize: 17, fontWeight: 800 }}>Build the main package first</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78, lineHeight: 1.6 }}>Configurator-driven main package.</div>
                </div>
                <div
                  style={{
                    border: "1px solid rgba(214,224,244,0.92)",
                    borderRadius: 16,
                    padding: 14,
                    background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <CustomerChip label="Step 2" tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                    <CustomerChip label="Optional extras" tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" />
                  </div>
                  <div style={{ marginTop: 10, fontSize: 15, fontWeight: 800 }}>Add extra catalog items any time</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.6 }}>Approved add-ons or standalone lines.</div>
                  <div style={{ marginTop: 10 }}>
                    <button type="button" onClick={openProductMasterLane}>
                      Open Product Master
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    border: "1px solid rgba(35,84,213,0.16)",
                    borderRadius: 16,
                    padding: 14,
                    background: "linear-gradient(180deg, #f5f8ff 0%, #ffffff 100%)",
                  }}
                >
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <CustomerChip label="Absstem Shield" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                    <CustomerChip label="Deployed asset spares" tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" />
                  </div>
                  <div style={{ marginTop: 10, fontSize: 15, fontWeight: 800 }}>Quote mapped job consumables fast</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.6 }}>Asset-linked spares and consumables.</div>
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.74 }}>
                    {selectedJobAsset
                      ? `${selectedJobAsset.serial_no || selectedJobAsset.job_id || "Selected asset"} • ${recommendedJobSparesLoading ? "loading mapped spares..." : `${recommendedJobSpares.length} mapped spare(s)`}`
                      : "Select a Job Asset / Serial No in Step 1 to unlock this lane."}
                  </div>
                  {selectedJobAssetId ? (
                    <div style={{ marginTop: 10 }}>
                      <button type="button" onClick={openAbsstemShieldLane}>
                        Open Absstem Shield
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              {itemsLane === "product_master" ? (
              <div style={{ marginTop: 18, border: "1px solid rgba(225,229,238,0.96)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%)", boxShadow: "0 12px 24px rgba(31,41,55,0.04)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 18 }}>Product Master: Additional Quote Items</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <CustomerChip label={hasQuoteItems ? "Quote already has items" : "Standalone or add-on use"} tone={hasQuoteItems ? "#eefaf2" : "#fff7ea"} color={hasQuoteItems ? "#136b3c" : "#9a5a00"} borderColor={hasQuoteItems ? "rgba(19,107,60,0.14)" : "rgba(154,90,0,0.12)"} />
                    <CustomerChip label="Catalog only" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                    <CustomerChip label="No manual lines" tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                    <button type="button" onClick={returnToPackageBuilder}>
                      Back To Package Builder
                    </button>
                  </div>
                </div>
                <div style={{ display: "grid", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10, alignItems: "end" }}>
                    <Field label="Category">
                      <select value={addCategoryId} onChange={(e) => setAddCategoryId(e.target.value)} style={{ width: "100%" }}>
                        <option value="">All</option>
                        {productCategories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.category_name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Group">
                      <select value={addGroupId} onChange={(e) => setAddGroupId(e.target.value)} style={{ width: "100%" }}>
                        <option value="">All</option>
                        {filteredGroups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.group_name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div style={{ position: "relative" }}>
                      <Field label="Item Search">
                        <input
                          value={addProductQ}
                          onChange={(e) => {
                            setAddProductQ(e.target.value);
                            setAddSelectedProduct(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            e.preventDefault();
                            if (!addSelectedProduct && addProductResults.length === 1) {
                              selectProductForAdd(addProductResults[0]);
                              return;
                            }
                            if (addSelectedProduct) {
                              addSelectedItem(false);
                            }
                          }}
                          placeholder={isBrowsingProducts ? "Type to narrow the filtered item list" : "Type item code or name"}
                          style={{ width: "100%" }}
                        />
                      </Field>
                      {!addSelectedProduct && addProductResults.length ? (
                        <div
                          style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            top: 64,
                            background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,251,255,0.98) 100%)",
                            border: "1px solid rgba(214,224,244,0.92)",
                            borderRadius: 16,
                            maxHeight: 280,
                            overflow: "auto",
                            zIndex: 5,
                            padding: 10,
                            boxShadow: "0 20px 40px rgba(22,36,71,0.12)",
                          }}
                        >
                          <div style={{ display: "grid", gap: 10 }}>
                            {addProductResults.map((p) => (
                              <ProductResultCard
                                key={p.id}
                                product={p}
                                selected={String(addSelectedProduct?.id || "") === String(p.id)}
                                onClick={() => {
                                  selectProductForAdd(p);
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {!addSelectedProduct && !addProductResults.length && (addProductQ.trim() || isBrowsingProducts) ? (
                        <div
                          style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            top: 64,
                            background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)",
                            border: "1px solid rgba(214,224,244,0.92)",
                            borderRadius: 16,
                            padding: 14,
                            zIndex: 5,
                            fontSize: 12,
                            opacity: 0.78,
                            boxShadow: "0 18px 34px rgba(22,36,71,0.1)",
                          }}
                        >
                          No items matched this search/filter.
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                    {isBrowsingProducts
                      ? "Browsing works from category/group filters even without typing."
                      : "Tip: choose category/group first for faster Product Master pickup."}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, alignItems: "end" }}>
                    <Field label="Qty">
                      <input
                        type="number"
                        value={addQty}
                        onChange={(e) => setAddQty(e.target.value)}
                        min={1}
                        step={1}
                        style={{ width: "100%" }}
                      />
                    </Field>
                    <Field label="Price List">
                      <select value={addPriceList} onChange={(e) => setAddPriceList(e.target.value)} style={{ width: "100%" }}>
                        {priceTypeOptions.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Gross Unit">
                      <input
                        type="number"
                        value={addGrossUnit}
                        min={0}
                        step={0.01}
                        readOnly
                        style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
                      />
                    </Field>
                    <Field label="Disc %">
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <input
                          type="number"
                          value={addDiscPct}
                          onChange={(e) => {
                            setAddDiscPct(e.target.value);
                            setAddDiscAmt("");
                          }}
                          placeholder="%"
                          min={0}
                          step={0.01}
                          style={{ width: "100%" }}
                        />
                        <input
                          type="number"
                          value={addDiscAmt}
                          placeholder="Amt"
                          min={0}
                          step={0.01}
                          readOnly
                          style={{ width: "100%", background: "#f5f7fb", color: "#5f6f8f" }}
                        />
                      </div>
                    </Field>
                    <Field label="Remarks">
                      <input value={addRemarks} onChange={(e) => setAddRemarks(e.target.value)} placeholder="Optional line remarks" style={{ width: "100%" }} />
                    </Field>
                  </div>
                </div>
                {addSelectedProduct ? (
                  <div
                    style={{
                      marginTop: 12,
                      border: "1px solid rgba(173,198,255,0.84)",
                      background: "radial-gradient(circle at top right, rgba(141,180,255,0.18), transparent 34%), linear-gradient(135deg, #edf4ff 0%, #ffffff 100%)",
                      borderRadius: 16,
                      padding: 14,
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: 12,
                      alignItems: "center",
                      boxShadow: "0 14px 30px rgba(56,94,178,0.08)",
                    }}
                  >
                    <div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <CustomerChip label="Selected item" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" />
                        {addSelectedProduct.item_code ? <CustomerChip label={addSelectedProduct.item_code} tone="#f8fbff" color="#31539d" borderColor="rgba(49,83,157,0.12)" /> : null}
                      </div>
                      <div style={{ marginTop: 10, fontWeight: 800, fontSize: 16 }}>{addSelectedProduct.item_name}</div>
                      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {addSelectedProduct.group_name ? <CustomerChip label={addSelectedProduct.group_name} tone="#f7f9fd" color="#46536b" borderColor="rgba(70,83,107,0.12)" /> : null}
                        <CustomerChip label={`GST ${toNumber(addSelectedProduct.gst_pct, 0).toFixed(2)}%`} tone="#f3fbf5" color="#1a7f47" borderColor="rgba(26,127,71,0.14)" />
                        <CustomerChip label={`List ${selectedProductQuoteListPrice.toFixed(2)}`} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                      </div>
                    </div>
                    <button type="button" onClick={() => setAddSelectedProduct(null)}>
                      Clear Selection
                    </button>
                  </div>
                ) : null}
                <div style={{ fontSize: 12, opacity: 0.72, marginTop: 12 }}>
                  All users, including distributors, can add only Product Master items in this lane. Manual line entry is locked.
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
                  <div style={{ display: "flex", gap: 10 }}>
                    {draftLines.length ? (
                      <button type="button" onClick={() => setDraftLines((prev) => [...prev, cloneDraftLine(prev[prev.length - 1])])}>
                        Duplicate Last Line
                      </button>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button type="button" onClick={() => addSelectedItem(true)} disabled={!addSelectedProduct}>
                      Add & Keep Item
                    </button>
                    <button type="button" onClick={addSelectedItem(false)} disabled={!addSelectedProduct}>
                      Add Selected Item
                    </button>
                  </div>
                </div>
              </div>
              ) : null}
              {itemsLane === "absstem_shield" ? (
              <div style={{ marginTop: 18, border: "1px solid rgba(35,84,213,0.16)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f5f8ff 100%)", boxShadow: "0 12px 24px rgba(31,41,55,0.04)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 18 }}>Absstem Shield: Recommended Job Spares</div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.72, lineHeight: 1.7 }}>
                      This lane converts installed asset BOM items into quoteable mapped spares and consumables. Add these first for deployed-system support quotes.
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <CustomerChip label={selectedJobAsset ? "Asset linked" : "Select asset first"} tone={selectedJobAsset ? "#eefaf2" : "#fff7ea"} color={selectedJobAsset ? "#136b3c" : "#9a5a00"} borderColor={selectedJobAsset ? "rgba(19,107,60,0.14)" : "rgba(154,90,0,0.12)"} />
                    <CustomerChip label={`${recommendedJobSpares.length} mapped spare(s)`} tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                    <button type="button" onClick={returnToPackageBuilder}>
                      Back To Package Builder
                    </button>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 0.9fr) minmax(0, 1.1fr)", gap: 12, alignItems: "start" }}>
                  <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 12, background: "#fff" }}>
                    <Field label="Deployed Job Asset / Serial No">
                      <select value={selectedJobAssetId} onChange={(e) => setSelectedJobAssetId(e.target.value)} disabled={!jobAssets.length}>
                        <option value="">Select deployed asset</option>
                        {jobAssets.map((asset) => (
                          <option key={asset.id} value={String(asset.id)}>
                            {[asset.serial_no || null, asset.job_id || null, asset.so_number ? `SO ${asset.so_number}` : null].filter(Boolean).join(" • ")}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.76, lineHeight: 1.7 }}>
                      <div>{jobAssetSummary}</div>
                      {selectedJobAsset ? (
                        <>
                          <div>{[selectedJobAsset.finished_good_item_name || null, selectedJobAsset.asset_name || null].filter(Boolean).join(" • ") || "Deployed package selected"}</div>
                          <div>{[selectedJobAsset.so_number ? `SO ${selectedJobAsset.so_number}` : null, selectedJobAsset.dispatch_number ? `Dispatch ${selectedJobAsset.dispatch_number}` : null].filter(Boolean).join(" • ") || "Commercial links available"}</div>
                          <div>{recommendedJobSparesLoading ? "Loading mapped consumables..." : `${totalRecommendedJobSpareQty || 0} total recommended qty`}</div>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {recommendedJobSparesLoading ? (
                      <div style={{ border: "1px dashed #d6deea", borderRadius: 14, padding: 16, background: "#fff", fontSize: 13, opacity: 0.76 }}>
                        Loading mapped spares for the selected Job Asset...
                      </div>
                    ) : !selectedJobAsset ? (
                      <div style={{ border: "1px dashed #d6deea", borderRadius: 14, padding: 16, background: "#fff", fontSize: 13, opacity: 0.76 }}>
                        Select a deployed Job Asset / Serial No to load mapped consumables and spare items.
                      </div>
                    ) : recommendedJobSpares.length ? (
                      recommendedJobSpares.map((spare) => (
                        <div key={`${spare.product_id}:${spare.mapping_type}`} style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 14, background: "#fff" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                            <div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                                <CustomerChip label={spare.item_code || "Mapped spare"} tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                                <CustomerChip label={String(spare.mapping_type || "consumable").replace(/_/g, " ")} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                                {spare.is_mandatory ? <CustomerChip label="Mandatory" tone="#fff1f4" color="#9f2042" borderColor="rgba(159,32,66,0.12)" /> : null}
                              </div>
                              <div style={{ fontWeight: 800, fontSize: 15 }}>{spare.item_name || "Mapped spare"}</div>
                              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                                Recommended qty {spare.qty_recommended || 0}
                                {spare.uom ? ` ${spare.uom}` : ""}
                                {spare.list_price ? ` • Base list ${Number(spare.list_price).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : ""}
                              </div>
                            </div>
                            <button type="button" onClick={() => addRecommendedJobSpare(spare)}>
                              Add To Draft
                            </button>
                          </div>
                          {Array.isArray(spare.source_lines) && spare.source_lines.length ? (
                            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.78, lineHeight: 1.7 }}>
                              From installed items: {spare.source_lines.map((line) => `${line.installed_item_code}${line.qty_installed ? ` x ${line.qty_installed}` : ""}`).join(" • ")}
                            </div>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div style={{ border: "1px dashed #d6deea", borderRadius: 14, padding: 16, background: "#fff", fontSize: 13, opacity: 0.76 }}>
                        No mapped recommended spares are configured yet for this deployed asset.
                      </div>
                    )}
                  </div>
                </div>
              </div>
              ) : null}

              <div style={{ marginTop: 18, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 18 }}>Step 2: Recommended Package</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 12 }}>
                  {visibleConfiguratorFamilies.map((family) => {
                    const selected = selectedConfiguratorFamily.key === family.key;
                    return (
                      <ConfiguratorFamilyCard key={family.key} family={family} selected={selected} onClick={() => setSelectedConfiguratorFamilyKey(family.key)} />
                    );
                  })}
                  <button
                    type="button"
                    onClick={openAbsstemShieldLane}
                    disabled={!selectedJobAssetId}
                    style={{
                      all: "unset",
                      cursor: selectedJobAssetId ? "pointer" : "not-allowed",
                      border: itemsLane === "absstem_shield" ? "1px solid #2354d5" : "1px solid rgba(214,224,244,0.92)",
                      background: itemsLane === "absstem_shield"
                        ? "radial-gradient(circle at top right, rgba(141,180,255,0.2), transparent 34%), linear-gradient(135deg, rgba(235,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)"
                        : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
                      borderRadius: 18,
                      padding: 14,
                      display: "block",
                      boxShadow: itemsLane === "absstem_shield" ? "0 18px 36px rgba(35,84,213,0.14)" : "0 8px 18px rgba(31,41,55,0.04)",
                      minHeight: 332,
                      opacity: selectedJobAssetId ? 1 : 0.76,
                    }}
                  >
                    <div
                      style={{
                        position: "relative",
                        height: 152,
                        borderRadius: 16,
                        overflow: "hidden",
                        background: "radial-gradient(circle at top right, rgba(80,120,255,0.28), transparent 38%), linear-gradient(135deg, #163472 0%, #2354d5 45%, #82a6ff 100%)",
                        boxShadow: itemsLane === "absstem_shield" ? "0 16px 30px rgba(16,38,79,0.14)" : "0 10px 22px rgba(16,38,79,0.08)",
                      }}
                    >
                      <div style={{ position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start", padding: 14 }}>
                        <CustomerChip label="AFM" tone="rgba(255,255,255,0.84)" color="#31539d" borderColor="rgba(255,255,255,0.18)" />
                        {itemsLane === "absstem_shield" ? <CustomerChip label="Open" tone="rgba(18,107,60,0.92)" color="#fff" borderColor="rgba(18,107,60,0.22)" /> : null}
                      </div>
                      <div style={{ position: "absolute", left: 14, right: 14, bottom: 14, zIndex: 1 }}>
                        <div style={{ fontWeight: 800, fontSize: 20, color: "#ffffff", textShadow: "0 2px 10px rgba(0,0,0,0.24)" }}>Absstem Shield</div>
                        <div style={{ marginTop: 6, fontSize: 12, color: "rgba(255,255,255,0.92)", lineHeight: 1.5, textShadow: "0 1px 6px rgba(0,0,0,0.24)" }}>Aftermarket spares</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CustomerChip
                        label={selectedJobAssetId ? "Asset-linked lane" : "Select asset first"}
                        tone={selectedJobAssetId ? "#eef4ff" : "#fff7ea"}
                        color={selectedJobAssetId ? "#2354d5" : "#9a5a00"}
                        borderColor={selectedJobAssetId ? "rgba(35,84,213,0.14)" : "rgba(154,90,0,0.12)"}
                      />
                    </div>
                    <div style={{ marginTop: 12, fontSize: 14, fontWeight: 700, color: "#24324a", lineHeight: 1.55 }}>
                      Quote recommended spares for the selected asset.
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.66, marginTop: 8, lineHeight: 1.7 }}>
                      {selectedJobAsset
                        ? `${selectedJobAsset.serial_no || selectedJobAsset.job_id || "Selected asset"}${recommendedJobSparesLoading ? " • Loading spares..." : ` • ${recommendedJobSpares.length} mapped spare(s)`}`
                        : "Choose a Job Asset / Serial No in Customer first."}
                    </div>
                  </button>
                </div>
                <div style={{ marginBottom: 14, padding: 14, borderRadius: 16, background: "radial-gradient(circle at top right, rgba(141,180,255,0.16), transparent 34%), linear-gradient(135deg, #f7faff 0%, #ffffff 100%)", border: "1px solid rgba(214,224,244,0.92)", boxShadow: "0 10px 22px rgba(31,41,55,0.04)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontWeight: 700, flex: 1 }}>{selectedConfiguratorFamily.label}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CustomerChip label={`${selectedConfiguratorFamily.company} presentation`} tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                    </div>
                  </div>
                </div>
                {selectedConfiguratorFamily.gas === "nitrogen" ? (
                <>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700, flex: 1 }}>{selectedConfiguratorFamily.label} Package Selector</div>
                </div>
                <div
                  style={{
                    marginTop: 12,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 12,
                    alignItems: "end",
                  }}
                >
                  <Field label="Purity">
                    <select value={nitroPurity} onChange={(e) => setNitroPurity(e.target.value)} disabled={nitroWorking}>
                      {nitroPurities.map((p) => (
                        <option key={p} value={p}>
                          {p}%
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Required Flow (Nm³/hr)">
                    <input
                      type="number"
                      value={nitroFlow}
                      onChange={(e) => setNitroFlow(e.target.value)}
                      min={0}
                      step={0.1}
                      disabled={nitroWorking}
                    />
                  </Field>
                  <Field label="Quote Mode">
                    <select value={nitroPackageMode} onChange={(e) => setNitroPackageMode(e.target.value)} disabled={nitroWorking}>
                      <option value="full_package">PSA + storage + compressor</option>
                      <option value="psa_only">Only PSA (client scope)</option>
                    </select>
                  </Field>
                </div>
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, alignItems: "stretch" }}>
                  <button type="button" style={{ width: "100%" }} onClick={recommendNitrogen} disabled={nitroWorking || !nitroFlow}>
                    Recommend
                  </button>
                  <button type="button" style={{ width: "100%" }} onClick={applyNitrogen} disabled={nitroWorking || !nitroRec}>
                    Apply Package
                  </button>
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <CustomerChip
                    label={nitroPackageMode === "psa_only" ? "Only generator will be added" : "Generator + storage + air system will be added"}
                    tone={nitroPackageMode === "psa_only" ? "#fff7ea" : "#eefaf2"}
                    color={nitroPackageMode === "psa_only" ? "#9a5a00" : "#136b3c"}
                    borderColor={nitroPackageMode === "psa_only" ? "rgba(154,90,0,0.12)" : "rgba(19,107,60,0.14)"}
                  />
                </div>
                {nitroRec ? (
                  <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                    <div style={{ border: "1px solid rgba(173,198,255,0.84)", borderRadius: 16, padding: 14, background: "radial-gradient(circle at top right, rgba(141,180,255,0.18), transparent 34%), linear-gradient(135deg, #edf4ff 0%, #ffffff 100%)", boxShadow: "0 14px 30px rgba(56,94,178,0.08)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                            <CustomerChip label={`${activeConfiguratorCard.familyLabel} recommendation`} tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" />
                            <CustomerChip label={activeConfiguratorCard.proposalProfileKey} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.76, marginTop: 6 }}>{activeConfiguratorCard.familyTitle}</div>
                        </div>
                        <CustomerChip label={`${activeConfiguratorCard.company} route`} tone="#f8fbff" color="#31539d" borderColor="rgba(49,83,157,0.12)" />
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.78, marginTop: 8, lineHeight: 1.6 }}>{activeConfiguratorCard.routeReason}</div>
                      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Recommended Package</div>
                          <div style={{ fontWeight: 700, marginTop: 6 }}>{activeConfiguratorCard.selectedModel || "—"}</div>
                          {activeConfiguratorCard.variantLabel ? (
                            <div style={{ fontSize: 11, opacity: 0.72, marginTop: 4 }}>
                              Story delta: {activeConfiguratorCard.variantLabel}
                            </div>
                          ) : null}
                          <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>
                            Flow {activeConfiguratorCard.selectedFlow || "—"} • Air {activeConfiguratorCard.selectedAirRequirement || "—"} CFM
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.74 }}>Storage {activeConfiguratorCard.selectedStorageVolume || "—"} L</div>
                        </div>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Story Framing</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
                            {activeConfiguratorCard.variantStory || selectedConfiguratorFamily.packageHint}
                          </div>
                        </div>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Proof Points</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
                            {(activeConfiguratorCard.proofPoints || []).slice(0, 3).join(" • ")}
                          </div>
                        </div>
                      </div>
                      {activeConfiguratorCard.warnings.length ? (
                        <div style={{ marginTop: 10, border: "1px solid #ffe1a8", background: "linear-gradient(180deg, #fff8e8 0%, #fffdf5 100%)", borderRadius: 14, padding: 12 }}>
                          <div style={{ fontWeight: 700, fontSize: 12 }}>Configurator warnings</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82, lineHeight: 1.6 }}>
                            {activeConfiguratorCard.warnings.join(" ")}
                          </div>
                        </div>
                      ) : null}
                      <div style={{ marginTop: 10 }}>{renderConfiguratorPreviewBlocks()}</div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 12 }}>
                    <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 12, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ fontSize: 12, opacity: 0.72, flex: 1 }}>Recommended Generator Options</div>
                        <select value={nitroApplyMode} onChange={(e) => setNitroApplyMode(e.target.value)} disabled={nitroWorking}>
                          <option value="replace">Replace ALL quote lines with this package</option>
                          <option value="append">Append package (keep existing lines)</option>
                        </select>
                      </div>
                      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                        {(nitroRec.options || []).map((option) => {
                          const selected = nitroModel === option.model;
                          return <ConfiguratorOptionCard key={option.model} option={option} selected={selected} onClick={() => setNitroModel(option.model)} familyLabel={selectedConfiguratorFamily.label} familyKey={selectedConfiguratorFamily.key} proposalProfileKey={selectedConfiguratorFamily.proposalProfileKey} variantLabel={inferNgenVariantFromValue(option.model)} />;
                        })}
                      </div>
                    </div>
                    <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 12, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)" }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        <CustomerChip label="Selected Package Summary" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                      </div>
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        Generator: {nitroModel || nitroRec.recommended?.model || "—"}
                      </div>
                    {selectedConfiguratorFamily.key === "NGENX" && nitroRec.catalog_source_label ? (
                      <div
                        style={{
                          marginTop: 8,
                          padding: "8px 10px",
                          borderRadius: 12,
                          fontSize: 12,
                          lineHeight: 1.55,
                          background: nitroRec.used_family_fallback ? "#fff7ea" : "#eefbf3",
                          border: `1px solid ${nitroRec.used_family_fallback ? "#f4dfb2" : "#ccefd9"}`,
                          color: nitroRec.used_family_fallback ? "#8b5a00" : "#147a3d",
                        }}
                      >
                        {nitroRec.used_family_fallback
                          ? `Sizing source: ${nitroRec.catalog_source_label}. Dedicated nGENX master rows are not configured separately yet.`
                          : `Sizing source: ${nitroRec.catalog_source_label}.`}
                      </div>
                    ) : null}
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78 }}>
                        Air req: {nitroRec.recommended?.airRequirement ?? "—"} CFM
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.78 }}>
                        Storage: {nitroRec.recommended?.storageVolume ?? "—"} L
                      </div>
                      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.72 }}>Suggested Compressor</div>
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        {nitroRec.compressor
                          ? `${nitroRec.compressor.compressorModel} • ${nitroRec.compressor.kw} • ${nitroRec.compressor.airflow} CFM`
                          : "—"}
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
                        {nitroPackageMode === "psa_only"
                          ? "Applying this mode adds only the selected PSA generator to the draft."
                          : "Applying the package adds generator, storage vessel, and compressor package lines to the draft. Dry Air Storage remains part of the compressor package."}
                      </div>
                      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" onClick={openProductMasterLane}>
                          Step 2: Add Approved Extras
                        </button>
                        <button type="button" onClick={openAbsstemShieldLane} disabled={!selectedJobAssetId}>
                          Absstem Shield
                        </button>
                      </div>
                    </div>
                    </div>
                  </div>
                ) : null}
              </>
              ) : null}
              </div>

              {selectedConfiguratorFamily.gas === "oxygen" ? (
              <div style={{ marginTop: 16, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 14, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 10px 22px rgba(31,41,55,0.04)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700, flex: 1 }}>{selectedConfiguratorFamily.label} Package Selector</div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>{selectedConfiguratorFamily.note}</div>
                </div>
                <div
                  style={{
                    marginTop: 12,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 12,
                    alignItems: "end",
                  }}
                >
                  <Field label="Purity">
                    <select value={oxygenPurity} onChange={(e) => setOxygenPurity(e.target.value)} disabled={oxygenWorking}>
                      <option value="95">95%</option>
                    </select>
                  </Field>
                  <Field label="Required Flow (Nm³/hr)">
                    <input
                      type="number"
                      value={oxygenFlow}
                      onChange={(e) => setOxygenFlow(e.target.value)}
                      min={0}
                      step={0.1}
                      disabled={oxygenWorking}
                    />
                  </Field>
                  <Field label="Quote Mode">
                    <select value={oxygenPackageMode} onChange={(e) => setOxygenPackageMode(e.target.value)} disabled={oxygenWorking}>
                      <option value="full_package">PSA + storage + compressor</option>
                      <option value="psa_only">Only PSA (client scope)</option>
                    </select>
                  </Field>
                </div>
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, alignItems: "stretch" }}>
                  <button type="button" style={{ width: "100%" }} onClick={recommendOxygen} disabled={oxygenWorking || !oxygenFlow}>
                    Recommend
                  </button>
                  <button type="button" style={{ width: "100%" }} onClick={applyOxygen} disabled={oxygenWorking || !oxygenRec}>
                    Apply Package
                  </button>
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <CustomerChip
                    label={oxygenPackageMode === "psa_only" ? "Only generator will be added" : "Generator + storage + air system will be added"}
                    tone={oxygenPackageMode === "psa_only" ? "#fff7ea" : "#eefaf2"}
                    color={oxygenPackageMode === "psa_only" ? "#9a5a00" : "#136b3c"}
                    borderColor={oxygenPackageMode === "psa_only" ? "rgba(154,90,0,0.12)" : "rgba(19,107,60,0.14)"}
                  />
                </div>
                {oxygenRec ? (
                  <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                    <div style={{ border: "1px solid rgba(173,198,255,0.84)", borderRadius: 16, padding: 14, background: "radial-gradient(circle at top right, rgba(141,180,255,0.18), transparent 34%), linear-gradient(135deg, #edf4ff 0%, #ffffff 100%)", boxShadow: "0 14px 30px rgba(56,94,178,0.08)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                            <CustomerChip label={`${activeConfiguratorCard.familyLabel} recommendation`} tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" />
                            <CustomerChip label={activeConfiguratorCard.proposalProfileKey} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.76, marginTop: 6 }}>{activeConfiguratorCard.familyTitle}</div>
                        </div>
                        <CustomerChip label={`${activeConfiguratorCard.company} route`} tone="#f8fbff" color="#31539d" borderColor="rgba(49,83,157,0.12)" />
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.78, marginTop: 8, lineHeight: 1.6 }}>{activeConfiguratorCard.routeReason}</div>
                      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Recommended Package</div>
                          <div style={{ fontWeight: 700, marginTop: 6 }}>{activeConfiguratorCard.selectedModel || "—"}</div>
                          {activeConfiguratorCard.variantLabel ? (
                            <div style={{ fontSize: 11, opacity: 0.72, marginTop: 4 }}>
                              Story delta: {activeConfiguratorCard.variantLabel}
                            </div>
                          ) : null}
                          <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>
                            Flow {activeConfiguratorCard.selectedFlow || "—"} • Air {activeConfiguratorCard.selectedAirRequirement || "—"} CFM
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.74 }}>Storage {activeConfiguratorCard.selectedStorageVolume || "—"} L</div>
                        </div>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Story Framing</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
                            {activeConfiguratorCard.variantStory || selectedConfiguratorFamily.packageHint}
                          </div>
                        </div>
                        <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                          <div style={{ fontSize: 11, opacity: 0.68 }}>Proof Points</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
                            {(activeConfiguratorCard.proofPoints || []).slice(0, 3).join(" • ")}
                          </div>
                        </div>
                      </div>
                      {activeConfiguratorCard.warnings.length ? (
                        <div style={{ marginTop: 10, border: "1px solid #ffe1a8", background: "linear-gradient(180deg, #fff8e8 0%, #fffdf5 100%)", borderRadius: 14, padding: 12 }}>
                          <div style={{ fontWeight: 700, fontSize: 12 }}>Configurator warnings</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82, lineHeight: 1.6 }}>
                            {activeConfiguratorCard.warnings.join(" ")}
                          </div>
                        </div>
                      ) : null}
                      <div style={{ marginTop: 10 }}>{renderConfiguratorPreviewBlocks()}</div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 12 }}>
                    <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 12, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ fontSize: 12, opacity: 0.72, flex: 1 }}>Recommended Generator Options</div>
                        <select value={oxygenApplyMode} onChange={(e) => setOxygenApplyMode(e.target.value)} disabled={oxygenWorking}>
                          <option value="replace">Replace ALL quote lines with this package</option>
                          <option value="append">Append package (keep existing lines)</option>
                        </select>
                      </div>
                      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                        {(oxygenRec.options || []).map((option) => {
                          const selected = oxygenModel === option.model;
                          return <ConfiguratorOptionCard key={option.model} option={option} selected={selected} onClick={() => setOxygenModel(option.model)} familyLabel={selectedConfiguratorFamily.label} familyKey={selectedConfiguratorFamily.key} proposalProfileKey={selectedConfiguratorFamily.proposalProfileKey} />;
                        })}
                      </div>
                    </div>
                    <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 16, padding: 12, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)" }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        <CustomerChip label="Selected Package Summary" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                      </div>
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        Generator: {oxygenModel || oxygenRec.recommended?.model || "—"}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78 }}>
                        Air req: {oxygenRec.recommended?.airRequirement ?? "—"} CFM
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.78 }}>
                        Storage: {oxygenRec.recommended?.storageVolume ?? "—"} L
                      </div>
                      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.72 }}>Suggested Compressor</div>
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        {oxygenRec.compressor
                          ? `${oxygenRec.compressor.compressorModel} • ${oxygenRec.compressor.kw} • ${oxygenRec.compressor.airflow} CFM`
                          : "—"}
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
                        {oxygenPackageMode === "psa_only"
                          ? "Applying this mode adds only the selected PSA generator to the draft."
                          : "Applying the package adds generator, storage vessel, and compressor package lines to the draft. Dry Air Storage remains part of the compressor package."}
                      </div>
                      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" onClick={openProductMasterLane}>
                          Step 2: Add Approved Extras
                        </button>
                        <button type="button" onClick={openAbsstemShieldLane} disabled={!selectedJobAssetId}>
                          Absstem Shield
                        </button>
                      </div>
                    </div>
                    </div>
                  </div>
                ) : null}
              </div>
              ) : null}

              <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
                {itemsLane !== "product_master" && itemsLane !== "absstem_shield" ? (
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                    {selectedJobAssetId ? (
                      <button type="button" onClick={openAbsstemShieldLane}>
                        Absstem Shield
                      </button>
                    ) : null}
                    <button type="button" onClick={openProductMasterLane}>
                      Open Product Master
                    </button>
                  </div>
                ) : null}
                {draftLines.length ? (
                  draftLines.map((line) => (
                    <DraftLineCard
                      key={line.key}
                      line={line}
                      isAdvancedOpen={advancedLineKey === line.key}
                      onToggleAdvanced={() => setAdvancedLineKey((prev) => (prev === line.key ? "" : line.key))}
                      onMove={(direction) => moveDraftLine(line.key, direction)}
                      onDuplicate={() => duplicateDraftLine(line.key)}
                      onRemove={() => removeDraftLine(line.key)}
                      onChange={(patch, source = undefined) => setDraftLine(line.key, patch, source)}
                      lineTotal={calcLineNetTotal(line).toFixed(2)}
                      priceTypeOptions={priceTypeOptions}
                      priceHint={line.product_id ? priceHints[String(line.product_id)] || null : null}
                      floorHint={buildLineFloorHint(line, pricingGuardrails)}
                    />
                  ))
                ) : (
                  <div style={{ padding: 12, opacity: 0.7, border: "1px dashed #e5e5e5", borderRadius: 10 }}>
                    No items added yet.
                  </div>
                )}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
                <button type="button" onClick={() => setStep(0)} disabled={saving}>
                  Previous
                </button>
                <button type="button" onClick={saveItemsAndContinue} disabled={saving || !draftLines.length}>
                  {saving ? "Saving..." : "Save Items & Continue"}
                </button>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div style={{ marginTop: 16, border: "1px solid #dfe6f4", borderRadius: 20, padding: 20, background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)", boxShadow: "0 16px 36px rgba(25,45,84,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>Step 3</div>
                  <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>Review</div>
                </div>
                <button type="button" onClick={() => setStep(1)} disabled={saving || summarySaving}>
                  Back to Offer
                </button>
              </div>

              <div style={{ marginTop: 12, fontSize: 13, opacity: 0.74, lineHeight: 1.7 }}>
                Confirm what the customer will see in the proposal before moving into the final review defaults.
              </div>
              <div style={{ marginTop: 12, marginBottom: 2, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#2354d5" }}>Recommended method</div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.76, lineHeight: 1.7 }}>
                  Review deliverables, exclusions, assumptions, and responsibilities now. This is the proposal-facing review before the final delivery step.
                </div>
              </div>

              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                <CustomerStatCard label="Route" value={quoteRoute === "healthcare" ? "Healthcare" : "Industrial"} accent={quoteRoute === "healthcare" ? "#1a7f47" : "#2354d5"} />
                <CustomerStatCard label="PDF Output" value={quoteSummary.merge_annexures ? "One PDF" : "Separate PDFs"} accent={quoteSummary.merge_annexures ? "#1a7f47" : "#9a5a00"} />
              </div>

              <div style={{ marginTop: 16, display: "grid", gap: 16 }}>
                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "radial-gradient(circle at top right, rgba(141,180,255,0.16), transparent 34%), linear-gradient(135deg, #f8fbff 0%, #ffffff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Commercial Defaults</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        Keep the standard domestic quote path simple. Review INR, `ADV50`, `Extra at actuals`, and `EXW` here, and only open export controls when the quote is truly exceptional.
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CustomerChip label="Domestic default" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                      <CustomerChip label={quoteRoute === "healthcare" ? "Healthcare route" : "Industrial route"} tone={quoteRoute === "healthcare" ? "#edf7f0" : "#eef4ff"} color={quoteRoute === "healthcare" ? "#1a7f47" : "#2354d5"} borderColor={quoteRoute === "healthcare" ? "rgba(26,127,71,0.14)" : "rgba(35,84,213,0.14)"} />
                    </div>
                  </div>

                  <div style={{ marginBottom: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                    <CustomerStatCard label="Pricing Mode" value={(quoteBootstrap.pricing_modes || []).find((mode) => mode.key === commercialForm.pricing_display_mode)?.label || "—"} accent="#2354d5" />
                    <CustomerStatCard label="Quote Currency" value={quoteCurrencyLabel || "INR - Indian Rupee"} accent="#31539d" />
                    <CustomerStatCard label="Supporting Clauses" value={selectedLibraryTermsCount} accent="#1a7f47" />
                    <CustomerStatCard label="PDF Output" value={quoteSummary.merge_annexures ? "Merged" : "Separate"} accent={quoteSummary.merge_annexures ? "#1a7f47" : "#9a5a00"} />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                    <Field label="Attention To">
                      <input
                        value={commercialForm.attention_to}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, attention_to: e.target.value }))}
                      />
                    </Field>
                    <Field label="Pricing Mode">
                      <select
                        value={commercialForm.pricing_display_mode}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, pricing_display_mode: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        {(quoteBootstrap.pricing_modes || []).map((mode) => (
                          <option key={mode.key} value={mode.key}>
                            {mode.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Base Currency">
                      <select value={commercialForm.base_currency_id} disabled style={{ width: "100%", minWidth: 0 }}>
                        <option value={inrCurrency?.id ? String(inrCurrency.id) : ""}>
                          {inrCurrency ? `${inrCurrency.currency_code} - ${inrCurrency.currency_name}` : "INR - Indian Rupee"}
                        </option>
                      </select>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>Base currency is fixed to INR for all quotes.</div>
                    </Field>
                    <Field label="Quote Currency">
                      <select
                        value={commercialForm.quote_currency_id}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, quote_currency_id: e.target.value }))}
                        disabled={!canSelectForeignQuoteCurrency}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        {!canSelectForeignQuoteCurrency ? null : <option value="">Select quote</option>}
                        {(quoteBootstrap.currencies || []).map((currency) =>
                          !canSelectForeignQuoteCurrency && String(currency.currency_code || "").trim().toUpperCase() !== "INR" ? null : (
                            <option key={currency.id} value={String(currency.id)}>
                              {currency.currency_code} - {currency.currency_name}
                            </option>
                          )
                        )}
                      </select>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>
                        {canSelectForeignQuoteCurrency ? "Export or outside-India quotes can use a quoted currency different from INR." : "Domestic quote currency stays locked to INR."}
                      </div>
                    </Field>
                    <Field label="Incoterm">
                      <select
                        value={commercialForm.incoterm_id}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, incoterm_id: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        <option value="">Select incoterm</option>
                        {(quoteBootstrap.incoterms || []).map((item) => (
                          <option key={item.id} value={String(item.id)}>
                            {item.incoterm_code} - {item.incoterm_name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Payment Term">
                      <select
                        value={commercialForm.payment_term_id}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, payment_term_id: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        <option value="">Select payment term</option>
                        {(quoteBootstrap.payment_terms || []).map((item) => (
                          <option key={item.id} value={String(item.id)}>
                            {item.term_code} - {item.term_name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Freight Term">
                      <select
                        value={commercialForm.freight_term_id}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, freight_term_id: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        <option value="">Select freight term</option>
                        {(quoteBootstrap.freight_terms || []).map((item) => (
                          <option key={item.id} value={String(item.id)}>
                            {item.term_code} - {item.term_name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="P&F Term">
                      <select
                        value={commercialForm.p_and_f_term_id}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, p_and_f_term_id: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        <option value="">Select P&F term</option>
                        {(quoteBootstrap.p_and_f_terms || []).map((item) => (
                          <option key={item.id} value={String(item.id)}>
                            {item.term_code} - {item.term_name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Delivery Lead Time (days)">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={commercialForm.delivery_lead_time_days}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, delivery_lead_time_days: e.target.value }))}
                        placeholder="e.g. 45"
                        style={{ width: "100%", minWidth: 0 }}
                      />
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>Typed lead time for the proposal — not free-text Delivery terms.</div>
                    </Field>
                    <Field label="Warranty (months)">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={commercialForm.warranty_months}
                        onChange={(e) => setCommercialForm((prev) => ({ ...prev, warranty_months: e.target.value }))}
                        placeholder="e.g. 12"
                        style={{ width: "100%", minWidth: 0 }}
                      />
                    </Field>
                    <div style={{ marginTop: 22, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                      {!showExportControls && !commercialForm.is_export ? (
                        <>
                          <div style={{ fontSize: 12, fontWeight: 700 }}>Domestic default locked</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68, lineHeight: 1.6 }}>
                            Export and foreign-currency settings stay hidden for standard quotes. Open them only if this quote is intentionally export or exception-based.
                          </div>
                          <button type="button" onClick={() => setShowExportControls(true)} style={{ marginTop: 10 }}>
                            Open Export / FX Settings
                          </button>
                        </>
                      ) : (
                        <>
                          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input
                              type="checkbox"
                              checked={commercialForm.is_export}
                              onChange={(e) =>
                                setCommercialForm((prev) => ({
                                  ...prev,
                                  is_export: e.target.checked,
                                  quote_currency_id: e.target.checked ? prev.quote_currency_id || String(inrCurrency?.id || "") : String(inrCurrency?.id || ""),
                                }))
                              }
                              disabled={!inrCurrency?.id}
                            />
                            Export Quote
                          </label>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>
                            Toggles export-specific commercial handling and downstream proposal expectations.
                          </div>
                          <div style={{ marginTop: 10 }}>
                            <button type="button" onClick={() => setShowExportControls(false)} disabled={commercialForm.is_export}>
                              Hide Export / FX Settings
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Validity & Follow-up</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        Decide the validity you are committing to and when you will chase it. Both travel with the quote and drive your Sales Desk follow-up queue.
                      </div>
                    </div>
                    <CustomerChip
                      label={cadenceValidityNote.label}
                      tone={cadenceValidityNote.tone}
                      color={cadenceValidityNote.color}
                      borderColor={cadenceValidityNote.borderColor}
                    />
                  </div>
                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                    <Field label="Quote Valid Till">
                      <input
                        type="date"
                        value={cadenceForm.quote_valid_till}
                        onChange={(e) => setCadenceForm((prev) => ({ ...prev, quote_valid_till: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      />
                      <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {[15, 30, 45, 60].map((days) => (
                          <button
                            key={days}
                            type="button"
                            onClick={() => setCadenceForm((prev) => ({ ...prev, quote_valid_till: dateInputValueFromToday(days) }))}
                            style={{ fontSize: 11, padding: "4px 8px" }}
                          >
                            {days} days
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label="Next Follow-up">
                      <input
                        type="date"
                        value={cadenceForm.next_follow_up_at}
                        onChange={(e) => setCadenceForm((prev) => ({ ...prev, next_follow_up_at: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      />
                      <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {[3, 7, 14].map((days) => (
                          <button
                            key={days}
                            type="button"
                            onClick={() => setCadenceForm((prev) => ({ ...prev, next_follow_up_at: dateInputValueFromToday(days) }))}
                            style={{ fontSize: 11, padding: "4px 8px" }}
                          >
                            +{days}d
                          </button>
                        ))}
                        <button type="button" onClick={() => setCadenceForm((prev) => ({ ...prev, next_follow_up_at: "" }))} style={{ fontSize: 11, padding: "4px 8px" }}>
                          Clear
                        </button>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>
                        {cadenceForm.next_follow_up_at ? "This quote will surface in your follow-up queue on that date." : "Without a follow-up date this quote never reminds you to chase it."}
                      </div>
                    </Field>
                    <Field label="Quote Kind">
                      <select
                        value={cadenceForm.quote_kind}
                        onChange={(e) => setCadenceForm((prev) => ({ ...prev, quote_kind: e.target.value }))}
                        style={{ width: "100%", minWidth: 0 }}
                      >
                        <option value="firm">Firm offer</option>
                        <option value="budgetary">Budgetary estimate</option>
                      </select>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.68 }}>
                        Budgetary estimates are indicative; firm offers are commitments the customer can order against.
                      </div>
                    </Field>
                  </div>
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Commercial Terms</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        These 4 terms are system-managed from the commercial selectors above and always travel first in the offer.
                      </div>
                    </div>
                    <CustomerChip label="Fixed order" tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                  </div>
                  <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                    {managedCommercialTerms.map((term) => (
                      <div key={term.id} style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                          <div style={{ fontWeight: 700, color: "#24324a", flex: 1 }}>{term.caption}</div>
                          <CustomerChip label="Managed" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" />
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.6, color: "#334155" }}>{term.description || "—"}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Supporting Clauses</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        Curate only the supporting clauses that should travel after the 4 managed commercial terms. Keep the library tight and intentional.
                      </div>
                    </div>
                    <button type="button" onClick={addTerm}>
                      Add Term
                    </button>
                  </div>
                  <div style={{ marginTop: 12, maxHeight: 420, overflow: "auto" }}>
                    {libraryTerms.map((term) => (
                      <div key={term.id} style={{ border: term.is_selected ? "1px solid rgba(35,84,213,0.24)" : "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, marginBottom: 10, background: term.is_selected ? "linear-gradient(135deg, rgba(237,243,255,0.98) 0%, rgba(255,255,255,0.98) 100%)" : "#fff", boxShadow: term.is_selected ? "0 12px 26px rgba(35,84,213,0.08)" : "none" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                          <input
                            type="checkbox"
                            checked={Boolean(term.is_selected)}
                            onChange={(e) => setTerm(term.id, { is_selected: e.target.checked })}
                          />
                          <input
                            value={term.caption || ""}
                            onChange={(e) => setTerm(term.id, { caption: e.target.value })}
                            placeholder="Caption"
                          />
                          {term.is_selected ? <CustomerChip label="Included" tone="#2354d5" color="#fff" borderColor="rgba(35,84,213,0.18)" /> : null}
                          <button type="button" onClick={() => removeTerm(term.id)}>
                            Remove
                          </button>
                        </div>
                        <textarea
                          value={term.description || ""}
                          onChange={(e) => setTerm(term.id, { description: e.target.value })}
                          rows={3}
                          style={{ width: "100%", resize: "vertical" }}
                        />
                      </div>
                    ))}
                    {!libraryTerms.length ? (
                      <div style={{ border: "1px dashed rgba(214,224,244,0.92)", borderRadius: 14, padding: 14, background: "#fff", fontSize: 12, opacity: 0.72 }}>
                        No supporting library clauses selected yet. The 4 managed commercial terms will still appear first in the offer.
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
                <button type="button" onClick={() => setStep(1)} disabled={saving || summarySaving}>
                  Previous
                </button>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button type="button" onClick={() => saveTermsAndCommercial(3)} disabled={saving || summarySaving}>
                    {saving ? "Saving..." : "Save Review & Continue"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div style={{ marginTop: 16, border: "1px solid #dfe6f4", borderRadius: 20, padding: 20, background: "linear-gradient(180deg, #ffffff 0%, #fbfdff 100%)", boxShadow: "0 16px 36px rgba(25,45,84,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>Step 4</div>
                  <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>Deliver</div>
                </div>
                <button type="button" onClick={() => setStep(2)}>
                  Back to Review
                </button>
              </div>

              <div style={{ marginTop: 12, fontSize: 13, opacity: 0.74, lineHeight: 1.7 }}>
                Finish only the last handoff decisions here: confirm blockers, check the send package, then send the issued quote.
              </div>
              <div style={{ marginTop: 12, marginBottom: 2, border: "1px solid rgba(214,224,244,0.92)", borderRadius: 14, padding: 12, background: "#fff" }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "#2354d5" }}>Recommended method</div>
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.76, lineHeight: 1.7 }}>
                  The safe order is: clear blockers, issue the revision if needed, confirm the final document package, and then send the customer handoff.
                </div>
              </div>

              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                <CustomerStatCard label="Revision" value={`${revision?.revision_no || "—"} • ${revisionStateLabel}`} accent="#2354d5" />
                <CustomerStatCard label="Approval" value={approval.approval_required ? "Needed" : "Clear"} accent={approval.approval_required ? "#9a5a00" : "#1a7f47"} />
                <CustomerStatCard label="Mail Ready" value={(selectedContact?.email || customerDetail?.email) ? "Yes" : "No"} accent={(selectedContact?.email || customerDetail?.email) ? "#1a7f47" : "#9a5a00"} />
              </div>

              <div style={{ marginTop: 16, display: "grid", gap: 16 }}>
                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ fontWeight: 800, fontSize: 18 }}>Preflight</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                    See only the blockers that matter before issue or send. Use the next action buttons below to clear the path quickly.
                  </div>
                  <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                    {readiness.blockers.length ? (
                      readiness.blockers.map((item) => (
                        <div
                          key={item.key}
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                            justifyContent: "space-between",
                            border: "1px solid #f5d0d0",
                            background: "linear-gradient(180deg, #fff6f6 0%, #fffbfb 100%)",
                            borderRadius: 12,
                            padding: "10px 12px",
                            fontSize: 12,
                          }}
                        >
                          <div>{item.label}</div>
                          <button type="button" onClick={() => setStep(item.step)}>
                            Fix
                          </button>
                        </div>
                      ))
                    ) : (
                      <div style={{ border: "1px solid #d7eadf", background: "linear-gradient(180deg, #f6fcf8 0%, #fcfffd 100%)", borderRadius: 12, padding: "10px 12px", fontSize: 12 }}>
                        No blocking issues remain for issue or send.
                      </div>
                    )}
                    {revisionState !== "issued" ? (
                      <div style={{ border: "1px solid rgba(234,215,161,0.92)", background: "linear-gradient(180deg, #fffaf0 0%, #fffdf6 100%)", borderRadius: 12, padding: "10px 12px", fontSize: 12, lineHeight: 1.6 }}>
                        Issue is still pending. Customer mail stays locked until the revision is issued so the final PDF and quote state remain aligned.
                      </div>
                    ) : null}
                    {reviewConfiguratorWarnings.length ? (
                      <div style={{ border: "1px solid #f2e3b2", background: "linear-gradient(180deg, #fffaf0 0%, #fffdf7 100%)", borderRadius: 12, padding: "10px 12px", fontSize: 12, lineHeight: 1.6 }}>
                        {reviewConfiguratorWarnings.join(" ")}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    {readiness.blockers.length ? (
                      <button type="button" className="button-primary" onClick={() => setStep(readiness.blockers[0].step)} style={{ fontWeight: 800 }}>
                        Clear blockers first
                      </button>
                    ) : null}
                    {!readiness.blockers.length && revisionState === "draft" && approval.approval_required ? (
                      <button type="button" className="button-primary" onClick={submitForApproval} disabled={saving} style={{ fontWeight: 800 }}>
                        {saving ? "Working..." : "Submit for approval"}
                      </button>
                    ) : null}
                    {!readiness.blockers.length && revisionState === "draft" && !approval.approval_required ? (
                      <button type="button" className="button-primary" onClick={issueRevision} disabled={saving} style={{ fontWeight: 800 }}>
                        {saving ? "Working..." : "Issue quote"}
                      </button>
                    ) : null}
                    {!readiness.blockers.length && approval.can_actor_approve && canApproveQuotes && revisionState === "pending_approval" ? (
                      <>
                        <button type="button" className="button-primary" onClick={approveRevision} disabled={saving} style={{ fontWeight: 800 }}>
                          {saving ? "Working..." : "Approve revision"}
                        </button>
                        <button type="button" onClick={rejectRevision} disabled={saving}>
                          Reject
                        </button>
                      </>
                    ) : null}
                    {!readiness.blockers.length && revisionState === "approved" ? (
                      <button type="button" className="button-primary" onClick={issueRevision} disabled={saving} style={{ fontWeight: 800 }}>
                        {saving ? "Working..." : "Issue approved quote"}
                      </button>
                    ) : null}
                    {!readiness.blockers.length && revisionState === "issued" ? (
                      <button type="button" className="button-primary" onClick={createSalesOrder} disabled={creatingSalesOrder} style={{ fontWeight: 800 }}>
                        {creatingSalesOrder ? "Creating SO..." : "Convert to sales order"}
                      </button>
                    ) : null}
                  </div>
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Approval Trail</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        {approval.approval_required
                          ? "Discount on this quote exceeds your autonomous limit, so it needs an approval stamp before it can be issued."
                          : "This quote is inside your autonomous discount limit, so you can issue it without an approval stamp."}
                      </div>
                    </div>
                    <CustomerChip
                      label={approval.approval_required ? "Approval needed" : "No approval needed"}
                      tone={approval.approval_required ? "#fff7ea" : "#f2fbf5"}
                      color={approval.approval_required ? "#9a5a00" : "#0b6b38"}
                      borderColor={approval.approval_required ? "rgba(154,90,0,0.12)" : "rgba(207,231,214,0.95)"}
                    />
                  </div>

                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                    <CustomerStatCard label="Your Discount Limit" value={`${Number(approval.autonomous_discount_pct || 0).toFixed(2)}%`} accent="#2354d5" />
                    <CustomerStatCard
                      label="Highest On Quote"
                      value={`${Number(approval.max_discount_pct || 0).toFixed(2)}%`}
                      accent={approval.approval_required ? "#9a5a00" : "#1a7f47"}
                    />
                    <CustomerStatCard
                      label="Waiting On"
                      value={approval.current_approver?.full_name || (revisionState === "pending_approval" ? "Unassigned" : "—")}
                      accent={revisionState === "pending_approval" ? "#9a5a00" : "#31539d"}
                    />
                  </div>

                  {revisionState === "pending_approval" && approval.current_approver ? (
                    <div style={{ marginTop: 12, border: "1px solid rgba(234,215,161,0.92)", background: "linear-gradient(180deg, #fffaf0 0%, #fffdf6 100%)", borderRadius: 12, padding: "10px 12px", fontSize: 12, lineHeight: 1.6 }}>
                      Waiting on {approval.current_approver.full_name || approval.current_approver.email || "the assigned approver"}
                      {approval.current_approver.email ? ` (${approval.current_approver.email})` : ""}. Chase this person directly if the customer is waiting.
                    </div>
                  ) : null}

                  {approval.approval_required && (approval.suggested_approvers || []).length ? (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Approval chain</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {approval.suggested_approvers.map((person) => (
                          <CustomerChip
                            key={person.id || person.email || person.sequence_no}
                            label={`${person.sequence_no || "?"}. ${person.full_name || person.email || "Approver"}`}
                            tone="#eef4ff"
                            color="#2354d5"
                            borderColor="rgba(35,84,213,0.14)"
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {(approval.triggering_lines || []).length ? (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Lines driving the approval</div>
                      <div style={{ display: "grid", gap: 8 }}>
                        {approval.triggering_lines.map((line) => (
                          <div
                            key={line.line_id || `${line.line_no}-${line.item_name}`}
                            style={{
                              display: "flex",
                              gap: 10,
                              alignItems: "center",
                              justifyContent: "space-between",
                              border: "1px solid rgba(214,224,244,0.92)",
                              borderRadius: 12,
                              padding: "10px 12px",
                              fontSize: 12,
                              background: "#fff",
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <span style={{ opacity: 0.6, marginRight: 8 }}>#{line.line_no}</span>
                              {line.item_name}
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <span style={{ fontWeight: 800, color: Number(line.discount_pct || 0) > Number(approval.autonomous_discount_pct || 0) ? "#9a5a00" : "#0b6b38" }}>
                                {Number(line.discount_pct || 0).toFixed(2)}%
                              </span>
                              <button type="button" onClick={() => setStep(1)} style={{ fontSize: 11, padding: "4px 8px" }}>
                                Review price
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Approval history</div>
                    <HistoryTable
                      headers={["Cycle", "Status", "Approver", "Acted at", "Remarks"]}
                      columns="minmax(0, 0.5fr) minmax(0, 0.8fr) minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1.4fr)"
                      rows={approvalHistoryRows}
                      loading={approvalLoading}
                      loadingLabel="Loading approval history…"
                      emptyLabel="No approval action has been recorded on this revision yet."
                    />
                  </div>

                  {revisionState === "issued" || revisionState === "rejected" ? (
                    <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <button type="button" onClick={startNewRevision} disabled={saving}>
                        {saving ? "Working..." : "Revise in builder"}
                      </button>
                      <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                        {revisionState === "issued"
                          ? "Creates the next revision and reopens the offer here so you can amend price or scope without leaving this screen."
                          : "This revision was rejected. Create the next revision to make changes and resubmit."}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "radial-gradient(circle at top right, rgba(141,180,255,0.16), transparent 34%), linear-gradient(135deg, #f8fbff 0%, #ffffff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Send Package</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        Confirm exactly what the customer will receive with the main offer before you send it.
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CustomerChip label={quoteSummary.merge_annexures ? "One PDF" : "Separate PDFs"} tone="#fff7ea" color="#9a5a00" borderColor="rgba(154,90,0,0.12)" />
                      <CustomerChip label={`${annexures.length} additional doc${annexures.length === 1 ? "" : "s"}`} tone="#eef4ff" color="#2354d5" borderColor="rgba(35,84,213,0.14)" />
                    </div>
                  </div>
                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                    <CustomerStatCard label="Offer PDF" value="Included" accent="#2354d5" />
                    <CustomerStatCard label="Additional Docs" value={annexures.length} accent="#31539d" />
                    <CustomerStatCard label="Output Mode" value={quoteSummary.merge_annexures ? "Combined" : "Separate"} accent={quoteSummary.merge_annexures ? "#1a7f47" : "#9a5a00"} />
                  </div>
                  <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => window.open(`/quotes/${quoteId}/pdf?annexures=${quoteSummary.merge_annexures ? 1 : 0}`, "_blank", "noopener,noreferrer")}
                      style={{ background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)" }}
                    >
                      Preview Main Offer
                    </button>
                    <button
                      type="button"
                      onClick={() => window.open(`/quotes/${quoteId}/pdf?club=1&annexures=${quoteSummary.merge_annexures ? 1 : 0}`, "_blank", "noopener,noreferrer")}
                      style={{ background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)" }}
                    >
                      Preview Combined Package
                    </button>
                    <button type="button" onClick={() => onOpenDetail(quoteId)} style={{ background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)" }}>
                      Open Full Quote Desk
                    </button>
                  </div>
                  {!quoteSummary.merge_annexures && annexures.length ? (
                    <div style={{ marginTop: 12, border: "1px solid #eef2fb", borderRadius: 14, padding: 12, background: "#ffffff" }}>
                      <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>Additional Documents (separate)</div>
                      <div style={{ display: "grid", gap: 8 }}>
                        {annexures.map((a) => (
                          <button
                            key={a.attachment_id}
                            type="button"
                            onClick={() => window.open(`/quotes/${quoteId}/annexures/${a.attachment_id}`, "_blank", "noopener,noreferrer")}
                            style={{ textAlign: "left", background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)" }}
                          >
                            {(a.group_name ? `${a.group_name} - ` : "") + (a.file_name || "Additional document")}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div style={{ border: "1px solid rgba(214,224,244,0.92)", borderRadius: 18, padding: 16, background: "linear-gradient(180deg, #fbfcff 0%, #ffffff 100%)", boxShadow: "0 14px 30px rgba(31,41,55,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>Customer Handoff</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.74, lineHeight: 1.7 }}>
                        Preflight and PDF preview stay here. Compose and send from the slide-over when you are ready.
                      </div>
                    </div>
                  </div>

                  <div className="builder-four-stat-grid" style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                    <CustomerStatCard label="Sender" value={mailBootstrap.sender?.full_name || me?.full_name || "—"} accent="#2354d5" />
                    <CustomerStatCard label="Mailbox" value={mailBootstrap.mail_source?.effective_sender?.connected ? "Ready" : "Missing"} accent={mailBootstrap.mail_source?.effective_sender?.connected ? "#1a7f47" : "#9a5a00"} />
                    <CustomerStatCard label="Recipient" value={(selectedContact?.email || customerDetail?.email || mailForm.to) ? "Set" : "Missing"} accent={(selectedContact?.email || customerDetail?.email || mailForm.to) ? "#1a7f47" : "#9a5a00"} />
                  </div>

                  {mailNotice ? <div style={{ color: "#0b6b38", marginTop: 10, fontSize: 12 }}>{mailNotice}</div> : null}

                  <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    {revisionState === "issued" || revisionState === "sent" ? (
                      <button
                        type="button"
                        className="button-primary"
                        onClick={openMailComposer}
                        disabled={mailLoading || !quoteId}
                        style={{ fontWeight: 800 }}
                      >
                        {mailLoading ? "Preparing mail…" : "Email Quote to Customer"}
                      </button>
                    ) : null}
                    {sendRequiresIssue ? (
                      <button
                        type="button"
                        onClick={openMailComposer}
                        disabled={mailLoading || !quoteId || readiness.blockers.length > 0 || issueBlockedByApproval || approval.can_issue === false}
                      >
                        {mailLoading ? "Preparing mail…" : "Issue & Email Quote"}
                      </button>
                    ) : null}
                    {issueBlockedByApproval ? (
                      <div style={{ marginTop: 4, fontSize: 12, color: "#9a5a00", lineHeight: 1.6 }}>
                        Manager discount approval is required before issue or email.
                      </div>
                    ) : null}
                    <button type="button" onClick={onCancel}>
                      Return to Quotes List
                    </button>
                  </div>
                  {sendRequiresIssue ? (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                      Issuing locks the revision. Use <strong>Issue quote</strong> above if you want to review the PDF first. <strong>Issue & Email</strong> asks you to confirm both in one step.
                    </div>
                  ) : null}
                  {revisionState === "pending_approval" ? (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                      This revision is waiting for approval, so it cannot be issued or emailed yet.
                    </div>
                  ) : null}

                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Delivery timeline</div>
                    <HistoryTable
                      headers={["Sent", "Status", "To", "Subject"]}
                      columns="minmax(0, 0.9fr) minmax(0, 0.7fr) minmax(0, 1.1fr) minmax(0, 1.4fr)"
                      rows={mailHistoryRows}
                      loading={mailLoading}
                      loadingLabel="Loading delivery history…"
                      emptyLabel="This quote has not been emailed yet."
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="builder-sidebar" style={{ position: "sticky", top: 16 }}>
          <div
            style={{
              border: "1px solid rgba(201,214,240,0.8)",
              borderRadius: 22,
              padding: 16,
              background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(247,250,255,0.98) 100%)",
              boxShadow: "0 24px 48px rgba(18,41,88,0.08)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                borderRadius: 18,
                padding: 16,
                background: "radial-gradient(circle at top left, rgba(111,147,255,0.22), transparent 45%), linear-gradient(135deg, #112a5c 0%, #1d4ca8 52%, #7ba1ff 130%)",
                color: "#fff",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, letterSpacing: "0.09em", textTransform: "uppercase", opacity: 0.78 }}>Builder Summary</div>
                  <div style={{ marginTop: 8, fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>{quote?.quote_number || "Draft quote in progress"}</div>
                  <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.6, opacity: 0.84 }}>
                    {quote?.customer_name || selectedCustomer?.customer_name || "Customer not selected yet"}
                  </div>
                </div>
                <div
                  style={{
                    alignSelf: "start",
                    padding: "7px 10px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 800,
                    letterSpacing: "0.04em",
                    background: "rgba(255,255,255,0.14)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    backdropFilter: "blur(10px)",
                  }}
                >
                  {lifecycleBadge.label}
                </div>
              </div>
              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {pricingSnapshotCards.map((card) => (
                  <SidebarMetricCard key={card.label} label={card.label} value={card.value} note={card.note} accent={card.accent} />
                ))}
              </div>
            </div>

            <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Recommended next action</div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{recommendedNextAction.title}</div>
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78, lineHeight: 1.7 }}>{recommendedNextAction.body}</div>
              <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <CustomerChip
                  label={primaryFlowAction.label}
                  tone={primaryFlowAction.tone}
                  color={primaryFlowAction.color}
                  borderColor={primaryFlowAction.borderColor}
                />
                <button type="button" onClick={() => setStep(recommendedNextAction.step)}>
                  {recommendedNextAction.ctaLabel || `Go to ${steps[recommendedNextAction.step]?.label || "step"}`}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 10 }}>Quote checklist</div>
              <div style={{ display: "grid", gap: 10 }}>
                {checklistItems.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setStep(item.step)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto 1fr",
                      gap: 10,
                      alignItems: "start",
                      textAlign: "left",
                      padding: 12,
                      borderRadius: 14,
                      background: item.done ? "linear-gradient(180deg, #f6fcf8 0%, #ffffff 100%)" : "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
                      borderColor: item.done ? "#d7eadf" : "rgba(214,224,244,0.92)",
                    }}
                  >
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 999,
                        display: "grid",
                        placeItems: "center",
                        marginTop: 1,
                        background: item.done ? "#0b6b38" : "#e9eef8",
                        color: item.done ? "#fff" : "#5a6781",
                        fontSize: 12,
                        fontWeight: 800,
                      }}
                    >
                      {item.done ? "✓" : item.step + 1}
                    </div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 800 }}>{item.label}</div>
                      <div style={{ marginTop: 4, fontSize: 11, opacity: 0.74, lineHeight: 1.6 }}>{item.detail}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Commercial frame</div>
              <div>
                {sidebarCommercialRows.map((row, index) => (
                  <div key={row.label} style={{ borderBottom: index === sidebarCommercialRows.length - 1 ? "none" : undefined }}>
                    <SidebarKeyValueRow label={row.label} value={row.value} emphasis={row.label === "Quote currency"} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(223,229,241,0.78)" }}>
                <SidebarKeyValueRow label="Subtotal" value={subtotal.toFixed(2)} />
                <SidebarKeyValueRow label="GST" value={taxTotal.toFixed(2)} />
                <div style={{ borderBottom: "none" }}>
                  <SidebarKeyValueRow label="Grand total" value={grandTotal.toFixed(2)} emphasis />
                </div>
              </div>
            </div>

            <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 10 }}>Quote readiness</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <CustomerChip
                  label={readiness.blockers.length ? `${readiness.blockers.length} blocker(s)` : "Issue-ready"}
                  tone={readiness.blockers.length ? "#fff1f1" : "#f2fbf5"}
                  color={readiness.blockers.length ? "#9f3f3f" : "#0b6b38"}
                  borderColor={readiness.blockers.length ? "rgba(243,199,199,0.95)" : "rgba(207,231,214,0.95)"}
                />
                <CustomerChip
                  label={readiness.warnings.length ? `${readiness.warnings.length} warning(s)` : "No warnings"}
                  tone={readiness.warnings.length ? "#fff9ee" : "#f5f7fb"}
                  color={readiness.warnings.length ? "#8a6708" : "#53627d"}
                  borderColor={readiness.warnings.length ? "rgba(234,215,161,0.95)" : "rgba(229,234,243,0.95)"}
                />
                <CustomerChip
                  label={mailBootstrap.mail_source?.effective_sender?.connected ? "Mail sender ready" : "Mail sender missing"}
                  tone={mailBootstrap.mail_source?.effective_sender?.connected ? "#f2fbf5" : "#fff1f1"}
                  color={mailBootstrap.mail_source?.effective_sender?.connected ? "#0b6b38" : "#9f3f3f"}
                  borderColor={mailBootstrap.mail_source?.effective_sender?.connected ? "rgba(207,231,214,0.95)" : "rgba(243,199,199,0.95)"}
                />
              </div>
              <div style={{ marginTop: 10, padding: "12px 12px 0", borderTop: "1px solid rgba(223,229,241,0.78)" }}>
                <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58, marginBottom: 6 }}>Current next step</div>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{primaryFlowAction.label}</div>
                <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.7, opacity: 0.78 }}>{recommendedNextAction.body}</div>
              </div>
              {(readiness.blockers.length || readiness.warnings.length) && (
                <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7, opacity: 0.74 }}>
                  {readiness.blockers.length
                    ? "Resolve blockers before issue so the PDF, approval, and mail handoff stay aligned."
                    : "Builder is issue-ready, but the warning review is still worth a final scan."}
                </div>
              )}
            </div>

            {reviewConfiguratorContext?.family_key ? (
              <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
                <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Configurator route</div>
                <SidebarKeyValueRow label="Family" value={reviewConfiguratorContext.family_label || reviewConfiguratorContext.family_name || "—"} />
                <SidebarKeyValueRow label="Variant" value={reviewConfiguratorContext.variant_label || "—"} />
                <SidebarKeyValueRow label="Route" value={reviewConfiguratorContext.presentation_company_code || "—"} />
                <div style={{ borderBottom: "none" }}>
                  <SidebarKeyValueRow label="Profile" value={reviewConfiguratorContext.proposal_profile_key || "—"} />
                </div>
                {reviewConfiguratorWarnings.length ? (
                  <div
                    style={{
                      marginTop: 10,
                      border: "1px solid #f2e3b2",
                      background: "linear-gradient(180deg, #fffaf0 0%, #fffef8 100%)",
                      borderRadius: 12,
                      padding: "10px 12px",
                      fontSize: 12,
                      lineHeight: 1.65,
                    }}
                  >
                    {reviewConfiguratorWarnings.join(" ")}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 10 }}>Top line items</div>
              <div style={{ display: "grid", gap: 10 }}>
                {topLineItemsPreview.map((line) => (
                  <div
                    key={line.key}
                    style={{
                      border: "1px solid rgba(225,231,242,0.96)",
                      borderRadius: 14,
                      padding: 12,
                      background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 800, lineHeight: 1.45 }}>{line.item_name || "Manual Item"}</div>
                        <div style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>{line.item_code || "Uncoded item"}</div>
                      </div>
                      <CustomerChip label={`Qty ${line.qty}`} tone="#f3f7ff" color="#2954aa" borderColor="rgba(138,165,221,0.24)" />
                    </div>
                    <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, opacity: 0.78 }}>
                      <span>{toNumber(line.unit_price_quote, 0).toFixed(2)} net unit</span>
                      <span>{calcLineNetTotal(line).toFixed(2)} line total</span>
                    </div>
                  </div>
                ))}
                {!topLineItemsPreview.length ? <div style={{ fontSize: 12, opacity: 0.7 }}>No lines added yet.</div> : null}
              </div>
            </div>

            {selectedGroupNames.length ? (
              <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
                <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>Selected items snapshot</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {selectedGroupNames.map((name) => (
                    <CustomerChip key={name} label={name} tone="#f5f7fb" color="#46536b" borderColor="rgba(229,234,243,0.95)" />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>

    <SlideOverDrawer
      open={mailComposerOpen}
      onClose={() => !mailSending && setMailComposerOpen(false)}
      title="Email Quote to Customer"
      subtitle={quote?.quote_number ? `${quote.quote_number} · ${quote?.customer_name || selectedCustomer?.customer_name || "Customer"}` : "Compose the customer handoff"}
      eyebrow="Quote delivery"
      width={640}
      footer={
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={() => setMailComposerOpen(false)} disabled={mailSending}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => sendQuoteMail({ issueAndSend: sendRequiresIssue })}
            disabled={
              mailSending ||
              mailLoading ||
              saving ||
              !mailForm.to ||
              !mailForm.subject ||
              revisionState === "pending_approval" ||
              (sendRequiresIssue && (issueBlockedByApproval || approval.can_issue === false || readiness.blockers.length > 0))
            }
            style={{ fontWeight: 800 }}
          >
            {mailSending ? "Sending…" : sendRequiresIssue ? "Issue & Send Quote" : "Send Quote"}
          </button>
        </div>
      }
    >
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
          <CustomerStatCard label="Mailbox" value={mailBootstrap.mail_source?.effective_sender?.connected ? "Ready" : "Missing"} accent={mailBootstrap.mail_source?.effective_sender?.connected ? "#1a7f47" : "#9a5a00"} />
          <CustomerStatCard label="Attachments" value={mailAttachments.length} accent="#2354d5" />
          <CustomerStatCard label="Prior Sends" value={Array.isArray(mailBootstrap.history) ? mailBootstrap.history.length : 0} accent="#31539d" />
        </div>

        {mailNotice ? <div style={{ color: "#0b6b38", fontSize: 12 }}>{mailNotice}</div> : null}

        <div style={{ fontSize: 12, opacity: 0.78, lineHeight: 1.7, border: "1px solid #e8eef8", borderRadius: 12, padding: 12, background: "#f8fbff" }}>
          <div>
            From:{" "}
            {mailBootstrap.mail_source?.effective_sender?.connected
              ? `${mailBootstrap.mail_source.effective_sender.email} (${mailBootstrap.mail_source.effective_sender.source})`
              : "Mailbox not configured"}
          </div>
          <div>Reply-To: {mailBootstrap.sender?.email || me?.email || "—"}</div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <Field label="To">
            <input
              value={mailForm.to}
              onChange={(e) => setMailForm((prev) => ({ ...prev, to: e.target.value }))}
              disabled={mailSending}
              placeholder="client@example.com"
            />
          </Field>
          <Field label="CC">
            <input value={mailForm.cc} onChange={(e) => setMailForm((prev) => ({ ...prev, cc: e.target.value }))} disabled={mailSending} />
          </Field>
          <Field label="BCC">
            <input value={mailForm.bcc} onChange={(e) => setMailForm((prev) => ({ ...prev, bcc: e.target.value }))} disabled={mailSending} />
          </Field>
          <Field label="Mail Style">
            <select
              value={mailForm.preset_key || mailBootstrap.default_preset_key || ""}
              onChange={(e) => applyMailPreset(e.target.value)}
              disabled={mailSending || !Array.isArray(mailBootstrap.mail_presets) || !mailBootstrap.mail_presets.length}
            >
              {(Array.isArray(mailBootstrap.mail_presets) ? mailBootstrap.mail_presets : []).map((preset) => (
                <option key={preset.key} value={preset.key}>
                  {preset.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Subject">
            <input value={mailForm.subject} onChange={(e) => setMailForm((prev) => ({ ...prev, subject: e.target.value }))} disabled={mailSending} />
          </Field>
        </div>

        {selectedMailPreset?.description ? (
          <div style={{ fontSize: 12, opacity: 0.72 }}>{selectedMailPreset.description}</div>
        ) : null}

        <Field label="Message">
          <textarea
            value={mailForm.body}
            onChange={(e) => setMailForm((prev) => ({ ...prev, body: e.target.value }))}
            rows={8}
            style={{ width: "100%", resize: "vertical" }}
            disabled={mailSending}
          />
        </Field>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={mailForm.clubbed}
            onChange={(e) => setMailForm((prev) => ({ ...prev, clubbed: e.target.checked }))}
            disabled={mailSending}
          />
          Send clubbed proposal (combined PDF package)
        </label>

        <div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <button type="button" onClick={openMailAttachmentPicker} disabled={mailAttachmentUploading || !quoteId || mailSending}>
              {mailAttachmentUploading ? "Attaching…" : "Attach Additional Files"}
            </button>
            <input ref={mailAttachmentInputRef} type="file" multiple onChange={handleMailAttachmentUpload} style={{ display: "none" }} />
          </div>
          {mailAttachments.length ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {mailAttachments.map((item) => (
                <CustomerChip
                  key={item.attachment_id || item.id}
                  label={item.file_name || "Attached file"}
                  tone="#eef4ff"
                  color="#2354d5"
                  borderColor="rgba(35,84,213,0.14)"
                />
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.7 }}>No extra attachments yet. The main quote PDF is included automatically.</div>
          )}
        </div>
      </div>
    </SlideOverDrawer>
    </>
  );
}
