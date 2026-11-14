"use client";

import { useEffect, useRef, useState } from "react";
// Import only the browser-safe parser modules. jsfitsio's package entry point
// also imports its optional Node filesystem reader, which Next cannot bundle
// into a client component.
import { ParseHeader } from "../../node_modules/jsfitsio/lib-esm/ParseHeader.js";
import { ParsePayload } from "../../node_modules/jsfitsio/lib-esm/ParsePayload.js";
import { prepareNoiseReducedPlane, rollOffSky, type NoiseReductionMode, type SpectralCube, type SpectrumPoint } from "../../utils/spectralCube";

type FitsImage = {
  width: number;
  height: number;
  pixels: ArrayLike<number | bigint>;
  bscale: number;
  bzero: number;
  crpix1: number | null;
  crpix2: number | null;
  wcs: Wcs | null;
};

const parsedImageCache = new WeakMap<ArrayBuffer, FitsImage>();

type Wcs = {
  projection: "SIN" | "TAN";
  crval1: number;
  crval2: number;
  crpix1: number;
  crpix2: number;
  cd11: number;
  cd12: number;
  cd21: number;
  cd22: number;
  sipA: SipTerm[];
  sipB: SipTerm[];
};

type SipTerm = { i: number; j: number; coefficient: number };

function getImageHdu(bytes: Uint8Array): FitsImage {
  const blockSize = ParseHeader.BLOCK_SIZE;
  let offset = 0;

  while (offset < bytes.byteLength) {
    const header = ParseHeader.parse(bytes, offset);
    const headerLength = ParseHeader.getHeaderByteLength(bytes, offset);
    const dataOffset = offset + headerLength;
    const axes = ParseHeader.getFITSItemValue(header, "NAXIS");
    const bitpix = ParseHeader.getFITSItemValue(header, "BITPIX");
    if (axes === null || bitpix === null || axes < 0 || axes > 9) {
      throw new Error("The FITS file has an invalid image header.");
    }

    const shape: number[] = [];
    for (let axis = 1; axis <= axes; axis++) {
      const length = ParseHeader.getFITSItemValue(header, `NAXIS${axis}`);
      if (length === null || length < 0) throw new Error("The FITS file has invalid image dimensions.");
      shape.push(length);
    }

    const elementCount = shape.reduce((total, length) => total * length, axes === 0 ? 0 : 1);
    const pcount = ParseHeader.getFITSItemValue(header, "PCOUNT") ?? 0;
    const gcount = ParseHeader.getFITSItemValue(header, "GCOUNT") ?? 1;
    const dataLength = (elementCount * Math.abs(bitpix) / 8 + pcount) * gcount;
    if (!Number.isSafeInteger(dataLength) || dataLength < 0 || dataOffset + dataLength > bytes.byteLength) {
      throw new Error("The FITS data unit is incomplete or too large to read.");
    }

    const extension = ParseHeader.getFITSItemStringValue(header, "XTENSION")?.trim().toUpperCase();
    const hasImage = (offset === 0 || extension === "IMAGE") && shape.length >= 2 && elementCount > 0;
    if (hasImage) {
      ParsePayload.assertSupportedBITPIX(bitpix);
      const width = shape[0];
      const height = shape[1];
      const payload = bytes.subarray(dataOffset, dataOffset + dataLength);
      const pixels = ParsePayload.createTypedArray(payload, bitpix) as ArrayLike<number | bigint>;
      if (pixels.length < width * height) throw new Error("The FITS image data does not match its dimensions.");
      const get = (key: string) => ParseHeader.getFITSItemValue(header, key);
      const crval1 = get("CRVAL1");
      const crval2 = get("CRVAL2");
      const crpix1 = get("CRPIX1");
      const crpix2 = get("CRPIX2");
      const ctype1 = ParseHeader.getFITSItemStringValue(header, "CTYPE1")?.toUpperCase() ?? "";
      // WISE exports its legacy scale/rotation cards with a W prefix. Treat
      // WCDELT/WCROTA as the equivalent linear WCS cards when CD/PC is absent.
      const cdelt1 = get("CDELT1") ?? get("WCDELT1");
      const cdelt2 = get("CDELT2") ?? get("WCDELT2");
      const directCd11 = get("CD1_1");
      const directCd12 = get("CD1_2");
      const directCd21 = get("CD2_1");
      const directCd22 = get("CD2_2");
      // Older survey FITS headers often encode detector rotation in CROTA2
      // instead of the newer PC/CD matrix. Ignoring CROTA leaves every frame
      // tilted by the scan angle even though its sky projection is valid.
      const crota = (get("CROTA2") ?? get("CROTA1") ?? get("WCROTA2") ?? 0) * Math.PI / 180;
      const hasPcMatrix = ["PC1_1", "PC1_2", "PC2_1", "PC2_2"].some((key) => get(key) !== null);
      const pc11 = get("PC1_1") ?? (hasPcMatrix ? 1 : Math.cos(crota));
      const pc12 = get("PC1_2") ?? (hasPcMatrix ? 0 : -Math.sin(crota));
      const pc21 = get("PC2_1") ?? (hasPcMatrix ? 0 : Math.sin(crota));
      const pc22 = get("PC2_2") ?? (hasPcMatrix ? 1 : Math.cos(crota));
      const orderA = Math.min(9, get("A_ORDER") ?? 0);
      const orderB = Math.min(9, get("B_ORDER") ?? 0);
      const sipA: SipTerm[] = [];
      const sipB: SipTerm[] = [];
      for (let i = 0; i <= orderA; i++) for (let j = 0; j <= orderA - i; j++) {
        const coefficient = get(`A_${i}_${j}`) ?? 0;
        if (coefficient) sipA.push({ i, j, coefficient });
      }
      for (let i = 0; i <= orderB; i++) for (let j = 0; j <= orderB - i; j++) {
        const coefficient = get(`B_${i}_${j}`) ?? 0;
        if (coefficient) sipB.push({ i, j, coefficient });
      }
      const cd11 = directCd11 ?? (cdelt1 === null ? null : cdelt1 * pc11);
      const cd12 = directCd12 ?? (cdelt1 === null ? null : cdelt1 * pc12);
      const cd21 = directCd21 ?? (cdelt2 === null ? null : cdelt2 * pc21);
      const cd22 = directCd22 ?? (cdelt2 === null ? null : cdelt2 * pc22);
      const determinant = cd11 !== null && cd12 !== null && cd21 !== null && cd22 !== null
        ? cd11 * cd22 - cd12 * cd21
        : 0;
      const projection: Wcs["projection"] = ctype1.includes("SIN") ? "SIN" : "TAN";
      const wcs = crval1 !== null && crval2 !== null && crpix1 !== null && crpix2 !== null &&
        cd11 !== null && cd12 !== null && cd21 !== null && cd22 !== null && Math.abs(determinant) > 1e-15
        ? { projection, crval1, crval2, crpix1, crpix2, cd11, cd12, cd21, cd22, sipA, sipB }
        : null;
      return {
        width,
        height,
        pixels,
        bscale: ParseHeader.getFITSItemValue(header, "BSCALE") ?? 1,
        bzero: ParseHeader.getFITSItemValue(header, "BZERO") ?? 0,
        crpix1,
        crpix2,
        wcs,
      };
    }

    offset = dataOffset + Math.ceil(dataLength / blockSize) * blockSize;
  }

  throw new Error("No two-dimensional image HDU was found in this FITS file.");
}

