import { NextRequest, NextResponse } from "next/server";
import { setDefaultResultOrder } from "node:dns";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fitsCacheKey } from "@/lib/fitsCache";
import { irsaCachePath } from "@/lib/irsaCachePath";
import { irsaQueryCacheKey, readIrsaJsonCache, writeIrsaJsonCache } from "@/lib/irsaJsonCache";
import { nativeHttpsGet, nativeHttpsGetWithRetry } from "@/lib/nativeHttpsGet";

export const runtime = "nodejs";
export const maxDuration = 60;

const SIA_ENDPOINT = "https://irsa.ipac.caltech.edu/SIA";
const IRSA_HOST = "irsa.ipac.caltech.edu";
const EDGE_CACHE_CONTROL = "public, s-maxage=86400, stale-while-revalidate=604800";
setDefaultResultOrder("ipv4first");

/** Convert decimal degrees or sexagesimal input to decimal degrees. */
function coordinateToDegrees(input: string, isRightAscension: boolean): number | null {
  const value = input.trim();
  if (!value) return null;

  const sexagesimal = /[:hHdDmMsS°′'″\s]/.test(value);
  if (!sexagesimal) {
    const decimal = Number(value);
    return Number.isFinite(decimal) ? decimal : null;
  }

  const parts = value
    .replace(/[hHdDmMsS°′'″]/g, " ")
    .trim()
    .split(/[:\s]+/)
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 3) return null;

  const first = Number(parts[0]);
  const minutes = Number(parts[1] ?? 0);
  const seconds = Number(parts[2] ?? 0);
  if (![first, minutes, seconds].every(Number.isFinite) || minutes >= 60 || seconds >= 60) {
    return null;
  }

  const sign = parts[0].startsWith("-") ? -1 : 1;
  const absolute = Math.abs(first) + minutes / 60 + seconds / 3600;
  return sign * absolute * (isRightAscension ? 15 : 1);
}

function csvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        value += '"';
        index++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    if (row.some((cell) => cell.trim())) rows.push(row);
  }
  return rows;
}

type ImageRecord = {
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
};
type ExposureRecord = { upstreamUrl: string; band: string; mjd: number; distance: number; quality: number };
export type SpherexCubeRecord = { url: string; ra: number; dec: number; pixelScaleArcsec: number | null };

const TIME_SERIES_CUTOUT_MARGIN = 1.5;
const FIRST_EPOCH_MS = Date.UTC(2010, 0, 1);
const LAST_EPOCH_MS = Date.UTC(2024, 11, 31);
const TIMESERIES_CACHE_DIR = irsaCachePath();
type TimeSeriesPayload = {
  status: 200;
  cacheVersion?: 12;
  images: ImageRecord[];
  total: number;
  failed: number;
  failureSummary: string[];
  source: string;
  synthetic?: boolean;
  error?: string;
};
const timeSeriesJobs = new Map<string, Promise<TimeSeriesPayload>>();

function timeSeriesCachePath(ra: number, dec: number, size: number) {
  return path.join(TIMESERIES_CACHE_DIR, `timeseries_${ra.toFixed(4)}_${dec.toFixed(4)}_${size}.json`);
}

async function readTimeSeriesCache(ra: number, dec: number, size: number): Promise<TimeSeriesPayload | null> {
  try {
    const data = JSON.parse(await readFile(timeSeriesCachePath(ra, dec, size), "utf8")) as TimeSeriesPayload;
    return data.status === 200 && data.cacheVersion === 12 && Array.isArray(data.images) && data.images.length > 0 ? data : null;
  } catch {
    return null;
  }
}

async function writeTimeSeriesCache(ra: number, dec: number, size: number, data: TimeSeriesPayload) {
  if (data.status !== 200 || data.images.length === 0) return;
  try {
    await mkdir(TIMESERIES_CACHE_DIR, { recursive: true });
    const destination = timeSeriesCachePath(ra, dec, size);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...data, cacheVersion: 12 }), { flag: "wx" });
    await rename(temporary, destination);
  } catch {
    // Cache failures must not fail an otherwise successful time-series response.
  }
}

