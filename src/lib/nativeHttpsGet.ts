import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";

// Reuse TLS connections for IRSA's many small FITS cutouts. Four sockets keep
// throughput predictable without opening a large burst against the archive.
const irsaAgent = new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4, scheduling: "lifo" });
export const IRSA_USER_AGENT = "Stella-AstroViewer/1.0 (NASA-SpaceApps; Next.js)";

export type NativeHttpsResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
};

type HttpsGetOptions = {
  allowedHosts: string[];
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
};

/** Native HTTPS GET with IPv4 lookup, bounded redirects, and an inactivity timeout. */
export function nativeHttpsGet(input: string | URL, options: HttpsGetOptions): Promise<NativeHttpsResponse> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 4;
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));

  return new Promise((resolve, reject) => {
    const requestUrl = input instanceof URL ? new URL(input) : new URL(input);
    if (requestUrl.protocol !== "https:" || !allowedHosts.has(requestUrl.hostname.toLowerCase())) {
      reject(new Error("HTTPS request target is not allowed."));
      return;
    }

    const request = https.get(requestUrl, {
      agent: irsaAgent,
      family: 4,
      timeout: timeoutMs,
      headers: {
        ...(allowedHosts.has("irsa.ipac.caltech.edu")
          ? { Accept: "*/*", "User-Agent": IRSA_USER_AGENT }
          : {}),
        ...options.headers,
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        response.resume();
        if (maxRedirects <= 0) {
          reject(new Error("HTTPS redirect limit exceeded."));
          return;
        }
        const redirectUrl = new URL(location, requestUrl);
        nativeHttpsGet(redirectUrl, { ...options, maxRedirects: maxRedirects - 1 })
          .then(resolve, reject);
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > maxBytes) {
          response.destroy(new Error(`HTTPS response exceeded ${maxBytes} bytes.`));
          return;
        }
        chunks.push(buffer);
      });
      response.on("error", reject);
      response.on("end", () => resolve({
        statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks, totalBytes),
        finalUrl: requestUrl.toString(),
      }));
    });

    request.on("timeout", () => {
      const error = new Error(`HTTPS request timed out after ${timeoutMs}ms.`);
      error.name = "TimeoutError";
      request.destroy(error);
    });
    request.on("error", reject);
  });
}