function evaluateSip(coefficients: SipTerm[], x: number, y: number) {
  let sum = 0;
  for (const term of coefficients) sum += term.coefficient * x ** term.i * y ** term.j;
  return sum;
}

function inputPixelForSky(raDeg: number, decDeg: number, wcs: Wcs) {
  const radians = Math.PI / 180;
  const ra = raDeg * radians;
  const dec = decDeg * radians;
  const ra0 = wcs.crval1 * radians;
  const dec0 = wcs.crval2 * radians;
  const deltaRa = Math.atan2(Math.sin(ra - ra0), Math.cos(ra - ra0));
  const denominator = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(deltaRa);
  if (wcs.projection === "TAN" && denominator <= 0) return null;

  // NEOWISE frames use RA---SIN-SIP / DEC--SIN-SIP. Applying the TAN
  // projection equations to those frames shifts the sky grid and can move
  // the requested target off the output canvas.
  const xi = (wcs.projection === "SIN"
    ? Math.cos(dec) * Math.sin(deltaRa)
    : Math.cos(dec) * Math.sin(deltaRa) / denominator) / radians;
  const eta = (wcs.projection === "SIN"
    ? Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(deltaRa)
    : (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(deltaRa)) / denominator) / radians;
  const determinant = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
  const linearX = (wcs.cd22 * xi - wcs.cd12 * eta) / determinant;
  const linearY = (-wcs.cd21 * xi + wcs.cd11 * eta) / determinant;
  let x = linearX;
  let y = linearY;
  for (let iteration = 0; iteration < 4; iteration++) {
    x = linearX - evaluateSip(wcs.sipA, x, y);
    y = linearY - evaluateSip(wcs.sipB, x, y);
  }
  return { x: wcs.crpix1 - 1 + x, y: wcs.crpix2 - 1 + y };
}

function skyAtOutputPixel(x: number, y: number, width: number, height: number, centerRa: number, centerDec: number, fieldSizeDeg: number) {
  const radians = Math.PI / 180;
  const xi = ((width / 2 - x - 0.5) * fieldSizeDeg / width) * radians;
  const eta = ((height / 2 - y - 0.5) * fieldSizeDeg / height) * radians;
  const ra0 = centerRa * radians;
  const dec0 = centerDec * radians;
  const rho = Math.hypot(xi, eta);
  const c = Math.atan(rho);
  const sinC = Math.sin(c);
  const dec = Math.asin(Math.cos(c) * Math.sin(dec0) + (rho ? eta * sinC * Math.cos(dec0) / rho : 0));
  const ra = ra0 + Math.atan2(xi * sinC, rho * Math.cos(dec0) * Math.cos(c) - eta * Math.sin(dec0) * sinC);
  return { ra: ((ra / radians) % 360 + 360) % 360, dec: dec / radians };
}

type SyntheticEpochTransform = {
  shiftX?: number;
  shiftY?: number;
  motionFraction?: number;
  motionArcsecPerYear?: number;
  objectOffsetRaArcsec?: number;
  objectOffsetDecArcsec?: number;
};

type CachedRender = {
  canvas: HTMLCanvasElement;
  spatial?: { width: number; height: number; values: Float32Array };
};

const renderedFrameCache = new Map<string, CachedRender>();
const MAX_RENDERED_FRAME_CACHE = 48;

function rememberRenderedFrame(key: string, rendered: CachedRender) {
  renderedFrameCache.delete(key);
  renderedFrameCache.set(key, rendered);
  while (renderedFrameCache.size > MAX_RENDERED_FRAME_CACHE) {
    const oldest = renderedFrameCache.keys().next().value;
    if (oldest === undefined) break;
    renderedFrameCache.delete(oldest);
  }
}