function finalizeExposureRecords(records: ExposureRecord[]) {
  // Keep each distinct detector exposure. The viewer validates full field
  // coverage after download, so this metadata pass does not collapse the many
  // real exposures collected during each six-month sky pass.
  return [...new Map(records.map((record) => [record.upstreamUrl, record])).values()]
    .sort((a, b) => a.mjd - b.mjd || a.band.localeCompare(b.band));
}

function imageRecordsFromCsv(csv: string, ra: number, dec: number, size: number): ImageRecord[] {
  const [header, ...rows] = csvRows(csv);
  if (!header) return [];
  const normalizedHeader = header.map((field) => field.trim().toLowerCase());
  const urlIndex = normalizedHeader.findIndex((field) =>
    ["access_url", "sia_url", "url"].includes(field),
  );
  const timeIndex = normalizedHeader.findIndex((field) => ["t_min", "mjd_obs"].includes(field));
  if (urlIndex < 0) return [];

  const records: ImageRecord[] = [];
  for (const row of rows) {
    const candidate = row[urlIndex]?.trim();
    if (!candidate) continue;
    try {
      const parsedUrl = new URL(candidate);
      if (
        parsedUrl.protocol === "https:" &&
        parsedUrl.hostname === "irsa.ipac.caltech.edu" &&
        parsedUrl.pathname.startsWith("/ibe/data/") &&
        /-w([1-4])-int-[^/]+\.fits(?:\.gz)?$/i.test(parsedUrl.pathname)
      ) {
        // Single-exposure pixels are rotated with the spacecraft. Request the
        // diagonal bounding square so reprojection can fill the requested
        // north-up square without clipping its corners.
        parsedUrl.searchParams.set("center", `${ra},${dec}`);
        parsedUrl.searchParams.set("size", `${size * Math.SQRT2}deg`);
        parsedUrl.searchParams.set("gzip", "false");
        const bandMatch = parsedUrl.pathname.match(/-w([1-4])-int-/i);
        const rawTime = timeIndex >= 0 ? row[timeIndex]?.trim() : "";
        const rawMjd = rawTime ? Number(rawTime) : NaN;
        records.push({
          url: `/api/fits?url=${encodeURIComponent(parsedUrl.toString())}`,
          band: bandMatch ? `wise-w${bandMatch[1]}` : "wise",
          mjd: Number.isFinite(rawMjd) ? rawMjd : null,
        });
      }
    } catch {
      // Ignore malformed or non-absolute URL cells.
    }
  }
  const unique = [...new Map(records.map((record) => [record.url, record])).values()];
  return unique.sort((a, b) => (a.mjd ?? Infinity) - (b.mjd ?? Infinity) || a.band.localeCompare(b.band));
}

async function fetchWiseRecords(ra: number, dec: number, size: number) {
  const siaUrl = new URL(SIA_ENDPOINT);
  siaUrl.searchParams.set("COLLECTION", "wise_allwise");
  // Discover the coadd tile around the target center; request the full field
  // later in the cutout URL. Large SIA cones are slow and can time out even
  // though the same atlas tile can provide a wider cutout.
  siaUrl.searchParams.set("POS", `CIRCLE ${ra} ${dec} ${Math.min(size, 0.05)}`);
  siaUrl.searchParams.set("DPTYPE", "image");
  siaUrl.searchParams.set("FORMAT", "image/fits");
  siaUrl.searchParams.set("RESPONSEFORMAT", "CSV");
  siaUrl.searchParams.set("MAXREC", "15");
  const response = await nativeHttpsGetWithRetry(siaUrl, {
    allowedHosts: [IRSA_HOST],
    timeoutMs: 12_000,
    retries: 1,
    maxBytes: 16 * 1024 * 1024,
    headers: { Accept: "text/csv" },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`IRSA WISE request failed with status ${response.statusCode}.`);
  }
  const csv = response.body.toString("utf8");
  if (!csv.trim() || csv.trimStart().startsWith("<")) throw new Error("IRSA returned an unexpected WISE response.");
  return imageRecordsFromCsv(csv, ra, dec, size);
}

