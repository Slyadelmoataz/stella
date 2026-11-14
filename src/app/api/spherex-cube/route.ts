import { NextRequest, NextResponse } from "next/server";
import { IRSA_USER_AGENT } from "@/lib/nativeHttpsGet";

export const runtime = "nodejs";
export const maxDuration = 30;

const TILE_URL = /^https:\/\/irsa\.ipac\.caltech\.edu\/ibe\/data\/spherex\/.+\.fits$/i;
const WAVELENGTHS = `0.753 0.771 0.790 0.809 0.828 0.848 0.868 0.889 0.910 0.932 0.955 0.978 1.001 1.025 1.050 1.075 1.102 1.113 1.139 1.167 1.195 1.224 1.254 1.284 1.315 1.346 1.378 1.412 1.446 1.481 1.517 1.554 1.592 1.631 1.656 1.695 1.735 1.775 1.818 1.861 1.905 1.949 1.995 2.041 2.089 2.139 2.189 2.240 2.292 2.345 2.399 2.445 2.506 2.575 2.646 2.719 2.794 2.871 2.951 3.033 3.118 3.204 3.293 3.383 3.476 3.570 3.667 3.768 3.833 3.867 3.901 3.935 3.970 4.005 4.040 4.076 4.112 4.148 4.184 4.220 4.257 4.294 4.331 4.368 4.405 4.435 4.467 4.500 4.533 4.566 4.600 4.635 4.669 4.704 4.739 4.773 4.808 4.843 4.879 4.915 4.951 4.988`.split(" ").map(Number);

