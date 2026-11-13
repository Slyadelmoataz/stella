"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import FitsCanvasViewer, { measureFitsCoverage } from "@/components/FitsCanvasViewer";
import SpectrumChart from "@/components/SpectrumChart";
import SpectralCompositeCanvas, { SPHEREX_ARRAYS } from "@/components/SpectralCompositeCanvas";
import { SpectralCube, type SpectrumPoint } from "../../utils/spectralCube";
import { createOfflineModelSources, synthesizeCubeFromWise, type SedSource } from "../../utils/syntheticSpectralCube";

export type ImageRecord = {
  url: string;
  band: string;
  mjd: number | null;
  source?: "allwise-atlas" | "single-exposure" | "synthetic-timeseries";
  syntheticShiftX?: number;
  syntheticShiftY?: number;
  syntheticNoiseSeed?: number;
};

export type ImageBlinkerProps = {
  images: ImageRecord[];
  playbackSpeed?: number;
  alt?: string;
  centerRa?: number;
  centerDec?: number;
  fieldSizeDeg?: number;
  zoom?: number;
  panOffset?: { x: number; y: number };
  onPanChange?: (offset: { x: number; y: number }) => void;
  spectralCube?: SpectralCube;
  selectedObject?: { name: string; ra: number; dec: number } | null;
  simbadObjects?: SedSource[];
  irsaFailed?: boolean;
  onIrsaFailure?: () => void;
};

type BandFrame = ImageRecord & { sourceIndex: number };
type BandGroup = { band: string; frames: BandFrame[] };

const wavelengthOptions = [
  { id: "wise-w1", label: "WISE W1 · 3.4 μm" },
  { id: "wise-w2", label: "WISE W2 · 4.6 μm" },
  { id: "wise-w3", label: "WISE W3 · 12 μm" },
  { id: "wise-w4", label: "WISE W4 · 22 μm" },
  { id: "0.75-1.1", label: "0.75–1.1 μm" },
  { id: "1.1-1.6", label: "1.1–1.6 μm" },
  { id: "1.6-2.4", label: "1.6–2.4 μm" },
  { id: "2.4-3.8", label: "2.4–3.8 μm" },
  { id: "3.8-4.4", label: "3.8–4.4 μm" },
  { id: "4.4-5.0", label: "4.4–5.0 μm" },
];

function mjdLabel(mjd: number | null | undefined) {
  if (mjd === null || mjd === undefined || !Number.isFinite(mjd)) return "Date unavailable";
  const date = new Date((mjd - 40_587) * 86_400_000);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toISOString().slice(0, 10);
}

