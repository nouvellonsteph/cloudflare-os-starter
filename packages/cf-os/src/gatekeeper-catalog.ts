// The optional Gatekeepers the submodule offers, read the way upstream's release tooling reads them
// (cloudflare-os/scripts/release/manifest-lib.ts), so `cf-os init` offers what the hosted deploy
// service offers. Beside cf-client.ts rather than in core/ because it reads the disk: the pure half
// is core/gatekeepers.ts.
//
// Every filter fails closed. A package upstream's own rules reject, or one needing something this
// deploy does not provide, is listed in `excluded` with the reason, never offered: an offered
// Gatekeeper has to deploy from nothing but a Worker name, vars and its secrets.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { ProdWranglerConfig } from "./core/deployment-config.ts";
import type { CatalogGatekeeper, ExcludedGatekeeper, GatekeeperCatalog } from "./core/gatekeepers.ts";
import { BUILT_IN_GATEKEEPER_SLUGS } from "./core/naming.ts";
import { BSPORT_VARS } from "./core/bsport.ts";

/** Why a package's own config rules it out, or undefined when nothing does. */
function unsupported(config: ProdWranglerConfig): string | undefined {
  // Wrangler would provision each of these empty on the first deploy, or, for a service binding,
  // needs a Worker this deploy knows nothing about. The hosted service resolves them from instance
  // state; deployment.jsonc has no place for them.
  if (config.kv_namespaces?.length) return "it declares KV namespaces, which the starter would provision empty";
  if (config.r2_buckets?.length) return "it declares R2 buckets, which the starter would provision empty";
  if (config.services?.length) return "it declares service bindings to other Workers";
  if (config.artifacts) return "it declares an Artifacts binding";
  return undefined;
}

/**
 * The catalog for the project at `root`. Upstream's module is imported dynamically: it resolves
 * through the submodule's own install, and without one the catalog is `unavailable` rather than the
 * command crashing. A deployment that selects no optional Gatekeeper never needs it.
 */
export async function loadCatalog(root: string): Promise<GatekeeperCatalog> {
  let lib: typeof import("@gadgets/scripts/release/manifest-lib");
  try {
    lib = await import("@gadgets/scripts/release/manifest-lib");
  } catch (error) {
    return { offered: [], excluded: [], unavailable: `upstream's release tooling did not load: ${(error as Error).message}` };
  }
  let packages: ReturnType<typeof lib.readDeployablePackages>;
  try {
    packages = lib.readDeployablePackages(join(root, "cloudflare-os", "packages"))
      .filter((pkg) => lib.isGatekeeperPackage(pkg.name));
  } catch (error) {
    return { offered: [], excluded: [], unavailable: `cloudflare-os/packages could not be read: ${(error as Error).message}` };
  }

  const offered: CatalogGatekeeper[] = [];
  const excluded: ExcludedGatekeeper[] = [];
  for (const pkg of packages) {
    let slug: string | undefined;
    try {
      slug = lib.releaseShortName(pkg.name);
    } catch {
      // buildWorkerEntry below throws the same error, with the reason.
    }
    const exclude = (reason: string) => excluded.push({ package: pkg.name, ...(slug ? { slug } : {}), reason });
    try {
      // Re-read strictly: upstream's scan parses best-effort, and a config the deploy cannot parse
      // is one it cannot deploy.
      const errors: ParseError[] = [];
      const config = parse(readFileSync(join(pkg.dir, "wrangler.jsonc"), "utf8"), errors,
        { allowTrailingComma: true }) as ProdWranglerConfig;
      if (errors.length) {
        exclude(`its wrangler.jsonc does not parse: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
        continue;
      }
      // With no modules, what upstream's release would say about it: installable, preinstall,
      // singleton and its inputs. It throws on a config key or input upstream has not decided about.
      const entry = lib.buildWorkerEntry({
        pkgName: pkg.name,
        config: pkg.config,
        mainModule: pkg.config.main ?? "",
        modules: [],
        deployInputs: lib.readDeployInputs(pkg.dir),
      });
      slug = entry.shortName!;
      const inputs = entry.inputs ?? [];
      const problem = !entry.installable ? "upstream marks it not installable"
        : BUILT_IN_GATEKEEPER_SLUGS.includes(slug) ? "the starter always deploys it"
        : unsupported(config)
          ?? (inputs.some((input) => input.kind === "workerName")
            ? "it takes another Worker's name as an input" : undefined);
      if (problem) {
        exclude(problem);
        continue;
      }
      const manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8")) as { name?: unknown };
      if (typeof manifest.name !== "string") {
        exclude("its package.json has no name to build it by");
        continue;
      }
      const packageDir = `cloudflare-os/packages/${pkg.name}`;
      offered.push({
        slug,
        packageDir,
        packageName: manifest.name,
        preinstall: entry.preinstall === true,
        singleton: entry.singleton === true,
        secrets: inputs.filter((input) => input.kind === "secret"),
        vars: inputs.filter((input) => input.kind === "var"),
        ...(existsSync(join(pkg.dir, "README.md")) ? { readme: `${packageDir}/README.md` } : {}),
        config,
      });
    } catch (error) {
      exclude((error as Error).message);
    }
  }
  // Explicit registration: the pinned upstream catalogue cannot discover or build this package.
  const bsportConfig = join(root, "packages/gatekeeper-bsport/wrangler.jsonc");
  if (existsSync(bsportConfig)) {
    if (offered.some(entry => entry.slug === "bsport")) throw new Error("Upstream now offers bsport; resolve the local registration collision before deployment.");
    const errors: ParseError[] = [];
    const config = parse(readFileSync(bsportConfig, "utf8"), errors, { allowTrailingComma: true }) as ProdWranglerConfig;
    if (errors.length) throw new Error("packages/gatekeeper-bsport/wrangler.jsonc does not parse.");
    offered.push({
      slug: "bsport", packageDir: "packages/gatekeeper-bsport", packageName: "gatekeeper-bsport", workspace: "starter", auth: "api-key",
      preinstall: false, singleton: true, config, readme: "packages/gatekeeper-bsport/README.md",
      vars: BSPORT_VARS.map(name => ({ name, kind: "var", label: name })),
      secrets: [{ name: "BSPORT_API_KEY", kind: "secret", label: "bsport API key", setupSteps: [
        "This is not OAuth. One deployment-managed bsport key stays on this dedicated Worker. Never paste it into chat or deployment.jsonc.",
        "Confirm the account and existing Worker identity before a human enters the key securely. Setting a Worker secret deploys a new version and needs separate production approval.",
      ] }],
    });
  }
  return { offered, excluded };
}
