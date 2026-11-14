"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  Check,
  Copy,
  Expand,
  Minimize2,
  Minus,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import ImageBlinker from "@/components/ImageBlinker";
import type { TimelineLinkState } from "@/components/ImageBlinker";
import { BUILT_IN_IMAGE_SOURCES, loadImageSources, saveImageSources, type ImageSource, type ImageSourceProtocol } from "../../config/imageSources";
import type { NoiseReductionMode } from "../../utils/spectralCube";

type SimbadObject = {
  name: string;
  ra: number;
  dec: number;
  objectType: string;
  spectralType?: string;
};

type ImageRecord = {
  id?: string;
  frameId?: string;
  url: string;
  band: string;
  mjd: number | null;
  source?: "allwise-atlas" | "single-exposure" | "synthetic-timeseries";
  sourceId?: string;
  sourceName?: string;
  agency?: string;
  syntheticShiftX?: number;
  syntheticShiftY?: number;
  syntheticNoiseSeed?: number;
  syntheticMotionFraction?: number;
  syntheticMotionArcsecPerYear?: number;
  syntheticObjectOffsetRaArcsec?: number;
  syntheticObjectOffsetDecArcsec?: number;
};

const TARGET_PRESETS = [
  { name: "WISE 0855 Brown Dwarf", subtitle: "Y-type brown dwarf · 7.2 light-years away", ra: "08h55m10.74s", dec: "-7d14m42.5s" },
  { name: "Tarantula Nebula (30 Dor)", subtitle: "Star-forming nebula · Large Magellanic Cloud", ra: "05h38m42.61s", dec: "-69d06m03.89s" },
  { name: "Orion Nebula (M42)", subtitle: "Emission nebula · Orion Molecular Cloud", ra: "05h35m17.3s", dec: "-5d23m28s" },
  { name: "Pillars of Creation (M16)", subtitle: "Eagle Nebula · Star-forming pillars", ra: "18h18m54.29s", dec: "-13d50m35.65s" },
];

const FIELD_OPTIONS = [
  { value: 0.05, label: "0.05° Zoomed" },
  { value: 0.25, label: "0.25° Nebula Wide" },
  { value: 0.5, label: "0.5° Panoramic" },
];

const MAX_NEARBY_OBJECTS = 40;


