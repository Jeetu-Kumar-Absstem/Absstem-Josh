/**
 * Product-family brochure copy for quote PDF modular technical sections.
 * Sourced from Absstem public product pages (absstem.com), condensed for proposal use.
 */

const FAMILY_BROCHURE_CONTENT = Object.freeze({
  NGEN: {
    family_key: "NGEN",
    family_name: "nGEN",
    title: "PSA Industrial Nitrogen Generator – nGEN",
    tagline: "Fully engineered, installed, and commissioned on-site nitrogen system for manufacturing plants",
    source_url: "https://absstem.com/psa-industrial-nitrogen-generator/",
    write_up:
      "Absstem’s nGEN is a PSA (Pressure Swing Adsorption) based on-site industrial nitrogen generator built for manufacturing plants that require continuous, high-purity nitrogen without cylinder or liquid nitrogen dependency. Unlike packaged machines, nGEN is delivered as a fully engineered, installed, and commissioned PSA nitrogen system – supplying nitrogen directly to your production lines at the required purity, pressure, and flow. A PSA industrial nitrogen generator produces nitrogen on-site from atmospheric air using Carbon Molecular Sieves (CMS). CMS selectively adsorbs oxygen by kinetic diffusion, allowing nitrogen to pass through at 95%–99.9995% purity. The system runs continuously on electricity alone – no cylinder deliveries, no liquid nitrogen, no PESO storage licence required.",
    unique_features: [
      "10-year Carbon Molecular Sieve (CMS) performance warranty – first Indian industrial PSA nitrogen manufacturer to publicly commit to this",
      "Industry-best air-to-nitrogen ratio through continuous R&D – lower electricity cost per Nm³",
      "Configurable purity 95%–99.9995% with flow range 5–3,000 Nm³/hr (higher on custom models)",
      "IIoT remote monitoring* for real-time purity, pressure, flow, compressor & CMS status",
      "Automatic idle mode with auto-restart on demand for continuous 24×7 manufacturing duty",
      "Industrial-grade HD touchscreen HMI with integrated pre-treatment (multi-stage filtration + dryer)",
      "Optional high-pressure booster path for laser cutting and pressure-critical applications (15–40 bar)",
      "Long-term AMC/CMC support through Absstem Shield",
    ],
    ambient_design: [
      { label: "CMS Type", value: "Premium-grade Carbon Molecular Sieve (kinetic diffusion PSA)" },
      { label: "Output Purity", value: "95% to 99.9995% N₂ – configurable at commissioning" },
      { label: "Flow Range", value: "5–3,000 Nm³/hr (higher flow ranges available on custom models)" },
      { label: "Delivery Pressure", value: "Up to 5.5–6 barg standard (optional up to 8–8.5 barg; booster for higher pressures)" },
      { label: "CMS Performance Warranty", value: "10 years under Absstem warranty conditions" },
      { label: "CMS Lifespan", value: "10–12 years standard under normal operating conditions" },
      { label: "Inlet Pressure Dew Point", value: "Below 5°C at PSA inlet (maintained by integrated dryer)" },
      { label: "CMS Sensitivity", value: "Protected from moisture and oil via Absstem pre-treatment train" },
      { label: "Air-to-N₂ Ratio", value: "Industry best – lowest in class at equivalent purity" },
      { label: "Operation", value: "Continuous 24×7 | Automatic idle mode | Auto-restart on demand" },
      { label: "Certifications", value: "ISO 13485:2016 (TÜV Nord) | ISO 9001:2015 | ISO 14001:2015 | ISO 45001:2018" },
    ],
  },

  NGEN_HF: {
    title: "nGEN HF Series – High-Flow Industrial Nitrogen",
    tagline: "High-flow nitrogen for throughput-led industrial duty (95–98% purity)",
    write_up:
      "The nGEN HF Series is configured for high-flow nitrogen applications such as petrochemical inerting, oil & gas, fire and explosion prevention, and plastics manufacturing. It retains the full nGEN engineered PSA platform – premium CMS, industry-best air-to-nitrogen ratio, IIoT monitoring*, and 10-year CMS warranty – tuned for 95–98% purity at industrial flow rates of 5–3,000 Nm³/hr.",
    unique_features: [
      "HF series purity band 95–98% optimised for high-flow inerting and process blanketing",
      "5–3,000 Nm³/hr flow with 5.5–6 barg delivery (optional up to 8–8.5 barg)",
      "10-year CMS performance warranty and industry-best air-to-nitrogen ratio",
      "IIoT remote monitoring* and Absstem Shield AMC/CMC pathway",
    ],
  },

  NGEN_SH: {
    title: "nGEN SH Series – Standard High-Performance Nitrogen",
    tagline: "Balanced premium nitrogen for food, pharma, moulding, and chemical blanketing (99–99.95%)",
    write_up:
      "The nGEN SH Series targets applications that need elevated purity without ultra-high specialty requirements – including food and beverage, pharmaceuticals, industrial moulding, and chemical blanketing. SH builds on the nGEN PSA nitrogen plant architecture with configurable 99–99.95% purity, continuous duty controls, and Absstem’s 10-year CMS performance warranty.",
    unique_features: [
      "SH series purity band 99–99.95% for quality-sensitive industrial processes",
      "Stable purity, pressure, and flow under fluctuating production loads",
      "10-year CMS warranty with premium-grade sieve and protected pre-treatment",
      "IIoT monitoring* and HD touchscreen HMI as part of the engineered package",
    ],
  },

  NGEN_UH: {
    title: "nGEN UH Series – Ultra-High-Purity Nitrogen",
    tagline: "Purity-led nitrogen for laser cutting, electronics, pharmaceuticals, and metallurgy (99.99–99.9995%)",
    write_up:
      "The nGEN UH Series is Absstem’s ultra-high-purity industrial nitrogen configuration for quality-critical processes such as laser cutting, electronics and semiconductor manufacturing, pharmaceuticals, and metallurgy. UH delivers configurable purity from 99.99% to 99.9995% on the same engineered PSA platform – premium Carbon Molecular Sieve, industry-best air-to-nitrogen ratio, IIoT remote monitoring*, and a 10-year CMS performance warranty. High-pressure booster options support laser cutting and pressure testing applications at 15–40 bar where required.",
    unique_features: [
      "UH purity band 99.99–99.9995% for purity-led industrial applications",
      "10-year molecular sieve (CMS) performance warranty – unmatched public commitment among Indian PSA nitrogen competitors",
      "Industry-best air-to-nitrogen ratio for lower cost per Nm³ at high purity",
      "Optional high-pressure booster path for laser cutting (15–40 bar)",
      "IIoT remote monitoring* of purity, pressure, flow, compressor and CMS status",
      "Designed for continuous manufacturing with automatic idle / auto-restart",
    ],
  },

  NGENX: {
    family_key: "NGENX",
    family_name: "nGENX",
    title: "Compact PSA Nitrogen Generator – nGENX",
    tagline: "Skid-mounted, plug-and-play on-site nitrogen for SMEs and space-constrained plants",
    source_url: "https://absstem.com/compact-psa-nitrogen-generator/",
    write_up:
      "Absstem’s nGENX is a compact, skid-mounted PSA nitrogen generator designed for small and medium enterprises that need reliable on-site nitrogen without the installation complexity, civil work, and extended lead times of a full-scale system. nGENX arrives pre-assembled on a single skid – connect air supply, power, and nitrogen outlet, and on-site nitrogen generation begins. Delivering 95%–99.90% nitrogen purity at 5–100 Nm³/hr, nGENX is ideal for food and beverage MAP packaging, small chemical and process plants, electronics SMT/reflow, small laser setups, automotive parts packaging, and oil & gas. Absstem backs nGENX with the same 10-year Carbon Molecular Sieve performance warranty and IIoT monitoring* pathway as the full-scale nGEN platform.",
    unique_features: [
      "10-year CMS performance warranty – first in India for industrial PSA nitrogen",
      "Plug-and-play skid format with minimal civil work; typical commissioning within 2 days",
      "95–99.90% purity at 5–100 Nm³/hr – purpose-built for SME scale",
      "Industry-best air-to-nitrogen ratio for lower operating cost vs cylinders / LIN",
      "IIoT remote monitoring* add-on with automatic start/stop and idle mode",
      "Compact footprint for limited factory space, mezzanines, or rooftops",
      "Operator training and long-term AMC/CMC through Absstem Shield",
    ],
    ambient_design: [
      { label: "CMS Type", value: "Premium-grade Carbon Molecular Sieve (PSA kinetic separation)" },
      { label: "Output Purity", value: "95% to 99.90% N₂ – configurable at commissioning" },
      { label: "Flow Range", value: "5–100 Nm³/hr" },
      { label: "Delivery Pressure", value: "5.5 barg typical (higher pressures available on demand)" },
      { label: "CMS Performance Warranty", value: "10 years – first in India" },
      { label: "CMS Lifespan", value: "10–12 years standard under warranty conditions" },
      { label: "Inlet Pressure Dew Point", value: "Below 5°C at PSA inlet (integrated dryer)" },
      { label: "Format", value: "Skid-mounted, pre-assembled, plug-and-play" },
      { label: "Commissioning", value: "Ready within ~2 days for typical installations" },
      { label: "Operation", value: "Continuous 24×7 with automatic start/stop and idle mode" },
    ],
  },

  MEDO: {
    family_key: "MEDO",
    family_name: "MedO",
    title: "ISO 13485-Certified PSA Medical Oxygen Generator – MedO",
    tagline: "Hospital-grade on-site medical oxygen for ICUs, OTs, emergency, and MGPS networks",
    source_url: "https://absstem.com/psa-medical-oxygen-generator/",
    write_up:
      "MedO is Absstem’s ISO 13485-certified PSA medical oxygen generator, engineered for hospitals, nursing homes, and healthcare facilities requiring a dependable on-site oxygen supply. Delivering 93–96% medical oxygen purity, MedO supports ICUs, operation theatres, emergency departments, and MGPS networks with reliable 24×7 performance. A medical oxygen generator produces medical-grade oxygen directly from ambient air using Pressure Swing Adsorption with zeolite molecular sieves – continuously supplying 93–96% oxygen without depending on cylinders or liquid oxygen deliveries. Every MedO system is manufactured in India, remotely monitorable through IIoT*, designed for extreme Indian weather conditions, and built for long-term operational savings.",
    unique_features: [
      "ISO 13485:2016 certified by TÜV Nord – medical device quality manufacturing",
      "93–96% purity compliant with Indian Pharmacopoeia, WHO, USP, and British Pharmacopoeia",
      "10-year zeolite molecular sieve performance warranty",
      "IIoT remote monitoring* of purity, pressure, flow, compressor and sieve status",
      "Automatic adsorption cycling, energy-saving idle mode, and intelligent restart",
      "PESO licence not required for the PSA generator (exempt under Gas Cylinders Rules 2016)",
      "Single-source delivery: design, manufacturing, commissioning, and Absstem Shield AMC/CMC",
      "Capacity range from ~100 LPM to 60,000+ LPM (custom) for hospitals of all sizes",
    ],
    ambient_design: [
      { label: "Oxygen Purity", value: "93–96% (pharmacopoeia-compliant medical oxygen)" },
      { label: "Typical Flow Envelope", value: "From ~100 LPM class units up to 60,000+ LPM custom plants (1–3,000 Nm³/hr class capability)" },
      { label: "Delivery Pressure", value: "5.5 barg (higher pressures available on demand)" },
      { label: "Molecular Sieve", value: "Zeolite molecular sieve – 10-year performance warranty" },
      { label: "Ambient Design", value: "Designed for extreme Indian weather conditions" },
      { label: "Operation", value: "Continuous 24×7 | Automatic idle mode | Auto-restart on demand" },
      { label: "Monitoring", value: "IIoT-enabled*: real-time purity, pressure, flow, compressor & sieve status" },
      { label: "Certifications", value: "ISO 13485:2016 (TÜV Nord) | ISO 9001:2015 | ISO 14001:2015 | ISO 45001:2018" },
      { label: "Compliances", value: "Indian Pharmacopoeia | WHO | USP | British Pharmacopoeia; NABH-supportive documentation" },
      { label: "Regulatory Note", value: "PSA generators are PESO-exempt – no gas cylinder storage licence required for the generator" },
    ],
  },

  MEDO_C: {
    family_key: "MEDO_C",
    family_name: "MedO C",
    title: "Affordable Custom Medical Oxygen Generator – MedO C",
    tagline: "Economical compact medical oxygen for small hospitals, nursing homes, and CHCs",
    source_url: "https://absstem.com/custom-psa-medical-oxygen-generator/",
    write_up:
      "Absstem’s MedO C is the affordable, economical version of MedO – India’s ISO 13485-certified medical oxygen generator – designed specifically for small hospitals, nursing homes, community health centres, and rural healthcare facilities that need reliable on-site oxygen at a lower investment. Introduced in 2024, MedO C delivers the core performance benefits of MedO – 93–96% purity oxygen compliant with Indian Pharmacopoeia, WHO, and USP – in a compact, modular format with faster installation and a significantly lower price point. Purity standards, ISO 13485 manufacturing quality, IIoT monitoring*, and the 10-year sieve warranty are identical to MedO – MedO C is not a compromise on purity or safety.",
    unique_features: [
      "Same 93–96% pharmacopoeia-compliant purity as full-scale MedO",
      "ISO 13485:2016 manufacturing quality (TÜV Nord) at a lower investment point",
      "10-year molecular sieve performance warranty included",
      "IIoT remote monitoring* add-on with automatic idle / auto-restart",
      "Compact modular format with faster installation for facilities up to ~100–150 beds",
      "Ideal for nursing homes, CHCs, rural facilities, and budget-constrained hospitals",
      "Absstem Shield AMC/CMC for hospital-grade uptime support",
    ],
    ambient_design: [
      { label: "Oxygen Purity", value: "93–96% (IP, WHO, USP, BP compliant)" },
      { label: "Typical Flow Envelope", value: "Compact class ~50–150 LPM / up to ~100 Nm³/hr envelope" },
      { label: "Delivery Pressure", value: "5.5 barg (higher pressures available on demand)" },
      { label: "Typical Facility Size", value: "Up to ~100–150 beds (nursing homes, CHCs, small private hospitals)" },
      { label: "Sieve Warranty", value: "10 years performance warranty" },
      { label: "Format", value: "Compact, modular PSA – faster installation than full-scale MedO" },
      { label: "Operation", value: "Continuous 24×7 | Auto idle mode | Auto-restart" },
      { label: "Certifications", value: "ISO 13485:2016 (TÜV Nord) | ISO 9001:2015 | ISO 14001:2015 | ISO 45001:2018" },
      { label: "PESO", value: "PSA generators exempt – no licence needed for the generator" },
    ],
  },

  IDOS: {
    family_key: "IDOS",
    family_name: "Idos",
    title: "PSA Industrial Oxygen Generator – Idos",
    tagline: "Fully engineered on-site industrial oxygen for manufacturing and process industries",
    source_url: "https://absstem.com/psa-industrial-oxygen-generator/",
    write_up:
      "Absstem’s Idos is a PSA-based on-site industrial oxygen generator designed for manufacturing and process industries that require continuous, reliable oxygen without dependence on cylinders or liquid oxygen supply. Idos is supplied as a fully engineered, installed, and commissioned PSA oxygen system – delivering oxygen directly to your process at the required purity, pressure, and flow. A PSA industrial oxygen generator produces oxygen on-site from atmospheric air using zeolite molecular sieves that selectively adsorb nitrogen under pressure, allowing oxygen to pass through at 90–96% purity. Unlike medical oxygen systems built around pharmacopoeia-regulated purity, Idos is engineered for industrial process requirements – combustion efficiency, oxidation reactions, dissolved oxygen targets, and continuous-duty operation.",
    unique_features: [
      "10-year zeolite molecular sieve performance warranty – first Indian industrial PSA oxygen manufacturer to provide this",
      "Industry-leading (lowest-in-class) air-to-oxygen ratio for lower cost per Nm³",
      "Configurable 90–96% purity with flow range 1–5,000 Nm³/hr",
      "IIoT remote monitoring* and HD touchscreen HMI with PLC automation",
      "Automatic idle mode with auto start/stop for continuous industrial duty",
      "PESO licence not required for the PSA generator",
      "Complete turnkey package: compressor, dryer, filtration, storage, installation, Absstem Shield AMC/CMC",
    ],
    ambient_design: [
      { label: "Sieve Type", value: "Zeolite Molecular Sieve" },
      { label: "Output Purity", value: "90–96% O₂ – configurable" },
      { label: "Flow Range", value: "1–5,000 Nm³/hr" },
      { label: "Delivery Pressure", value: "5.5 barg (higher pressures available on demand)" },
      { label: "Sieve Performance Warranty", value: "10-year warranty" },
      { label: "Air-to-Oxygen Ratio", value: "Industry-leading – lowest in class" },
      { label: "Operation", value: "Continuous 24×7 industrial duty" },
      { label: "Control System", value: "HD touchscreen HMI with PLC automation" },
      { label: "Remote Monitoring", value: "IIoT-enabled remote access*" },
      { label: "Quality System", value: "Manufactured under ISO 13485:2016 (TÜV Nord)" },
    ],
  },

  IDOS_C: {
    family_key: "IDOS_C",
    family_name: "Idos C",
    title: "Affordable PSA Industrial Oxygen Generator – Idos C",
    tagline: "Plug-and-play on-site oxygen for SMEs, MSMEs, and OEMs",
    source_url: "https://absstem.com/custom-psa-industrial-oxygen-generator/",
    write_up:
      "Absstem’s Idos C is the affordable, plug-and-play industrial oxygen generator designed for SMEs, MSMEs, and OEMs that need reliable on-site oxygen at a lower investment and faster commissioning than a full-scale custom system. Launched in 2024, Idos C delivers the core benefits of Idos – continuous on-site oxygen, lowest air-to-gas ratio, IIoT monitoring*, and 10-year sieve warranty – at a price point accessible for small-scale businesses. The C Series format means Idos C arrives pre-configured and ready to connect, with no complex civil work and readiness within about 60 minutes for most installations.",
    unique_features: [
      "Affordable entry to on-site PSA oxygen without full-scale plant complexity",
      "Ready in ~60 minutes for most installations – pre-configured plug-and-play format",
      "90–96% purity at 1–500 Nm³/hr for SME-scale process needs",
      "Same 10-year sieve warranty and IIoT monitoring* pathway as full-scale Idos",
      "Energy-efficient PSA design with Absstem Shield AMC/CMC support",
      "PESO licence not required for the PSA generator",
    ],
    ambient_design: [
      { label: "Oxygen Purity", value: "90–96%" },
      { label: "Flow Range", value: "1–500 Nm³/hr" },
      { label: "Delivery Pressure", value: "5.5 barg (higher pressures available on demand)" },
      { label: "Commissioning", value: "Ready within ~60 minutes for most installations" },
      { label: "Sieve Warranty", value: "10 years performance warranty" },
      { label: "Operation", value: "Continuous 24×7" },
      { label: "Remote Monitoring", value: "IIoT-enabled*: purity, pressure, flow, sieve" },
      { label: "Format", value: "Plug-and-play, pre-configured – minimal civil work" },
    ],
  },

  SHIELD: {
    family_key: "SHIELD",
    family_name: "Absstem Shield",
    title: "Absstem Shield – AMC & CMC for PSA Oxygen & Nitrogen Plants",
    tagline: "Manufacturer-grade maintenance for PSA plants – Absstem-built or multi-brand",
    source_url: "https://absstem.com/shield/",
    write_up:
      "Absstem Shield provides manufacturer-grade maintenance for PSA oxygen and nitrogen generators — Absstem-built or not. Hospitals and industries across India trust Shield for preventive care, genuine spares, breakdown response, and IIoT-powered remote monitoring. Shield works on any PSA plant after a free plant health assessment. Both Shield (AMC) and Shield Premium (CMC) are built on certified engineers, genuine spares, and scheduled preventive care – with CMC adding all-inclusive breakdown spare coverage, root-cause analysis, priority dispatch, and audit-ready IQ/OQ documentation.",
    unique_features: [
      "4 quarterly preventive maintenance visits per year (customisable scheduling)",
      "IIoT real-time remote monitoring* of purity, pressure, flow, compressor status, run hours, and temperature",
      "Telephonic/remote support within 2–6 hours; on-site CMC response typically 48 hours",
      "Multi-brand coverage – OEM or non-OEM PSA plants after health assessment",
      "Shield Premium: breakdown spares in scope, RCA, post-repair performance test, priority dispatch, IQ/OQ docs",
      "10-year molecular sieves warranty when sieves are replaced by Absstem under CMC",
      "Pan-India service network across 24 states & 6 UTs; 300+ trusted installations",
    ],
    ambient_design: [
      { label: "Preventive Visits", value: "4 quarterly PM visits per year" },
      { label: "Remote Support SLA", value: "Telephonic response within 2–6 hours" },
      { label: "On-site CMC Response", value: "Typically 48 hours (CMC) / up to 72 hours (AMC context)" },
      { label: "IIoT Parameters*", value: "Purity %, output pressure, flow (Nm³/hr), compressor status/alarms, run hours, temperature" },
      { label: "Plant Coverage", value: "Multi-brand PSA oxygen & nitrogen generators" },
      { label: "Sieve Warranty (CMC path)", value: "10-year molecular sieves warranty if replaced by Absstem under CMC" },
      { label: "Compliance Support", value: "Service history, IQ/OQ records, annual purity lab certification pathway" },
    ],
  },

  AIR_SYSTEM: {
    family_key: "AIR_SYSTEM",
    family_name: "Compressed Air System",
    title: "Compressed Air System – Feed Air Package",
    tagline: "Integrated compressor, dryer, and filtration package sized to the PSA plant duty",
    write_up:
      "The Compressed Air System is the feed-air package for the PSA generator. It supplies clean, dry compressed air at the pressure and flow required by the adsorber beds, protecting molecular sieves from oil and moisture while enabling stable purity and continuous plant operation. The package comprises the air compressor with dryer and multi-stage filtration, matched to the dry-air requirement of the offered generator.",
    unique_features: [
      "Matched to the dry-air requirement of the offered generator at the selected purity and flow",
      "Multi-stage filtration and dryer protect the molecular sieves from oil and moisture",
      "Supports continuous 24×7 duty with automatic idle and restart",
      "Oil-free or oil-lubricated compressor options to suit process, food or pharma requirements",
    ],
    ambient_design: [
      { label: "Role in Package", value: "Feed-air supply to PSA adsorber vessels" },
      { label: "Scope", value: "Air compressor, dryer and multi-stage filtration (air receiver where quoted)" },
      { label: "Inlet Air Quality", value: "Dry, filtered air with PSA inlet dew point maintained by the dryer" },
      { label: "Duty", value: "Continuous 24×7 plant duty" },
    ],
  },

  GAS_STORAGE: {
    family_key: "GAS_STORAGE",
    family_name: "Gas Storage Vessel",
    title: "Gas Storage Vessel – Product Buffer Storage",
    tagline: "Pressurised nitrogen / oxygen buffer storage for stable delivery pressure and flow",
    write_up:
      "Gas Storage Vessels provide the product-gas buffer between the PSA generator and the customer process or pipeline. Correct storage volume smooths purity and pressure during adsorption cycle swings, supports peak draw, and improves overall package reliability. Storage capacity is matched to the recommended storage volume for the offered generator and may be supplied as one or more vessels.",
    unique_features: [
      "Storage capacity matched to the recommended volume for the offered generator",
      "Stabilises delivery pressure and flow during PSA cycle transitions and demand peaks",
      "Rated vessels with safety accessories as per the offered scope",
      "Works with generator controls and optional high-pressure booster where quoted",
    ],
    ambient_design: [
      { label: "Role in Package", value: "Product nitrogen/oxygen buffer storage" },
      { label: "Configuration", value: "Single vessel or multiple vessels to meet the required storage volume" },
      { label: "Integration", value: "Between PSA outlet and process / booster / pipeline" },
    ],
  },

  BOOSTER: {
    family_key: "BOOSTER",
    family_name: "High-Pressure Booster",
    title: "High-Pressure Booster – Elevated Delivery Pressure Stage",
    tagline: "Optional booster stage for laser cutting, pressure testing, and high-pressure process duty",
    write_up:
      "A High-Pressure Booster is an optional package stage used when process demand exceeds the standard PSA delivery pressure band. On Absstem nitrogen packages this is commonly selected for laser cutting, pressure testing, and other high-pressure applications (typically in the 15–40 bar class, application-dependent). The booster takes product gas from the PSA / storage train and elevates pressure to the required process setpoint while preserving the upstream purity produced by the generator.",
    unique_features: [
      "Enables high-pressure delivery beyond standard PSA outlet pressure (application-dependent, often 15–40 bar class)",
      "Commonly applied for laser cutting, pressure testing, and elevated-pressure process lines",
      "Preserves upstream PSA purity while raising delivery pressure to process requirement",
      "Integrates with storage buffer and package safety / control philosophy",
    ],
    ambient_design: [
      { label: "Role in Package", value: "Optional high-pressure elevation stage after PSA / storage" },
      { label: "Typical Applications", value: "Laser cutting, pressure testing, high-pressure process supply" },
      { label: "Indicative Pressure Band", value: "Often 15–40 bar class (exact rating per selected booster model)" },
      { label: "Feed Source", value: "Product gas from PSA generator and gas storage train" },
    ],
  },
});

function normalizeFamilyKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function detectFamilyKeyFromText(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "";
  if (/\bshield\b/.test(text) && !/\bmedo\b|\bidos\b|\bngen\b/.test(text)) return "SHIELD";
  if (/\bmedo[\s_-]?c\b|\bmedo\s*c\b/.test(text)) return "MEDO_C";
  if (/\bmedo\b/.test(text)) return "MEDO";
  if (/\bidos[\s_-]?c\b|\bidos\s*c\b/.test(text)) return "IDOS_C";
  if (/\bidos\b/.test(text)) return "IDOS";
  if (/\bngenx\b/.test(text)) return "NGENX";
  if (/\bngen\b/.test(text)) return "NGEN";
  return "";
}

function cleanStringList(value) {
  return (Array.isArray(value) ? value : []).map((x) => String(x || "").trim()).filter(Boolean);
}

function cleanDesignRows(value) {
  return (Array.isArray(value) ? value : [])
    .map((row) => ({ label: String(row?.label || "").trim(), value: String(row?.value || "").trim() }))
    .filter((row) => row.label && row.value);
}

/**
 * Built-in family content with saved quote_family_content rows applied on top.
 * Only non-empty saved fields replace the built-in text.
 */
function buildFamilyContent(rows) {
  const content = {};
  for (const [key, entry] of Object.entries(FAMILY_BROCHURE_CONTENT)) content[key] = { ...entry };
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = normalizeFamilyKey(row?.content_key);
    if (!key || row?.is_active === false) continue;
    const next = { ...(content[key] || { family_key: key }) };
    for (const field of ["title", "tagline", "source_url", "write_up"]) {
      const v = String(row?.[field] || "").trim();
      if (v) next[field] = v;
    }
    const features = cleanStringList(row?.unique_features);
    if (features.length) next.unique_features = features;
    const design = cleanDesignRows(row?.design_rows);
    if (design.length) next.ambient_design = design;
    content[key] = next;
  }
  return content;
}

