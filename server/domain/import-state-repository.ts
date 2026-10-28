import { mkdir, readFile, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./json-repository";
import type { ImportState } from "./pipeline-types";

type Change = { set: ImportState[]; remove: string[] };
// A durable append journal avoids rewriting every contact for each remote request.
// Compact snapshots remain compatible with downloaded JSON backups.
export class ImportStateRepository {
  readonly fileName = "lead-import-states.json";
  private readonly snapshot = path.join(dataDir, this.fileName);
  private readonly journal = path.join(dataDir, "lead-import-states.journal");
  private values = new Map<string, ImportState>();
  private ready?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private changes = 0;

  initialize() {
    return (this.ready ??= this.load());
  }
  private async load() {
    await mkdir(dataDir, { recursive: true });
    try {
      const records: ImportState[] = JSON.parse(
        await readFile(this.snapshot, "utf8"),
      );
      for (const row of records) this.values.set(row.id, row);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const text = await readFile(this.journal, "utf8");
      const complete = text.endsWith("\n")
        ? text
        : text.slice(0, text.lastIndexOf("\n") + 1);
      for (const line of complete.split("\n")) {
        if (!line) continue;
        this.apply(JSON.parse(line) as Change);
      }
      // Remove a torn final write before appending another complete transaction.
      if (complete !== text)
        await writeFile(this.journal, complete, { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private apply(change: Change) {
    for (const id of change.remove) this.values.delete(id);
    for (const row of change.set) this.values.set(row.id, row);
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    await this.initialize();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.queue;
    this.queue = previous.then(() => next);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  async all() {
    await this.initialize();
    return structuredClone([...this.values.values()]);
  }
  async findById(_field: "id", id: string) {
    await this.initialize();
    const value = this.values.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async set(value: ImportState) {
    await this.exclusive(() =>
      this.commit({ set: [structuredClone(value)], remove: [] }),
    );
  }
  private async commit(change: Change) {
    if (!change.set.length && !change.remove.length) return;
    const handle = await open(this.journal, "a", 0o600);
    try {
      await handle.writeFile(JSON.stringify(change) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.apply(change);
    this.changes += change.set.length + change.remove.length;
    if (this.changes >= 250) await this.compact();
  }
  async mutate<T>(
    change: (rows: ImportState[]) => T | Promise<T>,
    _backup = false,
  ): Promise<T> {
    return this.exclusive(async () => {
      const rows = structuredClone([...this.values.values()]);
      const result = await change(rows);
      const next = new Map(rows.map((row) => [row.id, row]));
      const updates = rows.filter(
        (row) =>
          JSON.stringify(row) !== JSON.stringify(this.values.get(row.id)),
      );
      await this.commit({
        set: updates,
        remove: [...this.values.keys()].filter((id) => !next.has(id)),
      });
      return result;
    });
  }
  private async compact() {
    const temporary = `${this.snapshot}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify([...this.values.values()], null, 2) + "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.snapshot);
    const journal = await open(this.journal, "w", 0o600);
    try {
      await journal.sync();
    } finally {
      await journal.close();
    }
    this.changes = 0;
  }
  async flush() {
    await this.exclusive(() => this.compact());
  }
}