function cardValue(header: string, key: string, fallback?: number) {
  const match = header.match(new RegExp(`^${key.padEnd(8)}=\\s*([^/\\n]+)`, "m"));
  const value = match ? Number(match[1].trim()) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function parseImageHdu(bytes: ArrayBuffer) {
  const text = new TextDecoder("ascii").decode(bytes);
  let offset = 0;
  while (offset + 2880 <= bytes.byteLength) {
    let end = offset;
    let foundEnd = false;
    while (end + 80 <= bytes.byteLength) {
      if (text.slice(end, end + 8).trim() === "END") {
        end += 80;
        foundEnd = true;
        break;
      }
      end += 80;
    }
    if (!foundEnd) break;
    const dataStart = offset + Math.ceil((end - offset) / 2880) * 2880;
    const header = text.slice(offset, end);
    const axisCount = cardValue(header, "NAXIS", 0) ?? 0;
    const width = cardValue(header, "NAXIS1", 0) ?? 0;
    const height = cardValue(header, "NAXIS2", 0) ?? 0;
    const bands = cardValue(header, "NAXIS3", 0) ?? 0;
    const bitpix = cardValue(header, "BITPIX", 0) ?? 0;
    if (axisCount >= 3 && width > 0 && height > 0 && bands >= 1 && bands <= 102 && bitpix === -32) {
      return {
        dataStart, width, height, bands,
        scale: cardValue(header, "BSCALE", 1) ?? 1,
        zero: cardValue(header, "BZERO", 0) ?? 0,
        cdelt1: cardValue(header, "CDELT1", 1) ?? 1,
        cdelt2: cardValue(header, "CDELT2", 1) ?? 1,
        pc11: cardValue(header, "PC1_1", 1) ?? 1,
        pc12: cardValue(header, "PC1_2", 0) ?? 0,
        pc21: cardValue(header, "PC2_1", 0) ?? 0,
        pc22: cardValue(header, "PC2_2", 1) ?? 1,
      };
    }
    const bitpixSize = Math.abs(bitpix) / 8;
    let dataBytes = axisCount > 0 ? bitpixSize : 0;
    for (let axis = 1; axis <= axisCount; axis++) dataBytes *= cardValue(header, `NAXIS${axis}`, 0) ?? 0;
    offset = dataStart + Math.ceil(dataBytes / 2880) * 2880;
  }
  throw new Error("The IRSA tile did not contain a supported 102-plane Float32 image HDU.");
}

async function rangeFetch(url: string, start: number, end: number, signal: AbortSignal) {
  let lastError: Error = new Error("IRSA did not honor a FITS byte-range request.");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/fits, application/octet-stream", Range: `bytes=${start}-${end}`, "User-Agent": IRSA_USER_AGENT },
        signal,
        cache: "no-store",
      });
      if (response.status !== 206) throw new Error(`IRSA FITS range request returned ${response.status}.`);
      return await response.arrayBuffer();
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error instanceof Error ? error : lastError;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const sourceUrl = params.get("url") ?? "";
  const ra = Number(params.get("ra"));
  const dec = Number(params.get("dec"));
  const tileRa = Number(params.get("tileRa"));
  const tileDec = Number(params.get("tileDec"));
  const fieldSize = Number(params.get("size"));
  if (!TILE_URL.test(sourceUrl) || ![ra, dec, tileRa, tileDec, fieldSize].every(Number.isFinite) ||
    ra < 0 || ra >= 360 || dec < -90 || dec > 90 || fieldSize <= 0 || fieldSize > 10) {
    return NextResponse.json({ error: "Invalid SPHEREx cube request." }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("SPHEREx cube request timed out after 25 seconds.")), 25_000);
  try {
    const headerBytes = await rangeFetch(sourceUrl, 0, 131071, controller.signal);
    const hdu = parseImageHdu(headerBytes);
    const angular = Math.min(fieldSize, 0.5);
    const radians = Math.PI / 180;
    // Convert a small local sky tangent-plane patch through the FITS PC matrix.
    const matrixA = hdu.cdelt1 * hdu.pc11;
    const matrixB = hdu.cdelt1 * hdu.pc12;
    const matrixC = hdu.cdelt2 * hdu.pc21;
    const matrixD = hdu.cdelt2 * hdu.pc22;
    const determinant = matrixA * matrixD - matrixB * matrixC;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error("SPHEREx tile has an invalid spatial WCS.");
    const inverse = [matrixD / determinant, -matrixB / determinant, -matrixC / determinant, matrixA / determinant];
    const east = ((((ra - tileRa) + 540) % 360) - 180) * Math.cos(tileDec * radians);
    const north = dec - tileDec;
    const sourceCenterX = (hdu.width - 1) / 2 + inverse[0] * east + inverse[1] * north;
    const sourceCenterY = (hdu.height - 1) / 2 + inverse[2] * east + inverse[3] * north;
    const halfField = angular / 2;
    const sourceRadiusX = (Math.abs(inverse[0]) + Math.abs(inverse[1])) * halfField + 2;
    const sourceRadiusY = (Math.abs(inverse[2]) + Math.abs(inverse[3])) * halfField + 2;
    if (sourceCenterX - sourceRadiusX < 0 || sourceCenterX + sourceRadiusX >= hdu.width ||
      sourceCenterY - sourceRadiusY < 0 || sourceCenterY + sourceRadiusY >= hdu.height) {
      throw new Error("The SPHEREx tile does not fully cover this field; using the WISE/SIMBAD model instead.");
    }
    const x0 = Math.max(0, Math.floor(sourceCenterX - sourceRadiusX));
    const x1 = Math.min(hdu.width - 1, Math.ceil(sourceCenterX + sourceRadiusX));
    const y0 = Math.max(0, Math.floor(sourceCenterY - sourceRadiusY));
    const y1 = Math.min(hdu.height - 1, Math.ceil(sourceCenterY + sourceRadiusY));
    if (x1 <= x0 || y1 <= y0) throw new Error("Requested coordinates fall outside the selected SPHEREx tile.");

    const outputWidth = Math.max(2, Math.min(512, Math.round(angular / Math.hypot(matrixA, matrixC))));
    const outputHeight = Math.max(2, Math.min(512, Math.round(angular / Math.hypot(matrixB, matrixD))));
    const cube = new Float32Array(outputWidth * outputHeight * hdu.bands);
    const bytesPerPlane = hdu.width * hdu.height * 4;
    const bytesPerRow = hdu.width * 4;
    const fetchedPlanes = new Map<number, DataView>();

    // A small bounded pool speeds up the 102 narrow plane reads while avoiding
    // the burst of simultaneous full-file requests that can trigger IRSA 503s.
    const rangeConcurrency = 6;
    for (let firstBand = 0; firstBand < hdu.bands; firstBand += rangeConcurrency) {
      const batch = Array.from({ length: Math.min(rangeConcurrency, hdu.bands - firstBand) }, (_, offset) => firstBand + offset);
      const planes = await Promise.all(batch.map(async (band) => {
        const start = hdu.dataStart + band * bytesPerPlane + y0 * bytesPerRow;
        const end = hdu.dataStart + band * bytesPerPlane + (y1 + 1) * bytesPerRow - 1;
        const bytes = await rangeFetch(sourceUrl, start, end, controller.signal);
        return [band, new DataView(bytes)] as const;
      }));
      for (const [band, view] of planes) fetchedPlanes.set(band, view);
    }

    const outputPixelScaleX = angular / Math.max(outputWidth - 1, 1);
    const outputPixelScaleY = angular / Math.max(outputHeight - 1, 1);
    for (let band = 0; band < hdu.bands; band++) {
      const view = fetchedPlanes.get(band)!;
      for (let y = 0; y < outputHeight; y++) for (let x = 0; x < outputWidth; x++) {
        const eastOffset = ((x - (outputWidth - 1) / 2) * outputPixelScaleX);
        const northOffset = -((y - (outputHeight - 1) / 2) * outputPixelScaleY);
        const sourceX = sourceCenterX + inverse[0] * eastOffset + inverse[1] * northOffset;
        const sourceY = sourceCenterY + inverse[2] * eastOffset + inverse[3] * northOffset;
        const nearestX = Math.max(x0, Math.min(x1, Math.round(sourceX)));
        const nearestY = Math.max(y0, Math.min(y1, Math.round(sourceY)));
        const byteOffset = ((nearestY - y0) * hdu.width + nearestX) * 4;
        const raw = view.getFloat32(byteOffset, false);
        cube[band * outputWidth * outputHeight + y * outputWidth + x] = Number.isFinite(raw) ? raw * hdu.scale + hdu.zero : NaN;
      }
    }

    return new NextResponse(cube.buffer, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        "X-Cube-Width": String(outputWidth),
        "X-Cube-Height": String(outputHeight),
        "X-Cube-Bands": String(hdu.bands),
        "X-Cube-Wavelengths": WAVELENGTHS.slice(0, hdu.bands).join(","),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read SPHEREx cube data.";
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
