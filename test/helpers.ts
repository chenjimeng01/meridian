import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8"));
}

export function listFiles(relDir: string, ext: string): string[] {
  const dir = join(ROOT, relDir);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listFiles(join(relDir, entry.name), ext));
    } else if (entry.name.endsWith(ext)) {
      out.push(join(relDir, entry.name));
    }
  }
  return out.sort();
}
