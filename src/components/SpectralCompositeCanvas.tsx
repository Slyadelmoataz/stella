"use client";

import { useEffect, useRef } from "react";
import type { SpectralCube, SpectrumPoint } from "../../utils/spectralCube";

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
  zoom?: number;
  panOffset?: { x: number; y: number };
  onPanChange?: (offset: { x: number; y: number }) => void;
  onSpectrumChange?: (spectrum: SpectrumPoint[] | null, pixel?: { x: number; y: number }) => void;
  emptyMessage?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !cube) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const composite = cube.getRGBComposite(redArray, greenArray, blueArray);
    const source = document.createElement("canvas");
    source.width = cube.width;
    source.height = cube.height;
    const sourceContext = source.getContext("2d");
    if (!sourceContext) return;
    const sourcePixels = new Uint8ClampedArray(composite.length);
    sourcePixels.set(composite);
    sourceContext.putImageData(new ImageData(sourcePixels, cube.width, cube.height), 0, 0);
    canvas.width = cube.width * 2;
    canvas.height = cube.height * 2;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  }, [blueArray, cube, greenArray, redArray]);

  return cube ? (
    <div className={`spectral-composite-frame${zoom > 1 && onPanChange ? " can-pan" : ""}`} style={{ aspectRatio: `${cube.width} / ${cube.height}` }} onPointerDown={(event) => {
      if (zoom <= 1 || !onPanChange) return;
      panStartRef.current = { x: event.clientX, y: event.clientY, offsetX: panOffset.x, offsetY: panOffset.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerUp={() => { panStartRef.current = null; }} onPointerCancel={() => { panStartRef.current = null; }} onPointerMove={(event) => {
      const start = panStartRef.current;
      if (start) {
        onPanChange?.({ x: start.offsetX + event.clientX - start.x, y: start.offsetY + event.clientY - start.y });
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(rect.width / cube.width, rect.height / cube.height);
      const drawWidth = cube.width * scale;
      const drawHeight = cube.height * scale;
      const x = (event.clientX - rect.left - (rect.width - drawWidth) / 2) / drawWidth * cube.width;
      const y = (event.clientY - rect.top - (rect.height - drawHeight) / 2) / drawHeight * cube.height;
      if (x >= 0 && y >= 0 && x < cube.width && y < cube.height) onSpectrumChange?.(cube.extractSpectrum(x, y, 3, 5, 8), { x, y });
    }} onClick={(event) => {
      if (zoom > 1 && panStartRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(rect.width / cube.width, rect.height / cube.height);
      const drawWidth = cube.width * scale;
      const drawHeight = cube.height * scale;
      const x = (event.clientX - rect.left - (rect.width - drawWidth) / 2) / drawWidth * cube.width;
      const y = (event.clientY - rect.top - (rect.height - drawHeight) / 2) / drawHeight * cube.height;
      if (x >= 0 && y >= 0 && x < cube.width && y < cube.height) onSpectrumChange?.(cube.extractSpectrum(x, y, 3, 5, 8), { x, y });
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
