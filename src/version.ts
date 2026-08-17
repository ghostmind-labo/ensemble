/**
 * The package version, read from package.json rather than duplicated in source.
 *
 * A hardcoded string is one more thing to forget on a release; `npm version`
 * already updates package.json, so that file is the single source of truth.
 * Resolution differs between a checkout (src/ → ../package.json) and an
 * installed build (dist/ → ../package.json), but the relative path is the same.
 */
import { createRequire } from "node:module";

export function packageVersion(): string {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}
