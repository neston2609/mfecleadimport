import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { Client as FtpClient } from "basic-ftp";
import { Client as SshClient, type FileEntryWithStats } from "ssh2";
import { dataDir } from "../domain/json-repository";
import type { SourceConfig, SourceIntegration } from "../domain/pipeline-types";
import { httpError } from "../domain/business";
import { decryptSecret } from "./genesys/secret.service";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const validFile = (name: string) => /\.(csv|json)$/i.test(name);
const cleanPath = (input: string) => {
  const value = input.trim();
  if (!value || value.includes("\0")) throw httpError(400, "Enter a file path");
  if (value.split(/[\\/]+/).includes(".."))
    throw httpError(400, "Parent-directory path segments are not allowed");
  const normalized = path.posix.normalize(value);
  if (normalized.split("/").includes(".."))
    throw httpError(400, "Parent-directory path segments are not allowed");
  return normalized;
};
const localRoots = () => {
  const configured = (
    process.env.SOURCE_FILE_ROOTS || path.join(dataDir, "source-inputs")
  )
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));
  return [...new Set(configured)];
};
function withinPath(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
function safeLocalPath(input: string) {
  const candidate = path.resolve(input);
  const root = localRoots().find((item) => withinPath(item, candidate));
  if (!root)
    throw httpError(
      403,
      "Path is outside the allowed source folders configured by the administrator",
    );
  return { candidate, root };
}
async function assertLocalPath(candidate: string, root: string) {
  const rootReal = await realpath(root).catch(async () => {
    await mkdir(root, { recursive: true });
    return realpath(root);
  });
  const parentReal = await realpath(path.dirname(candidate));
  if (
    path.resolve(candidate) !== path.resolve(root) &&
    !withinPath(rootReal, parentReal)
  )
    throw httpError(
      403,
      "Source paths through symbolic link folders are blocked",
    );
  const canonicalCandidate = path.join(parentReal, path.basename(candidate));
  const resolved = await realpath(canonicalCandidate);
  if (!withinPath(rootReal, resolved))
    throw httpError(
      403,
      "Symbolic links outside allowed source folders are blocked",
    );
  return resolved;
}
export async function browseLocal(input = "") {
  const roots = localRoots();
  await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
  if (!input)
    return {
      path: "",
      roots,
      entries: [],
    };
  const { candidate, root } = safeLocalPath(input);
  const resolved = await assertLocalPath(candidate, root);
  const info = await stat(resolved);
  if (info.isFile()) {
    if (!validFile(resolved)) throw httpError(400, "Select a CSV or JSON file");
    if (info.size > MAX_FILE_BYTES)
      throw httpError(413, "Files must be 5 MB or smaller");
    return {
      path: path.dirname(resolved),
      roots,
      entries: [
        {
          name: path.basename(resolved),
          path: resolved,
          type: "FILE",
          size: info.size,
        },
      ],
    };
  }
  if (!info.isDirectory())
    throw httpError(400, "Choose a regular file or folder");
  const entries = [];
  for (const name of await readdir(resolved)) {
    if (name.startsWith(".")) continue;
    const fullPath = path.join(resolved, name);
    const item = await lstat(fullPath);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory())
      entries.push({ name, path: fullPath, type: "DIRECTORY" as const });
    else if (item.isFile() && validFile(name))
      entries.push({
        name,
        path: fullPath,
        type: "FILE" as const,
        size: item.size,
      });
  }
  entries.sort((a, b) =>
    a.type === b.type
      ? a.name.localeCompare(b.name)
      : a.type === "DIRECTORY"
        ? -1
        : 1,
  );
  return { path: resolved, roots, entries: entries.slice(0, 500) };
}
export async function validateLocalFile(filePath: string) {
  const { candidate, root } = safeLocalPath(filePath);
  const resolved = await assertLocalPath(candidate, root);
  const info = await stat(resolved);
  if (!info.isFile() || !validFile(resolved))
    throw httpError(400, "Select a CSV or JSON file");
  if (info.size > MAX_FILE_BYTES)
    throw httpError(413, "Files must be 5 MB or smaller");
  return { fileName: path.basename(resolved), size: info.size };
}
export async function readLocalFile(filePath: string) {
  const { candidate, root } = safeLocalPath(filePath);
  const resolved = await assertLocalPath(candidate, root);
  if (!validFile(resolved)) throw httpError(400, "Select a CSV or JSON file");
  const handle = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw httpError(400, "Select a CSV or JSON file");
    if (info.size > MAX_FILE_BYTES)
      throw httpError(413, "Files must be 5 MB or smaller");
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        bytes,
        buffer.length - bytes,
        null,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
    }
    if (bytes > MAX_FILE_BYTES)
      throw httpError(413, "Files must be 5 MB or smaller");
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

