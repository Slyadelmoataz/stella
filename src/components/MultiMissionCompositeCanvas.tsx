"use client";

import { useEffect, useRef, useState } from "react";
import { extractFitsPixelSignal, renderFitsChannel } from "@/components/FitsCanvasViewer";
import type { SpectrumPoint } from "../../utils/spectralCube";

export type SurveyFrame = { url: string; band: string; sourceId: string; sourceName: string };
export type WiseFrame = { url: string; band: string; buffer: ArrayBuffer };
const responseCache = new Map<string, Promise<ArrayBuffer>>();
const renderedLayerCache = new Map<ArrayBuffer, Map<string, Uint8Array>>();

async function fetchFits(url: string) {
  let cached = responseCache.get(url);
  if (!cached) {
    cached = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`Survey image unavailable (${response.status}).`);
      return response.arrayBuffer();
    });
    responseCache.set(url, cached);
    cached.catch(() => responseCache.delete(url));
  }
  return cached;
}

function renderLayerCached(buffer: ArrayBuffer, centerRa: number, centerDec: number, fieldSizeDeg: number) {
  const key = `${centerRa}:${centerDec}:${fieldSizeDeg}`;
  let cache = renderedLayerCache.get(buffer);
  if (!cache) {
    cache = new Map();
    renderedLayerCache.set(buffer, cache);
  }
  const existing = cache.get(key);
  if (existing) {
    renderedLayerCache.delete(buffer);
    renderedLayerCache.set(buffer, cache);
    return existing;
  }
  const rendered = renderFitsChannel(buffer, centerRa, centerDec, fieldSizeDeg);
  cache.set(key, rendered);
  renderedLayerCache.delete(buffer);
  renderedLayerCache.set(buffer, cache);
  while (renderedLayerCache.size > 8) renderedLayerCache.delete(renderedLayerCache.keys().next().value!);
  return rendered;
}