function rowsFromIbeCsv(csv: string): Record<string, unknown>[] {
  const [header, ...rows] = csvRows(csv);
  if (!header) return [];
  const columns = header.map((column) => column.trim().toLowerCase());
  return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""])));
}

function exposureRecordsFromRows(rows: Record<string, unknown>[], dataSet: "neowiser" | "allsky", ra: number, dec: number, size: number): ExposureRecord[] {
  const value = (row: Record<string, unknown>, key: string) => row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
  const readMjd = (row: Record<string, unknown>) => {
    const rawMjdValue = value(row, "mjd_obs");
    const rawMjd = rawMjdValue === undefined || rawMjdValue === null || rawMjdValue === "" ? NaN : Number(rawMjdValue);
    if (Number.isFinite(rawMjd)) return rawMjd;
    const dateObs = value(row, "date_obs");
    if (dateObs === undefined || dateObs === null || dateObs === "") return NaN;
    const date = typeof dateObs === "number" ? new Date(dateObs) : new Date(String(dateObs));
    return Number.isFinite(date.getTime()) ? date.getTime() / 86_400_000 + 40_587 : NaN;
  };
  const allowedBands = dataSet === "allsky" ? [1, 2, 3, 4] : [1, 2];
  const records: ExposureRecord[] = [];
  for (const row of rows) {
    const scanId = String(value(row, "scan_id") ?? "").trim();
    const frameNumber = Number(value(row, "frame_num"));
    const bandNumber = Number(value(row, "band"));
    const mjd = readMjd(row);
    const rawQuality = Number(value(row, "qual_frame"));
    const quality = Number.isFinite(rawQuality) ? rawQuality : 1;
    const observedRa = Number(value(row, "ra") ?? ra);
    const observedDec = Number(value(row, "dec") ?? dec);
    if (!scanId || !/^\w{6}$/.test(scanId) || !Number.isInteger(frameNumber) || frameNumber < 0 ||
      !allowedBands.includes(bandNumber) || quality <= 0 || !Number.isFinite(mjd)) continue;

    const observedAt = (mjd - 40_587) * 86_400_000;
    if (observedAt < FIRST_EPOCH_MS || observedAt > LAST_EPOCH_MS) continue;
    const raDistance = Number.isFinite(observedRa) ? ((observedRa - ra + 540) % 360 - 180) * Math.cos(dec * Math.PI / 180) : 0;
    const decDistance = Number.isFinite(observedDec) ? observedDec - dec : 0;
    const distance = raDistance * raDistance + decDistance * decDistance;
    const frame = String(frameNumber).padStart(3, "0");
    const imagePath = `/ibe/data/wise/${dataSet}/${dataSet === "neowiser" ? "p1bm_frm" : "4band_p1bm_frm"}/${scanId.slice(-2)}/${scanId}/${frame}/${scanId}${frame}-w${bandNumber}-int-1b.fits`;
    const fitsUrl = new URL(imagePath, `https://${IRSA_HOST}`);
    fitsUrl.searchParams.set("center", `${ra},${dec}`);
    // The native detector frame is rotated. Fetch a margin around the requested
    // field so WCS reprojection can fill its north-up corners without clipping.
    fitsUrl.searchParams.set("size", `${size * TIME_SERIES_CUTOUT_MARGIN}deg`);
    fitsUrl.searchParams.set("gzip", "false");
    const candidate = { upstreamUrl: fitsUrl.toString(), band: `wise-w${bandNumber}`, mjd, distance, quality };
    records.push(candidate);
  }
  return records;
}

