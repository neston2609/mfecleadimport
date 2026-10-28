import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
function sourceUpdatedAt() {
  try {
    const timestamp = execFileSync(
      "git",
      [
        "log",
        "-1",
        "--format=%cI",
        "--",
        "src",
        "server",
        "public",
        "scripts",
        "deploy",
        ".github",
        "index.html",
        "vite.config.ts",
        "tsconfig.json",
        "package.json",
        "package-lock.json",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return timestamp && Number.isFinite(Date.parse(timestamp))
      ? timestamp
      : null;
  } catch {
    return null;
  }
}
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    define: { __SOURCE_UPDATED_AT__: JSON.stringify(sourceUpdatedAt()) },
    plugins: [react(), tailwindcss()],
    server: {
      port: 5175,
      strictPort: true,
      proxy: {
        "/api": {
          target: env.API_PROXY_TARGET || "http://127.0.0.1:3002",
          changeOrigin: false,
        },
      },
    },
    build: { outDir: "dist/client" },
  };
});
