/**
 * A band-major spectral cube. Pixel planes are stored contiguously:
 * data[band * width * height + y * width + x]. Wavelengths are in micrometers.
 */
export type SpectrumPoint = { wavelength: number; flux: number };
export type NoiseReductionMode = "off" | "standard" | "aggressive";

export type SkyStatistics = { median: number; sigma: number };

function medianOf(values: number[]) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** Robust background estimate using three rounds of 3-sigma clipping. */
export function sigmaClippedSky(values: ArrayLike<number>, iterations = 3): SkyStatistics {
  let sample = Array.from(values).filter(Number.isFinite);
  let center = medianOf([...sample]);
  let sigma = 0;
  for (let iteration = 0; iteration < iterations && sample.length; iteration++) {
    center = medianOf([...sample]);
    sigma = 1.4826 * medianOf(sample.map((value) => Math.abs(value - center)));
    if (!(sigma > 0)) break;
    const clipped = sample.filter((value) => Math.abs(value - center) <= 3 * sigma);
    if (!clipped.length || clipped.length === sample.length) break;
    sample = clipped;
  }
  center = medianOf([...sample]);
  sigma = 1.4826 * medianOf(sample.map((value) => Math.abs(value - center)));
  return { median: center, sigma: Number.isFinite(sigma) ? sigma : 0 };
}

/** Replace isolated >6-sigma spikes with the median of their eight neighbors. */
export function despeckleOutliers(values: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (!(sigma > 0) || width < 3 || height < 3) return values;
  const result = values.slice();
  const neighbors: number[] = [];
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const index = y * width + x;
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    neighbors.length = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const neighbor = values[(y + dy) * width + x + dx];
      if (Number.isFinite(neighbor)) neighbors.push(neighbor);
    }
    if (neighbors.length < 5) continue;
    const localMedian = medianOf([...neighbors]);
    if (value > localMedian + 6 * sigma) result[index] = localMedian;
  }
  return result;
}

/** Softly roll the sky floor to zero while retaining the signal above it. */
export function rollOffSky(value: number, sky: SkyStatistics, mode: NoiseReductionMode) {
  if (mode === "off" || !(sky.sigma > 0)) return Math.max(0, value - sky.median);
  const startSigma = mode === "aggressive" ? 3.5 : 2.5;
  const endSigma = mode === "aggressive" ? 6 : 4.5;
  const start = sky.median + startSigma * sky.sigma;
  const end = sky.median + endSigma * sky.sigma;
  const t = Math.max(0, Math.min(1, (value - start) / Math.max(end - start, Number.EPSILON)));
  const smooth = t * t * (3 - 2 * t);
  return Math.max(0, value - start) * smooth;
}

/** Prepare one image plane for a noise-reduced display, leaving Off untouched. */
export function prepareNoiseReducedPlane(values: Float32Array, width: number, height: number, mode: NoiseReductionMode) {
  if (mode === "off") return { values, sky: { median: 0, sigma: 0 } };
  const sky = sigmaClippedSky(values);
  return { values: despeckleOutliers(values, width, height, sky.sigma), sky };
}

export class SpectralCube {
  readonly width: number;
  readonly height: number;
  readonly bands: number;
  readonly data: Float32Array;
  readonly wavelengths: number[];

