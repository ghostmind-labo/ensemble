#!/usr/bin/env node
// Thin launcher so `ensemble` works as an installed bin. Node >=22.6 strips the
// TypeScript types at load time; no build step.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, "..", "src", "cli.ts"));
