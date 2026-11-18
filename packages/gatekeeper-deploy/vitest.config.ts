import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

// The generated configurator HTML is imported as a `*.txt` module (Wrangler's Text-module
// convention). Vitest resolves it as an asset URL without this mirror; see workshop-backend's
// vitest.config.ts for the same plugin's rationale. capnweb-validate hands transformed modules a
// root-anchored importer id, so a resolution that misses the real file falls back to src/.
const textModules: Plugin = {
  name: "text-modules",
  enforce: "pre",
  resolveId(source, importer) {
    if (source.endsWith(".txt") && importer !== undefined) {
      let candidate = path.resolve(path.dirname(importer), source);
      if (existsSync(candidate)) return candidate;
      return path.resolve(import.meta.dirname, "src", source.replace(/^\.\//, ""));
    }
  },
  load(id) {
    if (id.endsWith(".txt")) {
      return `export default ${JSON.stringify(readFileSync(id, "utf-8"))};`;
    }
  },
};

export default defineConfig({
  plugins: [
    textModules,
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
      },
    }),
  ],
  test: { include: ["__tests__/*.test.ts"] },
});
