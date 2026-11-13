import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fitsCacheKey } from "@/lib/fitsCache";

const CACHE_DIR = path.join(process.cwd(), ".cache", "irsa", "sia");

export function irsaQueryCacheKey(identity: string) {
  return fitsCacheKey(identity);
}

export async function readIrsaJsonCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await readFile(path.join(CACHE_DIR, `${key}.json`), "utf8");
    const entry = JSON.parse(raw) as { savedAt: number; data: T };
    if (!Number.isFinite(entry.savedAt)) return null;
    return entry.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function writeIrsaJsonCache<T>(key: string, data: T) {
  await mkdir(CACHE_DIR, { recursive: true });
  const destination = path.join(CACHE_DIR, `${key}.json`);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), data }), { flag: "wx" });
  await rename(temporary, destination);
}
