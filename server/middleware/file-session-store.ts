import session from "express-session";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../domain/json-repository";

export class FileSessionStore extends session.Store {
  private readonly directory = path.join(dataDir, ".sessions");

  constructor() {
    super();
    setInterval(
      () => {
        void this.reapExpired().catch((error) =>
          console.error("Session cleanup failed", error),
        );
      },
      60 * 60 * 1000,
    ).unref();
  }

  private file(sid: string): string {
    return path.join(
      this.directory,
      `${createHash("sha256").update(sid).digest("hex")}.json`,
    );
  }

  get(
    sid: string,
    callback: (
      error?: Error | null,
      value?: session.SessionData | null,
    ) => void,
  ): void {
    void readFile(this.file(sid), "utf8")
      .then((raw) => {
        const value = JSON.parse(raw) as session.SessionData;
        if (
          value.cookie.expires &&
          new Date(value.cookie.expires).getTime() <= Date.now()
        ) {
          void unlink(this.file(sid)).catch(() => undefined);
          callback(null, null);
        } else callback(null, value);
      })
      .catch((error: NodeJS.ErrnoException) =>
        callback(error.code === "ENOENT" ? null : error, null),
      );
  }

  set(
    sid: string,
    value: session.SessionData,
    callback?: (error?: Error | null) => void,
  ): void {
    const target = this.file(sid);
    const temporary = `${target}.${randomUUID()}.tmp`;
    void mkdir(this.directory, { recursive: true, mode: 0o700 })
      .then(() => writeFile(temporary, JSON.stringify(value), { mode: 0o600 }))
      .then(() => rename(temporary, target))
      .then(() => callback?.(null))
      .catch((error: Error) => {
        void unlink(temporary).catch(() => undefined);
        callback?.(error);
      });
  }

  destroy(sid: string, callback?: (error?: Error | null) => void): void {
    void unlink(this.file(sid))
      .then(() => callback?.(null))
      .catch((error: NodeJS.ErrnoException) =>
        callback?.(error.code === "ENOENT" ? null : error),
      );
  }

  touch(
    sid: string,
    value: session.SessionData,
    callback?: (error?: Error | null) => void,
  ): void {
    this.set(sid, value, callback);
  }

  private async reapExpired(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const file = path.join(this.directory, name);
      try {
        const value = JSON.parse(
          await readFile(file, "utf8"),
        ) as session.SessionData;
        if (
          value.cookie.expires &&
          new Date(value.cookie.expires).getTime() <= Date.now()
        )
          await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          console.error("Unable to inspect session", name, error);
      }
    }
  }
}
