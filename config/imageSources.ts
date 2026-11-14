export type ImageSourceProtocol = "irsa-ibe" | "hips2fits" | "sia-v2" | "direct-fits";
export type ImageSourceAgency = "NASA/IRSA" | "CDS/ESA" | "Custom";

export type ImageSource = {
  id: string;
  name: string;
  agency: ImageSourceAgency;
  wavelengthRange: string;
  protocol: ImageSourceProtocol;
  endpointUrl: string;
  bands: string[];
  enabled: boolean;
  supportsTimeSeries: boolean;
};

export const BUILT_IN_IMAGE_SOURCES: ImageSource[] = [
  {
    id: "wise-neowise",
    name: "NASA WISE / NEOWISE",
    agency: "NASA/IRSA",
    wavelengthRange: "3.4–22 µm",
    protocol: "irsa-ibe",
    endpointUrl: "https://irsa.ipac.caltech.edu/ibe/",
    bands: ["W1", "W2", "W3", "W4"],
    enabled: true,
    supportsTimeSeries: true,
  },
  {
    id: "dss2-optical",
    name: "DSS2 Optical Survey",
    agency: "CDS/ESA",
    wavelengthRange: "0.4–0.9 µm",
    protocol: "hips2fits",
    endpointUrl: "CDS/P/DSS2",
    bands: ["color", "red", "blue"],
    enabled: true,
    supportsTimeSeries: false,
  },
  {
    id: "spherex-archive",
    name: "NASA SPHEREx Archive",
    agency: "NASA/IRSA",
    wavelengthRange: "0.75–5.0 µm",
    protocol: "sia-v2",
    endpointUrl: "https://irsa.ipac.caltech.edu/SIA",
    bands: ["Array 1–6"],
    enabled: true,
    supportsTimeSeries: false,
  },
];

const STORAGE_KEY = "stella.image-sources.v1";

export function loadImageSources(): ImageSource[] {
  if (typeof window === "undefined") return BUILT_IN_IMAGE_SOURCES.map((source) => ({ ...source, bands: [...source.bands] }));
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(parsed)) return BUILT_IN_IMAGE_SOURCES.map((source) => ({ ...source, bands: [...source.bands] }));
    // Drop the retired 2MASS HiPS source from older local registries. The CDS
    // endpoint was returning 404s for these requests in the current setup.
    const saved = parsed.filter((source): source is ImageSource => isImageSource(source) && source.id !== "2mass-near-ir");
    const savedById = new Map(saved.map((source) => [source.id, source]));
    const mergedBuiltins = BUILT_IN_IMAGE_SOURCES.map((source) => {
      const stored = savedById.get(source.id);
      savedById.delete(source.id);
      return stored ? { ...source, enabled: stored.enabled } : { ...source, bands: [...source.bands] };
    });
    return [...mergedBuiltins, ...savedById.values()];
  } catch {
    return BUILT_IN_IMAGE_SOURCES.map((source) => ({ ...source, bands: [...source.bands] }));
  }
}

export function saveImageSources(sources: ImageSource[]) {
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
}

function isImageSource(value: unknown): value is ImageSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<ImageSource>;
  return typeof source.id === "string" && typeof source.name === "string" &&
    typeof source.agency === "string" && typeof source.wavelengthRange === "string" &&
    ["irsa-ibe", "hips2fits", "sia-v2", "direct-fits"].includes(source.protocol ?? "") &&
    typeof source.endpointUrl === "string" && Array.isArray(source.bands) &&
    source.bands.every((band) => typeof band === "string") &&
    typeof source.enabled === "boolean" && typeof source.supportsTimeSeries === "boolean";
}
