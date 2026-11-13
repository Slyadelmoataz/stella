import { NextRequest, NextResponse } from "next/server";
import { setDefaultResultOrder } from "node:dns";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fitsCacheKey, readFitsCache, writeFitsCache } from "@/lib/fitsCache";
import { irsaQueryCacheKey, readIrsaJsonCache, writeIrsaJsonCache } from "@/lib/irsaJsonCache";
import { nativeHttpsGet } from "@/lib/nativeHttpsGet";

export const runtime = "nodejs";

const SIA_ENDPOINT = "https://irsa.ipac.caltech.edu/SIA";
const IRSA_HOST = "irsa.ipac.caltech.edu";
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
  url: string;
  band: string;
  mjd: number | null;
  source?: "allwise-atlas" | "single-exposure" | "synthetic-timeseries";
  syntheticShiftX?: number;
  syntheticShiftY?: number;
  syntheticNoiseSeed?: number;
};
type ExposureRecord = { upstreamUrl: string; band: string; mjd: number; distance: number; quality: number };
type FitsDimensions = { width: number; height: number };
export type SpherexCubeRecord = { url: string; ra: number; dec: number; pixelScaleArcsec: number | null };

const MAX_FITS_BYTES = 20 * 1024 * 1024;
const TIME_SERIES_DOWNLOAD_CONCURRENCY = 1;
const SIX_MONTHS_MS = 182.62125 * 86_400_000;
const FIRST_EPOCH_MS = Date.UTC(2010, 0, 1);
const LAST_EPOCH_MS = Date.UTC(2024, 11, 31);
const TIMESERIES_CACHE_DIR = path.join(process.cwd(), ".cache", "irsa");
type TimeSeriesPayload = {
  status: 200;
  cacheVersion?: 5;
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
    return data.status === 200 && data.cacheVersion === 5 && Array.isArray(data.images) && data.images.length > 0 ? data : null;
  } catch {
    return null;
  }
}

async function writeTimeSeriesCache(ra: number, dec: number, size: number, data: TimeSeriesPayload) {
  if (data.status !== 200 || data.images.length === 0) return;
  await mkdir(TIMESERIES_CACHE_DIR, { recursive: true });
  const destination = timeSeriesCachePath(ra, dec, size);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...data, cacheVersion: 5 }), { flag: "wx" });
  await rename(temporary, destination);
}

