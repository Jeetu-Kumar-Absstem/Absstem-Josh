const OXYGEN_PACKAGE_DATA = [
  { model: "IDOS 01 B", storageVolume: 500, airVesselVolume: 200 },
  { model: "IDOS 02 B", storageVolume: 500, airVesselVolume: 200 },
  { model: "IDOS 03 B", storageVolume: 500, airVesselVolume: 250 },
  { model: "IDOS 04 B", storageVolume: 1000, airVesselVolume: 300 },
  { model: "IDOS 05 B", storageVolume: 1250, airVesselVolume: 500 },
  { model: "IDOS 06 B", storageVolume: 1250, airVesselVolume: 500 },
  { model: "IDOS 07 B", storageVolume: 1500, airVesselVolume: 500 },
  { model: "IDOS 09 B", storageVolume: 2000, airVesselVolume: 750 },
  { model: "IDOS 12.5 B", storageVolume: 2500, airVesselVolume: 1000 },
  { model: "IDOS 15 B", storageVolume: 3000, airVesselVolume: 1250 },
  { model: "IDOS 18 B", storageVolume: 3500, airVesselVolume: 1500 },
  { model: "IDOS 22 B", storageVolume: 4000, airVesselVolume: 2000 },
  { model: "IDOS 25 B", storageVolume: 5000, airVesselVolume: 2000 },
  { model: "IDOS 30 B", storageVolume: 6000, airVesselVolume: 2500 },
  { model: "IDOS 40 B", storageVolume: 7000, airVesselVolume: 3000 },
  { model: "IDOS 45 B", storageVolume: 8000, airVesselVolume: 3500 },
  { model: "IDOS 50 B", storageVolume: 10000, airVesselVolume: 4000 },
  { model: "IDOS 60 B", storageVolume: 13000, airVesselVolume: 5000 },
  { model: "IDOS 75 B", storageVolume: 15000, airVesselVolume: 6000 },
  { model: "IDOS 90 B", storageVolume: 20000, airVesselVolume: 8000 },
  { model: "IDOS 110 B", storageVolume: 20000, airVesselVolume: 8000 },
  { model: "IDOS 130 B", storageVolume: 25000, airVesselVolume: 10000 },
  { model: "IDOS 150 B", storageVolume: 30000, airVesselVolume: 12000 },
  { model: "IDOS 200 B", storageVolume: 40000, airVesselVolume: 16000 },
  { model: "IDOS 250 B", storageVolume: 50000, airVesselVolume: 20000 },
  { model: "IDOS 2C", storageVolume: 500, airVesselVolume: 200 },
  { model: "IDOS 3C", storageVolume: 500, airVesselVolume: 250 },
  { model: "IDOS 4C", storageVolume: 1000, airVesselVolume: 300 },
  { model: "IDOS 5C", storageVolume: 1250, airVesselVolume: 500 },
  { model: "IDOS 7C", storageVolume: 1500, airVesselVolume: 500 },
  { model: "IDOS 9C", storageVolume: 2000, airVesselVolume: 750 },
  { model: "IDOS 12.5C", storageVolume: 2500, airVesselVolume: 1000 },
  { model: "IDOS 15 C", storageVolume: 3000, airVesselVolume: 1250 },
  { model: "IDOS 18 C", storageVolume: 3500, airVesselVolume: 1500 },
  { model: "IDOS 20 C", storageVolume: 4000, airVesselVolume: 2000 },
  { model: "IDOS 25 C", storageVolume: 5000, airVesselVolume: 2000 },
  { model: "IDOS 30 C", storageVolume: 6000, airVesselVolume: 2500 },
];

function normalizeOxygenModelKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

const OXYGEN_PACKAGE_BY_MODEL = new Map(
  OXYGEN_PACKAGE_DATA.map((row) => [normalizeOxygenModelKey(row.model), row])
);

module.exports = {
  OXYGEN_PACKAGE_DATA,
  OXYGEN_PACKAGE_BY_MODEL,
  normalizeOxygenModelKey,
};
