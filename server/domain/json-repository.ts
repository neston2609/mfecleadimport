import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const dataDir = path.resolve(
  process.env.DATA_DIR || path.join(process.cwd(), "data"),
);
export const backupsDir = path.resolve(
  process.env.BACKUPS_DIR || path.join(process.cwd(), "backups"),
);

export class JsonRepository<T extends object> {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    public readonly fileName: string,
    private readonly seed: () => T[],
  ) {
    if (!/^[a-z0-9-]+\.json$/.test(fileName))
      throw new Error("Invalid data file name");
  }

  get filePath(): string {
    return path.join(dataDir, this.fileName);
  }

  async initialize(): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    try {
      const handle = await open(this.filePath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify(this.seed(), null, 2)}\n`,
          "utf8",
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  async all(): Promise<T[]> {
    await this.initialize();
    const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
    if (!Array.isArray(value))
      throw new Error(`${this.fileName} must contain an array`);
    return value as T[];
  }

  async findById<K extends keyof T>(
    field: K,
    id: T[K],
  ): Promise<T | undefined> {
    return (await this.all()).find((item) => item[field] === id);
  }

  async query(
    options: {
      search?: string;
      fields?: (keyof T)[];
      filter?: (item: T) => boolean;
      sortBy?: keyof T;
      descending?: boolean;
      page?: number;
      pageSize?: number;
    } = {},
  ) {
    let rows = await this.all();
    if (options.filter) rows = rows.filter(options.filter);
    if (options.search?.trim()) {
      const term = options.search.trim().toLocaleLowerCase();
      rows = rows.filter((item) =>
        (options.fields ?? (Object.keys(item) as (keyof T)[])).some((field) =>
          String(item[field] ?? "")
            .toLocaleLowerCase()
            .includes(term),
        ),
      );
    }
    if (options.sortBy) {
      const field = options.sortBy;
      rows.sort(
        (a, b) =>
          String(a[field] ?? "").localeCompare(String(b[field] ?? ""), "th", {
            numeric: true,
          }) * (options.descending ? -1 : 1),
      );
    }
    const total = rows.length;
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
    return {
      items: rows.slice((page - 1) * pageSize, page * pageSize),
      total,
      page,
      pageSize,
    };
  }

  async mutate<R>(
    change: (rows: T[]) => R | Promise<R>,
    backup = false,
  ): Promise<R> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.writeQueue;
    this.writeQueue = previous.then(() => next);
    await previous;
    try {
      const rows = await this.all();
      if (backup) await this.backup();
      const result = await change(rows);
      await this.atomicWrite(rows);
      return result;
    } finally {
      release();
    }
  }

  async backup(targetDir?: string): Promise<string> {
    await this.initialize();
    const directory =
      targetDir ??
      path.join(
        backupsDir,
        new Date()
          .toISOString()
          .replace(/[-:T.Z]/g, "")
          .slice(0, 14),
      );
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, this.fileName);
    await copyFile(this.filePath, target);
    return target;
  }

  async replaceAll(rows: T[]): Promise<void> {
    await this.mutate((current) => {
      current.splice(0, current.length, ...rows);
    }, true);
  }

  private async atomicWrite(rows: T[]): Promise<void> {
    const serialized = `${JSON.stringify(rows, null, 2)}\n`;
    JSON.parse(serialized);
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, this.filePath);
  }
}
