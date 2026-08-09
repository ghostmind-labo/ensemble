#!/usr/bin/env node
// Launcher for the `ensemble` bin.
//
// Prefers the compiled build (dist/) — required for installed packages, because
// Node refuses to strip TypeScript types for anything under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Falls back to src/*.ts when
// running straight from a checkout that hasn't been built yet.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "dist", "cli.js");
const source = join(here, "..", "src", "cli.ts");

if (existsSync(built)) {
  await import(built);
} else if (existsSync(source)) {
  await import(source);
} else {
  console.error("ensemble: no build found — run `npm run build` in the package directory.");
  process.exit(1);
}