function renderCacheKey({ frameCacheKey, url, centerRa, centerDec, fieldSizeDeg, syntheticEpoch, rawPixels, noiseReduction }: {
  frameCacheKey?: string;
  url?: string;
  centerRa?: number;
  centerDec?: number;
  fieldSizeDeg: number;
  syntheticEpoch?: SyntheticEpochTransform;
  rawPixels?: boolean;
  noiseReduction?: NoiseReductionMode;
}) {
  return JSON.stringify(["fits-render-v6", frameCacheKey ?? url ?? "buffer", null, centerRa ?? null, centerDec ?? null, fieldSizeDeg, false, "motion", syntheticEpoch ?? null, rawPixels ?? false, noiseReduction ?? "off"]);
}

/** Reproject native FITS samples to the same north-up sky grid for every epoch. */
function drawRawPixels(canvas: HTMLCanvasElement, image: FitsImage, centerRa?: number, centerDec?: number, fieldSizeDeg = 0.05, noiseReduction: NoiseReductionMode = "off") {
  // WISE cutouts are only a few dozen detector pixels across. A shared 128²
  // sky grid aligns every epoch without multiplying each FITS sample count.
  const outputSize = 128;
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not create a 2D canvas.");

  const aligned = image.wcs && Number.isFinite(centerRa) && Number.isFinite(centerDec);
  const referenceX = image.crpix1 !== null ? image.crpix1 - 1 : (image.width - 1) / 2;
  const referenceY = image.crpix2 !== null ? image.crpix2 - 1 : (image.height - 1) / 2;
  const sourceValues = new Float64Array(outputSize * outputSize);
  sourceValues.fill(NaN);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let y = 0; y < outputSize; y++) {
    for (let x = 0; x < outputSize; x++) {
      let sourceX: number;
      let sourceY: number;
      if (aligned && image.wcs) {
        const sky = skyAtOutputPixel(x, y, outputSize, outputSize, centerRa!, centerDec!, fieldSizeDeg);
        const source = inputPixelForSky(sky.ra, sky.dec, image.wcs);
        sourceX = source ? Math.round(source.x) : -1;
        sourceY = source ? Math.round(source.y) : -1;
      } else {
        sourceX = referenceX + x - (outputSize - 1) / 2;
        sourceY = referenceY - (y - (outputSize - 1) / 2);
      }
      sourceX = Math.round(sourceX);
      sourceY = Math.round(sourceY);
      if (sourceX < 0 || sourceX >= image.width || sourceY < 0 || sourceY >= image.height) continue;
      const raw = Number(image.pixels[sourceY * image.width + sourceX]);
      const value = Number.isFinite(raw) ? raw * image.bscale + image.bzero : NaN;
      const index = y * outputSize + x;
      sourceValues[index] = value;
      if (Number.isFinite(value)) {
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
    }
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) throw new Error("This FITS exposure does not cover the selected sky field.");
  const rawPlane = Float32Array.from(sourceValues);
  const { values: displayValues, sky } = prepareNoiseReducedPlane(rawPlane, outputSize, outputSize, noiseReduction);
  let span = maximum - minimum;
  if (noiseReduction !== "off") {
    const positive = Array.from(displayValues).filter(Number.isFinite).map((value) => rollOffSky(value, sky, noiseReduction)).filter((value) => value > 0).sort((a, b) => a - b);
    span = positive[Math.max(0, Math.floor((positive.length - 1) * 0.997))] ?? 0;
  }
  const pixels = context.createImageData(outputSize, outputSize);
  for (let index = 0; index < sourceValues.length; index++) {
    const value = sourceValues[index];
    const intensity = Number.isFinite(value) && span > 0
      ? noiseReduction === "off"
        ? Math.round((value - minimum) / span * 255)
        : Math.round(Math.asinh(Math.max(0, Math.min(1, rollOffSky(displayValues[index], sky, noiseReduction) / span)) * 6) / Math.asinh(6) * 255)
      : 0;
    const offset = index * 4;
    pixels.data[offset] = intensity;
    pixels.data[offset + 1] = intensity;
    pixels.data[offset + 2] = intensity;
    pixels.data[offset + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
}

/** Render an epoch as soon as its FITS bytes arrive so playback only blits a cached canvas. */
export function precacheFitsFrame(buffer: ArrayBuffer, options: {
  frameCacheKey?: string;
  url?: string;
  centerRa?: number;
  centerDec?: number;
  fieldSizeDeg?: number;
  syntheticEpoch?: SyntheticEpochTransform;
  rawPixels?: boolean;
  noiseReduction?: NoiseReductionMode;
}) {
  const fieldSizeDeg = options.fieldSizeDeg ?? 0.05;
  const key = renderCacheKey({ ...options, fieldSizeDeg });
  if (renderedFrameCache.has(key)) return;
  const image = getImageHdu(new Uint8Array(buffer));
  const canvas = document.createElement("canvas");
  if (options.rawPixels) drawRawPixels(canvas, image, options.centerRa, options.centerDec, fieldSizeDeg, options.noiseReduction);
  else drawImage(canvas, image, options.centerRa, options.centerDec, fieldSizeDeg, options.syntheticEpoch, options.noiseReduction);
  const context = canvas.getContext("2d");
  let spatial: CachedRender["spatial"];
  if (context) {
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const values = new Float32Array(canvas.width * canvas.height);
    for (let pixel = 0; pixel < values.length; pixel++) values[pixel] = rgba[pixel * 4] / 255;
    spatial = { width: canvas.width, height: canvas.height, values };
  }
  rememberRenderedFrame(key, { canvas, spatial });
}

function drawImage(canvas: HTMLCanvasElement, image: FitsImage, centerRa?: number, centerDec?: number, fieldSizeDeg = 0.05, syntheticEpoch?: SyntheticEpochTransform, noiseReduction: NoiseReductionMode = "off") {
  const aligned = image.wcs && Number.isFinite(centerRa) && Number.isFinite(centerDec);
  // Use a square output grid for every epoch. WCS reprojection or CRPIX
  // fallback below aligns the requested coordinate to the grid center.
  const width = Math.max(image.width, image.height);
  const height = width;
  canvas.width = width;
  canvas.height = height;

  const finiteValues: number[] = [];
  const sourcePixelCount = image.width * image.height;
  const physicalPixels = new Float32Array(sourcePixelCount);
  physicalPixels.fill(NaN);
  const rawPhysical = (index: number) => {
    const value = Number(image.pixels[index]);
    return Number.isFinite(value) ? value * image.bscale + image.bzero : NaN;
  };
  for (let index = 0; index < sourcePixelCount; index++) {
    const value = rawPhysical(index);
    if (Number.isFinite(value)) {
      // Each render owns its physical-pixel plane, including every synthetic
      // epoch that reuses the same cached AllWISE FITS bytes.
      physicalPixels[index] = value;
      finiteValues.push(value);
    }
  }
  const physical = (index: number) => physicalPixels[index];
  if (!finiteValues.length) throw new Error("The FITS image contains no finite pixel values.");
  finiteValues.sort((a, b) => a - b);
  const percentile = (fraction: number) => {
    const position = (finiteValues.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return finiteValues[lower] + (finiteValues[upper] - finiteValues[lower]) * (position - lower);
  };
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not create a 2D canvas.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const projected = new Float32Array(width * height);
  projected.fill(NaN);
  let validPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sourceX: number;
      let sourceY: number;
      if (aligned && image.wcs) {
        const sky = skyAtOutputPixel(x, y, width, height, centerRa!, centerDec!, fieldSizeDeg);
        const source = inputPixelForSky(sky.ra, sky.dec, image.wcs);
        sourceX = source ? Math.round(source.x) : -1;
        sourceY = source ? Math.round(source.y) : -1;
      } else {
        // When a cutout has incomplete WCS cards, CRPIX still identifies its
        // requested sky center. Align that pixel to the canvas center instead
        // of centering the detector rectangle, which can shift edge cutouts.
        const referenceX = image.crpix1 !== null ? image.crpix1 - 1 : (image.width - 1) / 2;
        const referenceY = image.crpix2 !== null ? image.crpix2 - 1 : (image.height - 1) / 2;
        sourceX = referenceX + x - (width - 1) / 2;
        sourceY = referenceY - (y - (height - 1) / 2);
      }
      if (syntheticEpoch) {
        sourceX -= (syntheticEpoch.shiftX ?? 0) * width / 128;
        sourceY -= (syntheticEpoch.shiftY ?? 0) * height / 128;
      }
      sourceX = Math.round(sourceX);
      sourceY = Math.round(sourceY);
      const inside = sourceX >= 0 && sourceX < image.width && sourceY >= 0 && sourceY < image.height;
      const value = inside ? physical(sourceY * image.width + sourceX) : NaN;
      if (Number.isFinite(value)) validPixels++;
      projected[y * width + x] = value;
    }
  }
  const frame = context.createImageData(width, height);
  const stretchScale = Math.asinh(3);
  const { values: displayPlane, sky } = prepareNoiseReducedPlane(projected, width, height, noiseReduction);
  let lowerClip: number;
  let upperClip: number;
  if (noiseReduction === "off") {
    const median = percentile(0.5);
    const deviations = finiteValues.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
    const deviationMiddle = (deviations.length - 1) * 0.5;
    const deviationLower = Math.floor(deviationMiddle);
    const deviationUpper = Math.ceil(deviationMiddle);
    const mad = deviations[deviationLower] + (deviations[deviationUpper] - deviations[deviationLower]) * (deviationMiddle - deviationLower);
    lowerClip = mad === 0 ? percentile(0.65) : median + 1.5 * 1.4826 * mad;
    upperClip = Math.max(percentile(0.997), lowerClip + Number.EPSILON);
  } else {
    lowerClip = sky.median;
    const signals = Array.from(displayPlane).filter(Number.isFinite).map((value) => rollOffSky(value, sky, noiseReduction)).filter((value) => value > 0).sort((a, b) => a - b);
    upperClip = Math.max(signals[Math.floor((signals.length - 1) * 0.997)] ?? 0, Number.EPSILON);
  }
  for (let index = 0; index < projected.length; index++) {
    const value = projected[index];
    const signal = noiseReduction === "off" ? value : rollOffSky(displayPlane[index], sky, noiseReduction);
    const normalized = Number.isFinite(value)
      ? Math.max(0, Math.min(1, noiseReduction === "off" ? (value - lowerClip) / (upperClip - lowerClip) : signal / upperClip))
      : 0;
    const gray = Number.isFinite(value) ? Math.round((Math.asinh(normalized * 3) / stretchScale) * 255) : 0;
    const pixel = index * 4;
    frame.data[pixel] = gray;
    frame.data[pixel + 1] = gray;
    frame.data[pixel + 2] = gray;
    frame.data[pixel + 3] = 255;
  }
  context.putImageData(frame, 0, 0);
  return validPixels / (width * height);
}

/** Render a FITS layer onto a shared north-up field before multi-survey compositing. */
export function renderFitsChannel(buffer: ArrayBuffer, centerRa: number, centerDec: number, fieldSizeDeg: number, outputSize = 512) {
  const image = getImageHdu(new Uint8Array(buffer));
  const source = document.createElement("canvas");
  drawImage(source, image, centerRa, centerDec, fieldSizeDeg);
  const aligned = document.createElement("canvas");
  aligned.width = outputSize;
  aligned.height = outputSize;
  const context = aligned.getContext("2d");
  if (!context) throw new Error("Could not create a shared survey grid.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, outputSize, outputSize);
  const rgba = context.getImageData(0, 0, outputSize, outputSize).data;
  const grayscale = new Uint8Array(outputSize * outputSize);
  for (let pixel = 0; pixel < grayscale.length; pixel++) grayscale[pixel] = rgba[pixel * 4];
  return grayscale;
}

/** Extract a local sky-subtracted physical FITS signal at a shared-grid pixel. */
export function extractFitsPixelSignal(buffer: ArrayBuffer, centerRa: number, centerDec: number, fieldSizeDeg: number, x: number, y: number, outputSize = 512) {
  let image = parsedImageCache.get(buffer);
  if (!image) {
    image = getImageHdu(new Uint8Array(buffer));
    parsedImageCache.set(buffer, image);
  }
  const samples: number[] = [];
  const sky: number[] = [];
  const rawValue = (gridX: number, gridY: number) => {
    if (gridX < 0 || gridY < 0 || gridX >= outputSize || gridY >= outputSize) return NaN;
    let sourceX: number;
    let sourceY: number;
    if (image!.wcs) {
      const position = skyAtOutputPixel(gridX, gridY, outputSize, outputSize, centerRa, centerDec, fieldSizeDeg);
      const source = inputPixelForSky(position.ra, position.dec, image!.wcs!);
      sourceX = source ? Math.round(source.x) : -1;
      sourceY = source ? Math.round(source.y) : -1;
    } else {
      sourceX = Math.round((gridX / (outputSize - 1)) * (image!.width - 1));
      sourceY = image!.height - 1 - Math.round((gridY / (outputSize - 1)) * (image!.height - 1));
    }
    if (sourceX < 0 || sourceY < 0 || sourceX >= image!.width || sourceY >= image!.height) return NaN;
    const value = Number(image!.pixels[sourceY * image!.width + sourceX]);
    return Number.isFinite(value) ? value * image!.bscale + image!.bzero : NaN;
  };
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const value = rawValue(x + dx, y + dy);
    if (Number.isFinite(value)) samples.push(value);
  }
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
    const radius = Math.hypot(dx, dy);
    if (radius < 5 || radius > 8) continue;
    const value = rawValue(x + dx, y + dy);
    if (Number.isFinite(value)) sky.push(value);
  }
  if (!samples.length) return null;
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  };
  return median(samples) - (sky.length ? median(sky) : 0);
}