async function fetchTimeSeriesRecords(ra: number, dec: number, size: number) {
  const search = async (dataSet: "neowiser" | "allsky", table: "p1bm_frm" | "4band_p1bm_frm") => {
    const searchUrl = new URL(`/ibe/search/wise/${dataSet}/${table}`, `https://${IRSA_HOST}`);
    searchUrl.searchParams.set("POS", `${ra},${dec}`);
    // Only ask the archive for exposures containing the target coordinate.
    // The FITS cutout step below still requests the full display field.
    searchUrl.searchParams.set("SIZE", "0");
    searchUrl.searchParams.set("INTERSECT", "CENTER");
    searchUrl.searchParams.set("where", dataSet === "allsky"
      ? "qual_frame>0 and mjd_obs between 55197 and 55700"
      : "qual_frame>0 and band in (1,2) and mjd_obs between 56600 and 60700");
    searchUrl.searchParams.set("columns", "scan_id,frame_num,band,mjd_obs,qual_frame");
    // Omit FORMAT: IBE defaults to matching rows; FORMAT=METADATA returns only
    // the schema. The response encoding is `ct`, not SIA's RESPONSEFORMAT.
    searchUrl.searchParams.set("ct", "CSV");
    const response = await nativeHttpsGetWithRetry(searchUrl, {
      allowedHosts: [IRSA_HOST],
      timeoutMs: 12_000,
      retries: 1,
      maxBytes: 32 * 1024 * 1024,
      headers: { Accept: "text/csv" },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`IRSA ${dataSet} image search failed with status ${response.statusCode}.`);
    }
    const rawCsv = response.body.toString("utf8");
    if (rawCsv.trimStart().startsWith("<")) {
      const detail = rawCsv.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
      throw new Error(`IRSA ${dataSet} image search returned XML: ${detail || "empty error response"}`);
    }
    const rows = rowsFromIbeCsv(rawCsv);
    return { rows, rawCsv };
  };

  const settleSearch = async (dataSet: "neowiser" | "allsky", table: "p1bm_frm" | "4band_p1bm_frm") => {
    try {
      return { status: "fulfilled" as const, value: await search(dataSet, table) };
    } catch (reason) {
      return { status: "rejected" as const, reason };
    }
  };
  // Query one catalog at a time: shared Vercel egress can overwhelm IRSA when
  // both spatial searches are issued concurrently.
  const neowiserResult = await settleSearch("neowiser", "p1bm_frm");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const allskyResult = await settleSearch("allsky", "4band_p1bm_frm");
  const neowiser = neowiserResult.status === "fulfilled" ? neowiserResult.value : null;
  const allsky = allskyResult.status === "fulfilled" ? allskyResult.value : null;
  const errors = [
    neowiserResult.status === "rejected" ? `NEOWISER: ${neowiserResult.reason instanceof Error ? neowiserResult.reason.message : String(neowiserResult.reason)}` : null,
    allskyResult.status === "rejected" ? `All-Sky: ${allskyResult.reason instanceof Error ? allskyResult.reason.message : String(allskyResult.reason)}` : null,
  ].filter((message): message is string => Boolean(message));
  const records = [
    ...(neowiser ? exposureRecordsFromRows(neowiser.rows, "neowiser", ra, dec, size) : []),
    ...(allsky ? exposureRecordsFromRows(allsky.rows, "allsky", ra, dec, size) : []),
  ];
  return {
    records: finalizeExposureRecords(records),
    rawMetadataJson: [neowiser?.rawCsv ?? null, allsky?.rawCsv ?? null],
    errors,
  };
}

async function buildTimeSeriesPayload(ra: number, dec: number, size: number): Promise<TimeSeriesPayload> {
  const searchResult = await fetchTimeSeriesRecords(ra, dec, size);
  // Keep the metadata response durable alongside the completed frame manifest.
  try {
    await mkdir(TIMESERIES_CACHE_DIR, { recursive: true });
    const metadataPath = timeSeriesCachePath(ra, dec, size).replace(/\.json$/, ".metadata.json");
    await writeFile(metadataPath, JSON.stringify({ responses: searchResult.rawMetadataJson, errors: searchResult.errors }));
  } catch {
    // Metadata is diagnostic only; failure must not block frame delivery.
  }

  if (searchResult.records.length === 0) {
    return {
      status: 200,
      images: [],
      total: 0,
      failed: 0,
      failureSummary: searchResult.errors,
      source: "no single-exposure observations",
      error: `No real single-exposure frames were returned. The visible AllWISE image is a static coadd, not a time series.${searchResult.errors.length ? ` IRSA search: ${searchResult.errors.join("; ")}` : ""}`,
    };
  }

  const records = searchResult.records;
  return {
    status: 200,
    images: records.map((record) => {
      const id = fitsCacheKey(record.upstreamUrl);
      return {
        id,
        frameId: id,
        url: `/api/fits?url=${encodeURIComponent(record.upstreamUrl)}`,
        band: record.band,
        mjd: record.mjd,
        date: new Date((record.mjd - 40_587) * 86_400_000).toISOString(),
        source: "single-exposure" as const,
      };
    }).sort((a, b) => (a.mjd ?? Infinity) - (b.mjd ?? Infinity) || a.band.localeCompare(b.band)),
    total: records.length,
    failed: 0,
    failureSummary: searchResult.errors,
    source: "IRSA WISE/NEOWISE single-exposure image search (OVERLAPS)",
  };
}

