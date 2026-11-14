import path from "node:path";

/** Vercel's writable filesystem is /tmp; local development keeps cache data in the repo. */
export function irsaCachePath(...segments: string[]) {
  const cacheRoot = process.env.VERCEL
    ? "/tmp/irsa-cache"
    : path.join(process.cwd(), ".cache", "irsa");
  return path.join(cacheRoot, ...segments);
}