export default function MultiMissionCompositeCanvas({
  surveyFrames,
  wiseFrames,
  centerRa,
  centerDec,
  fieldSizeDeg,
  onSpectrumChange,
  showCrosshair = false,
}: {
  surveyFrames: SurveyFrame[];
  wiseFrames: WiseFrame[];
  centerRa?: number;
  centerDec?: number;
  fieldSizeDeg: number;
  onSpectrumChange?: (spectrum: SpectrumPoint[] | null, pixel?: { x: number; y: number }) => void;
  showCrosshair?: boolean;
}) {
  const [canvasUrl, setCanvasUrl] = useState("");
  const [status, setStatus] = useState("Preparing DSS2 + WISE layers…");
  const [spectrumLayers, setSpectrumLayers] = useState<Array<{ buffer: ArrayBuffer; wavelength: number }>>([]);
  const lastSpectrumUpdate = useRef(0);

  useEffect(() => {
    if (centerRa === undefined || centerDec === undefined) return;
    let active = true;
    setStatus("Preparing DSS2 + WISE layers…");
    void (async () => {
      try {
        const buffers = await Promise.all(surveyFrames.map(async (frame) => ({ frame, buffer: await fetchFits(frame.url) })));
        const layers = await Promise.all([
          ...buffers.map(({ frame, buffer }) => Promise.resolve({
            band: frame.band.toLowerCase().split(":").at(-1) ?? frame.band.toLowerCase(),
            pixels: renderLayerCached(buffer, centerRa, centerDec, fieldSizeDeg),
          })),
          ...wiseFrames.map((frame) => Promise.resolve({
            band: frame.band.toLowerCase(),
            pixels: renderLayerCached(frame.buffer, centerRa, centerDec, fieldSizeDeg),
          })),
        ]);
        const extractors: Array<{ buffer: ArrayBuffer; wavelength: number }> = [];
        for (const { frame, buffer } of buffers) {
          const band = frame.band.toLowerCase().split(":").at(-1);
          if (band === "red") extractors.push({ buffer, wavelength: 0.65 });
          if (band === "blue") extractors.push({ buffer, wavelength: 0.45 });
        }
        for (const frame of wiseFrames) {
          if (frame.band === "wise-w1") extractors.push({ buffer: frame.buffer, wavelength: 3.4 });
          if (frame.band === "wise-w2") extractors.push({ buffer: frame.buffer, wavelength: 4.6 });
        }
        const byBand = new Map<string, Uint8Array>();
        for (const layer of layers) if (!byBand.has(layer.band)) byBand.set(layer.band, layer.pixels);
        const opticalRed = byBand.get("red");
        const opticalBlue = byBand.get("blue");
        const opticalColor = byBand.get("color");
        const w1 = byBand.get("wise-w1");
        const w2 = byBand.get("wise-w2");
        if (!opticalRed && !opticalBlue && !opticalColor && !w1 && !w2) throw new Error("No DSS2 or WISE layers are available.");
        const size = 512;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not compose the multi-mission color image.");
        const pixels = context.createImageData(size, size);
        const max = (first?: Uint8Array, second?: Uint8Array, third?: Uint8Array, index = 0) => Math.max(first?.[index] ?? 0, second?.[index] ?? 0, third?.[index] ?? 0);
        for (let pixel = 0; pixel < size * size; pixel++) {
          // Combine the optical DSS2 plates with WISE infrared bands. This is
          // a visual comparison composite, not a calibrated color product.
          pixels.data[pixel * 4] = max(w2, w1, opticalRed ?? opticalColor, pixel);
          pixels.data[pixel * 4 + 1] = max(w1, opticalColor, undefined, pixel);
          pixels.data[pixel * 4 + 2] = max(opticalBlue, opticalColor, undefined, pixel);
          pixels.data[pixel * 4 + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
        if (active) {
          setCanvasUrl(canvas.toDataURL("image/png"));
          setSpectrumLayers(extractors);
          setStatus("");
        }
      } catch (error) {
        if (active) setStatus(error instanceof Error ? error.message : "Multi-mission composite unavailable.");
      }
    })();
    return () => { active = false; };
  }, [centerDec, centerRa, fieldSizeDeg, surveyFrames, wiseFrames]);

  const inspectSpectrum = (clientX: number, clientY: number, container: HTMLDivElement) => {
    if (centerRa === undefined || centerDec === undefined || !spectrumLayers.length) return;
    const rect = container.getBoundingClientRect();
    const x = Math.max(0, Math.min(511, Math.floor((clientX - rect.left) / rect.width * 512)));
    const y = Math.max(0, Math.min(511, Math.floor((clientY - rect.top) / rect.height * 512)));
    const spectrum = spectrumLayers.flatMap(({ buffer, wavelength }) => {
      try {
        const flux = extractFitsPixelSignal(buffer, centerRa, centerDec, fieldSizeDeg, x, y);
        return flux === null || !Number.isFinite(flux) ? [] : [{ wavelength, flux }];
      } catch { return []; }
    }).sort((a, b) => a.wavelength - b.wavelength);
    onSpectrumChange?.(spectrum.length ? spectrum : null, { x, y });
  };

  return <div className="spectral-composite-frame multi-mission-composite" style={{ aspectRatio: "1 / 1" }} onClick={(event) => {
    inspectSpectrum(event.clientX, event.clientY, event.currentTarget);
  }} onPointerMove={(event) => {
    if (event.pointerType === "touch" || Date.now() - lastSpectrumUpdate.current < 80) return;
    lastSpectrumUpdate.current = Date.now();
    inspectSpectrum(event.clientX, event.clientY, event.currentTarget);
  }}>
    {canvasUrl ? <img src={canvasUrl} alt="DSS2 optical and WISE infrared comparison composite" /> : <div className="image-blinker-empty">{status}</div>}
    {showCrosshair && <div className="canvas-crosshair" aria-hidden="true"><i /><i /></div>}
  </div>;
}
