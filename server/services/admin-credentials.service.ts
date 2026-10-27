import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "../domain/json-repository";

const credentialSchema = z.object({
  username: z.string().min(1),
  salt: z.string().regex(/^[0-9a-f]{32}$/),
  passwordHash: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.string().uuid(),
  updatedAt: z.string(),
});

type Credentials = z.infer<typeof credentialSchema>;

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, Buffer.from(salt, "hex"), 32).toString("hex");
}

function matchesPassword(password: string, credentials: Credentials): boolean {
  const actual = Buffer.from(hashPassword(password, credentials.salt), "hex");
  const expected = Buffer.from(credentials.passwordHash, "hex");
  return timingSafeEqual(actual, expected);
}

function createCredentials(username: string, password: string): Credentials {
  const salt = randomBytes(16).toString("hex");
  return {
    username,
    salt,
    passwordHash: hashPassword(password, salt),
    version: randomUUID(),
    updatedAt: new Date().toISOString(),
  };
}

export class AdminCredentialsService {
  private readonly directory = path.join(dataDir, ".auth");
  private readonly file = path.join(this.directory, "admin.json");
  private changeQueue: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await this.read();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const password =
      process.env.ADMIN_PASSWORD ||
      (process.env.NODE_ENV === "production" ? "" : "ChangeMe123!");
    if (!password) {
      throw new Error(
        "ADMIN_PASSWORD is required to initialize administrator credentials",
      );
    }
    const credentials = createCredentials(
      process.env.ADMIN_USERNAME || "admin",
      password,
    );
    try {
      const handle = await open(this.file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(credentials)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await this.read();
    }
  }

  async read(): Promise<Credentials> {
    return credentialSchema.parse(
      JSON.parse(await readFile(this.file, "utf8")),
    );
  }

  async authenticate(
    username: string,
    password: string,
  ): Promise<{ username: string; version: string } | null> {
    const credentials = await this.read();
    if (!matchesPassword(password, credentials)) return null;
    if (username !== credentials.username) return null;
    return { username: credentials.username, version: credentials.version };
  }

  async isSessionValid(username?: string, version?: string): Promise<boolean> {
    if (!username || !version) return false;
    const credentials = await this.read();
    return username === credentials.username && version === credentials.version;
  }

  async changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const change = this.changeQueue.then(async () => {
      const credentials = await this.read();
      if (!matchesPassword(currentPassword, credentials)) return false;
      const updated = createCredentials(credentials.username, newPassword);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(updated)}\n`, {
          mode: 0o600,
        });
        await rename(temporary, this.file);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return true;
    });
    this.changeQueue = change.then(
      () => undefined,
      () => undefined,
    );
    return change;
  }
}

export const adminCredentials = new AdminCredentialsService();
