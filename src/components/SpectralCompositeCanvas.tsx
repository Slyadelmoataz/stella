"use client";

import { useEffect, useRef } from "react";
import type { NoiseReductionMode, SpectralCube, SpectrumPoint } from "../../utils/spectralCube";

const compositeCache = new WeakMap<SpectralCube, Map<string, HTMLCanvasElement>>();
const MAX_CACHED_GRADES_PER_CUBE = 3;

function getCompositeCanvas(cube: SpectralCube, redArray: number, greenArray: number, blueArray: number, alphaArray?: number, noiseReduction: NoiseReductionMode = "off") {
  const key = `${redArray}:${greenArray}:${blueArray}:${alphaArray ?? "opaque"}:${noiseReduction}`;
  let cache = compositeCache.get(cube);
  if (!cache) {
    cache = new Map();
    compositeCache.set(cube, cache);
  }
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }

  const canvas = document.createElement("canvas");
  canvas.width = cube.width * 2;
  canvas.height = cube.height * 2;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const composite = cube.getRGBComposite(redArray, greenArray, blueArray, alphaArray, noiseReduction);
  const pixels = new ImageData(new Uint8ClampedArray(composite), cube.width, cube.height);
  const source = document.createElement("canvas");
  source.width = cube.width;
  source.height = cube.height;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) return null;
  sourceContext.putImageData(pixels, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  cache.set(key, canvas);
  while (cache.size > MAX_CACHED_GRADES_PER_CUBE) cache.delete(cache.keys().next().value!);
  return canvas;
}

export const SPHEREX_ARRAYS = [
  { index: 0, label: "Array 1 · 0.75–1.11 μm" },
  { index: 1, label: "Array 2 · 1.11–1.64 μm" },
  { index: 2, label: "Array 3 · 1.64–2.42 μm" },
  { index: 3, label: "Array 4 · 2.42–3.82 μm" },
  { index: 4, label: "Array 5 · 3.82–4.42 μm" },
  { index: 5, label: "Array 6 · 4.42–5.00 μm" },
];

export default function SpectralCompositeCanvas({
  cube,
  redArray,
  greenArray,
  blueArray,
  alphaArray,
  noiseReduction = "off",
  zoom = 1,
  panOffset = { x: 0, y: 0 },
  onPanChange,
  onSpectrumChange,
  emptyMessage = "SPHEREx cube is being prepared from the selected WISE frame and catalog sources…",
}: {
  cube?: SpectralCube;
  redArray: number;
  greenArray: number;
  blueArray: number;
  alphaArray?: number;
  noiseReduction?: NoiseReductionMode;
  zoom?: number;
  panOffset?: { x: number; y: number };
  onPanChange?: (offset: { x: number; y: number }) => void;
  onSpectrumChange?: (spectrum: SpectrumPoint[] | null, pixel?: { x: number; y: number }) => void;
  emptyMessage?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const queuedPointerRef = useRef<{ x: number; y: number } | null>(null);
  const lastSpectrumPixelRef = useRef<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !cube) return;
    const cachedComposite = getCompositeCanvas(cube, redArray, greenArray, blueArray, alphaArray, noiseReduction);
    if (!cachedComposite) return;
    canvas.width = cachedComposite.width;
    canvas.height = cachedComposite.height;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(cachedComposite, 0, 0);
  }, [alphaArray, blueArray, cube, greenArray, noiseReduction, redArray]);

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
  }, []);

  useEffect(() => {
    lastSpectrumPixelRef.current = null;
  }, [cube]);

  const inspectSpectrumAt = (clientX: number, clientY: number) => {
    if (!cube) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / cube.width, rect.height / cube.height);
    const drawWidth = cube.width * scale;
    const drawHeight = cube.height * scale;
    const x = (clientX - rect.left - (rect.width - drawWidth) / 2) / drawWidth * cube.width;
    const y = (clientY - rect.top - (rect.height - drawHeight) / 2) / drawHeight * cube.height;
    if (x < 0 || y < 0 || x >= cube.width || y >= cube.height) return;
    const pixelKey = `${Math.floor(x)},${Math.floor(y)}`;
    if (pixelKey === lastSpectrumPixelRef.current) return;
    lastSpectrumPixelRef.current = pixelKey;
    onSpectrumChange?.(cube.extractSpectrum(x, y, 3, 5, 8), { x, y });
  };

  const queueSpectrumInspection = (clientX: number, clientY: number) => {
    queuedPointerRef.current = { x: clientX, y: clientY };
    if (hoverTimerRef.current !== null) return;
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      const pointer = queuedPointerRef.current;
      queuedPointerRef.current = null;
      if (pointer) inspectSpectrumAt(pointer.x, pointer.y);
    }, 60);
  };

  const flushSpectrumInspection = (clientX: number, clientY: number) => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    queuedPointerRef.current = null;
    inspectSpectrumAt(clientX, clientY);
  };

  return cube ? (
    <div className={`spectral-composite-frame${zoom > 1 && onPanChange ? " can-pan" : ""}`} style={{ aspectRatio: `${cube.width} / ${cube.height}` }} onPointerDown={(event) => {
      if (zoom <= 1 || !onPanChange) return;
      panStartRef.current = { x: event.clientX, y: event.clientY, offsetX: panOffset.x, offsetY: panOffset.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerUp={() => { panStartRef.current = null; }} onPointerCancel={() => { panStartRef.current = null; }} onPointerLeave={() => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
      queuedPointerRef.current = null;
    }} onPointerMove={(event) => {
      const start = panStartRef.current;
      if (start) {
        onPanChange?.({ x: start.offsetX + event.clientX - start.x, y: start.offsetY + event.clientY - start.y });
        return;
      }
      queueSpectrumInspection(event.clientX, event.clientY);
    }} onClick={(event) => {
      if (zoom > 1 && panStartRef.current) return;
      flushSpectrumInspection(event.clientX, event.clientY);
    }}>
      <canvas ref={canvasRef} className="spectral-composite-canvas" style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`, transformOrigin: "center" }} role="img" aria-label="SPHEREx six-array false-color RGB composite" />
    </div>
  ) : (
    <div className="spectral-composite-empty" role="status">
      <strong>Preparing spectral view</strong>
      <span>{emptyMessage}</span>
    </div>
  );
}