function mergeBrochureProfiles(baseKey, overlayKey, content = FAMILY_BROCHURE_CONTENT) {
  const base = content[baseKey];
  const overlay = overlayKey ? content[overlayKey] : null;
  if (!base && !overlay) return null;
  if (!overlay) return { ...base };
  return {
    ...base,
    ...overlay,
    family_key: base?.family_key || overlay.family_key,
    family_name: base?.family_name || overlay.family_name,
    source_url: overlay.source_url || base?.source_url,
    unique_features: Array.isArray(overlay.unique_features) && overlay.unique_features.length
      ? overlay.unique_features
      : base?.unique_features || [],
    ambient_design: Array.isArray(overlay.ambient_design) && overlay.ambient_design.length
      ? overlay.ambient_design
      : base?.ambient_design || [],
    write_up: overlay.write_up || base?.write_up || "",
    title: overlay.title || base?.title || "",
    tagline: overlay.tagline || base?.tagline || "",
  };
}

function lineSearchText(line) {
  return [
    line?.item_code,
    line?.item_name,
    line?.product_item_code,
    line?.product_item_name,
    line?.product_group_name,
    line?.product_category_name,
    line?.product_description,
  ]
    .filter(Boolean)
    .join(" ");
}

function detectPackageModuleKey(line) {
  const text = lineSearchText(line).toLowerCase();
  if (!text) return "";
  // Booster before air-system so "high pressure booster compressor" does not fall into AIR_SYSTEM.
  if (/booster|high[\s-]?pressure\s+booster|hp\s+booster/.test(text)) return "BOOSTER";
  if (/gas\s+storage|storage\s+vessel|nitrogen\s+storage|oxygen\s+storage|\bvessel\b|\btank\b/.test(text) && !/air\s+receiver|dry\s+air/.test(text)) {
    return "GAS_STORAGE";
  }
  if (/compressed\s+air|air\s+system|air\s+compressor|\bcompressor\b|air\s+receiver|dry\s+air/.test(text)) {
    return "AIR_SYSTEM";
  }
  if (/\bshield\b|amc|cmc/.test(text)) return "SHIELD";
  return "";
}

