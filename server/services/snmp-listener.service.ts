import dgram from "node:dgram";
import ipaddr from "node:net";
import * as snmp from "net-snmp";
import { decryptSecret } from "./genesys/secret.service";
import { acceptAlert, evaluateAlertGroup, redactAlertFields } from "./alert-rules.service";
import {
  alertConfigurations,
  snmpListenerConfiguration,
} from "../domain/alert-store";
import type {
  AlertValue,
  SnmpListenerConfiguration,
  SnmpListenerMetrics,
} from "../domain/alert-types";
import { httpError } from "../domain/business";
import { alertTestSessions } from "../domain/alert-store";

let receiver: { close(callback?: (info?: unknown) => void): void; getAuthorizer(): { addCommunity(value: string): void; addUser(value: unknown): void } } | null = null;
let desired = false;
let recovering = false;
let recoveryTimer: NodeJS.Timeout | null = null;
let metrics: SnmpListenerMetrics = {
  status: "STOPPED", lastReceivedAt: "", receivedCount: 0, errorCount: 0,
  lastError: "", startedAt: "",
};

function maskIp(value: string) {
  if (ipaddr.isIP(value) === 4) return value.split(".").map((part, index) => index === 3 ? "0" : part).join(".");
  const parts = value.split(":").filter(Boolean);
  return `${parts.slice(0, 3).join(":")}:…`;
}

function parseIp(value: string) {
  try { return ipaddr.isIP(value) ? value.toLowerCase() : ""; } catch { return ""; }
}

function ipv4Number(value: string) {
  return value.split(".").reduce((result, part) => (result << 8n) | BigInt(Number(part)), 0n);
}

function ipv6Number(value: string) {
  const normalized = value.toLowerCase();
  const halves = normalized.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const pieces = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (pieces.length !== 8) return null;
  return pieces.reduce((result, part) => (result << 16n) | BigInt(parseInt(part || "0", 16)), 0n);
}

export function validIpOrCidr(value: string) {
  const [address, mask] = value.split("/");
  const version = ipaddr.isIP(address);
  if (!version || value.split("/").length > 2) return false;
  if (mask === undefined) return true;
  const bits = Number(mask);
  return Number.isInteger(bits) && bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

export function ipAllowed(address: string, rules: string[]) {
  if (!rules.length) return true;
  const source = parseIp(address);
  if (!source) return false;
  const normalized = source.startsWith("::ffff:") ? source.slice(7) : source;
  for (const rule of rules) {
    if (!validIpOrCidr(rule)) continue;
    const [network, maskRaw] = rule.split("/");
    const normalizedNetwork = network.toLowerCase().startsWith("::ffff:") ? network.slice(7) : network;
    const version = ipaddr.isIP(normalized);
    if (version !== ipaddr.isIP(normalizedNetwork)) continue;
    if (maskRaw === undefined && normalized === normalizedNetwork) return true;
    const bits = Number(maskRaw ?? (version === 4 ? 32 : 128));
    const left = version === 4 ? ipv4Number(normalized) : ipv6Number(normalized);
    const right = version === 4 ? ipv4Number(normalizedNetwork) : ipv6Number(normalizedNetwork);
    if (left === null || right === null) continue;
    const shift = BigInt((version === 4 ? 32 : 128) - bits);
    if ((left >> shift) === (right >> shift)) return true;
  }
  return false;
}

function jsonSafe(value: unknown, depth = 0): AlertValue {
  if (depth > 8) return "[nested value omitted]";
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => jsonSafe(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, AlertValue> = Object.create(null);
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 500))
      if (!["__proto__", "prototype", "constructor"].includes(key)) result[key] = jsonSafe(item, depth + 1);
    return result;
  }
  return String(value).slice(0, 2000);
}

export function normalizeTrap(trap: { pdu: Record<string, unknown>; rinfo: { address: string; port: number }; version?: number; user?: string }) {
  const { community: _community, user: _user, ...safePdu } = trap.pdu;
  const pdu = safePdu;
  const varbinds = Array.isArray(pdu.varbinds) ? pdu.varbinds as { oid?: string; value?: unknown; type?: number }[] : [];
  const bindings: AlertValue[] = [];
  const oidValues: Record<string, AlertValue> = Object.create(null);
  let trapOid = String(pdu.trapOid || "");
  let enterpriseOid = String(pdu.enterprise || "");
  let timestampValue = "";
  for (const binding of varbinds) {
    const oid = String(binding.oid || "");
    const value = jsonSafe(binding.value);
    bindings.push({ oid, type: binding.type ?? 0, value });
    oidValues[`oid:${oid}`] = value;
    if (oid === "1.3.6.1.6.3.1.1.4.1.0") trapOid = String(value ?? "");
    if (oid === "1.3.6.1.2.1.1.3.0") timestampValue = String(value ?? "");
    const short = oid.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (short) oidValues[`varbind_${short}`] = value;
  }
  const authenticatedUser = trap.user || (typeof _user === "string" ? _user : "");
  const version = authenticatedUser ? 3 : Number(pdu.type) === snmp.PduType.Trap ? 0 : 1;
  const raw: Record<string, AlertValue> = {
    source_ip: trap.rinfo.address,
    source_port: trap.rinfo.port,
    snmp_version: version === 0 ? "v1" : version === 1 ? "v2c" : version === 3 ? "v3" : `v${version}`,
    enterprise_oid: enterpriseOid,
    trap_oid: trapOid,
    timestamp: timestampValue,
    received_at: new Date().toISOString(),
    varbinds: bindings,
    ...oidValues,
  };
  return { raw: { ...raw, raw_pdu: redactSnmpCredentialPdu(jsonSafe(pdu)) }, fields: raw };
}

