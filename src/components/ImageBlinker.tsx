"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import FitsCanvasViewer, { measureFitsCoverage, precacheFitsFrame } from "@/components/FitsCanvasViewer";
import SpectrumChart from "@/components/SpectrumChart";
import SpectralCompositeCanvas, { SPHEREX_ARRAYS } from "@/components/SpectralCompositeCanvas";
import MultiMissionCompositeCanvas, { type SurveyFrame, type WiseFrame } from "@/components/MultiMissionCompositeCanvas";
import { SpectralCube, type NoiseReductionMode, type SpectrumPoint } from "../../utils/spectralCube";
import { createOfflineModelSources, synthesizeCubeFromWise, type SedSource } from "../../utils/syntheticSpectralCube";

export type ImageRecord = {
  id?: string;
  frameId?: string;
  url: string;
  band: string;
  mjd: number | null;
  date?: string;
  source?: "allwise-atlas" | "single-exposure" | "synthetic-timeseries";
  syntheticShiftX?: number;
  syntheticShiftY?: number;
  syntheticMotionFraction?: number;
  syntheticMotionArcsecPerYear?: number;
  syntheticObjectOffsetRaArcsec?: number;
  syntheticObjectOffsetDecArcsec?: number;
  sourceId?: string;
  sourceName?: string;
  agency?: string;
};

export type ImageBlinkerProps = {
  images: ImageRecord[];
  sourceImages?: ImageRecord[];
  playbackSpeed?: number;
  noiseReduction?: NoiseReductionMode;
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
  spherexEnabled?: boolean;
  timeSeriesStatus?: string;
  initialTimeline?: TimelineLinkState | null;
  onTimelineStateChange?: (state: TimelineLinkState) => void;
  viewMode?: "time" | "spherex" | "multimission";
  onViewModeChange?: (mode: "time" | "spherex" | "multimission") => void;
  showCrosshair?: boolean;
  onCursorReadout?: (value: { ra: number; dec: number; x: number; y: number; flux: number } | null) => void;
};

