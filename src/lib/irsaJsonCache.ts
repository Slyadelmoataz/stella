import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fitsCacheKey } from "@/lib/fitsCache";
import { irsaCachePath } from "@/lib/irsaCachePath";

const CACHE_DIR = irsaCachePath("sia");

export function irsaQueryCacheKey(identity: string) {
  return fitsCacheKey(identity);
}

export async function readIrsaJsonCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await readFile(irsaCachePath("sia", `${key}.json`), "utf8");
    const entry = JSON.parse(raw) as { savedAt: number; data: T };
    if (!Number.isFinite(entry.savedAt)) return null;
    return entry.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function writeIrsaJsonCache<T>(key: string, data: T) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const destination = irsaCachePath("sia", `${key}.json`);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), data }), { flag: "wx" });
    await rename(temporary, destination);
  } catch {
    // Cache failures must not fail an otherwise successful IRSA response.
  }
}