function projectPhysicalPixels(image: FitsImage, centerRa: number, centerDec: number, fieldSizeDeg: number) {
  const width = 128;
  const height = 128;
  const values = new Float32Array(width * height);
  const valid = new Uint8Array(width * height);
  const physical = (index: number) => {
    const value = Number(image.pixels[index]);
    return Number.isFinite(value) ? value * image.bscale + image.bzero : NaN;
  };
  let coveredPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sourceX: number;
      let sourceY: number;
      if (image.wcs) {
        const sky = skyAtOutputPixel(x, y, width, height, centerRa, centerDec, fieldSizeDeg);
        const source = inputPixelForSky(sky.ra, sky.dec, image.wcs);
        sourceX = source ? Math.round(source.x) : -1;
        sourceY = source ? Math.round(source.y) : -1;
      } else {
        sourceX = Math.round((x / (width - 1)) * (image.width - 1));
        sourceY = image.height - 1 - Math.round((y / (height - 1)) * (image.height - 1));
      }
      const outputIndex = y * width + x;
      if (sourceX < 0 || sourceX >= image.width || sourceY < 0 || sourceY >= image.height) continue;
      const value = physical(sourceY * image.width + sourceX);
      if (!Number.isFinite(value)) continue;
      values[outputIndex] = value;
      valid[outputIndex] = 1;
      coveredPixels++;
    }
  }
  return { width, height, values, valid, coverage: coveredPixels / (width * height) };
}