export type TimelineLinkState = {
  band: string;
  view: "time" | "spherex" | "multimission";
  from?: string;
  to?: string;
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
  sourceImages = [],
  playbackSpeed = 500,
  noiseReduction = "off",
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
  spherexEnabled = true,
  timeSeriesStatus = "",
  initialTimeline = null,
  onTimelineStateChange,
  viewMode: controlledViewMode,
  onViewModeChange,
  showCrosshair = false,
  onCursorReadout,
}: ImageBlinkerProps) {
  const [selectedBand, setSelectedBand] = useState("wise-w1");
  const [isPlaying, setIsPlaying] = useState(false);
  const [outlineChanges, setOutlineChanges] = useState(false);
  const [differenceMode, setDifferenceMode] = useState<"motion" | "brightness">("motion");
  const [showPairTool, setShowPairTool] = useState(false);
  const [pairOperation, setPairOperation] = useState<"add" | "subtract">("subtract");
  const [timeGap, setTimeGap] = useState(1);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(1);
  const [frameBuffers, setFrameBuffers] = useState<(ArrayBuffer | null)[] | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [spectrum, setSpectrum] = useState<SpectrumPoint[] | null>(null);
  const [spectrumTarget, setSpectrumTarget] = useState("");
  const [localViewMode, setLocalViewMode] = useState<"time" | "spherex" | "multimission">("time");
  const viewMode = controlledViewMode ?? localViewMode;
  const setViewMode = onViewModeChange ?? setLocalViewMode;
  const [redArray, setRedArray] = useState(5);
  const [greenArray, setGreenArray] = useState(3);
  const [blueArray, setBlueArray] = useState(1);
  const [alphaArray, setAlphaArray] = useState(0);
  const [rgbaEnabled, setRgbaEnabled] = useState(false);
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
  const initialRangeAppliedRef = useRef(false);

  useEffect(() => {
    if (!initialTimeline) return;
    setSelectedBand(initialTimeline.band);
    setViewMode(initialTimeline.view);
  }, [initialTimeline]);

  useEffect(() => {
    if (viewMode !== "time" && selectedBand !== "wise-w1" && selectedBand !== "wise-w2") setSelectedBand("wise-w1");
  }, [selectedBand, viewMode]);

  const playbackRecords = useMemo<BandFrame[]>(() => images
    .map((image, sourceIndex) => ({ ...image, sourceIndex }))
    .filter((image) => image.source === "single-exposure"), [images]);

  const bandGroups = useMemo<BandGroup[]>(() => {
    const grouped = new Map<string, BandFrame[]>();
    for (const image of playbackRecords) {
      const frames = grouped.get(image.band) ?? [];
      frames.push(image);
      grouped.set(image.band, frames);
    }
    return [...grouped].map(([band, frames]) => ({ band, frames }));
  }, [playbackRecords]);

  const frameCount = playbackRecords.length;
  const frameLimit = frameCount;
  const requestedDelay = Number.isFinite(playbackSpeed) ? playbackSpeed : 500;
  const intervalDelay = Math.min(1000, Math.max(100, requestedDelay));
  const selectedGroup = bandGroups.find(({ band }) => band === selectedBand);
  const selectedFrames = selectedGroup?.frames ?? [];
  const availableFrames = selectedFrames.filter(({ sourceIndex }) => Boolean(frameBuffers?.[sourceIndex]));
  const maxRangeIndex = Math.max(0, availableFrames.length - 1);
  const safeStart = Math.min(rangeStart, maxRangeIndex);
  const safeEnd = Math.max(safeStart + 1, Math.min(rangeEnd, maxRangeIndex));
  const startIdx = safeStart;
  const frameA = availableFrames[startIdx];
  const endIdx = Math.min(maxRangeIndex, startIdx + timeGap);
  const frameB = availableFrames[endIdx];
  // Keep these object identities stable: FitsCanvasViewer uses them as render
  // dependencies and reports its cached spatial plane back to this component.
  const frameAEpoch = useMemo(() => frameA?.source === "synthetic-timeseries" ? {
    shiftX: frameA.syntheticShiftX ?? 0,
    shiftY: frameA.syntheticShiftY ?? 0,
    motionFraction: frameA.syntheticMotionFraction ?? 0,
    motionArcsecPerYear: frameA.syntheticMotionArcsecPerYear ?? 0,
    objectOffsetRaArcsec: frameA.syntheticObjectOffsetRaArcsec ?? 0,
    objectOffsetDecArcsec: frameA.syntheticObjectOffsetDecArcsec ?? 0,
  } : undefined, [frameA]);
  const frameBEpoch = useMemo(() => frameB?.source === "synthetic-timeseries" ? {
    shiftX: frameB.syntheticShiftX ?? 0,
    shiftY: frameB.syntheticShiftY ?? 0,
    motionFraction: frameB.syntheticMotionFraction ?? 0,
    motionArcsecPerYear: frameB.syntheticMotionArcsecPerYear ?? 0,
    objectOffsetRaArcsec: frameB.syntheticObjectOffsetRaArcsec ?? 0,
    objectOffsetDecArcsec: frameB.syntheticObjectOffsetDecArcsec ?? 0,
  } : undefined, [frameB]);
  const frameAKey = frameA ? `${frameA.id ?? frameA.frameId ?? frameA.url}:${frameA.mjd ?? frameA.date ?? ""}` : undefined;
  const frameBKey = frameB ? `${frameB.id ?? frameB.frameId ?? frameB.url}:${frameB.mjd ?? frameB.date ?? ""}` : undefined;
  const surveyCompositeFrames = useMemo<SurveyFrame[]>(() => sourceImages.filter((frame) => frame.sourceId && frame.sourceId !== "wise-neowise" && frame.sourceId !== "spherex-archive").map((frame) => ({ url: frame.url, band: frame.band, sourceId: frame.sourceId!, sourceName: frame.sourceName ?? frame.sourceId! })), [sourceImages]);
  const wiseCompositeFrames = useMemo<WiseFrame[]>(() => {
    const result: WiseFrame[] = [];
    for (const band of ["wise-w1", "wise-w2"]) {
      const index = images.findIndex((frame) => frame.band.toLowerCase() === band && Boolean(frameBuffers?.[images.indexOf(frame)]));
      if (index >= 0 && frameBuffers?.[index]) result.push({ url: images[index].url, band, buffer: frameBuffers[index]! });
    }
    return result;
  }, [frameBuffers, images]);
  const wiseEpochPair = useMemo(() => {
    const targetMjd = frameA?.mjd;
    const nearest = (band: "wise-w1" | "wise-w2") => {
      const candidates = playbackRecords.filter((frame) => frame.band.toLowerCase() === band && frameBuffers?.[frame.sourceIndex]);
      if (!candidates.length) return undefined;
      return candidates.reduce((best, candidate) => {
        if (targetMjd === null || targetMjd === undefined) return candidate;
        const bestDistance = Math.abs((best.mjd ?? Infinity) - targetMjd);
        const candidateDistance = Math.abs((candidate.mjd ?? Infinity) - targetMjd);
        return candidateDistance < bestDistance ? candidate : best;
      });
    };
    const w1 = nearest("wise-w1");
    const w2 = nearest("wise-w2");
    const build = (frame: BandFrame | undefined) => frame && frameBuffers?.[frame.sourceIndex]
      ? { buffer: frameBuffers[frame.sourceIndex]!, key: `${frame.id ?? frame.frameId ?? frame.url}:${frame.mjd ?? ""}` }
      : undefined;
    return { w1: build(w1), w2: build(w2), targetMjd };
  }, [frameA?.mjd, frameBuffers, playbackRecords]);
  const timedWiseCompositeFrames = useMemo<WiseFrame[]>(() => {
    const frames: WiseFrame[] = [];
    if (wiseEpochPair.w1) frames.push({ url: wiseEpochPair.w1.key, band: "wise-w1", buffer: wiseEpochPair.w1.buffer });
    if (wiseEpochPair.w2) frames.push({ url: wiseEpochPair.w2.key, band: "wise-w2", buffer: wiseEpochPair.w2.buffer });
    return frames.length ? frames : wiseCompositeFrames;
  }, [wiseCompositeFrames, wiseEpochPair]);
  const wavelengthLabel = wavelengthOptions.find(({ id }) => id === selectedBand)?.label ?? selectedBand;
  const totalAvailable = playbackRecords.filter(({ sourceIndex }) => Boolean(frameBuffers?.[sourceIndex])).length;

  useEffect(() => {
    if (!initialTimeline || initialRangeAppliedRef.current || selectedBand !== initialTimeline.band) return;
    if (!initialTimeline.from && !initialTimeline.to) {
      initialRangeAppliedRef.current = true;
      return;
    }
    if (isDownloading || !availableFrames.length) return;
    const toMjd = (date: string | undefined) => date ? Date.parse(date) / 86_400_000 + 40_587 : NaN;
    const nearestIndex = (mjd: number) => availableFrames.reduce((best, frame, index) => {
      const bestMjd = availableFrames[best]?.mjd ?? Infinity;
      const frameMjd = frame.mjd ?? Infinity;
      return Math.abs(frameMjd - mjd) < Math.abs(bestMjd - mjd) ? index : best;
    }, 0);
    const fromMjd = toMjd(initialTimeline.from);
    const toMjdValue = toMjd(initialTimeline.to);
    const fromIndex = Number.isFinite(fromMjd) ? nearestIndex(fromMjd) : 0;
    const toIndex = Number.isFinite(toMjdValue) ? nearestIndex(toMjdValue) : fromIndex + 1;
    setRangeStart(fromIndex);
    setTimeGap(Math.max(1, toIndex - fromIndex));
    initialRangeAppliedRef.current = true;
  }, [availableFrames, initialTimeline, isDownloading, selectedBand]);

  useEffect(() => {
    if (!onTimelineStateChange) return;
    const frameDate = (frame: BandFrame | undefined) => frame?.date ?? (frame?.mjd === null || frame?.mjd === undefined
      ? undefined
      : new Date((frame.mjd - 40_587) * 86_400_000).toISOString());
    onTimelineStateChange({ band: selectedBand, view: viewMode, from: frameDate(frameA), to: frameDate(frameB) });
  }, [frameA?.date, frameA?.mjd, frameB?.date, frameB?.mjd, onTimelineStateChange, selectedBand, viewMode]);

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
    if (!spherexEnabled) {
      setIrsaCube(undefined);
      setCubeLoadError("SPHEREx is disabled in Data Sources.");
      setIsLoadingIrsaCube(false);
      return;
    }
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
  }, [centerDec, centerRa, fieldSizeDeg, spherexEnabled, viewMode]);

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
    const frameBuffer = (image: ImageRecord, source: ArrayBuffer) =>
      image.source === "synthetic-timeseries" ? source.slice(0) : source;
    const buffers: (ArrayBuffer | null)[] = images.map((image) => {
      const cached = frameBufferByUrlRef.current.get(image.url);
      return cached ? frameBuffer(image, cached) : null;
    });
    rejectedFramesRef.current = new Set<number>();
    setFrameBuffers([...buffers]);
    setFailedCount(0);
    setIsDownloading(playbackRecords.slice(0, frameLimit).some(({ sourceIndex }) => !buffers[sourceIndex]));
    if (!frameLimit) {
      setIsDownloading(false);
      return () => controller.abort();
    }

    const validateCompleteFrame = (image: BandFrame, buffer: ArrayBuffer) => {
      const coverage = measureFitsCoverage(buffer, centerRa, centerDec, fieldSizeDeg);
      coverageByUrlRef.current.set(image.url, coverage);
      if (coverage < 0.98) throw new Error(`Incomplete FITS cutout (${Math.round(coverage * 100)}% of the requested field covered).`);
    };

    let rejectedIncomplete = 0;
    const rejectedIncompleteUrls = new Set<string>();
    for (const image of playbackRecords.slice(0, frameLimit)) {
      const buffer = buffers[image.sourceIndex];
      if (!buffer) continue;
      try { validateCompleteFrame(image, buffer); }
      catch {
        buffers[image.sourceIndex] = null;
        frameBufferByUrlRef.current.delete(image.url);
        rejectedIncompleteUrls.add(image.url);
        rejectedIncomplete++;
      }
    }
    setFailedCount(rejectedIncomplete);
    setFrameBuffers([...buffers]);

    async function downloadFrameWithRetries(url: string): Promise<ArrayBuffer> {
      let lastError = new Error("Could not download this FITS frame.");
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) {
            const retryAfter = Number(response.headers.get("retry-after"));
            const body = await response.json().catch(() => null) as { error?: string } | null;
            lastError = new Error(body?.error || `FITS download failed (${response.status}).`);
            if (attempt < 3) {
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
          if (attempt === 3) throw lastError;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 800 * (attempt + 1)));
        }
      }
      throw lastError;
    }

    async function downloadSelectedFrames() {
      let failed = rejectedIncomplete;
      for (const [playbackIndex, image] of playbackRecords.slice(0, frameLimit).entries()) {
        const sourceIndex = image.sourceIndex;
        if (rejectedIncompleteUrls.has(image.url)) {
          continue;
        }
        if (!buffers[sourceIndex]) {
          const cached = frameBufferByUrlRef.current.get(image.url);
          if (cached) buffers[sourceIndex] = frameBuffer(image, cached);
        }
        if (buffers[sourceIndex]) {
          const frame = image;
          const frameKey = `${frame.id ?? frame.frameId ?? frame.url}:${frame.mjd ?? frame.date ?? ""}`;
          const epoch = frame.source === "synthetic-timeseries" ? {
            shiftX: frame.syntheticShiftX ?? 0,
            shiftY: frame.syntheticShiftY ?? 0,
            motionFraction: frame.syntheticMotionFraction ?? 0,
            motionArcsecPerYear: frame.syntheticMotionArcsecPerYear ?? 0,
            objectOffsetRaArcsec: frame.syntheticObjectOffsetRaArcsec ?? 0,
            objectOffsetDecArcsec: frame.syntheticObjectOffsetDecArcsec ?? 0,
          } : undefined;
          try {
            precacheFitsFrame(buffers[sourceIndex]!, { frameCacheKey: frameKey, url: frame.url, centerRa, centerDec, fieldSizeDeg, syntheticEpoch: epoch, rawPixels: true, noiseReduction });
          } catch { /* The viewer reports invalid FITS data when that frame is selected. */ }
          if (active && !controller.signal.aborted) setFrameBuffers([...buffers]);
          continue;
        }
        try {
          const downloaded = await downloadFrameWithRetries(image.url);
          validateCompleteFrame(image, downloaded);
          frameBufferByUrlRef.current.set(image.url, downloaded);
          buffers[sourceIndex] = frameBuffer(image, downloaded);
          const frameKey = `${image.id ?? image.frameId ?? image.url}:${image.mjd ?? image.date ?? ""}`;
          const epoch = image.source === "synthetic-timeseries" ? {
            shiftX: image.syntheticShiftX ?? 0,
            shiftY: image.syntheticShiftY ?? 0,
            motionFraction: image.syntheticMotionFraction ?? 0,
            motionArcsecPerYear: image.syntheticMotionArcsecPerYear ?? 0,
            objectOffsetRaArcsec: image.syntheticObjectOffsetRaArcsec ?? 0,
            objectOffsetDecArcsec: image.syntheticObjectOffsetDecArcsec ?? 0,
          } : undefined;
          try {
            precacheFitsFrame(downloaded, { frameCacheKey: frameKey, url: image.url, centerRa, centerDec, fieldSizeDeg, syntheticEpoch: epoch, rawPixels: true, noiseReduction });
          } catch { /* Keep the buffer; FITS errors are reported by the viewer on selection. */ }
        } catch (error) {
          if (controller.signal.aborted) break;
          failed++;
          if (error instanceof Error && error.message.startsWith("Incomplete FITS cutout")) {
            rejectedIncompleteUrls.add(image.url);
            frameBufferByUrlRef.current.delete(image.url);
          }
          if (error instanceof Error && /timed out/i.test(error.message)) onIrsaFailure?.();
        }
        if (active && !controller.signal.aborted) {
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
  }, [frameLimit, images, noiseReduction, playbackRecords]);

  useEffect(() => {
    if (!isPlaying || availableFrames.length < 2 || safeEnd <= safeStart) return;
    const intervalId = window.setInterval(() => {
      followLatestRef.current = false;
      const nextStart = safeStart < availableFrames.length - 1 ? safeStart + 1 : 0;
      setRangeStart(nextStart);
    }, intervalDelay);
    return () => window.clearInterval(intervalId);
  }, [availableFrames.length, intervalDelay, isPlaying, safeStart]);

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
  }, [selectedBand, viewMode]);

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
    if (pixel) {
      setSpectrumTarget(`Pixel ${Math.round(pixel.x)}, ${Math.round(pixel.y)}`);
      if (centerRa !== undefined && centerDec !== undefined) {
        const width = viewMode === "multimission" ? 512 : activeCube?.width ?? 128;
        const height = viewMode === "multimission" ? 512 : activeCube?.height ?? 128;
        const ra = (centerRa + (width / 2 - pixel.x) * fieldSizeDeg / width / Math.max(Math.cos(centerDec * Math.PI / 180), 0.01) + 360) % 360;
        const dec = centerDec + (height / 2 - pixel.y) * fieldSizeDeg / height;
        onCursorReadout?.({ ra, dec, x: Math.round(pixel.x), y: Math.round(pixel.y), flux: nextSpectrum?.[Math.max(0, nextSpectrum.length - 1)]?.flux ?? 0 });
      }
    } else onCursorReadout?.(null);
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
      <div className={`band-window-selector${viewMode === "multimission" ? " is-minimal" : ""}`}>
        <div className="viewer-mode-toggle" role="group" aria-label="Image viewer mode">
          <button type="button" className={viewMode === "time" ? "active" : ""} aria-pressed={viewMode === "time"} onClick={() => setViewMode("time")}>Time Motion (WiseView)</button>
          <button type="button" className={viewMode === "spherex" ? "active" : ""} aria-pressed={viewMode === "spherex"} disabled={!spherexEnabled} onClick={() => { setCubeLoadError(""); setViewMode("spherex"); }}>SPHEREx 6-Array RGB</button>
          <button type="button" className={viewMode === "multimission" ? "active" : ""} aria-pressed={viewMode === "multimission"} onClick={() => setViewMode("multimission")}>Multi-mission IR RGB</button>
        </div>
        {viewMode === "time" ? <div className="viewer-sub-controls">
          <label htmlFor="infrared-band">Infrared wavelength</label>
          <select id="infrared-band" value={selectedBand} onChange={(event) => setSelectedBand(event.target.value)}>
            {wavelengthOptions.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div> : viewMode === "spherex" ? <div className="rgb-mappings">
          {([ ["R", redArray, setRedArray], ["G", greenArray, setGreenArray], ["B", blueArray, setBlueArray] ] as const).map(([channel, value, setValue]) => (
            <label key={channel} className={`rgb-mapping rgb-${channel.toLowerCase()}`}><span>{channel}</span><select aria-label={`${channel} color array`} value={value} onChange={(event) => setValue(Number(event.target.value))}>{SPHEREX_ARRAYS.map((array) => <option key={array.index} value={array.index}>{array.label}</option>)}</select></label>
          ))}
          <label className="rgba-toggle"><input type="checkbox" checked={rgbaEnabled} onChange={(event) => setRgbaEnabled(event.target.checked)} /> RGBA</label>
          {rgbaEnabled && <label className="rgb-mapping rgb-a"><span>A</span><select aria-label="Alpha array" value={alphaArray} onChange={(event) => setAlphaArray(Number(event.target.value))}>{SPHEREX_ARRAYS.map((array) => <option key={array.index} value={array.index}>{array.label}</option>)}</select></label>}
          <span className="rgb-grade-label">JWST-inspired · Rust / Gold / Sapphire</span>
        </div> : null}
      </div>

      {viewMode === "spherex" ? <>
        <div className="spectral-source-strip">
          <span className={`spectral-source-badge${hasLiveCube ? " is-live" : " is-synthetic"}`}>{activeCube ? cubeLabel : "Waiting for WISE image data"}</span>
          <span>{hasLiveCube ? "Observed data" : isLoadingIrsaCube ? "Searching archive · model fallback is visualization only" : cubeLoadError ? `Archive unavailable · model fallback is visualization only` : spherexImageCount ? "Spectral cutouts found · model fallback is visualization only" : "Model · not calibrated for science"}</span>
        </div>
        <div className="spectral-source-strip epoch-source-strip"><span>WISE W1/W2 epoch in Arrays 4–6 · short arrays held</span><span>Display-only overlay; SPHEREx spectra remain unchanged</span></div>
        <div className="shared-epoch-controls">
          <span>{frameA ? `WISE epoch · ${mjdLabel(frameA.mjd)}` : "WISE epoch unavailable"}</span>
          <select aria-label="Timeline WISE band" value={selectedBand} onChange={(event) => setSelectedBand(event.target.value)}><option value="wise-w1">W1 · 3.4 μm</option><option value="wise-w2">W2 · 4.6 μm</option></select>
          <input aria-label="SPHEREx display epoch" className="range-input playback-timeline" type="range" min="0" max={maxRangeIndex} step="1" value={safeStart} disabled={availableFrames.length < 2} onChange={(event) => { followLatestRef.current = false; setRangeStart(Number(event.target.value)); }} />
          <button className="image-blinker-toggle" type="button" onClick={() => setIsPlaying((playing) => !playing)} disabled={availableFrames.length < 2} aria-pressed={isPlaying}>{isPlaying ? "Pause" : "Play"}</button>
          <small>{availableFrames.length} epochs · {mjdLabel(availableFrames[0]?.mjd)} – {mjdLabel(availableFrames[availableFrames.length - 1]?.mjd)}</small>
        </div>
        <SpectralCompositeCanvas cube={activeCube} redArray={redArray} greenArray={greenArray} blueArray={blueArray} alphaArray={rgbaEnabled ? alphaArray : undefined} noiseReduction={noiseReduction} zoom={zoom} panOffset={panOffset} onPanChange={onPanChange} onSpectrumChange={handleCanvasSpectrum} showCrosshair={showCrosshair} epochFrames={wiseEpochPair} centerRa={centerRa} centerDec={centerDec} fieldSizeDeg={fieldSizeDeg} />
        {!wiseSpatial && frameA && frameBuffers?.[frameA.sourceIndex] && (
          <div className="cube-spatial-source" aria-hidden="true">
            <FitsCanvasViewer frameCacheKey={frameAKey} buffer={frameBuffers[frameA.sourceIndex]!} url={frameA.url} centerRa={centerRa} centerDec={centerDec} fieldSizeDeg={fieldSizeDeg} noiseReduction={noiseReduction} alt="WISE spatial source for model cube" onSpatialImage={(width, height, values) => setWiseSpatial((current) => current?.values === values ? current : { width, height, values })} />
          </div>
        )}
      </> : viewMode === "multimission" ? <>
      <div className="spectral-source-strip"><span className="spectral-source-badge is-live">DSS2 + WISE survey composite</span><span>Independent survey images · not calibrated SPHEREx data</span></div>
        <div className="shared-epoch-controls">
          <span>{frameA ? `WISE epoch · ${mjdLabel(frameA.mjd)}` : "WISE epoch unavailable"}</span>
          <select aria-label="Timeline WISE band" value={selectedBand} onChange={(event) => setSelectedBand(event.target.value)}><option value="wise-w1">W1 · 3.4 μm</option><option value="wise-w2">W2 · 4.6 μm</option></select>
          <input aria-label="Multi-mission WISE epoch" className="range-input playback-timeline" type="range" min="0" max={maxRangeIndex} step="1" value={safeStart} disabled={availableFrames.length < 2} onChange={(event) => { followLatestRef.current = false; setRangeStart(Number(event.target.value)); }} />
          <button className="image-blinker-toggle" type="button" onClick={() => setIsPlaying((playing) => !playing)} disabled={availableFrames.length < 2} aria-pressed={isPlaying}>{isPlaying ? "Pause" : "Play"}</button>
          <span className="subtraction-tooltip" title="Pixel subtraction requires same-instrument epochs"><button className="image-blinker-toggle subtraction-unavailable" type="button" disabled>Subtract</button></span>
          <small>{availableFrames.length} WISE epochs · DSS2 optical reference stays fixed</small>
        </div>
        <MultiMissionCompositeCanvas surveyFrames={surveyCompositeFrames} wiseFrames={timedWiseCompositeFrames} centerRa={centerRa} centerDec={centerDec} fieldSizeDeg={fieldSizeDeg} onSpectrumChange={handleCanvasSpectrum} showCrosshair={showCrosshair} />
      </> : <>
      <div className="spectral-source-strip"><span className="spectral-source-badge is-live">WISE / NEOWISE single exposures</span></div>
      <div className="single-playback-view">
        <header className="compare-pane-header"><h3>{frameA ? `Frame ${startIdx + 1} / ${availableFrames.length}` : "Time-series playback"}</h3><time>{mjdLabel(frameA?.mjd)}</time></header>
        <div className="image-blinker-frame">
          {frameA && frameBuffers?.[frameA.sourceIndex] ? <FitsCanvasViewer key={`playback:${frameAKey}`} frameCacheKey={frameAKey} buffer={frameBuffers[frameA.sourceIndex]!} url={frameA.url} centerRa={centerRa} centerDec={centerDec} fieldSizeDeg={fieldSizeDeg} zoom={zoom} panOffset={panOffset} onPanChange={onPanChange} rawPixels noiseReduction={noiseReduction} showCrosshair={showCrosshair} onFrameRejected={() => rejectFrame(frameA.sourceIndex)} spectralCube={activeCube} onSpectrumChange={handleCanvasSpectrum} onSpatialImage={(width, height, values) => setWiseSpatial((current) => current?.values === values ? current : { width, height, values })} alt={`${alt}, ${wavelengthLabel}, ${mjdLabel(frameA.mjd)}`} /> : <div className="image-blinker-empty">{isDownloading ? "Receiving NASA frames…" : timeSeriesStatus || "No NASA single-exposure frames available for this position."}</div>}
        </div>
      </div>

      <div className="time-range-panel">
        <input aria-label="Playback frame" className="range-input playback-timeline" type="range" min="0" max={maxRangeIndex} step="1" value={safeStart} disabled={availableFrames.length < 2} onChange={(event) => { followLatestRef.current = false; setRangeStart(Number(event.target.value)); }} />
        <div className="time-range-footer">
          <button className="image-blinker-toggle" type="button" onClick={() => setIsPlaying((playing) => !playing)} disabled={availableFrames.length < 2} aria-pressed={isPlaying}>
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}<span>{isPlaying ? "Pause playback" : isDownloading ? "Preparing frames…" : "Play video"}</span>
          </button>
          <span>{availableFrames.length} dated frames available for this band</span>
        </div>
      </div>

      <div className="pair-tool-controls">
        <button type="button" className="image-blinker-toggle" onClick={() => setShowPairTool((visible) => !visible)} aria-expanded={showPairTool}>{showPairTool ? "Close two-frame tool" : "Add two-frame tool"}</button>
        {showPairTool && <>
          <label>Time difference <select value={timeGap} onChange={(event) => setTimeGap(Number(event.target.value))}>{Array.from({ length: Math.max(1, availableFrames.length - 1) }, (_, index) => index + 1).map((gap) => <option key={gap} value={gap}>{gap} frame{gap === 1 ? "" : "s"}{availableFrames[startIdx + gap]?.mjd ? ` · ${mjdLabel(availableFrames[startIdx + gap].mjd)}` : ""}</option>)}</select></label>
          <div className="difference-mode" role="group" aria-label="Two-frame arithmetic"><button type="button" className={pairOperation === "add" ? "active" : ""} aria-pressed={pairOperation === "add"} onClick={() => setPairOperation("add")}>Add</button><button type="button" className={pairOperation === "subtract" ? "active" : ""} aria-pressed={pairOperation === "subtract"} onClick={() => setPairOperation("subtract")}>Subtract</button></div>
          <span>{mjdLabel(frameA?.mjd)} → {mjdLabel(frameB?.mjd)}</span>
        </>}
      </div>
      {showPairTool && comparisonReady && <div className="pair-result-view"><header className="compare-pane-header"><h3>{pairOperation === "add" ? "A + B" : "|B − A|"}</h3><time>{mjdLabel(frameA?.mjd)} → {mjdLabel(frameB?.mjd)}</time></header><div className="image-blinker-frame"><FitsCanvasViewer key={`pair:${pairOperation}:${frameAKey}:${frameBKey}`} frameCacheKey={frameBKey} compareFrameCacheKey={frameAKey} buffer={frameBuffers![frameB!.sourceIndex]!} compareBuffer={frameBuffers![frameA!.sourceIndex]!} syntheticEpoch={frameBEpoch} compareSyntheticEpoch={frameAEpoch} differenceMode={pairOperation === "add" ? "add" : "motion"} noiseReduction={noiseReduction} centerRa={centerRa} centerDec={centerDec} fieldSizeDeg={fieldSizeDeg} zoom={zoom} panOffset={{ x: 0, y: 0 }} alt={`${pairOperation} of frames ${mjdLabel(frameA?.mjd)} and ${mjdLabel(frameB?.mjd)}`} /></div></div>}

      <div className="image-blinker-controls">
        <span className="image-blinker-count">{totalAvailable}/{frameLimit} frames received{failedCount ? ` · ${failedCount} skipped or failed` : ""}</span>
        {isDownloading && <button className="image-blinker-toggle" type="button" onClick={() => { setIsDownloading(false); controllerRef.current?.abort(); }} aria-label="Stop downloading frames"><Square size={13} /><span>Stop</span></button>}
      </div>
      <div className="image-blinker-limit">
      </div>
      </>}
      <SpectrumChart data={spectrum ?? []} target={spectrumTarget} dataSource={viewMode === "multimission" ? "Live DSS2 + WISE survey bands · approximate wavelengths" : activeCube ? cubeLabel : undefined} />
    </section>
  );
}