  constructor(width: number, height: number, bands: number, data: Float32Array, wavelengths: number[]) {
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new RangeError("Cube width and height must be positive integers.");
    }
    if (!Number.isInteger(bands) || bands < 1 || bands > 102) {
      throw new RangeError("Cube bands must be an integer from 1 to 102.");
    }
    if (data.length !== width * height * bands) {
      throw new RangeError("Cube data length must equal width × height × bands.");
    }
    if (wavelengths.length !== bands || wavelengths.some((value) => !Number.isFinite(value))) {
      throw new RangeError("Provide one finite wavelength for every band.");
    }
    this.width = width;
    this.height = height;
    this.bands = bands;
    this.data = data;
    this.wavelengths = [...wavelengths];
  }

  /** Sum one of six consecutive 17-band groups; a short final group is allowed. */
  getCoaddedArrayImage(arrayIndex: number): Float32Array {
    if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex > 5) {
      throw new RangeError("arrayIndex must be an integer from 0 to 5.");
    }
    const planeSize = this.width * this.height;
    const firstBand = arrayIndex * 17;
    const endBand = Math.min(firstBand + 17, this.bands);
    const result = new Float32Array(planeSize);
    for (let band = firstBand; band < endBand; band++) {
      const offset = band * planeSize;
      for (let pixel = 0; pixel < planeSize; pixel++) result[pixel] += this.data[offset + pixel];
    }
    return result;
  }

  /** Create a sky-subtracted, JWST-inspired false-color composite. */
  getRGBComposite(rArray: number, gArray: number, bArray: number, alphaArray?: number, noiseReduction: NoiseReductionMode = "off", displayOverrides?: ReadonlyMap<number, Float32Array>): Uint8ClampedArray {
    const channels = [rArray, gArray, bArray, ...(alphaArray === undefined ? [] : [alphaArray])].map((index) => {
      // Display-only epoch overlays let WISE morphology animate long-wave
      // false-color channels without altering this cube's measured spectra.
      const override = displayOverrides?.get(index);
      return override?.length === this.width * this.height ? override : this.getCoaddedArrayImage(index);
    });
    const median = (sorted: number[]) => {
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const percentile = (sorted: number[], fraction: number) => {
      if (!sorted.length) return 0;
      const position = (sorted.length - 1) * fraction;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
    };
    const planeSize = this.width * this.height;
    const rowCorrected = channels.map((values) => {
      const rowMedians = new Float64Array(this.height);
      for (let y = 0; y < this.height; y++) {
        const row = Array.from(values.slice(y * this.width, (y + 1) * this.width)).filter(Number.isFinite).sort((a, b) => a - b);
        rowMedians[y] = row.length ? median(row) : 0;
      }
      const sortedRows = [...rowMedians].sort((a, b) => a - b);
      const rowCenter = median(sortedRows);
      const corrected = new Float32Array(planeSize);
      for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
        const pixel = y * this.width + x;
        const value = values[pixel];
        corrected[pixel] = Number.isFinite(value) ? value - rowMedians[y] + rowCenter : NaN;
      }
      return noiseReduction === "off"
        ? corrected
        : prepareNoiseReducedPlane(corrected, this.width, this.height, noiseReduction).values;
    });
    const footprintFeathers = rowCorrected.map((values) => {
      const distances = new Uint8Array(planeSize);
      distances.fill(255);
      const queue = new Int32Array(planeSize);
      let head = 0;
      let tail = 0;
      for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
        const pixel = y * this.width + x;
        if (!Number.isFinite(values[pixel])) continue;
        let edge = false;
        for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height || !Number.isFinite(values[ny * this.width + nx])) {
            edge = true;
            break;
          }
        }
        if (edge) {
          distances[pixel] = 1;
          queue[tail++] = pixel;
        }
      }
      while (head < tail) {
        const pixel = queue[head++];
        const nextDistance = distances[pixel] + 1;
        if (nextDistance > 8) continue;
        const x = pixel % this.width;
        const y = Math.floor(pixel / this.width);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
          const neighbor = ny * this.width + nx;
          if (!Number.isFinite(values[neighbor]) || distances[neighbor] <= nextDistance) continue;
          distances[neighbor] = nextDistance;
          queue[tail++] = neighbor;
        }
      }
      return distances;
    });
    const stretches = rowCorrected.map((values) => {
      const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
      if (!sorted.length) return { background: 0, white: 0 };
      if (noiseReduction !== "off") {
        const sky = sigmaClippedSky(values);
        const rolled = sorted.map((value) => rollOffSky(value, sky, noiseReduction)).filter((value) => value > 0).sort((a, b) => a - b);
        return { background: sky.median, white: percentile(rolled, 0.996), sky, rolled: true };
      }
      const center = median(sorted);
      const deviations = sorted.map((value) => Math.abs(value - center)).sort((a, b) => a - b);
      const background = center + 2.5 * median(deviations);
      const aboveBackground = sorted.map((value) => Math.max(0, value - background)).filter((value) => value > 0);
      aboveBackground.sort((a, b) => a - b);
      return { background, white: percentile(aboveBackground, 0.996), sky: undefined, rolled: false };
    });
    const palette: Record<number, [number, number, number]> = {
      0: [0.16, 0.5, 1],
      1: [0.12, 0.62, 1],
      2: [0.38, 0.76, 1],
      3: [1, 0.78, 0.48],
      4: [1, 0.52, 0.16],
      5: [1, 0.35, 0.05],
    };
    const channelColors = [rArray, gArray, bArray].map((index, channel) =>
      palette[index] ?? ([[1, 0.2, 0.15], [0.3, 1, 0.35], [0.2, 0.45, 1]][channel] as [number, number, number]),
    );

    const rgba = new Uint8ClampedArray(planeSize * 4);
    const asinhScale = Math.asinh(6);
    for (let pixel = 0; pixel < planeSize; pixel++) {
      const normalized = [0, 1, 2].map((channel) => {
        const value = rowCorrected[channel][pixel];
        const { background, white, sky, rolled } = stretches[channel];
        const feather = Math.min(1, footprintFeathers[channel][pixel] / 8);
        const signal = Number.isFinite(value) && rolled && sky
          ? rollOffSky(value, sky, noiseReduction)
          : Math.max(0, value - background);
        return Number.isFinite(value) && white > 0 ? signal / white * feather : 0;
      });
      const linear = [0, 1, 2].map((outputChannel) =>
        normalized.reduce((sum, value, inputChannel) => sum + value * channelColors[inputChannel][outputChannel], 0),
      );
      const intensity = (linear[0] + linear[1] + linear[2]) / 3;
      const stretchedIntensity = intensity > 0 ? Math.asinh(intensity * 6) / asinhScale : 0;
      const scale = intensity > 0 ? stretchedIntensity / intensity : 0;
      const stretched = linear.map((value) => value * scale);
      const luminance = 0.2126 * stretched[0] + 0.7152 * stretched[1] + 0.0722 * stretched[2];
      for (let channel = 0; channel < 3; channel++) {
        const saturated = luminance + (stretched[channel] - luminance) * 1.35;
        rgba[pixel * 4 + channel] = Math.round(Math.max(0, Math.min(1, saturated)) * 255);
      }
      if (alphaArray === undefined) rgba[pixel * 4 + 3] = 255;
      else {
        const alphaValue = rowCorrected[3][pixel];
        const { background, white, sky, rolled } = stretches[3];
        const feather = Math.min(1, footprintFeathers[3][pixel] / 8);
        const alphaSignal = Number.isFinite(alphaValue) && rolled && sky
          ? rollOffSky(alphaValue, sky, noiseReduction)
          : Math.max(0, alphaValue - background);
        const alpha = Number.isFinite(alphaValue) && white > 0 ? Math.max(0, Math.min(1, alphaSignal / white * feather)) : 0;
        rgba[pixel * 4 + 3] = Math.round(alpha * 255);
      }
    }
    // A light separable 3×3 Gaussian removes diagonal aliasing from detector
    // resampling without noticeably enlarging point sources.
    const smoothed = new Uint8ClampedArray(rgba.length);
    const kernel = [1, 2, 1];
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      const destination = (y * this.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let total = 0;
        let weight = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
          const sampleWeight = kernel[dx + 1] * kernel[dy + 1];
          total += rgba[(ny * this.width + nx) * 4 + channel] * sampleWeight;
          weight += sampleWeight;
        }
        smoothed[destination + channel] = Math.round(total / weight);
      }
      smoothed[destination + 3] = 255;
    }
    return smoothed;
  }

  extractSpectrum(centerX: number, centerY: number, apertureRadius = 3, skyInner = 5, skyOuter = 8): SpectrumPoint[] {
    if (![centerX, centerY, apertureRadius, skyInner, skyOuter].every(Number.isFinite) || apertureRadius < 0 || skyInner < 0 || skyOuter <= skyInner) {
      throw new RangeError("Provide a finite center, a nonnegative aperture, and skyOuter > skyInner.");
    }
    const minX = Math.max(0, Math.floor(centerX - skyOuter));
    const maxX = Math.min(this.width - 1, Math.ceil(centerX + skyOuter));
    const minY = Math.max(0, Math.floor(centerY - skyOuter));
    const maxY = Math.min(this.height - 1, Math.ceil(centerY + skyOuter));
    const apertureRadiusSq = apertureRadius ** 2;
    const skyInnerSq = skyInner ** 2;
    const skyOuterSq = skyOuter ** 2;
    const aperturePixels: number[] = [];
    const skyPixels: number[] = [];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const distanceSq = (x - centerX) ** 2 + (y - centerY) ** 2;
      if (distanceSq <= apertureRadiusSq) aperturePixels.push(y * this.width + x);
      else if (distanceSq >= skyInnerSq && distanceSq <= skyOuterSq) skyPixels.push(y * this.width + x);
    }
    const median = (values: number[]) => {
      if (!values.length) return 0;
      values.sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    };
    const planeSize = this.width * this.height;
    return this.wavelengths.map((wavelength, band) => {
      const offset = band * planeSize;
      let sum = 0;
      let validAperturePixels = 0;
      for (const pixel of aperturePixels) {
        const value = this.data[offset + pixel];
        if (Number.isFinite(value)) { sum += value; validAperturePixels++; }
      }
      const background = median(skyPixels.map((pixel) => this.data[offset + pixel]).filter(Number.isFinite));
      return { wavelength, flux: sum - background * validAperturePixels };
    });
  }
}