function drawDifference(
  canvas: HTMLCanvasElement,
  earlier: FitsImage,
  later: FitsImage,
  centerRa: number,
  centerDec: number,
  fieldSizeDeg: number,
  outline: boolean,
  mode: "motion" | "brightness" | "add",
  noiseReduction: NoiseReductionMode = "off",
) {
  const a = projectPhysicalPixels(earlier, centerRa, centerDec, fieldSizeDeg);
  const b = projectPhysicalPixels(later, centerRa, centerDec, fieldSizeDeg);
  const planeA = Float32Array.from(a.values, (value, index) => a.valid[index] ? value : NaN);
  const planeB = Float32Array.from(b.values, (value, index) => b.valid[index] ? value : NaN);
  const preparedA = prepareNoiseReducedPlane(planeA, a.width, a.height, noiseReduction);
  const preparedB = prepareNoiseReducedPlane(planeB, b.width, b.height, noiseReduction);
  const valuesA = preparedA.values;
  const valuesB = preparedB.values;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not create a 2D canvas.");
  canvas.width = a.width;
  canvas.height = a.height;
  const frame = context.createImageData(a.width, a.height);
  const deltas: number[] = [];
  const combinedValues: number[] = [];
  for (let i = 0; i < a.values.length; i++) {
    if (a.valid[i] && b.valid[i] && Number.isFinite(valuesA[i]) && Number.isFinite(valuesB[i])) {
      deltas.push(valuesB[i] - valuesA[i]);
      combinedValues.push(valuesA[i] + valuesB[i]);
    }
  }
  const median = (values: number[]) => {
    if (!values.length) return 0;
    const sortedValues = [...values].sort((left, right) => left - right);
    return sortedValues[Math.floor(sortedValues.length / 2)];
  };
  const backgroundDelta = median(deltas);
  const residuals = deltas.map((value) => Math.abs(value - backgroundDelta));
  const noise = median(residuals) * 1.4826;
  const skyA = preparedA.sky;
  const skyB = preparedB.sky;
  const quadratureThreshold = 3.5 * Math.hypot(skyA.sigma, skyB.sigma);
  const threshold = noiseReduction === "off" ? noise * 4.5 : quadratureThreshold;
  const gatedResiduals = noiseReduction === "off" ? residuals : residuals.map((value) => Math.max(0, value - threshold));
  const sorted = gatedResiduals.sort((left, right) => left - right);
  const percentile = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.998))] : 1;
  const motionPercentile = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.995))] : 1;
  const motionScale = Math.max(motionPercentile, Number.EPSILON);
  const sortedCombined = combinedValues.sort((left, right) => left - right);
  const combinedLow = sortedCombined.length ? sortedCombined[Math.floor(sortedCombined.length * 0.5)] : 0;
  const combinedHigh = sortedCombined.length ? sortedCombined[Math.min(sortedCombined.length - 1, Math.floor(sortedCombined.length * 0.995))] : 1;
  const scale = Math.max(percentile, threshold * 2, Number.EPSILON);
  const displaySpan = Math.max(scale - threshold, Number.EPSILON);
  const outlineThreshold = Math.max(threshold, scale * 0.45);
  const changed = new Uint8Array(a.values.length);

  for (let i = 0; i < a.values.length; i++) {
    const hasData = Boolean(a.valid[i] && b.valid[i] && Number.isFinite(valuesA[i]) && Number.isFinite(valuesB[i]));
    const earlierValue = hasData ? valuesA[i] : 0;
    const laterValue = hasData ? valuesB[i] : 0;
    const delta = hasData ? laterValue - earlierValue - backgroundDelta : 0;
    const magnitude = mode === "add"
      ? Math.max(0, Math.min(1, ((earlierValue + laterValue) - combinedLow) / Math.max(combinedHigh - combinedLow, Number.EPSILON)))
      : mode === "motion"
      ? Math.max(0, Math.min(1, (Math.abs(delta) - (noiseReduction === "off" ? 0 : threshold)) / motionScale))
      : Math.max(0, Math.min(1, (Math.abs(delta) - threshold) / displaySpan));
    changed[i] = hasData && Math.abs(delta) >= outlineThreshold && magnitude > 0.08 ? 1 : 0;
    const pixel = i * 4;
    if (!hasData) {
      frame.data[pixel] = 0;
      frame.data[pixel + 1] = 0;
      frame.data[pixel + 2] = 0;
      frame.data[pixel + 3] = 255;
      continue;
    }
    if (mode === "motion" || mode === "add") {
      const intensity = Math.round(255 * magnitude);
      frame.data[pixel] = intensity;
      frame.data[pixel + 1] = intensity;
      frame.data[pixel + 2] = intensity;
    } else {
      frame.data[pixel] = delta >= 0 ? Math.round(8 + 247 * magnitude) : Math.round(4 + 20 * magnitude);
      frame.data[pixel + 1] = delta >= 0 ? Math.round(5 + 132 * magnitude) : Math.round(15 + 116 * magnitude);
      frame.data[pixel + 2] = delta >= 0 ? Math.round(2 + 35 * magnitude) : Math.round(24 + 231 * magnitude);
    }
    frame.data[pixel + 3] = 255;
  }

  if (outline) {
    const visited = new Uint8Array(changed.length);
    const outlineMask = new Uint8Array(changed.length);
    const minimumObjectPixels = 14;

    // Trace only coherent, compact regions. Single pixels and tiny clusters
    // from detector noise are left in the difference image but never outlined.
    for (let start = 0; start < changed.length; start++) {
      if (!changed[start] || visited[start]) continue;
      const component = [start];
      visited[start] = 1;
      let minX = a.width;
      let maxX = 0;
      let minY = a.height;
      let maxY = 0;

      for (let cursor = 0; cursor < component.length; cursor++) {
        const index = component[cursor];
        const x = index % a.width;
        const y = Math.floor(index / a.width);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        for (let offsetY = -1; offsetY <= 1; offsetY++) {
          for (let offsetX = -1; offsetX <= 1; offsetX++) {
            if (offsetX === 0 && offsetY === 0) continue;
            const nextX = x + offsetX;
            const nextY = y + offsetY;
            if (nextX < 0 || nextX >= a.width || nextY < 0 || nextY >= a.height) continue;
            const nextIndex = nextY * a.width + nextX;
            if (changed[nextIndex] && !visited[nextIndex]) {
              visited[nextIndex] = 1;
              component.push(nextIndex);
            }
          }
        }
      }

      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      const density = component.length / (boxWidth * boxHeight);
      const aspect = Math.max(boxWidth, boxHeight) / Math.max(1, Math.min(boxWidth, boxHeight));
      if (component.length >= minimumObjectPixels && density >= 0.2 && aspect <= 4) {
        for (const index of component) outlineMask[index] = 1;
      }
    }

    for (let y = 1; y < a.height - 1; y++) {
      for (let x = 1; x < a.width - 1; x++) {
        const i = y * a.width + x;
        if (!outlineMask[i]) continue;
        if (!outlineMask[i - 1] || !outlineMask[i + 1] || !outlineMask[i - a.width] || !outlineMask[i + a.width]) {
          const pixel = i * 4;
          frame.data[pixel] = 255;
          frame.data[pixel + 1] = 245;
          frame.data[pixel + 2] = 130;
        }
      }
    }
  }
  context.putImageData(frame, 0, 0);
  return { earlierCoverage: a.coverage, laterCoverage: b.coverage };
}

