import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import type { ImageSource } from "../../../../config/imageSources";
import { fitsCacheKey, readFitsCache, writeFitsCache } from "@/lib/fitsCache";
import { nativeHttpsGet } from "@/lib/nativeHttpsGet";

export const runtime = "nodejs";

type SourceImage = { id: string; frameId: string; url: string; band: string; mjd: null; sourceId: string; sourceName: string; agency: string };
const CDS_HOST = "alasky.cds.unistra.fr";
const IRSA_HOST = "irsa.ipac.caltech.edu";
const MAX_BYTES = 20 * 1024 * 1024;

function isPublicAddress(address: string) {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    return !(normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168."));
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224);
}

async function validateCustomUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hostname.endsWith(".local") || url.hostname === "localhost") {
    throw new Error("Custom sources must use a public HTTPS endpoint.");
  }
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("The source host must resolve only to public IP addresses.");
  return url;
}

function csvAccessUrl(body: string) {
  const lines = body.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map((value) => value.replace(/^"|"$/g, "").toLowerCase());
  const accessIndex = header.indexOf("access_url");
  if (accessIndex < 0) return null;
  const row = lines[1].split(",").map((value) => value.replace(/^"|"$/g, ""));
  return row[accessIndex] || null;
}

async function loadSourceFits(source: ImageSource, band: string, ra: number, dec: number, size: number) {
  let upstreamUrl: URL;
  let allowedHosts: string[];
  if (source.protocol === "hips2fits") {
    const survey = source.id === "dss2-optical"
      ? `${source.endpointUrl.replace(/\/$/, "")}/${band}`
      : source.bands.length > 1 ? `${source.endpointUrl.replace(/\/$/, "")}/${band}` : source.endpointUrl;
    upstreamUrl = new URL("https://alasky.cds.unistra.fr/hips-image-services/hips2fits");
    for (const [key, value] of Object.entries({
      hips: survey,
      format: "fits",
      projection: "TAN",
      coordsys: "icrs",
      rotation_angle: "0",
      ra: String(ra),
      dec: String(dec),
      fov: String(size),
      width: "500",
      height: "500",
    })) upstreamUrl.searchParams.set(key, value);
    allowedHosts = [CDS_HOST];
  } else if (source.protocol === "sia-v2") {
    upstreamUrl = await validateCustomUrl(source.endpointUrl);
    upstreamUrl.searchParams.set("POS", `CIRCLE ${ra} ${dec} ${size}`);
    upstreamUrl.searchParams.set("SIZE", String(size));
    upstreamUrl.searchParams.set("FORMAT", "image/fits");
    upstreamUrl.searchParams.set("RESPONSEFORMAT", "CSV");
    const result = await nativeHttpsGet(upstreamUrl, { allowedHosts: [upstreamUrl.hostname], timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024, headers: { Accept: "text/csv" } });
    if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`${source.name} SIA search returned HTTP ${result.statusCode}.`);
    const accessUrl = csvAccessUrl(result.body.toString("utf8"));
    if (!accessUrl) throw new Error(`${source.name} found no FITS product at these coordinates.`);
    upstreamUrl = await validateCustomUrl(accessUrl);
    allowedHosts = [upstreamUrl.hostname];
  } else if (source.protocol === "direct-fits") {
    const rawUrl = source.endpointUrl.replaceAll("{ra}", String(ra)).replaceAll("{dec}", String(dec)).replaceAll("{size}", String(size));
    upstreamUrl = await validateCustomUrl(rawUrl);
    allowedHosts = [upstreamUrl.hostname];
  } else {
    throw new Error(`${source.name} is loaded by the dedicated WISE/SPHEREx route.`);
  }

  const identity = `source:${source.id}:${band}:${ra.toFixed(6)}:${dec.toFixed(6)}:${size}:${upstreamUrl.toString()}`;
  const key = fitsCacheKey(identity);
  const cached = await readFitsCache(key);
  if (cached) return { key, byteLength: cached.byteLength };
  const response = await nativeHttpsGet(upstreamUrl, {
    allowedHosts,
    timeoutMs: 20_000,
    maxBytes: MAX_BYTES,
    headers: { Accept: "application/fits, application/octet-stream" },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const detail = response.body.toString("utf8").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    throw new Error(`${source.name} returned HTTP ${response.statusCode}${detail ? `: ${detail}` : ""}.`);
  }
  const signature = response.body.subarray(0, 80).toString("ascii");
  if (!signature.startsWith("SIMPLE  =") && !signature.startsWith("XTENSION=")) throw new Error(`${source.name} did not return a FITS image.`);
  await writeFitsCache(key, response.body);
  return { key, byteLength: response.body.byteLength };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { ra?: unknown; dec?: unknown; size?: unknown; sources?: ImageSource[] };
    const ra = Number(body.ra);
    const dec = Number(body.dec);
    const size = Number(body.size);
    if (!Number.isFinite(ra) || ra < 0 || ra >= 360 || !Number.isFinite(dec) || dec < -90 || dec > 90 || !Number.isFinite(size) || size <= 0 || size > 2 || !Array.isArray(body.sources)) {
      return NextResponse.json({ error: "Valid RA, Dec, size, and source list are required." }, { status: 400 });
    }
    const sources = body.sources.filter((source) => source && source.enabled && typeof source.id === "string" && typeof source.name === "string" && typeof source.endpointUrl === "string" && Array.isArray(source.bands) && source.bands.length <= 8);
    const images: SourceImage[] = [];
    const errors: string[] = [];
    const requests = sources.filter((source) => !["wise-neowise", "spherex-archive", "2mass-near-ir"].includes(source.id))
      .flatMap((source) => source.bands.slice(0, 8).map((band) => ({ source, band: String(band) })));
    for (let offset = 0; offset < requests.length; offset += 3) {
      const batch = await Promise.all(requests.slice(offset, offset + 3).map(async ({ source, band }) => {
        try {
          const { key } = await loadSourceFits(source, band, ra, dec, size);
          return { image: { id: `${source.id}:${band}:${key}`, frameId: `${source.id}:${band}:${key}`, url: `/api/fits?key=${key}`, band: `${source.id}:${band}`, mjd: null as null, sourceId: source.id, sourceName: source.name, agency: source.agency } satisfies SourceImage };
        } catch (error) {
          return { error: `${source.name} ${band}: ${error instanceof Error ? error.message : "source unavailable"}` };
        }
      }));
      for (const result of batch) {
        if (result.image) images.push(result.image);
        else if (result.error) errors.push(result.error);
      }
    }
    return NextResponse.json({ images, errors });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load additional image sources." }, { status: 500 });
  }
}
