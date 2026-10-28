import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { dataDir, backupsDir } from "./json-repository";
import {
  pipelineRepositories,
  sourceIntegrations,
  importStates,
} from "./pipeline-store";
const repositories = pipelineRepositories;
export function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}
export async function createBackup(): Promise<{
  directory: string;
  files: string[];
}> {
  await importStates.flush();
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 17);
  const directory = path.join(backupsDir, stamp);
  await mkdir(directory, { recursive: true });
  const files: string[] = [];
  for (const name of await readdir(dataDir)) {
    if (!name.endsWith(".json")) continue;
    await copyFile(path.join(dataDir, name), path.join(directory, name));
    files.push(name);
  }
  const configDir = path.join(dataDir, "config");
  await mkdir(path.join(directory, "config"), { recursive: true });
  for (const name of await readdir(configDir)) {
    if (!name.endsWith(".json")) continue;
    await copyFile(
      path.join(configDir, name),
      path.join(directory, "config", name),
    );
    files.push(`config/${name}`);
  }
  const sourceFiles = path.join(dataDir, "source-files");
  await mkdir(sourceFiles, { recursive: true });
  await mkdir(path.join(directory, "source-files"), { recursive: true });
  const referencedFiles = new Set(
    (await sourceIntegrations.all())
      .filter((source) => ["CSV", "JSON"].includes(source.kind))
      .map((source) => (source.config.fileId || source.id) + ".txt"),
  );
  for (const name of await readdir(sourceFiles)) {
    if (!/^[a-f0-9-]{36}\.txt$/i.test(name)) continue;
    if (!referencedFiles.has(name)) continue;
    await copyFile(
      path.join(sourceFiles, name),
      path.join(directory, "source-files", name),
    );
    files.push(`source-files/${name}`);
  }
  return { directory: stamp, files };
}

export async function downloadBackup(stamp: string) {
  if (!/^\d{17}$/.test(stamp)) throw httpError(400, "Invalid backup ID");
  const directory = path.join(backupsDir, stamp);
  const files: Record<string, unknown> = {};
  for (const name of await readdir(directory)) {
    if (name.endsWith(".json"))
      files[name] = JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      );
  }
  if (Array.isArray(files["source-integrations.json"])) {
    files["source-integrations.json"] = (
      files["source-integrations.json"] as Record<string, unknown>[]
    ).map(({ secretEncrypted, ...source }) => ({
      ...source,
      secretConfigured: false,
    }));
  }
  try {
    for (const name of await readdir(path.join(directory, "source-files"))) {
      if (/^[a-f0-9-]{36}\.txt$/i.test(name))
        files[`source-files/${name}`] = await readFile(
          path.join(directory, "source-files", name),
          "utf8",
        );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const configDir = path.join(directory, "config");
  for (const name of await readdir(configDir)) {
    if (name.endsWith(".json")) {
      const value = JSON.parse(
        await readFile(path.join(configDir, name), "utf8"),
      ) as Record<string, unknown>;
      if (name === "genesys.json") {
        delete value.clientId;
        delete value.clientSecretEncrypted;
      }
      files[`config/${name}`] = value;
    }
  }
  return files;
}

export async function writeBackupManifest(
  stamp: string,
  files: string[],
): Promise<void> {
  await writeFile(
    path.join(backupsDir, stamp, "manifest.json"),
    `${JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 2)}\n`,
    "utf8",
  );
}
