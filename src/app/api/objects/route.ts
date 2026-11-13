import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// CDS currently lists these mirrors as alternatives when its Strasbourg
// services are unavailable. Each URL is a SIMBAD TAP sync endpoint.
const TAP_ENDPOINTS = [
  "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync",
  "https://simbad.idia.ac.za/simbad/sim-tap/sync",
  "https://simbad.cds.unistra.fr/simbad/sim-tap/sync",
];

const MAX_RESULTS = 500;

type TapResponse = {
  data?: unknown[][];
  metadata?: { name?: string }[];
  error?: string;
};

function tapErrorDetail(body: string): string {
  for (const match of body.matchAll(/<INFO\b([^>]*)>([\s\S]*?)<\/INFO>/gi)) {
    const attributes = match[1];
    if (/name=["']QUERY_STATUS["']/i.test(attributes) && /value=["']ERROR["']/i.test(attributes)) {
      return match[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
    }
  }
  return body.replace(/\s+/g, " ").slice(0, 240);
}

function numberParam(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const ra = numberParam(params.get("ra"));
  const dec = numberParam(params.get("dec"));
  const radius = numberParam(params.get("radius"));

  if (ra === null || dec === null || radius === null) {
    return NextResponse.json(
      { error: "Required query parameters: ra, dec, and radius (decimal degrees)." },
      { status: 400 },
    );
  }
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90 || radius <= 0 || radius > 180) {
    return NextResponse.json(
      { error: "Coordinates must be RA 0–360°, Dec −90–90°, and radius greater than 0 and at most 180°." },
      { status: 400 },
    );
  }

  // ADQL's CIRCLE radius is in degrees. Values are validated numbers, not
  // user-provided ADQL fragments.
  const adql = `SELECT TOP ${MAX_RESULTS} main_id, ra, dec, otype_txt, sp_type
FROM basic
WHERE 1 = CONTAINS(
  POINT('ICRS', ra, dec),
  CIRCLE('ICRS', ${ra}, ${dec}, ${radius})
 )`;

  const tapRequests = TAP_ENDPOINTS.map(async (endpoint) => {
    const tapUrl = new URL(endpoint);
    tapUrl.searchParams.set("request", "doQuery");
    tapUrl.searchParams.set("lang", "adql");
    tapUrl.searchParams.set("format", "json");
    tapUrl.searchParams.set("query", adql);

    const response = await fetch(tapUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = tapErrorDetail(await response.text());
      throw new Error(`SIMBAD TAP returned HTTP ${response.status}${detail ? `: ${detail}` : ""}.`);
    }

    const payload = (await response.json()) as TapResponse;
    if (!Array.isArray(payload.data)) {
      throw new Error(payload.error || "SIMBAD TAP returned an unexpected response.");
    }

    return payload.data.map((row) => ({
      name: row[0] == null ? "" : String(row[0]).trim(),
      ra: row[1] == null ? null : Number(row[1]),
      dec: row[2] == null ? null : Number(row[2]),
      objectType: row[3] == null ? "Unknown" : String(row[3]).trim(),
      spectralType: row[4] == null ? "" : String(row[4]).trim(),
    })).filter((object) => object.name && object.ra !== null && object.dec !== null)
      .sort((first, second) => {
        const cosineDec = Math.cos(dec * Math.PI / 180);
        const firstDistance = ((first.ra! - ra) * cosineDec) ** 2 + (first.dec! - dec) ** 2;
        const secondDistance = ((second.ra! - ra) * cosineDec) ** 2 + (second.dec! - dec) ** 2;
        return firstDistance - secondDistance;
      });
  });

  try {
    const objects = await Promise.any(tapRequests);
    return NextResponse.json(objects);
  } catch (error) {
    const failures = error instanceof AggregateError ? error.errors : [];
    const timedOut = failures.some((failure) => failure instanceof Error && failure.name === "TimeoutError");
    const message = timedOut
      ? "All SIMBAD TAP mirrors timed out."
      : failures.find((failure) => failure instanceof Error)?.message || "SIMBAD TAP is temporarily unavailable.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