/** Measure finite, reprojected pixels for timeline default selection. */
export function measureFitsCoverage(buffer: ArrayBuffer, centerRa?: number, centerDec?: number, fieldSizeDeg = 0.05) {
  const image = getImageHdu(new Uint8Array(buffer));
  if (image.wcs && Number.isFinite(centerRa) && Number.isFinite(centerDec)) {
    return projectPhysicalPixels(image, centerRa!, centerDec!, fieldSizeDeg).coverage;
  }
  let valid = 0;
  for (let index = 0; index < image.width * image.height; index++) {
    const raw = Number(image.pixels[index]);
    if (Number.isFinite(raw) && Number.isFinite(raw * image.bscale + image.bzero)) valid++;
  }
  return valid / (image.width * image.height);
}

export type FitsCanvasViewerProps = {
  /** A browser-readable URL to a FITS image. */
  url?: string;
  /** Stable ID/date for caching this rendered epoch independently of its band. */
  frameCacheKey?: string;
  compareFrameCacheKey?: string;
  /** A FITS response already fetched and retained in memory by the image player. */
  buffer?: ArrayBuffer;
  centerRa?: number;
  centerDec?: number;
  fieldSizeDeg?: number;
  zoom?: number;
  panOffset?: { x: number; y: number };
  onPanChange?: (offset: { x: number; y: number }) => void;
  onFrameRejected?: () => void;
  onCompareFrameRejected?: () => void;
  compareBuffer?: ArrayBuffer;
  showOutline?: boolean;
  differenceMode?: "motion" | "brightness" | "add";
  alt?: string;
  /** Optional wavelength-resolved cube aligned to the rendered image grid. */
  spectralCube?: SpectralCube;
  /** A rendered model cube to display when no network FITS frame is available. */
  syntheticCube?: SpectralCube;
  /** Explicitly illustrative per-epoch offset/noise for fallback timelines. */
  syntheticEpoch?: SyntheticEpochTransform;
  compareSyntheticEpoch?: SyntheticEpochTransform;
  /** Show source FITS samples directly in native pixel coordinates. */
  rawPixels?: boolean;
  noiseReduction?: NoiseReductionMode;
  onSpectrumChange?: (spectrum: SpectrumPoint[] | null, pixel?: { x: number; y: number }) => void;
  onSpatialImage?: (width: number, height: number, values: Float32Array) => void;
};

