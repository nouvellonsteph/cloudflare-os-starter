import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

await build({
  configFile: false,
  root: "app",
  plugins: [viteSingleFile()],
  build: { outDir: "../dist", emptyOutDir: true },
});
await mkdir("src/generated", { recursive: true });
await writeFile("src/generated/app.txt", await readFile("dist/index.html"));
