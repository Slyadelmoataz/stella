"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  LocateFixed,
  Minus,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import ImageBlinker from "@/components/ImageBlinker";

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
  syntheticShiftX?: number;
  syntheticShiftY?: number;
  syntheticNoiseSeed?: number;
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
  const [ra, setRa] = useState("08h55m08.699s");
  const [dec, setDec] = useState("-7d14m39.74s");
  const [targetName, setTargetName] = useState(TARGET_PRESETS[0].name);
  const [targetSubtitle, setTargetSubtitle] = useState(TARGET_PRESETS[0].subtitle);
  const [fieldSizeDeg, setFieldSizeDeg] = useState(0.05);
  const [zoom, setZoom] = useState(1.0);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [playbackSpeed, setPlaybackSpeed] = useState(500);
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [simbadObjects, setSimbadObjects] = useState<SimbadObject[]>([]);
  const [selectedSpectrumObject, setSelectedSpectrumObject] = useState<SimbadObject | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeSeriesStatus, setTimeSeriesStatus] = useState("");
  const [irsaFailed, setIrsaFailed] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const timeSeriesControllerRef = useRef<AbortController | null>(null);
  const viewerRa = coordinateToDegrees(ra, true) ?? undefined;
  const viewerDec = coordinateToDegrees(dec, false) ?? undefined;

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
      const objectQuery = new URLSearchParams({ ra: String(decimalRa), dec: String(decimalDec), radius: String(Math.max(0.1, fieldSizeDeg)) });

      const imageTask = (async () => {
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
          if (!controller.signal.aborted) setSimbadObjects(Array.isArray(objects) ? objects : []);
        } catch {
          if (!controller.signal.aborted) {
            setSimbadObjects([]);
            setRequestError((current) => current ? `${current} · Object search unavailable` : "Object search unavailable");
          }
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
  }, [ra, dec, refreshKey, fieldSizeDeg]);

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

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Stella home"><Image src="/stella-logo.png" alt="" width={215} height={148} priority /><span>STELLA</span></a>
      </header>

      <div className="layout">
        <section className="viewer">
          <div className="object-heading">
            <div>
              <h1>{targetName}</h1>
              <p className="subheading">{targetSubtitle}</p>
            </div>
            <button className="subtle-button"><span>Visible light</span><span className="chevron">⌄</span></button>
          </div>

          <ImageBlinker
            images={images}
            playbackSpeed={playbackSpeed}
            centerRa={viewerRa}
            centerDec={viewerDec}
            fieldSizeDeg={fieldSizeDeg}
            zoom={zoom}
            panOffset={panOffset}
            onPanChange={setPanOffset}
            selectedObject={selectedSpectrumObject}
            simbadObjects={simbadObjects}
            irsaFailed={irsaFailed}
            onIrsaFailure={() => setIrsaFailed(true)}
            alt="Astronomical image time-lapse"
          />
          <div className="request-status" aria-live="polite">
            {loading ? "Searching IRSA and SIMBAD…" : requestError || `${images.length} image frames · ${simbadObjects.length} nearby objects`}
            {!loading && timeSeriesStatus ? ` · ${timeSeriesStatus}` : ""}
          </div>

          <div className="viewer-footer">
            <div className="image-caption">{irsaFailed ? "Offline Gaussian Starfield · Model Only" : "Image preview"}</div>
            <div className="zoom-controls">
              <button aria-label="Reset zoom" onClick={() => { setZoom(1); setPanOffset({ x: 0, y: 0 }); }}><RotateCcw size={14} /></button>
              <span className="controls-divider" />
              <button aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(1, +(value - 0.5).toFixed(1)))}><Minus size={14} /></button>
              <span className="zoom-value">{zoom.toFixed(1)}×</span>
              <button aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(10, +(value + 0.5).toFixed(1)))}><Plus size={14} /></button>
            </div>
          </div>
        </section>

        <aside className="sidebar">
          <div className="sidebar-heading"><h2>Observation</h2></div>

          <section className="control-group quick-target-group">
            <div className="group-heading"><h3>Quick targets</h3></div>
            <div className="target-preset-list">
              {TARGET_PRESETS.map((target) => (
                <button key={target.name} type="button" className={target.name === targetName ? "active" : ""} aria-pressed={target.name === targetName} onClick={() => {
                  setRa(target.ra);
                  setDec(target.dec);
                  const isBrownDwarf = target.name === "WISE 0855 Brown Dwarf";
                  setFieldSizeDeg(isBrownDwarf ? 0.05 : 0.25);
                  setZoom(isBrownDwarf ? 1.5 : 1.0);
                  setPanOffset({ x: 0, y: 0 });
                  setTargetName(target.name);
                  setTargetSubtitle(target.subtitle);
                }}>{target.name}</button>
              ))}
            </div>
            <label htmlFor="field-of-view">Field of View</label>
            <select id="field-of-view" className="text-input field-of-view-select" value={fieldSizeDeg} onChange={(event) => setFieldSizeDeg(Number(event.target.value))}>
              {FIELD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </section>

          <section className="control-group coordinates-group">
            <div className="group-heading"><h3>Coordinates</h3><button className="small-icon-button" aria-label="Use current location"><LocateFixed size={15} /></button></div>
            <label htmlFor="right-ascension">Right ascension <span>RA</span></label>
            <input id="right-ascension" className="text-input" value={ra} onChange={(event) => { setRa(event.target.value); setTargetName("Custom target"); setTargetSubtitle("User-entered J2000 coordinates"); }} />
            <label htmlFor="declination">Declination <span>DEC</span></label>
            <input id="declination" className="text-input" value={dec} onChange={(event) => { setDec(event.target.value); setTargetName("Custom target"); setTargetSubtitle("User-entered J2000 coordinates"); }} />
            <button className="locate-button" type="button" onClick={() => setRefreshKey((key) => key + 1)}><Search size={14} /> Refresh results</button>
          </section>

          <section className="control-group range-group">
            <div className="group-heading"><h3>Zoom</h3><output>{zoom.toFixed(1)}×</output></div>
            <input className="range-input" aria-label="Zoom" type="range" min="1" max="10" step="0.1" value={zoom} style={{ "--progress": `${((zoom - 1) / 9) * 100}%` } as React.CSSProperties} onChange={(event) => setZoom(Number(event.target.value))} />
            <div className="range-ends"><span>1×</span><span>10×</span></div>
          </section>

          <section className="control-group range-group playback-group">
            <div className="group-heading"><h3>Playback speed</h3><output>{playbackSpeed} ms</output></div>
            <input className="range-input" aria-label="Playback Speed" type="range" min="100" max="1000" step="50" value={playbackSpeed} style={{ "--progress": `${((playbackSpeed - 100) / 900) * 100}%` } as React.CSSProperties} onChange={(event) => setPlaybackSpeed(Number(event.target.value))} />
            <div className="range-ends"><span>100 ms</span><span>1000 ms</span></div>
          </section>

          <section className="control-group nearby-group">
            <div className="group-heading"><h3>Nearby objects</h3><output>{simbadObjects.length}</output></div>
            {simbadObjects.length === 0 ? (
              <p className="nearby-empty">{loading ? "Searching…" : "No catalog objects found in this radius."}</p>
            ) : (
              <ul className="object-list">
                {simbadObjects.slice(0, 8).map((object, index) => (
                  <li key={`${object.name}-${index}`}>
                    <button type="button" className="object-name object-select-button" onClick={() => setSelectedSpectrumObject(object)} aria-label={`Extract spectrum for ${object.name}`} aria-pressed={selectedSpectrumObject?.name === object.name}>{object.name}</button>
                    <span className="object-type">{object.objectType || "Unknown type"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="sidebar-note">Coordinates use the J2000 reference epoch.</div>
        </aside>
      </div>
    </main>
  );
}