type RemoteConfig = Pick<
  SourceConfig,
  | "host"
  | "sshHostKeyFingerprint"
  | "port"
  | "username"
  | "transferProtocol"
  | "authMethod"
  | "remotePath"
  | "allowInsecureFtp"
> & { secretEncrypted?: string; secret?: string; passphrase?: string };
function decryptedRemoteSecret(encrypted: string) {
  const value = decryptSecret(encrypted);
  try {
    const parsed = JSON.parse(value) as {
      secret?: string;
      passphrase?: string;
    };
    if (parsed && typeof parsed.secret === "string") return parsed;
  } catch {
    // Backwards compatibility with remote credentials saved before key
    // passphrases were supported.
  }
  return { secret: value, passphrase: "" };
}
async function validateRemoteHost(host: string) {
  const allowlist = (process.env.SOURCE_REMOTE_ALLOWED_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw httpError(400, "Remote host did not resolve");
  if (addresses.some(({ address }) => address.includes("%")))
    throw httpError(400, "Scoped IPv6 remote addresses are not supported");
  const blocked = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["100.64.0.0", 10],
    ["::", 128],
    ["::1", 128],
    ["fe80::", 10],
    ["fc00::", 7],
  ] as const)
    blocked.addSubnet(network, prefix, network.includes(":") ? "ipv6" : "ipv4");
  for (const { address } of addresses) {
    const allowedInternal = allowlist.includes(host.toLowerCase());
    const family = isIP(address);
    if (!family)
      throw httpError(400, "Remote host resolved to an invalid address");
    let normalized = address;
    if (family === 6 && address.toLowerCase().startsWith("::ffff:")) {
      const mapped = address.slice(7);
      if (isIP(mapped) === 4) normalized = mapped;
      else {
        const groups = mapped.split(":");
        if (
          groups.length === 2 &&
          groups.every((group) => /^[a-f0-9]{1,4}$/i.test(group))
        ) {
          const high = Number.parseInt(groups[0], 16);
          const low = Number.parseInt(groups[1], 16);
          normalized = [high >> 8, high & 255, low >> 8, low & 255].join(".");
        }
      }
    }
    const normalizedFamily = isIP(normalized);
    if (
      !allowedInternal &&
      (blocked.check(address, family === 6 ? "ipv6" : "ipv4") ||
        blocked.check(normalized, normalizedFamily === 6 ? "ipv6" : "ipv4") ||
        normalized === "100.100.100.200" ||
        normalized === "168.63.129.16")
    )
      throw httpError(
        400,
        "Remote loopback, link-local and metadata hosts are blocked unless explicitly allowlisted by the administrator",
      );
  }
  return addresses[0].address;
}
export { validateRemoteHost };
function validateRemote(config: RemoteConfig) {
  const host = config.host?.trim();
  const protocol = config.transferProtocol;
  if (!host || !protocol)
    throw httpError(400, "Configure the remote protocol and host");
  if (/[/\\@\s]/.test(host) || host.length > 253)
    throw httpError(
      400,
      "Enter a hostname or IP address without a URL or path",
    );
  const authMethod = config.authMethod || "PASSWORD";
  const username = config.username?.trim();
  const decrypted = decryptedRemoteSecret(config.secretEncrypted || "");
  const secret = config.secret || decrypted.secret;
  const passphrase = config.passphrase || decrypted.passphrase;
  if (!username) throw httpError(400, "Username is required");
  if (authMethod === "PASSWORD" && !secret)
    throw httpError(400, "Enter the remote account password");
  if (authMethod === "KEY" && !secret)
    throw httpError(400, "Enter or configure the private key");
  if (authMethod === "KEY" && !["SCP", "SFTP"].includes(protocol))
    throw httpError(
      400,
      "SSH key authentication is only supported by SCP/SFTP",
    );
  if (
    ["SCP", "SFTP"].includes(protocol) &&
    !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(config.sshHostKeyFingerprint || "")
  )
    throw httpError(
      400,
      "Enter the trusted SSH server SHA256 host-key fingerprint before connecting",
    );
  if (
    ["SCP", "SFTP"].includes(protocol) &&
    config.sshHostKeyFingerprint &&
    !config.sshHostKeyFingerprint.startsWith("SHA256:")
  )
    throw httpError(400, "Only SHA256 SSH host-key fingerprints are supported");
  if (protocol === "FTP" && !config.allowInsecureFtp)
    throw httpError(
      400,
      "FTP is unencrypted. Confirm this connection is allowed",
    );
  return {
    host,
    protocol,
    username,
    secret,
    passphrase,
    authMethod,
    port:
      config.port ||
      ({ FTP: 21, FTPS: 21, SCP: 22, SFTP: 22 } as const)[protocol],
  };
}
export function verifySshHostFingerprint(
  hostHashHex: string,
  expectedFingerprint: string,
) {
  if (!/^[a-f0-9]{64}$/i.test(hostHashHex)) return false;
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(expectedFingerprint)) return false;
  const actual = `SHA256:${Buffer.from(hostHashHex, "hex")
    .toString("base64")
    .replace(/=+$/, "")}`;
  return expectedFingerprint.replace(/=+$/, "") === actual;
}
function sshConnect(config: RemoteConfig): Promise<SshClient> {
  const options = validateRemote(config);
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const timeout = setTimeout(() => {
      client.end();
      reject(httpError(504, "SSH connection timed out"));
    }, 12000);
    client.once("ready", () => {
      clearTimeout(timeout);
      resolve(client);
    });
    client.once("error", (error) => {
      clearTimeout(timeout);
      client.end();
      reject(
        httpError(502, `SSH connection failed: ${error.message.slice(0, 180)}`),
      );
    });
    void validateRemoteHost(options.host)
      .then((address) =>
        client.connect({
          host: address,
          port: options.port,
          username: options.username,
          hostHash: "sha256",
          hostVerifier: (fingerprint: string) =>
            verifySshHostFingerprint(
              fingerprint,
              config.sshHostKeyFingerprint || "",
            ),
          ...(options.authMethod === "KEY"
            ? {
                privateKey: options.secret,
                passphrase: options.passphrase || undefined,
              }
            : { password: options.secret }),
          readyTimeout: 12000,
          keepaliveInterval: 10000,
        }),
      )
      .catch((error) => {
        clearTimeout(timeout);
        client.end();
        reject(error);
      });
  });
}
function getSftp(client: SshClient) {
  return new Promise<import("ssh2").SFTPWrapper>((resolve, reject) =>
    client.sftp((error, sftp) =>
      error || !sftp
        ? reject(error || new Error("SFTP unavailable"))
        : resolve(sftp),
    ),
  );
}
function sshExec(client: SshClient, command: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        channel.close();
        reject(httpError(504, "Remote SCP listing timed out"));
      }, 12000);
      channel.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.length;
        if (bytes > 2 * 1024 * 1024) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            channel.close();
            reject(httpError(413, "Remote folder contains too many entries"));
          }
          return;
        }
        chunks.push(value);
      });
      channel.stderr.on("data", () => undefined);
      channel.once("error", (cause: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(cause);
      });
      channel.once("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(httpError(502, "Remote SCP command failed"));
        else resolve(Buffer.concat(chunks));
      });
    });
  });
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function browseScp(config: RemoteConfig, inputPath: string) {
  const client = await sshConnect(config);
  try {
    const current = cleanPath(inputPath || config.remotePath || "/");
    const quoted = shellQuote(current);
    const [directories, files] = await Promise.all([
      sshExec(client, `find ${quoted} -mindepth 1 -maxdepth 1 -type d -print0`),
      sshExec(
        client,
        `find ${quoted} -mindepth 1 -maxdepth 1 -type f \\( -iname '*.csv' -o -iname '*.json' \\) -print0`,
      ),
    ]);
    const entries = [
      ...directories
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((remoteFile) => ({
          name: path.posix.basename(remoteFile),
          path: remoteFile,
          type: "DIRECTORY" as const,
        })),
      ...files
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((remoteFile) => ({
          name: path.posix.basename(remoteFile),
          path: remoteFile,
          type: "FILE" as const,
        })),
    ]
      .sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "DIRECTORY"
            ? -1
            : 1,
      )
      .slice(0, 500);
    return { path: current, roots: [], entries };
  } finally {
    client.end();
  }
}
function sftpList(sftp: import("ssh2").SFTPWrapper, remotePath: string) {
  return new Promise<FileEntryWithStats[]>((resolve, reject) =>
    sftp.readdir(remotePath, (error, list) =>
      error ? reject(error) : resolve(list || []),
    ),
  );
}
async function browseSsh(config: RemoteConfig, inputPath: string) {
  const client = await sshConnect(config);
  try {
    const sftp = await getSftp(client);
    const current = cleanPath(inputPath || config.remotePath || "/");
    const entries = (await sftpList(sftp, current))
      .filter((entry) => entry.filename !== "." && entry.filename !== "..")
      .filter(
        (entry) =>
          entry.attrs.isDirectory() ||
          (entry.attrs.isFile() && validFile(entry.filename)),
      )
      .map((entry) => ({
        name: entry.filename,
        path: path.posix.join(current, entry.filename),
        type: entry.attrs.isDirectory()
          ? ("DIRECTORY" as const)
          : ("FILE" as const),
        size: entry.attrs.size,
      }))
      .sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "DIRECTORY"
            ? -1
            : 1,
      );
    return { path: current, roots: [], entries: entries.slice(0, 500) };
  } finally {
    client.end();
  }
}
async function browseFtp(config: RemoteConfig, inputPath: string) {
  const options = validateRemote(config);
  if (options.authMethod === "KEY")
    throw httpError(400, "FTP/FTPS does not support SSH key authentication");
  const client = new FtpClient(12000, { allowSeparateTransferHost: false });
  try {
    const address = await validateRemoteHost(options.host);
    await client.access({
      host: address,
      port: options.port,
      user: options.username,
      password: options.secret,
      secure:
        options.protocol === "FTPS"
          ? options.port === 990
            ? "implicit"
            : true
          : false,
      ...(options.protocol === "FTPS"
        ? { secureOptions: { servername: options.host } }
        : {}),
    });
    const current = cleanPath(inputPath || config.remotePath || "/");
    const entries = (await client.list(current))
      .filter((entry) => entry.name !== "." && entry.name !== "..")
      .filter(
        (entry) => entry.isDirectory || (entry.isFile && validFile(entry.name)),
      )
      .map((entry) => ({
        name: entry.name,
        path: path.posix.join(current, entry.name),
        type: entry.isDirectory ? ("DIRECTORY" as const) : ("FILE" as const),
        size: entry.size,
      }))
      .sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "DIRECTORY"
            ? -1
            : 1,
      );
    return { path: current, roots: [], entries: entries.slice(0, 500) };
  } finally {
    client.close();
  }
}
export async function browseRemote(
  config: RemoteConfig,
  secretEncrypted: string,
  remotePath = "",
) {
  const full = { ...config, secretEncrypted };
  const protocol = validateRemote(full).protocol;
  if (protocol === "SCP") return browseScp(full, remotePath);
  return protocol === "SFTP"
    ? browseSsh(full, remotePath)
    : browseFtp(full, remotePath);
}
function boundedWriter() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const writer = new Writable({
    write(chunk, _encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAX_FILE_BYTES) {
        callback(httpError(413, "Files must be 5 MB or smaller"));
        return;
      }
      chunks.push(value);
      callback();
    },
  });
  return { writer, text: () => Buffer.concat(chunks).toString("utf8") };
}
export async function readRemoteFile(
  config: RemoteConfig,
  secretEncrypted: string,
  filePath: string,
) {
  const full = { ...config, secretEncrypted };
  const options = validateRemote(full);
  const target = cleanPath(filePath);
  if (!validFile(target))
    throw httpError(400, "Select a CSV or JSON remote file");
  const output = boundedWriter();
  if (options.protocol === "SCP") {
    const client = await sshConnect(full);
    try {
      return await new Promise<string>((resolve, reject) => {
        client.exec(`scp -f -- ${shellQuote(target)}`, (error, channel) => {
          if (error) {
            reject(error);
            return;
          }
          let pending = Buffer.alloc(0);
          let expectedBytes: number | undefined;
          let receivedBytes = 0;
          const chunks: Buffer[] = [];
          let finished = false;
          let idleTimer: ReturnType<typeof setTimeout>;
          const acknowledge = (code: number) =>
            channel.write(Buffer.from([code]));
          const fail = (error: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(idleTimer);
            acknowledge(2);
            reject(error);
          };
          channel.on("data", (chunk: Buffer | string) => {
            if (finished) return;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () => fail(httpError(504, "Remote SCP transfer timed out")),
              20000,
            );
            pending = Buffer.concat([
              pending,
              Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
            ]);
            if (expectedBytes === undefined) {
              const lineEnd = pending.indexOf(10);
              if (lineEnd < 0 && pending.length > 1024) {
                fail(httpError(502, "Invalid remote SCP response header"));
                return;
              }
              if (lineEnd < 0) return;
              if (lineEnd > 1024) {
                fail(httpError(502, "Invalid remote SCP response header"));
                return;
              }
              const headerBytes = pending.subarray(0, lineEnd);
              if (headerBytes[0] === 1 || headerBytes[0] === 2) {
                fail(
                  httpError(
                    502,
                    `Remote SCP transfer failed: ${headerBytes.subarray(1).toString("utf8").slice(0, 160)}`,
                  ),
                );
                return;
              }
              const header = headerBytes.toString("utf8");
              const match = header.match(/^C[0-7]{4} (\d+) (.+)$/);
              if (!match) {
                fail(httpError(502, "Unexpected remote SCP response"));
                return;
              }
              expectedBytes = Number(match[1]);
              if (
                !Number.isSafeInteger(expectedBytes) ||
                expectedBytes > MAX_FILE_BYTES
              ) {
                fail(httpError(413, "Files must be 5 MB or smaller"));
                return;
              }
              pending = pending.subarray(lineEnd + 1);
              acknowledge(0);
            }
            if (expectedBytes === undefined) return;
            if (pending.length > expectedBytes - receivedBytes + 1) {
              fail(
                httpError(
                  502,
                  "Remote SCP transfer exceeded its declared size",
                ),
              );
              return;
            }
            if (!pending.length) return;
            const size = Math.min(
              expectedBytes - receivedBytes,
              pending.length,
            );
            if (size > 0) {
              chunks.push(pending.subarray(0, size));
              receivedBytes += size;
            }
            pending = pending.subarray(size);
            if (receivedBytes === expectedBytes && pending.length) {
              if (pending[0] !== 0) {
                fail(
                  httpError(502, "Remote SCP transfer did not finish cleanly"),
                );
                return;
              }
              finished = true;
              clearTimeout(idleTimer);
              acknowledge(0);
              resolve(Buffer.concat(chunks).toString("utf8"));
            }
          });
          channel.stderr.on("data", () => undefined);
          channel.once("error", (cause: Error) => fail(cause));
          channel.once("close", () => {
            clearTimeout(idleTimer);
            if (!finished)
              fail(
                httpError(
                  502,
                  "Remote SCP connection closed before the file was read",
                ),
              );
          });
          idleTimer = setTimeout(
            () => fail(httpError(504, "Remote SCP transfer timed out")),
            20000,
          );
          acknowledge(0);
        });
      });
    } finally {
      client.end();
    }
  }
  if (options.protocol === "SFTP") {
    const client = await sshConnect(full);
    try {
      const sftp = await getSftp(client);
      const attrs = await new Promise<import("ssh2").Stats>((resolve, reject) =>
        sftp.stat(target, (error, value) =>
          error || !value
            ? reject(error || new Error("Remote file not found"))
            : resolve(value),
        ),
      );
      if (!attrs.isFile())
        throw httpError(400, "Remote path is not a regular file");
      if (attrs.size > MAX_FILE_BYTES)
        throw httpError(413, "Files must be 5 MB or smaller");
      await pipeline(sftp.createReadStream(target), output.writer, {
        signal: AbortSignal.timeout(20000),
      });
      return output.text();
    } catch (error) {
      output.writer.destroy();
      throw error;
    } finally {
      client.end();
    }
  }
  if (options.authMethod === "KEY")
    throw httpError(400, "FTP/FTPS does not support SSH keys");
  const client = new FtpClient(20000, { allowSeparateTransferHost: false });
  try {
    const address = await validateRemoteHost(options.host);
    await client.access({
      host: address,
      port: options.port,
      user: options.username,
      password: options.secret,
      secure:
        options.protocol === "FTPS"
          ? options.port === 990
            ? "implicit"
            : true
          : false,
      ...(options.protocol === "FTPS"
        ? { secureOptions: { servername: options.host } }
        : {}),
    });
    const size = await client.size(target);
    if (size > MAX_FILE_BYTES)
      throw httpError(413, "Files must be 5 MB or smaller");
    await client.downloadTo(output.writer, target);
    return output.text();
  } catch (error) {
    output.writer.destroy();
    throw error;
  } finally {
    client.close();
  }
}
export async function testRemoteConnection(
  config: RemoteConfig,
  secretEncrypted: string,
) {
  const configuredPath = config.remotePath || "/";
  const browsePath = validFile(configuredPath)
    ? path.posix.dirname(configuredPath)
    : configuredPath;
  const result = await browseRemote(config, secretEncrypted, browsePath);
  return {
    connected: true,
    path: result.path,
    entries: result.entries.length,
    message: `Connected successfully. ${result.entries.length} file/folder entries are available.`,
  };
}

export function fileReadMode(source: SourceIntegration) {
  return (
    source.config.fileLocation || (source.config.fileId ? "UPLOAD" : "SERVER")
  );
}
