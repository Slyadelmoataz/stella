import { SpectralCube } from "./spectralCube";

export type SedSource = {
  name: string;
  ra: number;
  dec: number;
  objectType?: string;
  spectralType?: string;
};

export function createOfflineModelSources(centerRa: number, centerDec: number, fieldSizeDeg: number): SedSource[] {
  const positions = [
    [0.18, 0.2], [0.72, 0.18], [0.48, 0.34], [0.29, 0.58],
    [0.78, 0.49], [0.58, 0.76], [0.16, 0.82], [0.88, 0.78],
    [0.42, 0.9], [0.91, 0.31], [0.33, 0.38], [0.67, 0.63],
  ];
  const spectralTypes = ["K3", "M2", "G8", "A5", "F2", "M5", "K1", "G2", "F8", "M1", "K5", "G5"];
  return positions.map(([x, y], index) => ({
    name: `Offline model star ${String(index + 1).padStart(2, "0")}`,
    ra: ((centerRa + (0.5 - x) * fieldSizeDeg / Math.max(Math.cos(centerDec * Math.PI / 180), 0.01)) % 360 + 360) % 360,
    dec: centerDec + (0.5 - y) * fieldSizeDeg,
    objectType: "Star (modeled)",
    spectralType: spectralTypes[index],
  }));
}

const ARRAY_LIMITS: Array<[number, number]> = [
  [0.75, 1.11], [1.11, 1.64], [1.64, 2.42],
  [2.42, 3.82], [3.82, 4.42], [4.42, 5.0],
];

function getTemperature(source: SedSource) {
  const classText = `${source.spectralType ?? ""} ${source.objectType ?? ""} ${source.name}`.toLowerCase();
  if (/085510|0855|y\s*\d|y dwarf|brown dwarf/.test(classText)) {
    const subtype = classText.match(/\by\s*([0-9])/i);
    return subtype ? Math.max(250, 450 - Number(subtype[1]) * 35) : 250;
  }
  if (/\bt\s*\d/.test(classText)) return 1100;
  if (/\bl\s*\d/.test(classText)) return 1800;
  if (/m\s*\d/.test(classText)) return 3200;
  if (/k\s*\d/.test(classText)) return 4700;
  if (/a\s*\d/.test(classText)) return 8500;
  return 5200;
}

function modelSed(source: SedSource, wavelength: number) {
  const classification = `${source.spectralType ?? ""} ${source.objectType ?? ""} ${source.name}`.toLowerCase();
  if (/qso|quasar|agn/.test(classification)) return wavelength ** -1.5;

  const temperature = getTemperature(source);
  // Planck B_lambda shape; values are normalized later for the display cube.
  const exponent = Math.min(700, 14_387.77 / (wavelength * temperature));
  let flux = 1 / (wavelength ** 5 * Math.expm1(exponent));
  if (/\by\s*\d|\bt\s*\d|y dwarf|brown dwarf|0855/.test(classification)) {
    const water = Math.exp(-0.5 * ((wavelength - 3.0) / 0.16) ** 2);
    const methane = Math.exp(-0.5 * ((wavelength - 3.3) / 0.11) ** 2);
    const carbonDioxide = Math.exp(-0.5 * ((wavelength - 4.25) / 0.10) ** 2);
    flux *= 1 - 0.42 * water - 0.55 * methane - 0.22 * carbonDioxide;
  }
  return flux;
}

/**
 * Creates an explicitly illustrative SED cube using WISE display morphology
 * and SIMBAD classifications. It is not a calibrated scientific product.
 */
export function synthesizeCubeFromWise(
  width: number,
  height: number,
  wiseSpatial: Float32Array,
  sources: SedSource[],
  centerRa: number,
  centerDec: number,
  fieldSizeDeg: number,
) {
  if (wiseSpatial.length !== width * height) throw new RangeError("WISE spatial image dimensions do not match its pixels.");
  const bands = 102;
  const wavelengths = ARRAY_LIMITS.flatMap(([min, max]) =>
    Array.from({ length: 17 }, (_, channel) => min + (channel + 0.5) / 17 * (max - min)),
  );
  const planeSize = width * height;
  const cubeData = new Float32Array(planeSize * bands);
  const sourcePixels = sources.map((source) => {
    const deltaRa = ((source.ra - centerRa + 540) % 360) - 180;
    return {
      ...source,
      x: width / 2 - deltaRa * Math.cos(centerDec * Math.PI / 180) / fieldSizeDeg * width,
      y: height / 2 - (source.dec - centerDec) / fieldSizeDeg * height,
    };
  }).filter((source) => source.x >= -4 && source.x < width + 4 && source.y >= -4 && source.y < height + 4);

  const sedNorms = sourcePixels.map((source) => Math.max(...wavelengths.map((wavelength) => modelSed(source, wavelength)), Number.EPSILON));
  for (let band = 0; band < bands; band++) {
    const wavelength = wavelengths[band];
    const planeOffset = band * planeSize;
    const backgroundShape = Math.max(0.08, 0.75 + 0.08 * Math.log(wavelength / 2.5));
    for (let pixel = 0; pixel < planeSize; pixel++) {
      const spatial = Math.max(0, Math.min(1, wiseSpatial[pixel]));
      const deterministicNoise = ((((pixel + 1) * 2_654_435_761 + (band + 1) * 97_531) >>> 0) / 4_294_967_295 - 0.5) * 0.004;
      cubeData[planeOffset + pixel] = spatial * backgroundShape * 0.08 + deterministicNoise;
    }
    for (let sourceIndex = 0; sourceIndex < sourcePixels.length; sourceIndex++) {
      const source = sourcePixels[sourceIndex];
      const sed = modelSed(source, wavelength) / sedNorms[sourceIndex];
      const minX = Math.max(0, Math.floor(source.x - 4));
      const maxX = Math.min(width - 1, Math.ceil(source.x + 4));
      const minY = Math.max(0, Math.floor(source.y - 4));
      const maxY = Math.min(height - 1, Math.ceil(source.y + 4));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const profile = Math.exp(-((x - source.x) ** 2 + (y - source.y) ** 2) / (2 * 1.15 ** 2));
        cubeData[planeOffset + y * width + x] += profile * sed;
      }
    }
  }
  return new SpectralCube(width, height, bands, cubeData, wavelengths);
}