const MODULE_ROLE_TO_BROCHURE = Object.freeze({
  air_system: "AIR_SYSTEM",
  gas_storage: "GAS_STORAGE",
  booster: "BOOSTER",
  shield: "SHIELD",
});

function normalizeModuleRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * Resolve brochure profile for a quote line (generator family or package module).
 * Prefers Product Master family_key / module_role / variant_key; falls back to text detection.
 * @returns {object|null}
 */
function resolveFamilyBrochureProfile({ configuratorContext, line, content } = {}) {
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const source = content && typeof content === "object" ? content : FAMILY_BROCHURE_CONTENT;
  const lineText = lineSearchText(line);
  const explicitModule = normalizeModuleRole(line?.product_module_role || line?.module_role);
  const packageModule =
    MODULE_ROLE_TO_BROCHURE[explicitModule] || detectPackageModuleKey(line);

  if (packageModule === "AIR_SYSTEM") return mergeBrochureProfiles("AIR_SYSTEM", null, source);
  if (packageModule === "GAS_STORAGE") return mergeBrochureProfiles("GAS_STORAGE", null, source);
  if (packageModule === "BOOSTER") return mergeBrochureProfiles("BOOSTER", null, source);
  if (packageModule === "SHIELD") return mergeBrochureProfiles("SHIELD", null, source);

  let familyKey = normalizeFamilyKey(line?.product_family_key || line?.family_key);
  if (!familyKey) familyKey = normalizeFamilyKey(cfg.family_key);
  if (!familyKey) familyKey = detectFamilyKeyFromText(lineText);
  if (!familyKey) return null;

  // Only attach family brochure to generator-class lines, not accessories.
  if (explicitModule && explicitModule !== "generator") return null;
  if (!isCoreGeneratorLine(line, configuratorContext)) return null;

  const variantKey =
    normalizeFamilyKey(line?.product_variant_key || line?.variant_key || cfg.variant_key);

  if (familyKey === "NGEN") {
    if (variantKey === "UH" || /\buh\b|ultra/.test(String(lineText).toLowerCase())) {
      return mergeBrochureProfiles("NGEN", "NGEN_UH", source);
    }
    if (variantKey === "HF" || /\bhf\b|high[\s-]?flow/.test(String(lineText).toLowerCase())) {
      return mergeBrochureProfiles("NGEN", "NGEN_HF", source);
    }
    if (variantKey === "SH" || /\bsh\b/.test(String(lineText).toLowerCase())) {
      return mergeBrochureProfiles("NGEN", "NGEN_SH", source);
    }
    return mergeBrochureProfiles("NGEN", null, source);
  }

  if (source[familyKey]) {
    return mergeBrochureProfiles(familyKey, null, source);
  }

  return null;
}