function drawSyntheticCube(canvas: HTMLCanvasElement, cube: SpectralCube) {
  canvas.width = cube.width;
  canvas.height = cube.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  const planeSize = cube.width * cube.height;
  const values = new Float32Array(planeSize);
  for (let band = 0; band < cube.bands; band++) {
    const offset = band * planeSize;
    for (let pixel = 0; pixel < planeSize; pixel++) {
      const value = cube.data[offset + pixel];
      if (Number.isFinite(value)) values[pixel] += value;
    }
  }
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
  const black = percentile(0.5);
  const white = Math.max(percentile(0.997), black + Number.EPSILON);
  const stretchMax = Math.asinh(3);
  const pixels = context.createImageData(cube.width, cube.height);
  for (let pixel = 0; pixel < planeSize; pixel++) {
    const normalized = Math.max(0, Math.min(1, (values[pixel] - black) / (white - black)));
    const intensity = Math.round(Math.asinh(normalized * 3) / stretchMax * 255);
    const offset = pixel * 4;
    pixels.data[offset] = intensity;
    pixels.data[offset + 1] = intensity;
    pixels.data[offset + 2] = intensity;
    pixels.data[offset + 3] = 255;
  }
  context.imageSmoothingEnabled = true;
  context.putImageData(pixels, 0, 0);
}

