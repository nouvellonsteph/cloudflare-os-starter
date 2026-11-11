import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fixtures } from "./__tests__/fixtures.js";

export default defineConfig({
  plugins: [{
    name: "worker-text-modules",
    enforce: "pre",
    resolveId(source, importer) {
      // Preserve Text module paths before Vite follows types.txt's symlink to types.d.ts.
      if (source.endsWith(".txt") && importer) return resolve(dirname(importer), source);
    },
    async load(id) {
      // Match Wrangler's Text rule, not Vite's default asset-URL imports.
      if (id.endsWith(".txt")) return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
    },
  }, capnwebValidate({ tsconfig: "./tsconfig.test.json" }), cloudflareTest({
    main: "./__tests__/worker.ts",
    miniflare: {
      compatibilityDate: "2026-09-04",
      compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
      // Intercept after native fetch; replacing global fetch would hide receiver errors.
      // Fail closed for every other request: no test may reach a live provider.
      outboundService: async request => {
        const url = new URL(request.url);
        if (request.method !== "GET" || url.origin !== "https://public.production.bsport.io" ||
            request.headers.get("X-Api-Key") !== "fake-test-key" ||
            request.headers.get("X-Client-ID") !== "test-client" ||
            request.headers.get("X-Company-ID") !== "42" || request.headers.has("X-Franchisor-ID")) {
          return new Response(null, { status: 403 });
        }
        if (url.pathname === "/api/v2/management/bookings/1/" && !url.search) return Response.json(fixtures.bookings);
        if (url.pathname === "/api/v2/management/bookings/2/" && !url.search) {
          return new Response(null, { status: 302, headers: { location: "https://redirect.invalid/private-location" } });
        }
        if (url.pathname === "/api/v2/management/bookings/" &&
            url.searchParams.get("page_size") === "1" && url.searchParams.get("page") === "1") {
          return Response.json({ results: [fixtures.bookings], next_page: null });
        }
        return new Response(null, { status: 403 });
      },
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
