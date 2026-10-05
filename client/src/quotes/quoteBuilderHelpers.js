import {
  DEFAULT_PRICE_TYPES,
  apiFetch,
  getPriceListMultiplier,
  normalizePriceTypes,
  parseDraftNumber,
  resolvePriceTypeKey,
} from "./quoteShared";

export function getPriceTypeLabel(priceTypes, priceTypeKey) {
  const options = normalizePriceTypes(priceTypes);
  const key = resolvePriceTypeKey(options, priceTypeKey);
  return options.find((item) => item.key === key)?.label || key;
}

export function roundPricing(value, scale = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** scale;
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

export function convertBaseAmountToQuote(baseAmount, exchangeRate) {
  const base = Number(baseAmount);
  const rate = Number(exchangeRate);
  if (!Number.isFinite(base)) return 0;
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return roundPricing(base, 2);
  return roundPricing(base / rate, 2);
}

export function resolveQuoteExchangeRate(exchangeRates, baseCurrencyId, quoteCurrencyId) {
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

export function getFallbackDraftLineQuotePrice(product, draftLines) {
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

export const EMPTY_NEW_CUSTOMER = {
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

export function shouldReplaceMailValue(currentValue, previousDefault) {
  const current = String(currentValue || "").trim();
  const prior = String(previousDefault || "").trim();
  return !current || current === prior;
}

export function statesForCountry(states, countryId) {
  const key = String(countryId || "").trim();
  return (Array.isArray(states) ? states : []).filter((item) => key && String(item.country_id) === key);
}

export function citiesForState(cities, stateId) {
  const key = String(stateId || "").trim();
  return (Array.isArray(cities) ? cities : []).filter((item) => key && String(item.state_id) === key);
}

export function findStateId(states, countryId, stateName) {
  const name = String(stateName || "").trim().toLowerCase();
  if (!name) return "";
  const match = statesForCountry(states, countryId).find((item) => String(item.state_name || "").trim().toLowerCase() === name);
  return match ? String(match.id) : "";
}

export function findCityId(cities, stateId, cityName) {
  const name = String(cityName || "").trim().toLowerCase();
  if (!name) return "";
  const match = citiesForState(cities, stateId).find((item) => String(item.city_name || "").trim().toLowerCase() === name);
  return match ? String(match.id) : "";
}

export function appendCityOption(cities, city) {
  if (!city?.id) return Array.isArray(cities) ? cities : [];
  const list = Array.isArray(cities) ? cities : [];
  if (list.some((item) => String(item.id) === String(city.id))) return list;
  return [...list, city].sort((a, b) => {
    const stateCompare = String(a?.state_name || "").localeCompare(String(b?.state_name || ""));
    if (stateCompare !== 0) return stateCompare;
    return String(a?.city_name || "").localeCompare(String(b?.city_name || ""));
  });
}

export function findIndiaCountryId(countries) {
  const list = Array.isArray(countries) ? countries : [];
  const direct = list.find((item) => String(item?.iso_code || "").trim().toUpperCase() === "IN");
  if (direct?.id !== undefined && direct?.id !== null) return String(direct.id);
  const byName = list.find((item) => String(item?.country_name || "").trim().toLowerCase() === "india");
  return byName?.id !== undefined && byName?.id !== null ? String(byName.id) : "";
}

export function isHealthcareConfiguratorFamilyKey(value) {
  const key = String(value || "").trim().toUpperCase();
  return key === "MEDO" || key === "MEDO_C";
}

export function normalizeLookupText(value) {
  return String(value || "").trim().toLowerCase();
}

export function findDefaultPaymentTermId(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const exactCode = list.find((item) => normalizeLookupText(item?.term_code) === "adv50");
  if (exactCode?.id !== undefined && exactCode?.id !== null) return String(exactCode.id);
  const fallback = list.find((item) => {
    const text = `${normalizeLookupText(item?.term_code)} ${normalizeLookupText(item?.term_name)}`;
    return text.includes("adv50") || text.includes("50% advance") || text.includes("50 advance");
  });
  return fallback?.id !== undefined && fallback?.id !== null ? String(fallback.id) : "";
}

export function findSparesPaymentTermId(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const match =
    list.find((item) => normalizeLookupText(item?.term_code) === "adv100") ||
    list.find((item) => normalizeLookupText(item?.term_name).includes("100% advance"));
  return match?.id !== undefined && match?.id !== null ? String(match.id) : "";
}

export function findDefaultFreightTermId(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const fallback = list.find((item) => {
    const text = `${normalizeLookupText(item?.term_code)} ${normalizeLookupText(item?.term_name)}`;
    return text.includes("extra at actual") || (text.includes("extra") && text.includes("actual"));
  });
  return fallback?.id !== undefined && fallback?.id !== null ? String(fallback.id) : "";
}

export function findDefaultIncotermId(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const exactCode = list.find((item) => normalizeLookupText(item?.incoterm_code) === "exw");
  if (exactCode?.id !== undefined && exactCode?.id !== null) return String(exactCode.id);
  const fallback = list.find((item) => {
    const text = `${normalizeLookupText(item?.incoterm_code)} ${normalizeLookupText(item?.incoterm_name)}`;
    return text.includes("exw") || text.includes("ex works");
  });
  return fallback?.id !== undefined && fallback?.id !== null ? String(fallback.id) : "";
}

export function findDefaultPAndFTermId(terms) {
  const list = Array.isArray(terms) ? terms : [];
  // Terms Library / Absstem default is "3% Extra." Prefer that commercial code first.
  const threePct = list.find((item) => {
    const code = normalizeLookupText(item?.term_code).replace(/\s+/g, "");
    const text = `${normalizeLookupText(item?.term_code)} ${normalizeLookupText(item?.term_name)}`;
    return code === "3%" || code === "3" || code === "pf3" || text.includes("3%") || /\b3\s*%/.test(text);
  });
  if (threePct?.id !== undefined && threePct?.id !== null) return String(threePct.id);

  const exactExtra = list.find((item) => normalizeLookupText(item?.term_code) === "extra");
  if (exactExtra?.id !== undefined && exactExtra?.id !== null) return String(exactExtra.id);
  const fallback = list.find((item) => {
    const text = `${normalizeLookupText(item?.term_code)} ${normalizeLookupText(item?.term_name)}`;
    return text.includes("extra at actual") || text.includes("packing") || text.includes("forwarding");
  });
  return fallback?.id !== undefined && fallback?.id !== null ? String(fallback.id) : "";
}

function findTermDescriptionByCaption(terms, captions) {
  const wanted = (Array.isArray(captions) ? captions : [captions]).map((item) => normalizeLookupText(item));
  const list = Array.isArray(terms) ? terms : [];
  const match = list.find((item) => wanted.includes(normalizeLookupText(item?.caption)));
  return typeof match?.description === "string"
    ? match.description
    : typeof match?.default_description === "string"
      ? match.default_description
      : "";
}

/** Parse Terms Library Delivery text (e.g. "6-8 Weeks...") into days for the commercial field. */
export function parseDeliveryLeadTimeDaysFromText(value) {
  const text = String(value || "");
  if (!text.trim()) return "";
  const dayMatch = text.match(/(\d+)\s*(?:-|to|–|—)\s*(\d+)\s*days?/i) || text.match(/(\d+)\s*days?/i);
  if (dayMatch) {
    const a = Number(dayMatch[1]);
    const b = dayMatch[2] !== undefined ? Number(dayMatch[2]) : a;
    const days = Math.max(a, b);
    return Number.isFinite(days) && days >= 0 ? String(days) : "";
  }
  const weekMatch = text.match(/(\d+)\s*(?:-|to|–|—)\s*(\d+)\s*weeks?/i) || text.match(/(\d+)\s*weeks?/i);
  if (weekMatch) {
    const a = Number(weekMatch[1]);
    const b = weekMatch[2] !== undefined ? Number(weekMatch[2]) : a;
    const weeks = Math.max(a, b);
    if (!Number.isFinite(weeks) || weeks < 0) return "";
    return String(weeks * 7);
  }
  return "";
}

/** Parse Terms Library Warranty text (prefer commissioning months, else first months figure). */
export function parseWarrantyMonthsFromText(value) {
  const text = String(value || "");
  if (!text.trim()) return "";
  const commissioning = text.match(/(\d+)\s*months?\s+from(?:\s+the)?\s+date\s+of\s+Commissioning/i);
  if (commissioning) {
    const months = Number(commissioning[1]);
    return Number.isFinite(months) && months >= 0 ? String(months) : "";
  }
  const anyMonths = text.match(/(\d+)\s*months?/i);
  if (anyMonths) {
    const months = Number(anyMonths[1]);
    return Number.isFinite(months) && months >= 0 ? String(months) : "";
  }
  return "";
}

export function resolveDefaultDeliveryLeadTimeDays({ revisionTerms, termsMaster } = {}) {
  const fromRevision = parseDeliveryLeadTimeDaysFromText(findTermDescriptionByCaption(revisionTerms, ["Delivery", "Delivery Lead Time"]));
  if (fromRevision) return fromRevision;
  return parseDeliveryLeadTimeDaysFromText(findTermDescriptionByCaption(termsMaster, ["Delivery", "Delivery Lead Time"]));
}

export function resolveDefaultWarrantyMonths({ revisionTerms, termsMaster } = {}) {
  const fromRevision = parseWarrantyMonthsFromText(findTermDescriptionByCaption(revisionTerms, ["Warranty"]));
  if (fromRevision) return fromRevision;
  return parseWarrantyMonthsFromText(findTermDescriptionByCaption(termsMaster, ["Warranty"]));
}

export function getManagedCommercialTermKind(value) {
  const caption = normalizeLookupText(value).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  if (caption === "incoterm" || caption === "incoterms") return "incoterm";
  if (caption === "payment term" || caption === "payment terms") return "payment_term";
  if (caption === "freight term" || caption === "freight terms" || caption === "freight") return "freight_term";
  if (caption === "p f" || caption === "p f terms" || caption === "packing forwarding" || caption === "packing and forwarding") {
    return "p_and_f_term";
  }
  return "";
}

export function isManagedCommercialTerm(value) {
  return Boolean(getManagedCommercialTermKind(value));
}

export const CONFIGURATOR_FAMILIES = [
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

export function pickConfiguratorModel(rec, selectedModel) {
  if (!rec || typeof rec !== "object") return null;
  const selected = Array.isArray(rec.options) ? rec.options.find((option) => option?.model === selectedModel) : null;
  return selected || rec.recommended || null;
}

export function dedupeStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

export function inferNgenVariantFromValue(value) {
  const text = normalizeConfiguratorSearchText(value);
  if (!text) return "";
  if (/\bUH\b/.test(text)) return "UH";
  if (/\bSH\b/.test(text)) return "SH";
  if (/\bHF\b/.test(text)) return "HF";
  return "";
}

export function describeConfiguratorVariant({ family, selectedPackage }) {
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

export function buildConfiguratorNarrative({
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

  if (packageMode === "psa_only" || packageMode === "psa_compressor") {
    const airCfm = Number(selectedPackage?.airRequirement) || 0;
    const storageL = Number(selectedPackage?.storageVolume) || 0;
    const compressorText = `Compressor package (air compressor, air dryer, air receiver, primary filter)${
      airCfm ? ` delivering min ${Math.ceil(airCfm)} CFM dry air` : ""
    } in client scope.`;
    const storageText = `Product gas buffer storage tank${storageL ? ` of min ${Math.ceil(storageL)} L` : ""} in client scope.`;
    exclusions = dedupeStrings([
      ...exclusions,
      packageMode === "psa_only" ? compressorText : "",
      storageText,
    ]);
    responsibilities = dedupeStrings([
      ...responsibilities.map((row) => `${row.party}|${row.responsibility}`),
      packageMode === "psa_only"
        ? "Client|Provide the compressor package and product gas storage tank to the stated minimum requirements."
        : "Client|Provide the product gas storage tank to the stated minimum capacity.",
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
    packageMode === "psa_only"
      ? "Absstem supplies the PSA generator; compressor package and storage tank are in client scope."
      : packageMode === "psa_compressor"
        ? "Absstem supplies the PSA generator and compressor package; storage tank is in client scope."
        : "Absstem supplies the complete system: compressor package, PSA generator and storage tank.",
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

export function normalizeConfiguratorSearchText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

export function detectConfiguratorFamilyKeyFromText(value) {
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

export function detectConfiguratorFamilyKeyFromLine(line) {
  return detectConfiguratorFamilyKeyFromText(
    [line?.item_code, line?.item_name, line?.remarks]
      .filter(Boolean)
      .join(" ")
  );
}

export function summarizeDraftConfiguratorFamilies(lines) {
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

export function buildConfiguratorRecommendationCard({ family, rec, selectedModel, packageMode, lines }) {
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
    warnings.push("Only PSA: compressor package and storage tank will be added as Client Scope lines (not priced).");
  } else if (packageMode === "psa_compressor") {
    warnings.push("PSA + compressor: storage tank will be added as a Client Scope line (not priced).");
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

export function buildConfiguratorContextPayload({ family, rec, selectedModel, packageMode, lines, preview }) {
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

export async function createCityMaster({ countryId, stateId, cityName }) {
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

export function isBlockingDuplicateLevel(row) {
  const level = row?.duplicate_confidence?.level;
  return level === "high" || level === "medium";
}

export function formatProposalProfileLabel(key) {
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

export function safeParseMeta(desc) {
  if (typeof desc !== "string" || !desc.trim()) return null;
  try {
    const value = JSON.parse(desc);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizePricingFields({ qty, grossUnit, discPct, discAmt, netUnit, changed }) {
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

export function normalizeEditableLinePricing(line, priceTypes = DEFAULT_PRICE_TYPES) {
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

export function toEditableLine(line, priceTypes = DEFAULT_PRICE_TYPES) {
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

export function mapServerLinesToDraft(lines, priceTypes = DEFAULT_PRICE_TYPES) {
  return Array.isArray(lines) ? lines.map((line) => toEditableLine(line, priceTypes)) : [];
}

export function buildLineMeta(line) {
  const prior = safeParseMeta(line.line_description) || {};
  const packageTags = {};
  for (const key of ["package_applied", "package_mode", "scope_role", "scope_requirement"]) {
    if (prior[key] !== undefined && prior[key] !== null) packageTags[key] = prior[key];
  }
  return JSON.stringify({
    ...packageTags,
    price_list: line.price_list || "list",
    source_list_price: toNumber(line.source_list_price, 0),
    gross_unit_price_quote: toNumber(line.gross_unit_price_quote, 0),
    discount_pct: toNumber(line.discount_pct, 0),
    discount_amt: toNumber(line.discount_amt, 0),
    remarks: line.remarks || "",
  });
}

export function calcLineNetTotal(line) {
  return toNumber(line.qty, 0) * toNumber(line.unit_price_quote, 0);
}

export function calcLineTaxTotal(line) {
  return (calcLineNetTotal(line) * toNumber(line.gst_pct, 0)) / 100;
}

export function cloneDraftLine(line) {
  return {
    ...line,
    key: `new:${Math.random().toString(16).slice(2)}`,
    id: null,
  };
}

export function matchClientGuardrail(guardrails, productGroupId) {
  const list = Array.isArray(guardrails) ? guardrails : [];
  const gid = Number(productGroupId);
  if (Number.isFinite(gid) && gid > 0) {
    const exact = list.find((row) => Number(row.product_group_id) === gid);
    if (exact) return exact;
  }
  return list.find((row) => row.product_group_id == null || row.product_group_id === "") || null;
}

export function buildLineFloorHint(line, guardrails) {
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

export function buildAftermarketContext(initialLaunch) {
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