function fitsImageDimensions(bytes: Uint8Array): FitsDimensions | null {
  const blockSize = 2880;
  let offset = 0;
  while (offset + blockSize <= bytes.byteLength) {
    const cards = new Map<string, string>();
    let headerEnd = offset;
    let foundEnd = false;
    while (headerEnd + blockSize <= bytes.byteLength && !foundEnd) {
      const blockEnd = headerEnd + blockSize;
      for (let cardOffset = headerEnd; cardOffset < blockEnd; cardOffset += 80) {
        const card = String.fromCharCode(...bytes.subarray(cardOffset, cardOffset + 80));
        const key = card.slice(0, 8).trim();
        if (key === "END") {
          headerEnd = cardOffset + 80;
          foundEnd = true;
          break;
        }
        if (card[8] === "=") cards.set(key, card.slice(10).split("/")[0].trim());
      }
      if (!foundEnd) headerEnd = blockEnd;
    }
    if (!foundEnd) return null;
    const value = (key: string, fallback = 0) => Number(cards.get(key) ?? fallback);
    const axes = value("NAXIS");
    const bitpix = value("BITPIX");
    const width = value("NAXIS1");
    const height = value("NAXIS2");
    const extension = (cards.get("XTENSION") ?? "").replace(/^['"]|['"]$/g, "").trim().toUpperCase();
    if ((offset === 0 || extension === "IMAGE") && axes >= 2 && width > 0 && height > 0) return { width, height };

    let elements = axes > 0 ? 1 : 0;
    for (let axis = 1; axis <= axes; axis++) elements *= value(`NAXIS${axis}`);
    const dataLength = (elements * Math.abs(bitpix) / 8 + value("PCOUNT")) * value("GCOUNT", 1);
    if (!Number.isFinite(dataLength) || dataLength < 0) return null;
    offset = headerEnd + Math.ceil(dataLength / blockSize) * blockSize;
  }
  return null;
}

function medianDimension(dimensions: FitsDimensions[], key: keyof FitsDimensions) {
  const values = dimensions.map((dimension) => dimension[key]).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function finalizeExposureRecords(records: ExposureRecord[]) {
  const bestByEpoch = new Map<string, ExposureRecord>();
  for (const record of records) {
    const epoch = Math.floor(((record.mjd - 40_587) * 86_400_000 - FIRST_EPOCH_MS) / SIX_MONTHS_MS);
    const key = `${record.band}:${epoch}`;
    const current = bestByEpoch.get(key);
    if (!current || record.quality > current.quality ||
      (record.quality === current.quality && record.distance < current.distance) ||
      (record.quality === current.quality && record.distance === current.distance && record.mjd < current.mjd)) bestByEpoch.set(key, record);
  }
  return [...bestByEpoch.values()].sort((a, b) => a.mjd - b.mjd || a.band.localeCompare(b.band));
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
  siaUrl.searchParams.set("MAXREC", "100");
  const response = await nativeHttpsGet(siaUrl, {
    allowedHosts: [IRSA_HOST],
    timeoutMs: 20_000,
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

function rowsFromIbeJson(json: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(json);
  if (Array.isArray(parsed)) return parsed.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row)));
  if (!parsed || typeof parsed !== "object") throw new Error("IRSA returned an invalid JSON image-search response.");
  const root = parsed as Record<string, unknown>;
  const candidates = [root.data, root.result, root.rows, root.results];
  const nested = candidates.find((candidate) => Array.isArray(candidate) && candidate.length > 0)
    ?? candidates.find((candidate) => Boolean(candidate && typeof candidate === "object"));
  const nestedObject = nested && !Array.isArray(nested) ? nested as Record<string, unknown> : null;
  const data = Array.isArray(nested) ? nested : nestedObject
    ? [nestedObject.rows, nestedObject.data, nestedObject.table].find(Array.isArray) as unknown[] | undefined
    : undefined;
  if (!data) throw new Error("IRSA JSON response did not contain image-search rows.");
  const objectRows = data.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row)));
  if (objectRows.length) return objectRows;
  const columnsRaw = root.columns ?? root.columnNames ?? root.header ?? nestedObject?.columns ?? nestedObject?.columnNames;
  const columns = Array.isArray(columnsRaw)
    ? columnsRaw.map((column) => typeof column === "string" ? column.toLowerCase() : String((column as Record<string, unknown>)?.name ?? "").toLowerCase())
    : [];
  if (columns.length && data.every(Array.isArray)) {
    return (data as unknown[][]).map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
  }
  return [];
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
  const bestByEpoch = new Map<string, ExposureRecord>();
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
    const epoch = Math.floor((observedAt - FIRST_EPOCH_MS) / SIX_MONTHS_MS);
    const raDistance = Number.isFinite(observedRa) ? ((observedRa - ra + 540) % 360 - 180) * Math.cos(dec * Math.PI / 180) : 0;
    const decDistance = Number.isFinite(observedDec) ? observedDec - dec : 0;
    const distance = raDistance * raDistance + decDistance * decDistance;
    const frame = String(frameNumber).padStart(3, "0");
    const imagePath = `/ibe/data/wise/${dataSet}/${dataSet === "neowiser" ? "p1bm_frm" : "4band_p1bm_frm"}/${scanId.slice(-2)}/${scanId}/${frame}/${scanId}${frame}-w${bandNumber}-int-1b.fits`;
    const fitsUrl = new URL(imagePath, `https://${IRSA_HOST}`);
    fitsUrl.searchParams.set("center", `${ra},${dec}`);
    fitsUrl.searchParams.set("size", `${size}deg`);
    fitsUrl.searchParams.set("gzip", "false");
    const candidate = { upstreamUrl: fitsUrl.toString(), band: `wise-w${bandNumber}`, mjd, distance, quality };
    const epochKey = `${bandNumber}:${epoch}`;
    const current = bestByEpoch.get(epochKey);
    if (!current || candidate.quality > current.quality ||
      (candidate.quality === current.quality && candidate.distance < current.distance) ||
      (candidate.quality === current.quality && candidate.distance === current.distance && candidate.mjd < current.mjd)) bestByEpoch.set(epochKey, candidate);
  }
  return [...bestByEpoch.values()].sort((a, b) => a.mjd - b.mjd);
}

