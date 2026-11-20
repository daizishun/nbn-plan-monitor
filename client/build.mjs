// Client bundle for the standalone build.
//
// Mirrors the canonical Bun.build() configuration the Muse host used
// (via `@hatch/space-sdk/build`): bundles `client/index.html` to
// `client/dist/`, production-mode React, Tailwind via bun-plugin-tailwind.
//
// Run with `bun run build:client` (or `bun run build`) from the repo root.

import { rm } from "node:fs/promises";
import { basename } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const ENTRY = "./client/index.html";
const OUTDIR = "./client/dist";

if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
  throw new Error("build.mjs must run under Bun");
}

await rm(OUTDIR, { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("buildClient() failed; see logged diagnostics");
}

// Bun writes imported assets to `naming.asset` (`assets/<name>-<hash>.<ext>`)
// but emits the JS/CSS import URL as a bare `./<name>-<hash>.<ext>` — without
// the `assets/` directory prefix. Re-prefix only the bare imported-asset
// URLs to `./assets/...`. This is idempotent and never rewrites chunk refs.
const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));

for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) {
    continue;
  }
  let text = await output.text();
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) {
    await Bun.write(output.path, text);
  }
}
