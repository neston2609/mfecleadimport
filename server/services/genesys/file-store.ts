import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const configDir = path.resolve(
  process.env.DATA_DIR || path.join(process.cwd(), "data"),
  "config",
);

export async function readJsonFile<T>(
  fileName: string,
  fallback: T,
): Promise<T> {
  try {
    const raw = await readFile(path.join(configDir, fileName), "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFile<T>(
  fileName: string,
  value: T,
): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const destination = path.join(configDir, fileName);
  const tmp = `${destination}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, destination);
}