async function fetchTimeSeriesRecords(ra: number, dec: number, size: number) {
  const search = async (dataSet: "neowiser" | "allsky", table: "p1bm_frm" | "4band_p1bm_frm") => {
    const searchUrl = new URL(`/ibe/search/wise/${dataSet}/${table}`, `https://${IRSA_HOST}`);
    searchUrl.searchParams.set("POS", `${ra},${dec}`);
    searchUrl.searchParams.set("SIZE", String(size));
    searchUrl.searchParams.set("INTERSECT", "OVERLAPS");
    searchUrl.searchParams.set("where", dataSet === "allsky"
      ? "qual_frame>0 and mjd_obs between 55197 and 55700"
      : "qual_frame>0 and mjd_obs between 56600 and 60700");
    searchUrl.searchParams.set("columns", "scan_id,frame_num,band,mjd_obs,qual_frame");
    searchUrl.searchParams.set("FORMAT", "metadata");
    searchUrl.searchParams.set("RESPONSEFORMAT", "JSON");
    const response = await nativeHttpsGet(searchUrl, {
      allowedHosts: [IRSA_HOST],
      timeoutMs: 20_000,
      maxBytes: 32 * 1024 * 1024,
      headers: { Accept: "application/json" },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`IRSA ${dataSet} image search failed with status ${response.statusCode}.`);
    }
    const rawJson = response.body.toString("utf8");
    if (rawJson.trimStart().startsWith("<")) {
      const detail = rawJson.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
      throw new Error(`IRSA ${dataSet} image search returned XML: ${detail || "empty error response"}`);
    }
    const rows = rowsFromIbeJson(rawJson);
    return { rows, rawJson };
  };

  const [neowiserResult, allskyResult] = await Promise.allSettled([
    search("neowiser", "p1bm_frm"),
    search("allsky", "4band_p1bm_frm"),
  ]);
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
    rawMetadataJson: [neowiser?.rawJson ?? null, allsky?.rawJson ?? null],
    errors,
  };
}

async function downloadAndCacheExposure(record: ExposureRecord) {
  const key = fitsCacheKey(record.upstreamUrl);
  let bytes: Uint8Array | null = await readFitsCache(key);
  if (!bytes) {
    const response = await nativeHttpsGet(record.upstreamUrl, {
      allowedHosts: [IRSA_HOST],
      timeoutMs: 12_000,
      maxBytes: MAX_FITS_BYTES,
      headers: { Accept: "application/fits, application/octet-stream", "User-Agent": "SpaceApps-AstroViewer-Hackathon/1.0 (Dev)" },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`IRSA FITS download failed with status ${response.statusCode}.`);
    }
    const contentLength = Number(response.headers["content-length"]);
    if ((Number.isFinite(contentLength) && contentLength > MAX_FITS_BYTES) || response.body.byteLength > MAX_FITS_BYTES) {
      throw new Error("IRSA FITS cutout exceeds the 20 MB cache limit.");
    }
    await writeFitsCache(key, response.body);
    bytes = response.body;
  }
  const dimensions = fitsImageDimensions(bytes);
  if (!dimensions) throw new Error("FITS image dimensions are missing or invalid.");
  return {
    image: { url: `/api/fits?key=${key}`, band: record.band, mjd: record.mjd, source: "single-exposure" as const },
    dimensions,
  };
}

