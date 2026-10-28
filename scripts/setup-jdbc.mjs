import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = path.join(root, "server/jdbc");
const manifest = JSON.parse(
  await fs.readFile(path.join(home, "drivers.json"), "utf8"),
);
await fs.mkdir(path.join(home, "drivers"), { recursive: true });
for (const driver of manifest.filter(
  (item) => !item.testOnly || process.argv.includes("--test"),
)) {
  const url = `https://repo.maven.apache.org/maven2/${driver.artifact}/${driver.version}/${driver.name}-${driver.version}.jar`;
  const target = path.join(home, "drivers", `${driver.name}.jar`);
  const jar = await fetch(url);
  if (!jar.ok || !driver.sha256)
    throw new Error(`Could not download pinned ${driver.name} driver`);
  const bytes = Buffer.from(await jar.arrayBuffer());
  const expected = driver.sha256;
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(`Driver checksum mismatch: ${driver.name}`);
  await fs.writeFile(target, bytes);
  console.log(`Verified ${driver.name} ${driver.version}`);
}
const compiled = spawnSync(
  "javac",
  [
    "-J-Xmx96m",
    "--release",
    "17",
    "-d",
    home,
    path.join(home, "JdbcBridge.java"),
  ],
  { stdio: "inherit", windowsHide: true },
);
if (compiled.error || compiled.status !== 0)
  throw new Error("Install JDK 21+ to compile the JDBC bridge");
console.log("JDBC runtime ready");
