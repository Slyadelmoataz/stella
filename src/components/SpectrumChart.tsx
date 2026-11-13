"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SpectrumPoint } from "../../utils/spectralCube";

export default function SpectrumChart({ data, target, dataSource }: { data: SpectrumPoint[]; target?: string; dataSource?: string }) {
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
    <section className="spectrum-panel" aria-label="Extracted spectrum">
      <header className="spectrum-heading">
        <div><h3>Live Spectrum{target ? ` · ${target}` : ""}</h3><p>Hover or click an image coordinate or nearby object</p>{dataSource && <span className={`spectrum-source-label${dataSource.startsWith("Live") ? " is-live" : " is-synthetic"}`}>{dataSource}</span>}</div>
        <div className="spectrum-heading-actions"><span>μm · sky-subtracted flux</span><button type="button" onClick={exportCsv} disabled={!data.length}>Export CSV</button></div>
      </header>
      {data.length ? <div className="spectrum-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 18, bottom: 4, left: 2 }}>
            <CartesianGrid stroke="#282b31" strokeDasharray="3 4" />
            <XAxis dataKey="wavelength" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "#9297a0", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "#41444b" }} label={{ value: "Wavelength (μm)", position: "insideBottom", offset: -2, fill: "#a9aeb7", fontSize: 10 }} />
            <YAxis tick={{ fill: "#9297a0", fontSize: 10 }} tickLine={false} axisLine={false} width={52} label={{ value: "Flux", angle: -90, position: "insideLeft", fill: "#a9aeb7", fontSize: 10 }} />
            <Tooltip contentStyle={{ background: "#101216", border: "1px solid #383b43", borderRadius: 3, fontSize: 11 }} labelFormatter={(value) => `${Number(value).toFixed(4)} μm`} formatter={(value) => [Number(value).toPrecision(5), "Flux"]} />
            <ReferenceLine x={3.0} stroke="#b8a9ff" strokeDasharray="4 4" label={{ value: "Water ice · 3.0 μm", fill: "#c5b9ee", fontSize: 9, position: "insideTopLeft" }} />
            <ReferenceLine x={3.3} stroke="#8dcab4" strokeDasharray="4 4" label={{ value: "Methane · 3.3 μm", fill: "#8dcab4", fontSize: 9, position: "insideTop" }} />
            <ReferenceLine x={4.67} stroke="#e4b77a" strokeDasharray="4 4" label={{ value: "CO · 4.67 μm", fill: "#e4b77a", fontSize: 9, position: "insideTopRight" }} />
            <Line type="monotone" dataKey="flux" stroke="#c2b6ff" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div> : <div className="spectrum-empty">{dataSource ? dataSource.startsWith("Live") ? "Select a canvas coordinate or nearby source to extract its spectrum." : "Synthetic SED preview only. It is illustrative and must not be used as measured SPHEREx photometry." : "Waiting for WISE image data to prepare a labeled spectral preview. WISE frames alone do not contain wavelength-resolved spectra."}</div>}
    </section>
  );
}