export default function ImageBlinker({
  images,
  playbackSpeed = 500,
  alt = "Astronomical image",
  centerRa,
  centerDec,
  fieldSizeDeg = 0.05,
  zoom = 1,
  panOffset = { x: 0, y: 0 },
  onPanChange,
  spectralCube,
  selectedObject = null,
  simbadObjects = [],
  irsaFailed = false,
  onIrsaFailure,
}: ImageBlinkerProps) {
  const [selectedBand, setSelectedBand] = useState("wise-w1");
  const [isPlaying, setIsPlaying] = useState(false);
  const [outlineChanges, setOutlineChanges] = useState(false);
  const [differenceMode, setDifferenceMode] = useState<"motion" | "brightness">("motion");
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(1);
  const [frameBuffers, setFrameBuffers] = useState<(ArrayBuffer | null)[] | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const [downloadedCount, setDownloadedCount] = useState(0);
  const [selectedLimit, setSelectedLimit] = useState<number | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [spectrum, setSpectrum] = useState<SpectrumPoint[] | null>(null);
  const [spectrumTarget, setSpectrumTarget] = useState("");
  const [viewMode, setViewMode] = useState<"time" | "spherex">("time");
  const [redArray, setRedArray] = useState(5);
  const [greenArray, setGreenArray] = useState(3);
  const [blueArray, setBlueArray] = useState(1);
  const [wiseSpatial, setWiseSpatial] = useState<{ width: number; height: number; values: Float32Array } | null>(null);
  const [irsaCube, setIrsaCube] = useState<SpectralCube | undefined>();
  const [cubeLoadError, setCubeLoadError] = useState("");
  const [spherexImageCount, setSpherexImageCount] = useState(0);
  const [isLoadingIrsaCube, setIsLoadingIrsaCube] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const frameBufferByUrlRef = useRef(new Map<string, ArrayBuffer>());
  const coverageByUrlRef = useRef(new Map<string, number>());
  const [coverageRevision, setCoverageRevision] = useState(0);
  const rejectedFramesRef = useRef(new Set<number>());
  const followLatestRef = useRef(true);

  const bandGroups = useMemo<BandGroup[]>(() => {
    const grouped = new Map<string, BandFrame[]>();
    for (const [sourceIndex, image] of images.entries()) {
      const frames = grouped.get(image.band) ?? [];
      frames.push({ ...image, sourceIndex });
      grouped.set(image.band, frames);
    }
    return [...grouped].map(([band, frames]) => ({ band, frames }));
  }, [images]);

  const frameCount = images.length;
  const frameLimit = Math.max(0, Math.min(frameCount, selectedLimit ?? frameCount));
  const requestedDelay = Number.isFinite(playbackSpeed) ? playbackSpeed : 500;
  const intervalDelay = Math.min(1000, Math.max(100, requestedDelay));
  const selectedGroup = bandGroups.find(({ band }) => band === selectedBand);
  const selectedFrames = selectedGroup?.frames ?? [];
  const availableFrames = selectedFrames.filter(({ sourceIndex }) => Boolean(frameBuffers?.[sourceIndex]));
  const maxRangeIndex = Math.max(0, availableFrames.length - 1);
  const safeStart = Math.min(rangeStart, Math.max(0, maxRangeIndex - 1));
  const safeEnd = Math.max(safeStart + 1, Math.min(rangeEnd, maxRangeIndex));
  const frameA = availableFrames[safeStart];
  const frameB = availableFrames[safeEnd];
  const syntheticTimeline = images.some((image) => image.source === "synthetic-timeseries");
  const epochTransform = (frame: BandFrame | undefined) => frame?.source === "synthetic-timeseries" ? {
    shiftX: frame.syntheticShiftX ?? 0,
    shiftY: frame.syntheticShiftY ?? 0,
    noiseSeed: frame.syntheticNoiseSeed ?? 0,
  } : undefined;
  const wavelengthLabel = wavelengthOptions.find(({ id }) => id === selectedBand)?.label ?? selectedBand;
  const totalAvailable = frameBuffers?.filter(Boolean).length ?? 0;

  useEffect(() => {
    if (centerRa === undefined || centerDec === undefined || !frameBuffers) return;
    let measured = false;
    for (const [sourceIndex, image] of images.entries()) {
      const buffer = frameBuffers[sourceIndex];
      if (!buffer || coverageByUrlRef.current.has(image.url)) continue;
      try {
        coverageByUrlRef.current.set(image.url, measureFitsCoverage(buffer, centerRa, centerDec, fieldSizeDeg));
      } catch {
        coverageByUrlRef.current.set(image.url, 0);
      }
      measured = true;
    }
    if (measured) setCoverageRevision((revision) => revision + 1);
  }, [centerDec, centerRa, fieldSizeDeg, frameBuffers, images]);

  const cleanFrameIndices = useMemo(() => {
    const indices: number[] = [];
    let availableIndex = 0;
    for (const frame of selectedFrames) {
      if (!frameBuffers?.[frame.sourceIndex]) continue;
      const coverage = coverageByUrlRef.current.get(frame.url);
      if (coverage !== undefined && coverage >= 0.7) indices.push(availableIndex);
      availableIndex++;
    }
    return indices;
  }, [coverageRevision, frameBuffers, selectedFrames]);
  useEffect(() => {
    if (viewMode !== "spherex") return;
    setIrsaCube(undefined);
    setCubeLoadError("");
    setSpherexImageCount(0);
    if (centerRa === undefined || centerDec === undefined) return;
    const controller = new AbortController();
    setIsLoadingIrsaCube(true);
    void (async () => {
      try {
        const search = new URLSearchParams({ mode: "spherex", ra: String(centerRa), dec: String(centerDec), size: String(fieldSizeDeg) });
        const searchResponse = await fetch(`/api/images?${search}`, { signal: controller.signal });
        const searchBody = await searchResponse.json() as {
          spherexImages?: unknown[];
          spherexCube?: { url: string; ra: number; dec: number } | null;
          spherexCubeError?: string | null;
        };
        if (!searchResponse.ok) throw new Error(`SPHEREx search failed (${searchResponse.status}).`);
        if (controller.signal.aborted) return;
        setSpherexImageCount(Array.isArray(searchBody.spherexImages) ? searchBody.spherexImages.length : 0);
        const tile = searchBody.spherexCube;
        if (!tile) throw new Error(searchBody.spherexCubeError || "No IRSA cube tile covers these coordinates.");

        const query = new URLSearchParams({
          url: tile.url,
          ra: String(centerRa),
          dec: String(centerDec),
          tileRa: String(tile.ra),
          tileDec: String(tile.dec),
          size: String(fieldSizeDeg),
        });
        const response = await fetch(`/api/spherex-cube?${query}`, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error || `SPHEREx cube request failed (${response.status}).`);
        }
        const width = Number(response.headers.get("x-cube-width"));
        const height = Number(response.headers.get("x-cube-height"));
        const bands = Number(response.headers.get("x-cube-bands"));
        const wavelengths = (response.headers.get("x-cube-wavelengths") ?? "").split(",").map(Number);
        if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(bands) || bands !== 102 || wavelengths.length !== bands) {
          throw new Error("IRSA returned incomplete SPHEREx cube metadata.");
        }
        const bytes = await response.arrayBuffer();
        const cube = new SpectralCube(width, height, bands, new Float32Array(bytes), wavelengths);
        if (!controller.signal.aborted) setIrsaCube(cube);
      } catch (error) {
        if (!controller.signal.aborted) setCubeLoadError(error instanceof Error ? error.message : "SPHEREx cube unavailable.");
      } finally {
        if (!controller.signal.aborted) setIsLoadingIrsaCube(false);
      }
    })();
    return () => controller.abort();
  }, [centerDec, centerRa, fieldSizeDeg, viewMode]);

  const generatedCube = useMemo(() => {
    if (irsaCube || spectralCube || (!wiseSpatial && !irsaFailed) || centerRa === undefined || centerDec === undefined) return undefined;
    const width = wiseSpatial?.width ?? 128;
    const height = wiseSpatial?.height ?? 128;
    const spatial = wiseSpatial?.values ?? new Float32Array(width * height);
    const sources = simbadObjects.length
      ? simbadObjects
      : createOfflineModelSources(centerRa, centerDec, fieldSizeDeg);
    return synthesizeCubeFromWise(width, height, spatial, sources, centerRa, centerDec, fieldSizeDeg);
  }, [centerDec, centerRa, fieldSizeDeg, irsaCube, irsaFailed, simbadObjects, spectralCube, wiseSpatial]);
  const activeCube = irsaCube ?? spectralCube ?? generatedCube;
  const hasLiveCube = Boolean(irsaCube ?? spectralCube);
  const cubeLabel = hasLiveCube ? "Live IRSA SPHEREx Cube" : wiseSpatial ? "Synthesized from WISE + SIMBAD SED" : "Offline Gaussian Starfield · Model Only";
  const offlineEpochFrame = useMemo(() => irsaFailed && activeCube
    ? { id: `offline-${centerRa ?? 0}-${centerDec ?? 0}`, cube: activeCube }
    : null, [activeCube, centerDec, centerRa, irsaFailed]);

  useEffect(() => {
    if (availableFrames.length < 2) {
      setIsPlaying(false);
      return;
    }
    if (followLatestRef.current) {
      setRangeStart(cleanFrameIndices[0] ?? 0);
      setRangeEnd(cleanFrameIndices[cleanFrameIndices.length - 1] ?? availableFrames.length - 1);
    } else {
      setRangeStart((start) => Math.min(start, availableFrames.length - 2));
      setRangeEnd((end) => Math.max(Math.min(end, availableFrames.length - 1), Math.min(rangeStart + 1, availableFrames.length - 1)));
    }
    // Track only the frame count. `rangeStart` is intentionally read as the
    // user's current selection when clamping after a failed frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableFrames.length, cleanFrameIndices, selectedBand]);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    let active = true;
    const buffers: (ArrayBuffer | null)[] = images.map((image) => frameBufferByUrlRef.current.get(image.url) ?? null);
    rejectedFramesRef.current = new Set<number>();
    setFrameBuffers([...buffers]);
    setFailedCount(0);
    setDownloadedCount(0);
    setIsDownloading(buffers.slice(0, frameLimit).some((buffer) => !buffer));
    if (!frameLimit) {
      setIsDownloading(false);
      return () => controller.abort();
    }

    async function downloadFrameWithRetries(url: string): Promise<ArrayBuffer> {
      let lastError = new Error("Could not download this FITS frame.");
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) {
            const retryAfter = Number(response.headers.get("retry-after"));
            const body = await response.json().catch(() => null) as { error?: string } | null;
            lastError = new Error(body?.error || `FITS download failed (${response.status}).`);
            if (/timed out/i.test(lastError.message)) throw lastError;
            if (attempt < 2) {
              const delay = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 10_000)
                : 800 * (attempt + 1);
              await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
              continue;
            }
            throw lastError;
          }
          return await response.arrayBuffer();
        } catch (error) {
          if (controller.signal.aborted) throw error;
          lastError = error instanceof Error ? error : lastError;
          if (/timed out/i.test(lastError.message)) throw lastError;
          if (attempt === 2) throw lastError;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 800 * (attempt + 1)));
        }
      }
      throw lastError;
    }

    async function downloadSelectedFrames() {
      let failed = 0;
      for (const [index, image] of images.slice(0, frameLimit).entries()) {
        if (!buffers[index]) buffers[index] = frameBufferByUrlRef.current.get(image.url) ?? null;
        if (buffers[index]) {
          setDownloadedCount((count) => Math.max(count, index + 1));
          if (active && !controller.signal.aborted) setFrameBuffers([...buffers]);
          continue;
        }
        try {
          buffers[index] = await downloadFrameWithRetries(image.url);
          frameBufferByUrlRef.current.set(image.url, buffers[index]!);
        } catch (error) {
          if (controller.signal.aborted) break;
          failed++;
          if (error instanceof Error && /timed out/i.test(error.message)) {
            onIrsaFailure?.();
            break;
          }
        }
        if (active && !controller.signal.aborted) {
          setDownloadedCount(index + 1);
          setFailedCount(failed);
          setFrameBuffers([...buffers]);
        }
      }
      if (active) setIsDownloading(false);
    }

    void downloadSelectedFrames();
    return () => {
      active = false;
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [frameLimit, images]);

  useEffect(() => {
    if (!isPlaying || availableFrames.length < 2 || safeEnd <= safeStart) return;
    const windowSize = safeEnd - safeStart;
    const intervalId = window.setInterval(() => {
      followLatestRef.current = false;
      const latestStart = Math.max(0, availableFrames.length - 1 - windowSize);
      const nextStart = safeStart < latestStart ? safeStart + 1 : 0;
      setRangeStart(nextStart);
      setRangeEnd(nextStart + windowSize);
    }, intervalDelay);
    return () => window.clearInterval(intervalId);
  }, [availableFrames.length, intervalDelay, isPlaying, safeEnd, safeStart]);

  useEffect(() => {
    setRangeStart(0);
    followLatestRef.current = true;
    setRangeEnd(Math.max(1, availableFrames.length - 1));
    setIsPlaying(false);
    // Reset only when the wavelength changes, not when another frame arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBand]);

  useEffect(() => {
    setSpectrum(null);
    setSpectrumTarget("");
  }, [selectedBand]);

  useEffect(() => {
    setWiseSpatial(null);
  }, [centerRa, centerDec, images]);

  useEffect(() => {
    if (!selectedObject) return;
    setSpectrumTarget(selectedObject.name);
    if (!activeCube || centerRa === undefined || centerDec === undefined || fieldSizeDeg <= 0) {
      setSpectrum(null);
      return;
    }
    const deltaRa = ((selectedObject.ra - centerRa + 540) % 360) - 180;
    const x = activeCube.width / 2 - deltaRa * Math.cos(centerDec * Math.PI / 180) / fieldSizeDeg * activeCube.width;
    const y = activeCube.height / 2 - (selectedObject.dec - centerDec) / fieldSizeDeg * activeCube.height;
    if (x < 0 || x >= activeCube.width || y < 0 || y >= activeCube.height) {
      setSpectrum(null);
      return;
    }
    setSpectrum(activeCube.extractSpectrum(x, y, 3, 5, 8));
  }, [activeCube, centerDec, centerRa, fieldSizeDeg, selectedBand, selectedObject]);

  const handleCanvasSpectrum = (nextSpectrum: SpectrumPoint[] | null, pixel?: { x: number; y: number }) => {
    setSpectrum(nextSpectrum);
    if (pixel) setSpectrumTarget(`Pixel ${Math.round(pixel.x)}, ${Math.round(pixel.y)}`);
  };

  const rejectFrame = (sourceIndex: number) => {
    if (rejectedFramesRef.current.has(sourceIndex)) return;
    rejectedFramesRef.current.add(sourceIndex);
    setFrameBuffers((current) => {
      if (!current?.[sourceIndex]) return current;
      const next = [...current];
      next[sourceIndex] = null;
      return next;
    });
    setFailedCount((count) => count + 1);
  };

  const comparisonReady = Boolean(frameA && frameB && frameBuffers?.[frameA.sourceIndex] && frameBuffers?.[frameB.sourceIndex]);

  return (
    <section className="image-blinker" aria-label="Infrared image comparison">
      <div className="band-window-selector">
        <div className="viewer-mode-toggle" role="group" aria-label="Image viewer mode">
          <button type="button" className={viewMode === "time" ? "active" : ""} aria-pressed={viewMode === "time"} onClick={() => setViewMode("time")}>Time Motion (WiseView)</button>
          <button type="button" className={viewMode === "spherex" ? "active" : ""} aria-pressed={viewMode === "spherex"} onClick={() => setViewMode("spherex")}>SPHEREx 6-Array RGB</button>
        </div>
        {viewMode === "time" ? <div className="viewer-sub-controls">
          <label htmlFor="infrared-band">Infrared wavelength</label>
          <select id="infrared-band" value={selectedBand} onChange={(event) => setSelectedBand(event.target.value)}>
            {wavelengthOptions.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div> : <div className="rgb-mappings">
          {([ ["R", redArray, setRedArray], ["G", greenArray, setGreenArray], ["B", blueArray, setBlueArray] ] as const).map(([channel, value, setValue]) => (
            <label key={channel} className={`rgb-mapping rgb-${channel.toLowerCase()}`}><span>{channel}</span><select aria-label={`${channel} color array`} value={value} onChange={(event) => setValue(Number(event.target.value))}>{SPHEREX_ARRAYS.map((array) => <option key={array.index} value={array.index}>{array.label}</option>)}</select></label>
          ))}
          <span className="rgb-grade-label">JWST-inspired · Rust / Gold / Sapphire</span>
        </div>}
      </div>

      {viewMode === "spherex" ? <>
        <div className="spectral-source-strip">
          <span className={`spectral-source-badge${hasLiveCube ? " is-live" : " is-synthetic"}`}>{activeCube ? cubeLabel : "Waiting for WISE image data"}</span>
          <span>{hasLiveCube ? "Observed 102-channel IRSA cube" : isLoadingIrsaCube ? "Searching IRSA for observed channels… model fallback is visualization only" : cubeLoadError ? `IRSA cube unavailable · ${cubeLoadError} · model fallback is visualization only` : spherexImageCount ? `${spherexImageCount} IRSA spectral-image cutout${spherexImageCount === 1 ? "" : "s"} found · model fallback is visualization only` : "Model spectrum · not calibrated for science"}</span>
        </div>
        <SpectralCompositeCanvas cube={activeCube} redArray={redArray} greenArray={greenArray} blueArray={blueArray} zoom={zoom} panOffset={panOffset} onPanChange={onPanChange} onSpectrumChange={handleCanvasSpectrum} />
        {!wiseSpatial && frameA && frameBuffers?.[frameA.sourceIndex] && (
          <div className="cube-spatial-source" aria-hidden="true">
            <FitsCanvasViewer buffer={frameBuffers[frameA.sourceIndex]!} url={frameA.url} centerRa={centerRa} centerDec={centerDec} fieldSizeDeg={fieldSizeDeg} alt="WISE spatial source for model cube" onSpatialImage={(width, height, values) => setWiseSpatial({ width, height, values })} />
          </div>
        )}
      </> : <>
      {offlineEpochFrame && <div className="spectral-source-strip"><span className="spectral-source-badge is-synthetic">{cubeLabel}</span><span>IRSA timed out · illustrative model only</span></div>}
      {syntheticTimeline && <div className="spectral-source-strip"><span className="spectral-source-badge is-synthetic">Illustrative timeline · model only</span><span>Epoch labels and subtle noise are illustrative; the frames reuse an AllWISE cutout and show no measured motion.</span></div>}
      <div className="comparison-grid">
        <article className="compare-pane">
          <header className="compare-pane-header"><h3>Image A</h3><time>{mjdLabel(frameA?.mjd)}</time></header>
          <div className="image-blinker-frame">
            {frameA && frameBuffers?.[frameA.sourceIndex] ? (
            <FitsCanvasViewer buffer={frameBuffers[frameA.sourceIndex]!} url={frameA.url} centerRa={centerRa} centerDec={centerDec} fieldSizeDeg={fieldSizeDeg} zoom={zoom} panOffset={panOffset} onPanChange={onPanChange} syntheticEpoch={epochTransform(frameA)} onFrameRejected={() => rejectFrame(frameA.sourceIndex)} spectralCube={activeCube} onSpectrumChange={handleCanvasSpectrum} onSpatialImage={(width, height, values) => setWiseSpatial({ width, height, values })} alt={`${alt}, ${wavelengthLabel}, image A`} />
            ) : offlineEpochFrame ? (
              <FitsCanvasViewer key={offlineEpochFrame.id} syntheticCube={offlineEpochFrame.cube} spectralCube={offlineEpochFrame.cube} onSpectrumChange={handleCanvasSpectrum} alt="Offline synthetic starfield" />
            ) : <div className="image-blinker-empty">{isDownloading ? "Receiving comparison frames…" : "Select a range with two available frames."}</div>}
          </div>
        </article>
        <article className="compare-pane">
          <header className="compare-pane-header"><h3>Image B</h3><time>{mjdLabel(frameB?.mjd)}</time></header>
          <div className="image-blinker-frame">
            {frameB && frameBuffers?.[frameB.sourceIndex] ? (
            <FitsCanvasViewer buffer={frameBuffers[frameB.sourceIndex]!} url={frameB.url} centerRa={centerRa} centerDec={centerDec} fieldSizeDeg={fieldSizeDeg} zoom={zoom} panOffset={panOffset} onPanChange={onPanChange} syntheticEpoch={epochTransform(frameB)} onFrameRejected={() => rejectFrame(frameB.sourceIndex)} spectralCube={activeCube} onSpectrumChange={handleCanvasSpectrum} alt={`${alt}, ${wavelengthLabel}, image B`} />
            ) : offlineEpochFrame ? (
              <FitsCanvasViewer key={`${offlineEpochFrame.id}-b`} syntheticCube={offlineEpochFrame.cube} spectralCube={offlineEpochFrame.cube} onSpectrumChange={handleCanvasSpectrum} alt="Offline synthetic starfield" />
            ) : <div className="image-blinker-empty">{isDownloading ? "Receiving comparison frames…" : "Select a range with two available frames."}</div>}
          </div>
        </article>
        <article className="compare-pane difference-pane">
          <header className="compare-pane-header">
            <h3>{differenceMode === "motion" ? "Motion · |B − A|" : "Brightness · B − A"}</h3>
            <div className="difference-actions">
              <div className="difference-mode" role="group" aria-label="Difference display mode">
                <button type="button" className={differenceMode === "motion" ? "active" : ""} aria-pressed={differenceMode === "motion"} onClick={() => setDifferenceMode("motion")}>Motion</button>
                <button type="button" className={differenceMode === "brightness" ? "active" : ""} aria-pressed={differenceMode === "brightness"} onClick={() => setDifferenceMode("brightness")}>Brightness</button>
              </div>
              <label className="outline-toggle"><input type="checkbox" checked={outlineChanges} onChange={(event) => setOutlineChanges(event.target.checked)} /> Outline</label>
            </div>
          </header>
          <div className="image-blinker-frame">
            {comparisonReady ? (
              <FitsCanvasViewer
                key={`${selectedBand}-difference`}
                buffer={frameBuffers![frameB!.sourceIndex]!}
                compareBuffer={frameBuffers![frameA!.sourceIndex]!}
                syntheticEpoch={epochTransform(frameB!)}
                compareSyntheticEpoch={epochTransform(frameA!)}
                showOutline={outlineChanges}
                differenceMode={differenceMode}
                spectralCube={activeCube}
                onSpectrumChange={handleCanvasSpectrum}
                onFrameRejected={() => rejectFrame(frameB!.sourceIndex)}
                onCompareFrameRejected={() => rejectFrame(frameA!.sourceIndex)}
                centerRa={centerRa}
                centerDec={centerDec}
                fieldSizeDeg={fieldSizeDeg}
                zoom={zoom}
                panOffset={panOffset}
                onPanChange={onPanChange}
                alt={`${alt}, ${wavelengthLabel}, difference image`}
              />
            ) : <div className="image-blinker-empty">Difference view appears when both images are available.</div>}
          </div>
          <div className="difference-legend">
            {differenceMode === "motion" ? <span><i className="motion-mark" /> Absolute subtraction · changes in either direction</span> : <><span><i className="dimmer-mark" /> Dimmer in B</span><span><i className="brighter-mark" /> Brighter in B</span></>}
          </div>
        </article>
      </div>

      <div className="time-range-panel">
        <div className="time-range-heading"><span>Comparison time range · {wavelengthLabel}</span><output>{mjdLabel(frameA?.mjd)} — {mjdLabel(frameB?.mjd)}</output></div>
        <div className="time-range-values"><span>A · {mjdLabel(frameA?.mjd)}</span><span>B · {mjdLabel(frameB?.mjd)}</span></div>
        <div className="dual-range" style={{ "--range-start": `${availableFrames.length > 1 ? safeStart / (availableFrames.length - 1) * 100 : 0}%`, "--range-end": `${availableFrames.length > 1 ? safeEnd / (availableFrames.length - 1) * 100 : 100}%` } as React.CSSProperties}>
          <div className="dual-range-track" />
          <div className="dual-range-selection" />
          <input aria-label="Earlier comparison date" type="range" min="0" max={maxRangeIndex} step="1" value={safeStart} disabled={availableFrames.length < 2} onChange={(event) => {
            followLatestRef.current = false;
            setRangeStart(Math.min(Number(event.target.value), safeEnd - 1));
          }} />
          <input aria-label="Later comparison date" type="range" min="0" max={maxRangeIndex} step="1" value={safeEnd} disabled={availableFrames.length < 2} onChange={(event) => {
            followLatestRef.current = false;
            setRangeEnd(Math.max(Number(event.target.value), safeStart + 1));
          }} />
        </div>
        <div className="time-range-footer">
          <button className="image-blinker-toggle" type="button" onClick={() => setIsPlaying((playing) => !playing)} disabled={!comparisonReady || safeEnd <= safeStart} aria-pressed={isPlaying}>
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}<span>{isPlaying ? "Pause range" : "Play range"}</span>
          </button>
          <span>{availableFrames.length} dated frames available for this band</span>
        </div>
      </div>

      <div className="image-blinker-controls">
        <span className="image-blinker-count">{totalAvailable}/{frameLimit} frames received{failedCount ? ` · ${failedCount} skipped or failed` : ""}</span>
        {isDownloading && <button className="image-blinker-toggle" type="button" onClick={() => { setIsDownloading(false); controllerRef.current?.abort(); }} aria-label="Stop downloading frames"><Square size={13} /><span>Stop</span></button>}
      </div>
      <div className="image-blinker-limit">
        <label htmlFor="frame-limit">Frames to receive <output>{frameLimit}</output></label>
        <input id="frame-limit" className="range-input" type="range" min="1" max={Math.max(1, frameCount)} step="1" value={Math.max(1, frameLimit)} disabled={!frameCount} onChange={(event) => {
          const limit = Number(event.target.value);
          setSelectedLimit(limit >= frameCount ? null : limit);
        }} />
        <div className="range-ends"><span>1 frame</span><span>{frameCount} frames</span></div>
        {downloadedCount === 0 && frameCount > 0 && !isDownloading && <p className="image-blinker-empty">No frames have arrived yet.</p>}
      </div>
      </>}
      <SpectrumChart data={spectrum ?? []} target={spectrumTarget} dataSource={activeCube ? cubeLabel : undefined} />
    </section>
  );
}