export default function FitsCanvasViewer({ url, frameCacheKey, compareFrameCacheKey, buffer, centerRa, centerDec, fieldSizeDeg = 0.05, zoom = 1, panOffset = { x: 0, y: 0 }, onPanChange, onFrameRejected, onCompareFrameRejected, compareBuffer, showOutline = false, differenceMode = "motion", alt = "Astronomical FITS image", spectralCube, syntheticCube, syntheticEpoch, compareSyntheticEpoch, rawPixels = false, noiseReduction = "off", onSpectrumChange, onSpatialImage }: FitsCanvasViewerProps) {
  const canvasRefs = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];
  const frontLayerRef = useRef(0);
  const hasRenderedRef = useRef(false);
  const onFrameRejectedRef = useRef(onFrameRejected);
  const onCompareFrameRejectedRef = useRef(onCompareFrameRejected);
  const onSpatialImageRef = useRef(onSpatialImage);
  const onSpectrumChangeRef = useRef(onSpectrumChange);
  const queuedPointerRef = useRef<{ x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const lastSpectrumPixelRef = useRef<string | null>(null);
  onFrameRejectedRef.current = onFrameRejected;
  onCompareFrameRejectedRef.current = onCompareFrameRejected;
  onSpatialImageRef.current = onSpatialImage;
  onSpectrumChangeRef.current = onSpectrumChange;
  const [frontLayer, setFrontLayer] = useState(0);
  const [status, setStatus] = useState("");
  const panStartRef = useRef<{ pointerX: number; pointerY: number; offsetX: number; offsetY: number } | null>(null);

  const inspectSpectrumAt = (clientX: number, clientY: number) => {
    if (!spectralCube || !hasRenderedRef.current) return;
    const canvas = canvasRefs[frontLayerRef.current].current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const renderedWidth = canvas.width * scale;
    const renderedHeight = canvas.height * scale;
    const left = rect.left + (rect.width - renderedWidth) / 2;
    const top = rect.top + (rect.height - renderedHeight) / 2;
    const x = (clientX - left) / renderedWidth * spectralCube.width;
    const y = (clientY - top) / renderedHeight * spectralCube.height;
    if (x < 0 || y < 0 || x >= spectralCube.width || y >= spectralCube.height) return;
    const pixelKey = `${Math.floor(x)},${Math.floor(y)}`;
    if (pixelKey === lastSpectrumPixelRef.current) return;
    lastSpectrumPixelRef.current = pixelKey;
    onSpectrumChangeRef.current?.(spectralCube.extractSpectrum(x, y, 3, 5, 8), { x, y });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || !onPanChange) return;
    panStartRef.current = { pointerX: event.clientX, pointerY: event.clientY, offsetX: panOffset.x, offsetY: panOffset.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current;
    if (start) {
      onPanChange?.({ x: start.offsetX + event.clientX - start.pointerX, y: start.offsetY + event.clientY - start.pointerY });
      return;
    }
    queuedPointerRef.current = { x: event.clientX, y: event.clientY };
    if (hoverTimerRef.current === null) {
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        const pointer = queuedPointerRef.current;
        queuedPointerRef.current = null;
        if (pointer) inspectSpectrumAt(pointer.x, pointer.y);
      }, 60);
    }
  };
  const handlePointerUp = () => { panStartRef.current = null; };
  const handlePointerLeave = () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    queuedPointerRef.current = null;
  };

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
  }, []);

  useEffect(() => {
    lastSpectrumPixelRef.current = null;
  }, [spectralCube]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function load() {
      try {
        if (!buffer && !url && syntheticCube) {
          const backLayer = 1 - frontLayerRef.current;
          const canvas = canvasRefs[backLayer].current;
          if (!active || !canvas) return;
          drawSyntheticCube(canvas, syntheticCube);
          frontLayerRef.current = backLayer;
          hasRenderedRef.current = true;
          setFrontLayer(backLayer);
          setStatus("");
          return;
        }
        let imageBytes: Uint8Array;
        if (buffer) {
          imageBytes = new Uint8Array(buffer);
        } else {
          if (!url) throw new Error("No FITS image source was provided.");
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) {
            const errorBody = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(errorBody?.error || `Image request failed (${response.status}).`);
          }
          imageBytes = new Uint8Array(await response.arrayBuffer());
        }
        const backLayer = 1 - frontLayerRef.current;
        const canvas = canvasRefs[backLayer].current;
        if (!active || !canvas) return;
        const cacheKey = compareBuffer ? JSON.stringify([
          frameCacheKey ?? url ?? "buffer", compareFrameCacheKey ?? null, centerRa ?? null, centerDec ?? null,
          fieldSizeDeg, showOutline, differenceMode, syntheticEpoch ?? null, compareSyntheticEpoch ?? null, rawPixels, noiseReduction,
        ]) : renderCacheKey({ frameCacheKey, url, centerRa, centerDec, fieldSizeDeg, syntheticEpoch, rawPixels, noiseReduction });
        let rendered = renderedFrameCache.get(cacheKey);
        if (!rendered) {
          if (!hasRenderedRef.current) setStatus("Loading FITS image…");
          const image = getImageHdu(imageBytes);
          const offscreen = document.createElement("canvas");
          let spatial: CachedRender["spatial"];
          if (compareBuffer) {
            const earlier = getImageHdu(new Uint8Array(compareBuffer));
            drawDifference(offscreen, earlier, image, centerRa ?? earlier.wcs?.crval1 ?? 0, centerDec ?? earlier.wcs?.crval2 ?? 0, fieldSizeDeg, showOutline, differenceMode, noiseReduction);
          } else {
            if (rawPixels) drawRawPixels(offscreen, image, centerRa, centerDec, fieldSizeDeg, noiseReduction);
            else drawImage(offscreen, image, centerRa, centerDec, fieldSizeDeg, syntheticEpoch, noiseReduction);
            const context = offscreen.getContext("2d");
            if (context) {
              const rgba = context.getImageData(0, 0, offscreen.width, offscreen.height).data;
              const values = new Float32Array(offscreen.width * offscreen.height);
              for (let pixel = 0; pixel < values.length; pixel++) values[pixel] = rgba[pixel * 4] / 255;
              spatial = { width: offscreen.width, height: offscreen.height, values };
            }
          }
          rendered = { canvas: offscreen, spatial };
          rememberRenderedFrame(cacheKey, rendered);
        }
        canvas.width = rendered.canvas.width;
        canvas.height = rendered.canvas.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser could not create a 2D canvas.");
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(rendered.canvas, 0, 0);
        if (rendered.spatial) onSpatialImageRef.current?.(rendered.spatial.width, rendered.spatial.height, rendered.spatial.values);
        frontLayerRef.current = backLayer;
        hasRenderedRef.current = true;
        setFrontLayer(backLayer);
        setStatus("");
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        if (!hasRenderedRef.current) {
          setStatus(error instanceof Error && error.message.includes("Failed to fetch")
            ? "Could not access this FITS file. Its host may not allow browser requests."
            : error instanceof Error ? error.message : "Could not read this FITS image.");
        }
      }
    }

    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [buffer, centerRa, centerDec, compareBuffer, compareFrameCacheKey, compareSyntheticEpoch, differenceMode, fieldSizeDeg, frameCacheKey, noiseReduction, rawPixels, showOutline, syntheticCube, syntheticEpoch, url]);

  return (
    <div className={`fits-canvas-viewer${zoom > 1 && onPanChange ? " can-pan" : ""}`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onPointerLeave={handlePointerLeave} onClick={(event) => {
      handlePointerLeave();
      inspectSpectrumAt(event.clientX, event.clientY);
    }}>
      {canvasRefs.map((canvasRef, index) => (
        <canvas
          key={index}
          ref={canvasRef}
          className={`fits-canvas-layer${frontLayer === index ? " is-visible" : ""}`}
          role={index === frontLayer ? "img" : undefined}
          aria-label={index === frontLayer ? alt : undefined}
          aria-hidden={index !== frontLayer}
          style={{ "--pan-x": `${panOffset.x}px`, "--pan-y": `${panOffset.y}px`, "--zoom": zoom } as React.CSSProperties}
        />
      ))}
      {status && <div className="fits-canvas-status" role="status">{status}</div>}
    </div>
  );
}
