import { NextRequest, NextResponse } from "next/server";
import { fitsCacheKey, readFitsCache, writeFitsCache } from "@/lib/fitsCache";
import { nativeHttpsGet } from "@/lib/nativeHttpsGet";

export const runtime = "nodejs";
export const maxDuration = 60;

const IRSA_HOST = "irsa.ipac.caltech.edu";
const MAX_FITS_BYTES = 20 * 1024 * 1024;

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const key = params.get("key");
  if (key) {
    try {
      const cached = await readFitsCache(key);
      if (!cached) return NextResponse.json({ error: "This FITS image is not in the local cache." }, { status: 404 });
      return new NextResponse(cached, {
        headers: { "Content-Type": "application/fits", "Cache-Control": "private, max-age=31536000", "Content-Length": String(cached.byteLength) },
      });
    } catch {
      return NextResponse.json({ error: "The FITS cache key is invalid." }, { status: 400 });
    }
  }

  const rawUrl = params.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "A FITS URL is required." }, { status: 400 });
  }

  let fitsUrl: URL;
  try {
    fitsUrl = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "The FITS URL is invalid." }, { status: 400 });
  }

  if (
    fitsUrl.protocol !== "https:" ||
    fitsUrl.hostname !== IRSA_HOST ||
    !fitsUrl.pathname.startsWith("/ibe/data/") ||
    !/\.fits(?:\.gz)?$/i.test(fitsUrl.pathname)
  ) {
    return NextResponse.json({ error: "Only FITS data hosted by IRSA can be loaded." }, { status: 400 });
  }

  fitsUrl.searchParams.set("gzip", "false");
  const cacheKey = fitsCacheKey(fitsUrl.toString());

  try {
    const cached = await readFitsCache(cacheKey);
    if (cached) {
      return new NextResponse(cached, {
        headers: { "Content-Type": "application/fits", "Cache-Control": "private, max-age=31536000", "Content-Length": String(cached.byteLength) },
      });
    }

    let upstream: Awaited<ReturnType<typeof nativeHttpsGet>> | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await nativeHttpsGet(fitsUrl, {
          allowedHosts: [IRSA_HOST],
          timeoutMs: 20_000,
          maxBytes: MAX_FITS_BYTES,
          headers: {
            Accept: "application/fits, application/octet-stream",
            "User-Agent": "SpaceApps-AstroViewer-Hackathon/1.0 (Dev)",
          },
        });
        if (response.statusCode >= 200 && response.statusCode < 300) {
          upstream = response;
          break;
        }
        lastError = new Error(`IRSA could not provide this FITS image (${response.statusCode}).`);
        const retryable = response.statusCode === 429 || response.statusCode >= 500;
        if (!retryable || attempt === 2) break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("IRSA FITS request failed.");
        const retryable = lastError.name === "TimeoutError" || /ECONNRESET|EPIPE|EAI_AGAIN|socket hang up/i.test(lastError.message);
        if (!retryable || attempt === 2) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
    if (!upstream && lastError) throw lastError;
    if (!upstream) throw new Error("IRSA FITS request failed after retries.");
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      return NextResponse.json({ error: `IRSA could not provide this FITS image (${upstream.statusCode}).` }, { status: 502 });
    }

    const contentLength = Number(upstream.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > MAX_FITS_BYTES) {
      return NextResponse.json({ error: "The FITS cutout is larger than the 20 MB viewer limit." }, { status: 413 });
    }

    const fitsData = upstream.body;
    if (fitsData.byteLength > MAX_FITS_BYTES) {
      return NextResponse.json({ error: "The FITS cutout is larger than the 20 MB viewer limit." }, { status: 413 });
    }

    await writeFitsCache(cacheKey, fitsData);

    return new NextResponse(new Uint8Array(fitsData), {
      status: 200,
      headers: {
        "Content-Type": "application/fits",
        "Cache-Control": "private, max-age=31536000",
        "Content-Length": String(fitsData.byteLength),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeded 20971520 bytes")) {
      return NextResponse.json({ error: "The FITS cutout is larger than the 20 MB viewer limit." }, { status: 413 });
    }
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "IRSA FITS request timed out after 20 seconds."
      : "Could not retrieve the FITS image from IRSA.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
