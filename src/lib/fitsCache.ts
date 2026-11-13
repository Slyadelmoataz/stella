import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_DIR = path.join(process.cwd(), ".cache", "irsa", "fits");
const KEY_PATTERN = /^[a-f0-9]{64}$/;

export function fitsCacheKey(identity: string) {
  return createHash("sha256").update(identity).digest("hex");
}

function cacheFile(key: string) {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid FITS cache key.");
  return path.join(CACHE_DIR, `${key}.fits`);
}

export async function readFitsCache(key: string) {
  try {
    return await readFile(cacheFile(key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeFitsCache(key: string, data: Uint8Array) {
  await mkdir(CACHE_DIR, { recursive: true });
  const destination = cacheFile(key);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data, { flag: "wx" });
  await rename(temporary, destination);
}
