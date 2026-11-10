import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import { readFile } from "node:fs/promises";

export default defineConfig({
  plugins: [{
    name: "worker-text-modules",
    enforce: "pre",
    async load(id) {
      // Match Wrangler's Text rule, not Vite's default asset-URL imports.
      if (id.endsWith(".txt")) return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
    },
  }, capnwebValidate({ tsconfig: "./tsconfig.test.json" }), cloudflareTest({
    main: "./__tests__/worker.ts",
    miniflare: {
      compatibilityDate: "2026-09-04",
      compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
      durableObjects: {
        BSPORT_ACCOUNTS: { className: "BsportAccount", useSQLite: true },
        // Register the class as a DO, not the plugin's fallback WorkerEntrypoint wrapper.
        BSPORT_GATEKEEPER: { className: "BsportGatekeeper", useSQLite: true },
        TEST_HOOKS: { className: "TestHooks", useSQLite: true },
      },
      bindings: {
        BASE_URL: "https://os.example.com/gatekeeper/bsport",
        CF_ACCESS_ISS: "https://example.cloudflareaccess.com",
        CF_ACCESS_AUD: "test-audience",
        BSPORT_COMPANY_ID: "42",
        BSPORT_CLIENT_ID: "test-client",
        BSPORT_OWNER_EMAIL: "owner@example.com",
        BSPORT_API_KEY: "fake-test-key"
      }
    },
  })],
  test: { include: ["__tests__/*.test.ts"] },
});