async function synthesizeCachedAllwiseEpochs(ra: number, dec: number, size: number): Promise<ImageRecord[]> {
  const stageOneKey = irsaQueryCacheKey(JSON.stringify({
    version: 6,
    mode: "wise",
    collection: "wise_allwise",
    ra,
    dec,
    size,
  }));
  const stageOne = await readIrsaJsonCache<{ wiseImages?: ImageRecord[] }>(stageOneKey);
  const base = stageOne?.wiseImages?.find((image) => image.band === "wise-w1") ?? stageOne?.wiseImages?.[0];
  if (!base) return [];

  let upstreamUrl: URL;
  try {
    const imageUrl = new URL(base.url, "https://stella.local");
    const rawUpstreamUrl = imageUrl.searchParams.get("url");
    if (!rawUpstreamUrl) return [];
    upstreamUrl = new URL(rawUpstreamUrl);
    if (upstreamUrl.protocol !== "https:" || upstreamUrl.hostname !== IRSA_HOST || !upstreamUrl.pathname.startsWith("/ibe/data/")) return [];
    upstreamUrl.searchParams.set("gzip", "false");
  } catch {
    return [];
  }

  const key = fitsCacheKey(upstreamUrl.toString());
  let bytes: Uint8Array | null = await readFitsCache(key);
  if (!bytes) {
    const response = await nativeHttpsGet(upstreamUrl, {
      allowedHosts: [IRSA_HOST],
      timeoutMs: 12_000,
      maxBytes: MAX_FITS_BYTES,
      headers: { Accept: "application/fits, application/octet-stream" },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) return [];
    bytes = response.body;
    await writeFitsCache(key, bytes);
  }
  if (!bytes) return [];
  if (!fitsImageDimensions(bytes)) return [];

  const imageUrl = `/api/fits?key=${key}`;
  const epochCount = 24;
  return Array.from({ length: epochCount }, (_, index) => {
    const year = 2010 + (14 * index) / (epochCount - 1);
    const wholeYear = Math.floor(year);
    const epochMs = Date.UTC(wholeYear, 0, 1) + (year - wholeYear) * 365.2425 * 86_400_000;
    const mjd = epochMs / 86_400_000 + 40_587;
    return {
      url: imageUrl,
      band: base.band,
      mjd,
      source: "synthetic-timeseries" as const,
      // The fallback reuses the same AllWISE cutout; moving the whole cutout
      // would falsely make the background drift between modeled timestamps.
      syntheticShiftX: 0,
      syntheticShiftY: 0,
      syntheticNoiseSeed: index + 1,
    };
  });
}

async function buildTimeSeriesPayload(ra: number, dec: number, size: number): Promise<TimeSeriesPayload> {
  const searchResult = await fetchTimeSeriesRecords(ra, dec, size);
  // Keep the metadata response durable alongside the completed frame manifest.
  await mkdir(TIMESERIES_CACHE_DIR, { recursive: true });
  const metadataPath = path.join(TIMESERIES_CACHE_DIR, `timeseries_${ra.toFixed(4)}_${dec.toFixed(4)}_${size}.metadata.json`);
  await writeFile(metadataPath, JSON.stringify({ responses: searchResult.rawMetadataJson, errors: searchResult.errors }));

  if (searchResult.records.length === 0) {
    const syntheticImages = await synthesizeCachedAllwiseEpochs(ra, dec, size);
    return {
      status: 200,
      images: syntheticImages,
      total: syntheticImages.length,
      failed: 0,
      failureSummary: searchResult.errors,
      source: "synthetic time-series model derived from AllWISE; not observed epochs",
      synthetic: true,
      ...(!syntheticImages.length ? { error: "IRSA returned no single-exposure frames and no cached AllWISE FITS image was available for the illustrative timeline." } : {}),
    };
  }

  const records = searchResult.records;
  let failed = 0;
  const failureKinds = new Map<string, number>();
  const accepted: Awaited<ReturnType<typeof downloadAndCacheExposure>>[] = [];
  let expectedDimensions: FitsDimensions | null = null;
  for (let offset = 0; offset < records.length; offset += TIME_SERIES_DOWNLOAD_CONCURRENCY) {
    const results = await Promise.all(records.slice(offset, offset + TIME_SERIES_DOWNLOAD_CONCURRENCY).map(async (record) => {
      try { return await downloadAndCacheExposure(record); }
      catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : "unknown error";
        const status = message.match(/status (\d+)/i)?.[1];
        const kind = status ? `HTTP ${status}` : /timed out/i.test(message) ? "upstream timeout" : /20 MB/i.test(message) ? "cutout too large" : "download error";
        failureKinds.set(kind, (failureKinds.get(kind) ?? 0) + 1);
        return null;
      }
    }));
    const batch = results.filter((result): result is NonNullable<typeof result> => result !== null);
    if (!expectedDimensions && batch.length) {
      expectedDimensions = {
        width: medianDimension(batch.map(({ dimensions }) => dimensions), "width"),
        height: medianDimension(batch.map(({ dimensions }) => dimensions), "height"),
      };
    }
    for (const result of batch) {
      if (expectedDimensions && result.dimensions.width >= expectedDimensions.width * 0.65 && result.dimensions.height >= expectedDimensions.height * 0.65) accepted.push(result);
      else {
        failed++;
        failureKinds.set("edge-clipped dimensions", (failureKinds.get("edge-clipped dimensions") ?? 0) + 1);
      }
    }
  }
  return {
    status: 200,
    images: accepted.map(({ image }) => image).sort((a, b) => (a.mjd ?? Infinity) - (b.mjd ?? Infinity) || a.band.localeCompare(b.band)),
    total: records.length,
    failed,
    failureSummary: [...searchResult.errors, ...[...failureKinds].map(([kind, count]) => `${kind}: ${count}`)],
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
  const response = await nativeHttpsGet(siaUrl, {
    allowedHosts: [IRSA_HOST],
    timeoutMs: 20_000,
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
  if (cached && mode !== "timeseries") return NextResponse.json(cached, { headers: { "X-IRSA-Cache": "HIT" } });

  if (mode === "timeseries") {
    try {
      const cachedPayload = await readTimeSeriesCache(ra, dec, size);
      if (cachedPayload) return NextResponse.json(cachedPayload, { headers: { "X-IRSA-Cache": "HIT" } });

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
      const payload = await job;
      return NextResponse.json(payload, { status: 200, headers: { "X-IRSA-Cache": "MISS" } });
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
      }, { status: 200, headers: { "X-IRSA-Cache": "MISS" } });
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
    return NextResponse.json(payload, { headers: { "X-IRSA-Cache": "MISS" } });
  }

  try {
    const wiseImages = await fetchWiseRecords(ra, dec, size);
    const payload = { wiseImages, source: "IRSA AllWISE Atlas" };
    await writeIrsaJsonCache(cacheKey, payload);
    return NextResponse.json(payload, { headers: { "X-IRSA-Cache": "MISS" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "IRSA WISE search timed out after 20 seconds."
      : error instanceof Error ? error.message : "Could not retrieve WISE image frames from IRSA.";
    return NextResponse.json({ error: message }, { status: 502, headers: { "X-IRSA-Cache": "MISS" } });
  }
}
