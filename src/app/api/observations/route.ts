import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

type Frame = {
  id?: string;
  frameId?: string;
  url: string;
  band: string;
  mjd: number | null;
  date?: string;
  source?: string;
};

type CachedTimeline = {
  status?: number;
  cacheVersion?: number;
  source?: string;
  images?: Frame[];
  total?: number;
  failed?: number;
  failureSummary?: string[];
};

const CACHE_DIR = path.join(process.cwd(), ".cache", "irsa");
const CACHE_VERSION = 12;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function makeLinks(
  requestUrl: URL,
  ra: number,
  dec: number,
  size: number,
  band: string,
  from: string,
  to: string,
  target: string,
  description: string,
  mode: string,
  zoom: number | null,
  speed: number | null,
) {
  const params = new URLSearchParams({ ra: String(ra), dec: String(dec), size: String(size) });
  const timeSeriesParams = new URLSearchParams({ ra: String(ra), dec: String(dec), size: String(size), mode: "timeseries" });
  const metadataParams = new URLSearchParams({
    ra: String(ra), dec: String(dec), size: String(size), band, target, description, view: mode,
  });
  if (zoom !== null) metadataParams.set("zoom", String(zoom));
  if (speed !== null) metadataParams.set("speed", String(speed));
  if (from) metadataParams.set("from", from);
  if (to) metadataParams.set("to", to);
  return {
    webpage: `${requestUrl.origin}/?${metadataParams.toString()}`,
    metadata: `${requestUrl.origin}/api/observations?${metadataParams.toString()}`,
    frames: `${requestUrl.origin}/api/images?${timeSeriesParams.toString()}`,
    nearbyObjects: `${requestUrl.origin}/api/objects?${params.toString()}`,
  };
}

async function respond(request: NextRequest, params: URLSearchParams) {
  const requestUrl = new URL(request.url);
  const ra = Number(params.get("ra"));
  const dec = Number(params.get("dec"));
  const size = Number(params.get("size"));
  const band = params.get("band") ?? "wise-w1";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const target = params.get("target") ?? "Custom target";
  const description = params.get("description") ?? "";
  const mode = params.get("view") ?? "time";
  const zoomValue = params.has("zoom") ? Number(params.get("zoom")) : null;
  const speedValue = params.has("speed") ? Number(params.get("speed")) : null;
  const fromTime = from ? Date.parse(from) : null;
  const toTime = to ? Date.parse(to) : null;

  if (!Number.isFinite(ra) || ra < 0 || ra >= 360 || !Number.isFinite(dec) || dec < -90 || dec > 90 || !Number.isFinite(size) || size <= 0 || size > 10 ||
    (from && !Number.isFinite(fromTime)) || (to && !Number.isFinite(toTime))) {
    return NextResponse.json({ error: "Provide valid ra, dec, size, and optional ISO from/to dates." }, { status: 400, headers: CORS_HEADERS });
  }

  if ((zoomValue !== null && (!Number.isFinite(zoomValue) || zoomValue < 1 || zoomValue > 10)) ||
    (speedValue !== null && (!Number.isFinite(speedValue) || speedValue < 100 || speedValue > 1000))) {
    return NextResponse.json({ error: "Zoom must be 1–10 and speed must be 100–1000 ms." }, { status: 400, headers: CORS_HEADERS });
  }

  const links = makeLinks(requestUrl, ra, dec, size, band, from, to, target, description, mode, zoomValue, speedValue);
  let cached: CachedTimeline | null = null;
  try {
    const cachePath = path.join(CACHE_DIR, `timeseries_${ra.toFixed(4)}_${dec.toFixed(4)}_${size}.json`);
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as CachedTimeline;
    if (parsed.status === 200 && parsed.cacheVersion === CACHE_VERSION && Array.isArray(parsed.images)) cached = parsed;
  } catch {
    // A missing manifest means the asynchronous frames endpoint has not filled this cache yet.
  }

  if (!cached) {
    return NextResponse.json({
      status: "pending",
      target,
      description: description || null,
      coordinates: { ra, dec, system: "ICRS/J2000", units: "degrees" },
      fieldOfView: { size, units: "degrees" },
      links,
      message: "No cached time-series manifest exists yet. Request the frames link, then poll this metadata URL again.",
    }, { status: 202, headers: { ...CORS_HEADERS, "Retry-After": "10", "Cache-Control": "no-store" } });
  }

  const frames = cached.images!.filter((frame) => {
    if (band && frame.band !== band) return false;
    const timestamp = frame.mjd === null ? NaN : (frame.mjd - 40_587) * 86_400_000;
    if (fromTime !== null && Number.isFinite(timestamp) && timestamp < fromTime) return false;
    if (toTime !== null && Number.isFinite(timestamp) && timestamp > toTime) return false;
    return true;
  }).map((frame) => ({
    id: frame.id ?? frame.frameId ?? frame.url,
    band: frame.band,
    mjd: frame.mjd,
    date: frame.date ?? (frame.mjd === null ? null : new Date((frame.mjd - 40_587) * 86_400_000).toISOString()),
    source: frame.source ?? "single-exposure",
    fits: new URL(frame.url, requestUrl).toString(),
  }));

  return NextResponse.json({
    schemaVersion: 1,
    status: "ready",
    generatedAt: new Date().toISOString(),
    target,
    description: description || null,
    coordinates: { ra, dec, system: "ICRS/J2000", units: "degrees" },
    fieldOfView: { size, units: "degrees" },
    view: { mode, band, from: from || null, to: to || null, zoom: zoomValue, playbackSpeedMs: speedValue },
    source: cached.source ?? "NASA/IRSA WISE single exposures",
    frameCount: frames.length,
    availableFrameCount: cached.images!.length,
    failedFrameCount: cached.failed ?? 0,
    failures: cached.failureSummary ?? [],
    links,
    frames,
  }, { headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=30" } });
}

export async function GET(request: NextRequest) {
  return respond(request, new URL(request.url).searchParams);
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON observation request." }, { status: 400, headers: CORS_HEADERS });
  }
  const params = new URLSearchParams();
  for (const key of ["ra", "dec", "size", "band", "from", "to", "target", "description", "view", "zoom", "speed"] as const) {
    const value = body[key];
    if (typeof value === "string" || typeof value === "number") params.set(key, String(value));
  }
  return respond(request, params);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