function coordinateToDegrees(value: string, isRa: boolean): number | null {
  const input = value.trim();
  if (!input) return null;
  if (!/[:hHdDmMsS°′'″\s]/.test(input)) {
    const number = Number(input);
    return Number.isFinite(number) ? number : null;
  }

  const parts = input.replace(/[hHdDmMsS°′'″]/g, " ").trim().split(/[:\s]+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 3) return null;
  const first = Number(parts[0]);
  const minutes = Number(parts[1] ?? 0);
  const seconds = Number(parts[2] ?? 0);
  if (![first, minutes, seconds].every(Number.isFinite) || minutes >= 60 || seconds >= 60) return null;
  const sign = parts[0].startsWith("-") ? -1 : 1;
  return sign * (Math.abs(first) + minutes / 60 + seconds / 3600) * (isRa ? 15 : 1);
}

export default function Home() {
  const workbenchDisplayRef = useRef<HTMLElement>(null);
  const [ra, setRa] = useState("08h55m10.74s");
  const [dec, setDec] = useState("-7d14m42.5s");
  const [targetName, setTargetName] = useState(TARGET_PRESETS[0].name);
  const [targetSubtitle, setTargetSubtitle] = useState(TARGET_PRESETS[0].subtitle);
  const [fieldSizeDeg, setFieldSizeDeg] = useState(0.05);
  const [zoom, setZoom] = useState(1.0);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [playbackSpeed, setPlaybackSpeed] = useState(500);
  const [noiseReduction, setNoiseReduction] = useState<NoiseReductionMode>("standard");
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [simbadObjects, setSimbadObjects] = useState<SimbadObject[]>([]);
  const [selectedSpectrumObject, setSelectedSpectrumObject] = useState<SimbadObject | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeSeriesStatus, setTimeSeriesStatus] = useState("");
  const [irsaFailed, setIrsaFailed] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [dataSources, setDataSources] = useState<ImageSource[]>(() => BUILT_IN_IMAGE_SOURCES.map((source) => ({ ...source, bands: [...source.bands] })));
  const [sourceRegistryReady, setSourceRegistryReady] = useState(false);
  const [sourceImages, setSourceImages] = useState<ImageRecord[]>([]);
  const [sourceErrors, setSourceErrors] = useState<string[]>([]);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceProtocol, setNewSourceProtocol] = useState<ImageSourceProtocol>("hips2fits");
  const [newSourceEndpoint, setNewSourceEndpoint] = useState("");
  const [newSourceWavelength, setNewSourceWavelength] = useState("");
  const [initialTimeline, setInitialTimeline] = useState<TimelineLinkState | null>(null);
  const [timelineShare, setTimelineShare] = useState<TimelineLinkState>({ band: "wise-w1", view: "time" });
  const [urlInitialized, setUrlInitialized] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [viewerMode, setViewerMode] = useState<TimelineLinkState["view"]>("time");
  const [crosshairEnabled, setCrosshairEnabled] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cursorReadout, setCursorReadout] = useState<{ ra: number; dec: number; x: number; y: number; flux: number } | null>(null);
  const timeSeriesControllerRef = useRef<AbortController | null>(null);
  const viewerRa = coordinateToDegrees(ra, true) ?? undefined;
  const viewerDec = coordinateToDegrees(dec, false) ?? undefined;

  useEffect(() => {
    const syncFullscreenState = () => {
      const active = document.fullscreenElement === workbenchDisplayRef.current;
      setIsFullscreen(active);
      if (active) {
        setZoom(1);
        setPanOffset({ x: 0, y: 0 });
      }
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  async function toggleFullscreen() {
    const viewer = workbenchDisplayRef.current;
    if (!viewer) return;
    if (document.fullscreenElement === viewer) {
      await document.exitFullscreen();
      return;
    }
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    await viewer.requestFullscreen();
  }
  const wiseSourceEnabled = dataSources.find((source) => source.id === "wise-neowise")?.enabled ?? true;
  const spherexSourceEnabled = dataSources.find((source) => source.id === "spherex-archive")?.enabled ?? true;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkedRa = params.get("ra");
    const linkedDec = params.get("dec");
    const linkedSize = Number(params.get("size"));
    const linkedZoom = Number(params.get("zoom"));
    const linkedSpeed = Number(params.get("speed"));
    const linkedTarget = params.get("target");
    const linkedDescription = params.get("description");
    const preset = TARGET_PRESETS.find((item) => item.name === linkedTarget);

    if (linkedRa && coordinateToDegrees(linkedRa, true) !== null) setRa(linkedRa);
    if (linkedDec && coordinateToDegrees(linkedDec, false) !== null) setDec(linkedDec);
    if (FIELD_OPTIONS.some((option) => option.value === linkedSize)) setFieldSizeDeg(linkedSize);
    if (Number.isFinite(linkedZoom) && linkedZoom >= 1 && linkedZoom <= 10) setZoom(linkedZoom);
    if (Number.isFinite(linkedSpeed) && linkedSpeed >= 100 && linkedSpeed <= 1000) setPlaybackSpeed(linkedSpeed);
    if (linkedTarget) {
      setTargetName(linkedTarget);
      setTargetSubtitle(linkedDescription || preset?.subtitle || "Observation opened from a shared link");
    }

    const requestedBand = params.get("band") ?? "wise-w1";
    const validBands = ["wise-w1", "wise-w2", "wise-w3", "wise-w4", "0.75-1.1", "1.1-1.6", "1.6-2.4", "2.4-3.8", "3.8-4.4", "4.4-5.0"];
    const requestedView = params.get("view");
    const timeline: TimelineLinkState = {
      band: validBands.includes(requestedBand) ? requestedBand : "wise-w1",
      view: requestedView === "spherex" || requestedView === "multimission" ? requestedView : "time",
      ...(params.get("from") ? { from: params.get("from")! } : {}),
      ...(params.get("to") ? { to: params.get("to")! } : {}),
    };
    setInitialTimeline(timeline);
    setTimelineShare(timeline);
    setViewerMode(timeline.view);
    setUrlInitialized(true);
  }, []);

  useEffect(() => {
    if (!urlInitialized || viewerRa === undefined || viewerDec === undefined) return;
    const url = new URL(window.location.href);
    url.searchParams.set("ra", viewerRa.toFixed(6));
    url.searchParams.set("dec", viewerDec.toFixed(6));
    url.searchParams.set("size", String(fieldSizeDeg));
    url.searchParams.set("target", targetName);
    url.searchParams.set("description", targetSubtitle);
    url.searchParams.set("zoom", zoom.toFixed(1));
    url.searchParams.set("speed", String(playbackSpeed));
    url.searchParams.set("source", "wise-neowise");
    url.searchParams.set("band", timelineShare.band);
    url.searchParams.set("view", timelineShare.view);
    if (timelineShare.from) url.searchParams.set("from", timelineShare.from);
    else url.searchParams.delete("from");
    if (timelineShare.to) url.searchParams.set("to", timelineShare.to);
    else url.searchParams.delete("to");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [fieldSizeDeg, playbackSpeed, targetName, targetSubtitle, timelineShare, urlInitialized, viewerDec, viewerRa, zoom]);

  useEffect(() => {
    // A previously installed production PWA worker can serve stale HTML while
    // Next dev has different hashed CSS assets, leaving the page unstyled.
    if (process.env.NODE_ENV !== "development" || !("serviceWorker" in navigator)) return;
    let active = true;
    void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
      if (!active || !registrations.length) return;
      const wasControlled = Boolean(navigator.serviceWorker.controller);
      await Promise.all(registrations.map((registration) => registration.unregister()));
      if (active && wasControlled) window.location.reload();
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setDataSources(loadImageSources());
    setSourceRegistryReady(true);
  }, []);
  useEffect(() => {
    if (sourceRegistryReady) saveImageSources(dataSources);
  }, [dataSources, sourceRegistryReady]);

  useEffect(() => {
    // Any new target/FOV needs a fresh centered viewport, including manual
    // coordinate edits and changes made from the quick target buttons.
    setPanOffset({ x: 0, y: 0 });
  }, [dec, fieldSizeDeg, ra]);

  useEffect(() => {
    const decimalRa = coordinateToDegrees(ra, true);
    const decimalDec = coordinateToDegrees(dec, false);
    if (decimalRa === null || decimalRa < 0 || decimalRa >= 360 || decimalDec === null || decimalDec < -90 || decimalDec > 90) {
      setImages([]);
      setSimbadObjects([]);
      setIrsaFailed(false);
      setLoading(false);
      setRequestError("Enter valid RA and Dec coordinates.");
      return;
    }

    const controller = new AbortController();
    timeSeriesControllerRef.current?.abort();
    timeSeriesControllerRef.current = null;
    let timeSeriesController: AbortController | null = null;
    setSelectedSpectrumObject(null);
    setImages([]);
    setTimeSeriesStatus("");
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setRequestError("");
      setIrsaFailed(false);
      const imageQuery = new URLSearchParams({ ra: String(decimalRa), dec: String(decimalDec), size: String(fieldSizeDeg) });
      const objectQuery = new URLSearchParams({ ra: String(decimalRa), dec: String(decimalDec), radius: String(Math.max(0.15, fieldSizeDeg)) });
      setTimeSeriesStatus(wiseSourceEnabled ? "Searching NASA/IRSA for WISE single-exposure frames…" : "WISE / NEOWISE is disabled in Data Sources.");

      const imageTask = (async () => {
        if (!wiseSourceEnabled) {
          setImages([]);
          setTimeSeriesStatus("WISE / NEOWISE is disabled in Data Sources.");
          return;
        }
        try {
          const response = await fetch(`/api/images?${imageQuery}`, { signal: controller.signal });
          const body = await response.json() as { wiseImages?: ImageRecord[]; error?: string };
          if (!response.ok) {
            throw new Error(body.error || "Could not load image frames.");
          }
          if (!controller.signal.aborted) {
            const nextImages = Array.isArray(body.wiseImages)
              ? body.wiseImages.filter((image): image is ImageRecord => Boolean(
                  image && typeof image.url === "string" && typeof image.band === "string" &&
                  (image.mjd === null || typeof image.mjd === "number"),
                )).map((image) => ({ ...image, source: "allwise-atlas" as const }))
              : [];
            setImages(nextImages);
            if (nextImages.length === 0) setRequestError("No WISE image frames cover these coordinates.");
            timeSeriesController = new AbortController();
            timeSeriesControllerRef.current = timeSeriesController;
            void loadTimeSeries(decimalRa, decimalDec, timeSeriesController.signal);
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            setImages([]);
            const message = error instanceof Error ? error.message : "Images unavailable";
            setIrsaFailed(/timed out/i.test(message));
            setRequestError(message);
          }
        }
      })();

      const objectTask = (async () => {
        try {
          const response = await fetch(`/api/objects?${objectQuery}`, { signal: controller.signal });
          if (!response.ok) throw new Error("Could not load nearby objects.");
          const objects = await response.json() as SimbadObject[];
          if (!controller.signal.aborted) setSimbadObjects(Array.isArray(objects) ? objects.slice(0, MAX_NEARBY_OBJECTS) : []);
        } catch {
          if (!controller.signal.aborted) setSimbadObjects([]);
        }
      })();

      void Promise.allSettled([imageTask, objectTask]).then(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, 400);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      timeSeriesController?.abort();
      if (timeSeriesControllerRef.current === timeSeriesController) timeSeriesControllerRef.current = null;
    };
  }, [ra, dec, refreshKey, fieldSizeDeg, wiseSourceEnabled]);

  useEffect(() => {
    if (!sourceRegistryReady) return;
    const decimalRa = coordinateToDegrees(ra, true);
    const decimalDec = coordinateToDegrees(dec, false);
    if (decimalRa === null || decimalDec === null) return;
    const additionalSources = dataSources.filter((source) => source.enabled && !["wise-neowise", "spherex-archive"].includes(source.id));
    if (!additionalSources.length) {
      setSourceImages([]);
      setSourceErrors([]);
      return;
    }
    const controller = new AbortController();
    let active = true;
    void fetch("/api/source-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ra: decimalRa, dec: decimalDec, size: fieldSizeDeg, sources: additionalSources }),
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json() as { images?: ImageRecord[]; errors?: string[]; error?: string };
      if (!response.ok) throw new Error(payload.error || `Additional survey request failed (${response.status}).`);
      if (active) {
        setSourceImages(Array.isArray(payload.images) ? payload.images : []);
        setSourceErrors(Array.isArray(payload.errors) ? payload.errors : []);
      }
    }).catch((error) => {
      if (active && !controller.signal.aborted) {
        setSourceImages([]);
        setSourceErrors([error instanceof Error ? error.message : "Additional survey data unavailable."]);
      }
    });
    return () => { active = false; controller.abort(); };
  }, [dataSources, dec, fieldSizeDeg, ra, sourceRegistryReady]);

  async function loadTimeSeries(decimalRa: number, decimalDec: number, signal: AbortSignal) {
    const query = new URLSearchParams({ mode: "timeseries", ra: String(decimalRa), dec: String(decimalDec), size: String(fieldSizeDeg) });
    try {
      setTimeSeriesStatus("Finding multi-year single-exposure frames…");
      const response = await fetch(`/api/images?${query}`, { signal });
      const result = await response.json() as {
        frames?: ImageRecord[];
        images?: ImageRecord[];
        total?: number;
        failed?: number;
        failureSummary?: string[];
        error?: string;
        synthetic?: boolean;
      };
      if (!response.ok) throw new Error(result.error || "IRSA single-exposure search failed.");
      if (signal.aborted) return;
      const returnedFrames = Array.isArray(result.frames) ? result.frames : result.images;
      const next = (returnedFrames ?? []).filter((image): image is ImageRecord => Boolean(
        image && typeof image.url === "string" && typeof image.band === "string" && typeof image.mjd === "number",
      )).map((image) => ({ ...image, source: image.source === "synthetic-timeseries" ? "synthetic-timeseries" as const : "single-exposure" as const }));
      if (next.length) {
        setImages((current) => {
          const newBands = new Set(next.map((image) => image.band));
          const kept = current.filter((image) => !(image.source === "allwise-atlas" && newBands.has(image.band)));
          const frameKey = (image: ImageRecord) => image.id ?? image.frameId ?? (
            image.source === "synthetic-timeseries" ? `${image.url}|${image.mjd}` : image.url
          );
          const unique = new Map([...kept, ...next].map((image) => [frameKey(image), image]));
          return [...unique.values()].sort((a, b) => (a.mjd ?? Infinity) - (b.mjd ?? Infinity) || a.band.localeCompare(b.band));
        });
      }
      setTimeSeriesStatus(result.synthetic && next.length
        ? `${next.length} illustrative model epochs · derived from AllWISE (not observed time-series data)`
        : result.total === 0
        ? result.error || "No single-exposure epochs found for this position."
        : next.length
          ? `${next.length} dated frames ready${result.failed ? ` · ${result.failed} skipped${result.failureSummary?.length ? ` (${result.failureSummary.join(", ")})` : ""}` : ""}`
          : `No frames retrieved · ${result.failed ?? 0} skipped${result.failureSummary?.length ? ` (${result.failureSummary.join(", ")})` : ""}`);
    } catch (error) {
      if (signal.aborted) return;
      setTimeSeriesStatus(error instanceof Error ? `Time series unavailable · ${error.message}` : "Time series unavailable.");
    }
  }

  function toggleSource(sourceId: string, enabled: boolean) {
    setDataSources((current) => current.map((source) => source.id === sourceId ? { ...source, enabled } : source));
  }

  function saveCustomSource() {
    const name = newSourceName.trim();
    const endpointUrl = newSourceEndpoint.trim();
    const wavelengthRange = newSourceWavelength.trim();
    if (!name || !endpointUrl || !wavelengthRange) return;
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom-source"}-${Date.now().toString(36)}`;
    const source: ImageSource = {
      id,
      name,
      agency: "Custom",
      wavelengthRange,
      protocol: newSourceProtocol,
      endpointUrl,
      bands: ["image"],
      enabled: true,
      supportsTimeSeries: false,
    };
    setDataSources((current) => [...current, source]);
    setShowAddSource(false);
    setNewSourceName("");
    setNewSourceEndpoint("");
    setNewSourceWavelength("");
  }

  function fillSourcePreset(preset: "panstarrs" | "glimpse" | "jwst") {
    if (preset === "panstarrs") {
      setNewSourceName("Pan-STARRS DR1");
      setNewSourceProtocol("hips2fits");
      setNewSourceEndpoint("CDS/P/PanSTARRS/DR1/color");
      setNewSourceWavelength("0.4–1.0 µm");
    } else if (preset === "glimpse") {
      setNewSourceName("Spitzer GLIMPSE");
      setNewSourceProtocol("sia-v2");
      setNewSourceEndpoint("https://irsa.ipac.caltech.edu/SIA");
      setNewSourceWavelength("3.6–8.0 µm");
    } else {
      setNewSourceName("JWST MAST FITS");
      setNewSourceProtocol("direct-fits");
      setNewSourceEndpoint("https://mast.stsci.edu/api/v0.1/Download/file?uri={uri}");
      setNewSourceWavelength("0.6–28 µm");
    }
  }

  function observationMetadataHref() {
    const params = new URLSearchParams({
      ra: String(viewerRa ?? ""),
      dec: String(viewerDec ?? ""),
      size: String(fieldSizeDeg),
      target: targetName,
      description: targetSubtitle,
      band: timelineShare.band,
      view: timelineShare.view,
      zoom: zoom.toFixed(1),
      speed: String(playbackSpeed),
    });
    if (timelineShare.from) params.set("from", timelineShare.from);
    if (timelineShare.to) params.set("to", timelineShare.to);
    return `/api/observations?${params.toString()}`;
  }

  async function copyObservationLink() {
    const apiHref = observationMetadataHref();
    const url = new URL(window.location.href);
    url.search = new URLSearchParams(apiHref.split("?")[1] ?? "").toString();
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1800);
    } catch {
      setShareCopied(false);
    }
  }

  // Keep upstream HTML/error payloads out of the workbench. DSS2's legacy
  // color endpoint can return a branded 404 page; it is not actionable UI.
  const visibleSourceError = sourceErrors
    .filter((error) => !/DSS2 Optical Survey/i.test(error))
    .map((error) => error.split(/\s*:root\b/i)[0].replace(/<[^>]*>/g, "").trim().slice(0, 160))
    .find(Boolean);

  return (
    <main className="app-shell">
      <header className="workbench-topbar">
        <a className="brand" href="#" aria-label="Stella home"><Image src="/stella-logo.png" alt="" width={215} height={148} priority /><span>STELLA</span><small>ASTRONOMICAL WORKBENCH</small></a>
        <div className="telemetry-readout" aria-live="polite">
          {cursorReadout ? <><span>RA <b>{cursorReadout.ra.toFixed(6)}°</b></span><span>Dec <b>{cursorReadout.dec.toFixed(6)}°</b></span><span>Pix <b>{cursorReadout.x},{cursorReadout.y}</b></span><span>Flux <b>{cursorReadout.flux.toExponential(3)}</b></span></> : <span className="telemetry-idle">MOVE CURSOR OVER IMAGE FOR WCS / FLUX</span>}
        </div>
        <nav className="topbar-mode-tabs" aria-label="Viewer mode">
          {[{ id: "spherex", title: "SPHEREx 6-Array RGB" }, { id: "time", title: "Time Motion Blinker" }, { id: "multimission", title: "Multi-mission" }].map(({ id, title }) => <button key={id} type="button" className={viewerMode === id ? "active" : ""} aria-pressed={viewerMode === id} disabled={id === "spherex" && !spherexSourceEnabled} onClick={() => setViewerMode(id as TimelineLinkState["view"])}>{title}</button>)}
        </nav>
      </header>

      <div className="workbench-main">
        <section className="workbench-display" ref={workbenchDisplayRef}>
          <div className="viewport-title"><div><strong>{targetName}</strong><span>{targetSubtitle}</span></div><div className="viewport-actions"><button type="button" className={`reticle-toggle${crosshairEnabled ? " active" : ""}`} aria-pressed={crosshairEnabled} onClick={() => setCrosshairEnabled((enabled) => !enabled)}>＋ Crosshair</button><button type="button" className="reticle-toggle fullscreen-toggle" aria-label={isFullscreen ? "Exit full screen" : "Fit image to full screen"} title={isFullscreen ? "Exit full screen" : "Fit image to full screen"} onClick={() => { void toggleFullscreen(); }}>{isFullscreen ? <Minimize2 size={13} aria-hidden="true" /> : <Expand size={13} aria-hidden="true" />}<span>{isFullscreen ? "Exit" : "Full screen"}</span></button></div></div>
          <ImageBlinker
            images={images}
            sourceImages={sourceImages}
            playbackSpeed={playbackSpeed}
            noiseReduction={noiseReduction}
            centerRa={viewerRa}
            centerDec={viewerDec}
            fieldSizeDeg={fieldSizeDeg}
            spherexEnabled={spherexSourceEnabled}
            zoom={zoom}
            panOffset={panOffset}
            onPanChange={setPanOffset}
            selectedObject={selectedSpectrumObject}
            simbadObjects={simbadObjects}
            irsaFailed={irsaFailed}
            timeSeriesStatus={timeSeriesStatus}
            initialTimeline={initialTimeline}
            onTimelineStateChange={setTimelineShare}
            viewMode={viewerMode}
            onViewModeChange={setViewerMode}
            showCrosshair={crosshairEnabled}
            onCursorReadout={setCursorReadout}
            onIrsaFailure={() => setIrsaFailed(true)}
            alt="Astronomical image time-lapse"
          />
          {(loading || requestError) && <div className="request-status" aria-live="polite">{loading ? "Loading observation…" : requestError}</div>}

        </section>

        <aside className="sidebar inspector-rail">
          <details className="inspector-section" open>
            <summary>TARGET &amp; COORDINATES</summary>
            <div className="inspector-content">
              <div className="target-preset-list">
                {TARGET_PRESETS.map((target) => <button key={target.name} type="button" className={target.name === targetName ? "active" : ""} aria-pressed={target.name === targetName} onClick={() => {
                  setRa(target.ra); setDec(target.dec); const isBrownDwarf = target.name === "WISE 0855 Brown Dwarf";
                  setFieldSizeDeg(isBrownDwarf ? 0.05 : 0.25); setZoom(isBrownDwarf ? 1.5 : 1); setPanOffset({ x: 0, y: 0 });
                  setTargetName(target.name); setTargetSubtitle(target.subtitle);
                }}>{target.name}</button>)}
              </div>
              <label htmlFor="right-ascension">Right ascension <span>RA</span></label>
              <input id="right-ascension" className="text-input" value={ra} onChange={(event) => { setRa(event.target.value); setTargetName("Custom target"); setTargetSubtitle("User-entered J2000 coordinates"); }} />
              <label htmlFor="declination">Declination <span>DEC</span></label>
              <input id="declination" className="text-input" value={dec} onChange={(event) => { setDec(event.target.value); setTargetName("Custom target"); setTargetSubtitle("User-entered J2000 coordinates"); }} />
              <label htmlFor="field-of-view">Field of view</label>
              <select id="field-of-view" className="text-input field-of-view-select" value={fieldSizeDeg} onChange={(event) => { setFieldSizeDeg(Number(event.target.value)); setPanOffset({ x: 0, y: 0 }); }}>
                {FIELD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <button className="locate-button" type="button" onClick={() => setRefreshKey((key) => key + 1)}><Search size={14} /> Refresh results</button>
              <div className="observation-link-tools"><button type="button" className="share-link-button" onClick={() => void copyObservationLink()}>{shareCopied ? <Check size={13} /> : <Copy size={13} />}{shareCopied ? "Copied link" : "Copy observation link"}</button><a className="metadata-api-link" href={observationMetadataHref()} target="_blank" rel="noreferrer">Open JSON metadata / webhook API</a></div>
            </div>
          </details>

          <details className="inspector-section" open>
            <summary>DATA SOURCES <span>{dataSources.filter((source) => source.enabled).length} ACTIVE</span></summary>
            <div className="inspector-content">
            <div className="data-source-list">
              {dataSources.map((source) => <label className="data-source-row" key={source.id}>
                <input type="checkbox" checked={source.enabled} onChange={(event) => toggleSource(source.id, event.target.checked)} />
                <span className="data-source-copy"><strong>{source.name}</strong><small>{source.agency} · {source.wavelengthRange}{source.supportsTimeSeries ? " · time series" : ""}</small></span>
              </label>)}
            </div>
            <button type="button" className="add-source-button" onClick={() => setShowAddSource(true)}>＋ Add Source</button>
            {visibleSourceError && <p className="source-fetch-error">{visibleSourceError}</p>}
            </div>
          </details>

          <details className="inspector-section" open>
            <summary>DISPLAY &amp; NOISE</summary>
            <div className="inspector-content">
            <div className="group-heading"><h3>Zoom</h3><output>{zoom.toFixed(1)}×</output></div>
            <div className="zoom-controls"><button aria-label="Reset zoom" onClick={() => { setZoom(1); setPanOffset({ x: 0, y: 0 }); }}><RotateCcw size={14} /></button><button aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(1, +(value - 0.5).toFixed(1)))}><Minus size={14} /></button><span className="zoom-value">{zoom.toFixed(1)}×</span><button aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(10, +(value + 0.5).toFixed(1)))}><Plus size={14} /></button></div>
            <input className="range-input" aria-label="Zoom" type="range" min="1" max="10" step="0.1" value={zoom} style={{ "--progress": `${((zoom - 1) / 9) * 100}%` } as React.CSSProperties} onChange={(event) => setZoom(Number(event.target.value))} />
            <div className="range-ends"><span>1×</span><span>10×</span></div>
            <div className="group-heading"><h3>Playback speed</h3><output>{playbackSpeed} ms</output></div>
            <input className="range-input" aria-label="Playback Speed" type="range" min="100" max="1000" step="50" value={playbackSpeed} style={{ "--progress": `${((playbackSpeed - 100) / 900) * 100}%` } as React.CSSProperties} onChange={(event) => setPlaybackSpeed(Number(event.target.value))} />
            <div className="range-ends"><span>100 ms</span><span>1000 ms</span></div>
            <div className="group-heading"><h3>Noise reduction</h3></div>
            <select className="noise-reduction-select" aria-label="Noise reduction" value={noiseReduction} onChange={(event) => setNoiseReduction(event.target.value as NoiseReductionMode)}>
              <option value="off">Off</option>
              <option value="standard">Standard</option>
              <option value="aggressive">Aggressive</option>
            </select>
            </div>
          </details>

          <details className="inspector-section" open>
            <summary>CATALOG CROSS-MATCH <span>{simbadObjects.length}</span></summary>
            <div className="inspector-content">
            <div className="group-heading"><h3>Nearby objects</h3><output>{simbadObjects.length}</output></div>
            {simbadObjects.length === 0 ? (
              <p className="nearby-empty">{loading ? "Searching…" : "No catalog objects found in this radius."}</p>
            ) : (
              <ul className="object-list">
                {simbadObjects.slice(0, MAX_NEARBY_OBJECTS).map((object, index) => (
                  <li key={`${object.name}-${index}`}>
                    <button type="button" className="object-name object-select-button" onClick={() => setSelectedSpectrumObject(object)} aria-label={`Extract spectrum for ${object.name}`} aria-pressed={selectedSpectrumObject?.name === object.name}>{object.name}</button>
                    <span className="object-type">{object.objectType || "Unknown type"}</span>
                  </li>
                ))}
              </ul>
            )}
            </div>
          </details>

        </aside>
      </div>
      {showAddSource && <div className="source-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAddSource(false); }}>
        <section className="source-modal" role="dialog" aria-modal="true" aria-labelledby="add-source-title">
          <header><div><h2 id="add-source-title">Add astronomical source</h2><p>Register a FITS image, HiPS survey, or SIA endpoint.</p></div><button type="button" aria-label="Close" onClick={() => setShowAddSource(false)}>×</button></header>
          <div className="source-presets"><button type="button" onClick={() => fillSourcePreset("panstarrs")}>Pan-STARRS DR1</button><button type="button" onClick={() => fillSourcePreset("glimpse")}>Spitzer GLIMPSE</button><button type="button" onClick={() => fillSourcePreset("jwst")}>JWST MAST FITS</button></div>
          <label>Source name<input value={newSourceName} onChange={(event) => setNewSourceName(event.target.value)} placeholder="Survey or instrument name" /></label>
          <label>Protocol<select value={newSourceProtocol} onChange={(event) => setNewSourceProtocol(event.target.value as ImageSourceProtocol)}><option value="hips2fits">HiPS2FITS Survey ID</option><option value="sia-v2">IRSA SIA v2 endpoint</option><option value="direct-fits">Direct FITS URL</option></select></label>
          <label>Endpoint / Survey ID<input value={newSourceEndpoint} onChange={(event) => setNewSourceEndpoint(event.target.value)} placeholder="CDS/P/... or https://…" /></label>
          <label>Wavelength range (µm)<input value={newSourceWavelength} onChange={(event) => setNewSourceWavelength(event.target.value)} placeholder="e.g. 0.4–0.9 µm" /></label>
          <footer><button type="button" className="image-blinker-toggle" onClick={() => setShowAddSource(false)}>Cancel</button><button type="button" className="locate-button" disabled={!newSourceName.trim() || !newSourceEndpoint.trim() || !newSourceWavelength.trim()} onClick={saveCustomSource}>Save and fetch at current coordinates</button></footer>
        </section>
      </div>}
    </main>
  );
}