function isCoreGeneratorLine(line, configuratorContext) {
  const explicitModule = normalizeModuleRole(line?.product_module_role || line?.module_role);
  if (explicitModule === "generator") return true;
  if (explicitModule && explicitModule !== "generator") return false;
  if (detectPackageModuleKey(line)) return false;
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const familyKey =
    normalizeFamilyKey(line?.product_family_key || line?.family_key) ||
    normalizeFamilyKey(cfg.family_key) ||
    detectFamilyKeyFromText(lineSearchText(line));
  const text = lineSearchText(line).toLowerCase();

  if (familyKey === "SHIELD") return /\bshield\b|amc|cmc/.test(text);
  if (familyKey === "NGEN" || familyKey === "NGENX") return /ngen|nitrogen/.test(text);
  if (familyKey === "MEDO" || familyKey === "MEDO_C") return /medo|medical\s+oxygen|oxygen\s+generator/.test(text);
  if (familyKey === "IDOS" || familyKey === "IDOS_C") return /idos|industrial\s+oxygen|oxygen\s+generator/.test(text);
  return /psa|generator|ngen|medo|idos/.test(text);
}

function brochureProfileKey(profile) {
  if (!profile) return "";
  return String(profile.family_key || profile.title || "").trim().toUpperCase();
}

module.exports = {
  FAMILY_BROCHURE_CONTENT,
  buildFamilyContent,
  resolveFamilyBrochureProfile,
  isCoreGeneratorLine,
  detectFamilyKeyFromText,
  detectPackageModuleKey,
  brochureProfileKey,
};
