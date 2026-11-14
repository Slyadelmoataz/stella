"use client";

import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SpectrumPoint } from "../../utils/spectralCube";

export default function SpectrumChart({ data, target, dataSource }: { data: SpectrumPoint[]; target?: string; dataSource?: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const resizeDrag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const maxPanelHeight = () => Math.max(160, Math.min(520, window.innerHeight * 0.6));
  const resizePanel = (height: number) => {
    const nextHeight = Math.max(88, Math.min(maxPanelHeight(), height));
    setPanelHeight(nextHeight);
    setCollapsed(false);
  };
  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeDrag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: event.currentTarget.parentElement?.getBoundingClientRect().height ?? (panelHeight ?? 192),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizePanel(drag.startHeight + drag.startY - event.clientY);
  };
  const handleResizePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeDrag.current?.pointerId !== event.pointerId) return;
    resizeDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentHeight = panelHeight ?? (collapsed ? 38 : 192);
    if (event.key === "ArrowUp") resizePanel(currentHeight + 16);
    else if (event.key === "ArrowDown") resizePanel(currentHeight - 16);
    else if (event.key === "Home") resizePanel(88);
    else if (event.key === "End") resizePanel(maxPanelHeight());
    else return;
    event.preventDefault();
  };
  const exportCsv = () => {
    if (!data.length) return;
    const rows = ["wavelength_um,sky_subtracted_flux", ...data.map(({ wavelength, flux }) => `${wavelength},${flux}`)];
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `stella-spectrum-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className={`spectrum-panel${collapsed ? " is-collapsed" : ""}`} aria-label="Extracted spectrum" style={panelHeight === null ? undefined : { "--spectrum-height": `${panelHeight}px` } as CSSProperties}>
      <div className="spectrum-resize-handle" role="separator" aria-label="Resize image frame and live spectrum" aria-orientation="horizontal" aria-valuemin={88} aria-valuemax={520} aria-valuenow={Math.round(panelHeight ?? (collapsed ? 38 : 192))} tabIndex={0} onPointerDown={handleResizePointerDown} onPointerMove={handleResizePointerMove} onPointerUp={handleResizePointerEnd} onPointerCancel={handleResizePointerEnd} onKeyDown={handleResizeKeyDown}><span /></div>
      <header className="spectrum-heading">
        <div><h3>Live Spectrum{target ? ` · ${target}` : ""}</h3>{!collapsed && <><p>Hover or click an image coordinate or nearby object</p>{dataSource && <span className={`spectrum-source-label${dataSource.startsWith("Live") ? " is-live" : " is-synthetic"}`}>{dataSource}</span>}</>}</div>
        <div className="spectrum-heading-actions"><span>μm · sky-subtracted flux</span><button type="button" onClick={exportCsv} disabled={!data.length}>Export CSV</button><button type="button" aria-label={collapsed ? "Expand live spectrum" : "Collapse live spectrum"} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button></div>
      </header>
      {!collapsed && (data.length ? <div className="spectrum-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 18, bottom: 4, left: 2 }}>
            <CartesianGrid stroke="#282b31" strokeDasharray="3 4" />
            <XAxis dataKey="wavelength" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "#9297a0", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "#41444b" }} label={{ value: "Wavelength (μm)", position: "insideBottom", offset: -2, fill: "#a9aeb7", fontSize: 10 }} />
            <YAxis tick={{ fill: "#9297a0", fontSize: 10 }} tickLine={false} axisLine={false} width={52} label={{ value: "Flux", angle: -90, position: "insideLeft", fill: "#a9aeb7", fontSize: 10 }} />
            <Tooltip contentStyle={{ background: "#101216", border: "1px solid #383b43", borderRadius: 3, fontSize: 11 }} labelFormatter={(value) => `${Number(value).toFixed(4)} μm`} formatter={(value) => [Number(value).toPrecision(5), "Flux"]} />
            <ReferenceLine x={3.0} stroke="#52616e" strokeDasharray="3 5" label={{ value: "H₂O Ice", fill: "#82909c", fontSize: 8, position: "insideTopLeft" }} />
            <ReferenceLine x={3.3} stroke="#52616e" strokeDasharray="3 5" label={{ value: "CH₄", fill: "#82909c", fontSize: 8, position: "insideTop" }} />
            <ReferenceLine x={4.26} stroke="#52616e" strokeDasharray="3 5" label={{ value: "CO₂", fill: "#82909c", fontSize: 8, position: "insideTopRight" }} />
            <Line type="linear" dataKey="flux" stroke="#E2E8F0" strokeWidth={2} dot={{ r: 3, fill: "#E2E8F0", stroke: "#0B0E14", strokeWidth: 1 }} activeDot={{ r: 4, fill: "#fff", stroke: "#0B0E14", strokeWidth: 1 }} isAnimationActive={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div> : <div className="spectrum-empty">{dataSource ? dataSource.startsWith("Live") ? "Select a canvas coordinate or nearby source to extract its spectrum." : "Synthetic SED preview only. It is illustrative and must not be used as measured SPHEREx photometry." : "Waiting for WISE image data to prepare a labeled spectral preview. WISE frames alone do not contain wavelength-resolved spectra."}</div>)}
    </section>
  );
}