async function fetchSpherexCube(ra: number, dec: number) {
  const siaUrl = new URL(SIA_ENDPOINT);
  siaUrl.searchParams.set("COLLECTION", "spherex_dr1_cube");
  siaUrl.searchParams.set("POS", `CIRCLE ${ra} ${dec} 0`);
  siaUrl.searchParams.set("DPTYPE", "cube");
  siaUrl.searchParams.set("RESPONSEFORMAT", "CSV");
  siaUrl.searchParams.set("MAXREC", "1");
  const response = await nativeHttpsGetWithRetry(siaUrl, {
    allowedHosts: [IRSA_HOST],
    timeoutMs: 12_000,
    retries: 1,
    maxBytes: 16 * 1024 * 1024,
    headers: { Accept: "text/csv" },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`IRSA SPHEREx cube search returned ${response.statusCode}.`);
  const [header, ...rows] = csvRows(response.body.toString("utf8"));
  if (!header || !rows[0]) return null;
  const columns = header.map((field) => field.trim().toLowerCase());
  const cell = (name: string) => rows[0][columns.indexOf(name)]?.trim() ?? "";
  try {
    const url = new URL(cell("access_url"));
    if (url.protocol !== "https:" || url.hostname !== "irsa.ipac.caltech.edu" ||
      !url.pathname.startsWith("/ibe/data/spherex/") || !/\.fits(?:\.gz)?$/i.test(url.pathname)) return null;
    const tileRa = Number(cell("s_ra"));
    const tileDec = Number(cell("s_dec"));
    const pixelScale = Number(cell("s_pixel_scale"));
    if (!Number.isFinite(tileRa) || !Number.isFinite(tileDec)) return null;
    return { url: url.toString(), ra: tileRa, dec: tileDec, pixelScaleArcsec: Number.isFinite(pixelScale) ? pixelScale : null } satisfies SpherexCubeRecord;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const raInput = searchParams.get("ra");
  const decInput = searchParams.get("dec");
  const sizeInput = searchParams.get("size");
  const mode = searchParams.get("mode") ?? "wise";

  if (!raInput || !decInput || !sizeInput) {
    return NextResponse.json(
      { error: "Required query parameters: ra, dec, and size." },
      { status: 400 },
    );
  }

  const ra = coordinateToDegrees(raInput, true);
  const dec = coordinateToDegrees(decInput, false);
  const size = Number(sizeInput);
  if (
    ra === null ||
    ra < 0 ||
    ra >= 360 ||
    dec === null ||
    dec < -90 ||
    dec > 90 ||
    !Number.isFinite(size) ||
    size <= 0 ||
    size > 10
  ) {
    return NextResponse.json(
      { error: "Invalid coordinates or size. Use RA 0–360°, Dec −90–90°, and size in degrees (0–10]." },
      { status: 400 },
    );
  }

  // Version the cached payload shape so older responses with stale band IDs
  // cannot hide newly discovered WISE products from the current selector.
  const collection = mode === "spherex" ? "spherex_dr1_cube" : mode === "timeseries" ? "wise_neowiser_p1bm_frm+wise_allsky_4band_p1bm_frm" : "wise_allwise";
  const cacheKey = irsaQueryCacheKey(JSON.stringify({ version: 6, mode, collection, ra, dec, size }));
  const cached = mode === "timeseries" ? null : await readIrsaJsonCache<{ wiseImages?: ImageRecord[]; spherexImages?: unknown[]; spherexCube?: SpherexCubeRecord | null; source?: string; error?: string }>(cacheKey);
  if (cached && mode !== "timeseries") return NextResponse.json(cached, { headers: { "X-IRSA-Cache": "HIT", "Cache-Control": EDGE_CACHE_CONTROL } });

  if (mode === "timeseries") {
    try {
      const requestedMaxRec = Number(searchParams.get("maxrec"));
      const limitManifest = (payload: TimeSeriesPayload): TimeSeriesPayload => {
        if (!Number.isInteger(requestedMaxRec) || requestedMaxRec < 1) return payload;
        const limit = Math.min(requestedMaxRec, 12);
        return { ...payload, images: payload.images.slice(0, limit), total: Math.min(payload.total, limit) };
      };
      const cachedPayload = await readTimeSeriesCache(ra, dec, size);
      if (cachedPayload) {
        const limited = limitManifest(cachedPayload);
        return NextResponse.json(limited, { headers: { "X-IRSA-Cache": "HIT", "Cache-Control": limited.failureSummary.length ? "no-store" : EDGE_CACHE_CONTROL } });
      }

      const jobKey = `${ra.toFixed(4)}:${dec.toFixed(4)}:${size}`;
      let job = timeSeriesJobs.get(jobKey);
      if (!job) {
        job = buildTimeSeriesPayload(ra, dec, size)
          .then(async (payload) => {
            if (payload.images.length > 0 && payload.status === 200) await writeTimeSeriesCache(ra, dec, size, payload);
            return payload;
          })
          .finally(() => timeSeriesJobs.delete(jobKey));
        timeSeriesJobs.set(jobKey, job);
      }
      const payload = limitManifest(await job);
      return NextResponse.json(payload, { status: 200, headers: { "X-IRSA-Cache": "MISS", "Cache-Control": payload.failureSummary.length ? "no-store" : EDGE_CACHE_CONTROL } });
    } catch (error) {
      console.error("[timeseries error]", error);
      const message = error instanceof Error && error.name === "TimeoutError"
        ? "IRSA single-exposure search timed out."
        : error instanceof Error ? error.message : "Could not search WISE/NEOWISE single-exposure frames.";
      return NextResponse.json({
        status: 200,
        images: [],
        total: 0,
        failed: 0,
        failureSummary: [],
        source: "unavailable",
        error: message,
      }, { status: 200, headers: { "X-IRSA-Cache": "MISS", "Cache-Control": "no-store" } });
    }
  }

  if (mode === "spherex") {
    let spherexCube: SpherexCubeRecord | null = null;
    let spherexCubeError: string | null = null;
    try {
      spherexCube = await fetchSpherexCube(ra, dec);
    } catch (error) {
      spherexCubeError = error instanceof Error ? error.message : "SPHEREx cube search unavailable.";
    }
    const payload = {
      spherexImages: [],
      spherexCube,
      spherexError: null,
      spherexCubeError,
    };
    if (!spherexCubeError) await writeIrsaJsonCache(cacheKey, payload);
    return NextResponse.json(payload, { headers: { "X-IRSA-Cache": "MISS", "Cache-Control": spherexCubeError ? "no-store" : EDGE_CACHE_CONTROL } });
  }

  try {
    const wiseImages = await fetchWiseRecords(ra, dec, size);
    const payload = { wiseImages, source: "IRSA AllWISE Atlas" };
    await writeIrsaJsonCache(cacheKey, payload);
    return NextResponse.json(payload, { headers: { "X-IRSA-Cache": "MISS", "Cache-Control": EDGE_CACHE_CONTROL } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "IRSA WISE search timed out after 20 seconds."
      : error instanceof Error ? error.message : "Could not retrieve WISE image frames from IRSA.";
    return NextResponse.json({ error: message }, { status: 502, headers: { "X-IRSA-Cache": "MISS", "Cache-Control": "no-store" } });
  }
}