function redactSnmpCredentialPdu(value: AlertValue): AlertValue {
  if (Array.isArray(value)) return value.map(redactSnmpCredentialPdu);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:community|user|authKey|privKey|password|secret)$/i.test(key) ? "[redacted]" : redactSnmpCredentialPdu(item)]));
}

export function trapCredentialsAllowed(configuration: SnmpListenerConfiguration, pdu: Record<string, unknown>) {
  const rawUser = pdu.user;
  const username = typeof rawUser === "string" ? rawUser : rawUser && typeof rawUser === "object" ? String((rawUser as { name?: unknown }).name || "") : "";
  const community = typeof pdu.community === "string" ? pdu.community : "";
  const version = username ? "v3" : Number(pdu.type) === snmp.PduType.Trap ? "v1" : "v2c";
  if (!configuration.versions.includes(version)) return false;
  if (version === "v3") {
    const user = configuration.users.find((item) => item.username === username);
    return Boolean(user && (user.level === "noAuthNoPriv" || user.authKeyEncrypted) && (user.level !== "authPriv" || user.privKeyEncrypted));
  }
  return configuration.communities.some((item) => item.versions.includes(version) && configuration.versions.includes(version) && decryptSecret(item.secretEncrypted) === community);
}

function maskedError(error: unknown) {
  return (error instanceof Error ? error.message : "Listener error").replace(/(community|authKey|privKey|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 300);
}

function customDgram(maxBytes: number) {
  return {
    createSocket(transport: string) {
      const socket = dgram.createSocket(transport as "udp4" | "udp6");
      const proxy = new Proxy(socket, {
        get(target, key) {
          if (key === "on") return (event: string, listener: (...args: unknown[]) => void) => {
            if (event === "message") target.on("message", (buffer, rinfo) => {
              if (buffer.length > maxBytes) {
                metrics.errorCount++;
                metrics.lastError = `Rejected oversized SNMP message (${buffer.length} bytes)`;
                return;
              }
              listener(buffer, rinfo);
            });
            else target.on(event as never, listener as never);
            return proxy;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return proxy;
    },
  };
}

async function startWith(configuration: SnmpListenerConfiguration) {
  const listener = snmp.createReceiver({
    port: configuration.port,
    address: configuration.bindAddress,
    transport: ipaddr.isIP(configuration.bindAddress) === 6 ? "udp6" : "udp4",
    includeAuthentication: true,
    dgramModule: customDgram(configuration.maxMessageBytes),
    engineID: "80004fb8054d4645434c65616453796e63",
  }, (error: Error | null, trap: { pdu: Record<string, unknown>; rinfo: { address: string; port: number }; version?: number }) => {
    if (error) {
      metrics.errorCount++;
      metrics.lastError = maskedError(error);
      if (configuration.logLevel === "DEBUG") console.warn("SNMP trap rejected", metrics.lastError);
      if (/EADDRINUSE|EACCES|ENETUNREACH|EHOSTUNREACH/.test(metrics.lastError)) {
        const failedReceiver = receiver;
        receiver = null;
        if (desired) {
          if (failedReceiver) failedReceiver.close(() => void scheduleRecovery());
          else void scheduleRecovery();
        }
      }
      return;
    }
    if (!trap?.rinfo || !ipAllowed(trap.rinfo.address, configuration.allowedSources)) {
      metrics.errorCount++;
      if (configuration.logLevel !== "ERROR") metrics.lastError = "SNMP source address is not allowed";
      return;
    }
    if (!trapCredentialsAllowed(configuration, trap.pdu)) {
      metrics.errorCount++;
      if (configuration.logLevel !== "ERROR") metrics.lastError = "SNMP version or credential is not enabled";
      return;
    }
    metrics.receivedCount++;
    metrics.lastReceivedAt = new Date().toISOString();
    const normalized = normalizeTrap(trap);
    if (configuration.logLevel === "DEBUG") console.info("SNMP trap received", { sourceIp: maskIp(trap.rinfo.address), trapOid: normalized.fields.trap_oid });
    void (async () => {
      const sessions = (await alertTestSessions.all()).filter((item) => item.transport === "SNMP" && new Date(item.expiresAt).getTime() > Date.now());
      const configs = await alertConfigurations.all();
        const session = sessions.map((item) => ({ session: item, config: configs.find((config) => config.id === item.alertConfigId) })).find(({ config }) => Boolean(config && !config.enabled && ipAllowed(trap.rinfo.address, config.allowedSources) && sessionCaptureMatches(config!, normalized.fields)));
        const matchesProduction = configs.some((config) => config.enabled && config.type === "SNMP" && evaluateAlertGroup(normalized.fields, config.match));
        if (session && !matchesProduction) {
         const captured = { ...normalized, raw: redactAlertFields(normalized.raw as Record<string, AlertValue>, session.config) };
         await acceptAlert({ transport: "SNMP", sourceIp: trap.rinfo.address, sourcePort: trap.rinfo.port, ...captured, configId: session.config!.id, testSessionId: session.session.id });
         return;
      }
      await acceptAlert({ transport: "SNMP", sourceIp: trap.rinfo.address, sourcePort: trap.rinfo.port, ...normalized });
    })().catch((reason) => {
      metrics.errorCount++;
      metrics.lastError = maskedError(reason);
    });
  });
  const authorizer = listener.getAuthorizer();
  for (const community of configuration.communities) {
    if (!community.versions.some((version) => configuration.versions.includes(version))) continue;
    authorizer.addCommunity(decryptSecret(community.secretEncrypted));
  }
  for (const item of configuration.users) {
    const level = item.level === "authPriv" ? snmp.SecurityLevel.authPriv : item.level === "authNoPriv" ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv;
    authorizer.addUser({
      name: item.username,
      level,
      ...(item.level === "noAuthNoPriv" ? {} : {
        authProtocol: snmp.AuthProtocols[item.authProtocol],
        authKey: decryptSecret(item.authKeyEncrypted),
      }),
      ...(item.level !== "authPriv" ? {} : {
        privProtocol: item.privProtocol === "aes256" ? snmp.PrivProtocols.aes256b : snmp.PrivProtocols[item.privProtocol],
        privKey: decryptSecret(item.privKeyEncrypted),
      }),
    });
  }
  receiver = listener;
  metrics.status = "RUNNING";
  metrics.startedAt = new Date().toISOString();
  metrics.lastError = "";
}

function sessionCaptureMatches(config: import("../domain/alert-types").AlertConfiguration, fields: Record<string, AlertValue>) {
  return config.type === "SNMP" && evaluateAlertGroup(fields, config.match);
}

async function scheduleRecovery() {
  if (!desired || recovering || recoveryTimer) return;
  recovering = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const current = await snmpListenerConfiguration.findById("id", "singleton");
    if (desired && current?.enabled) await startWith(current);
  } catch (error) {
    metrics.status = "ERROR";
    metrics.errorCount++;
    metrics.lastError = maskedError(error);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void scheduleRecovery();
    }, 15000);
    recoveryTimer.unref();
  } finally {
    recovering = false;
  }
}

export function snmpListenerStatus() {
  return { ...metrics };
}

export async function startSnmpListener() {
  const configuration = await snmpListenerConfiguration.findById("id", "singleton");
  if (!configuration?.enabled) {
    desired = false;
    metrics.status = "STOPPED";
    return snmpListenerStatus();
  }
  if (!configuration.versions.length) throw httpError(400, "Select at least one SNMP version");
  if ((configuration.versions.includes("v1") || configuration.versions.includes("v2c")) && !configuration.communities.length)
    throw httpError(400, "Configure a community for SNMP v1/v2c before starting the listener");
  if (configuration.versions.includes("v3") && !configuration.users.length)
    throw httpError(400, "Configure an SNMPv3 user before starting the listener");
  if (receiver) return snmpListenerStatus();
  desired = true;
  try {
    await startWith(configuration);
  } catch (error) {
    desired = false;
    metrics.status = "ERROR";
    metrics.errorCount++;
    metrics.lastError = maskedError(error);
    throw error;
  }
  return snmpListenerStatus();
}

export async function stopSnmpListener() {
  desired = false;
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  if (receiver) await new Promise<void>((resolve) => receiver!.close(() => resolve()));
  receiver = null;
  metrics.status = "STOPPED";
  metrics.lastError = "";
  return snmpListenerStatus();
}

export async function restartSnmpListener() {
  await stopSnmpListener();
  return startSnmpListener();
}

export async function initializeSnmpListener() {
  const configuration = await snmpListenerConfiguration.findById("id", "singleton");
  if (!configuration?.enabled) return snmpListenerStatus();
  try { return await startSnmpListener(); }
  catch (error) {
    metrics.status = "ERROR";
    metrics.errorCount++;
    metrics.lastError = maskedError(error);
    desired = true;
    void scheduleRecovery();
    return snmpListenerStatus();
  }
}

export const snmpListenerDefaults = {
  ipAllowed,
  validIpOrCidr,
  normalizeTrap,
  trapCredentialsAllowed,
};
