/**
 * Module resolution hook, so a scene can `import { scene } from
 * "@ghostmind-dev/ensemble"` with **no package.json and no node_modules**.
 *
 * Node resolves bare specifiers by walking up looking for node_modules; a
 * globally-installed CLI is not on that path. Without this hook the only ways to
 * get types in a scene are to install the package locally or to drop the import
 * and lose them. Neither is acceptable for `npm i -g` + write one file.
 *
 * This runs on the loader thread, so the path to our own entry point is handed
 * over via `register(..., { data })` rather than captured from a closure.
 */
let selfUrl: string | undefined;

const PACKAGE = "@ghostmind-dev/ensemble";

export function initialize(data: { selfUrl: string }): void {
  selfUrl = data.selfUrl;
}

export async function resolve(
  specifier: string,
  context: unknown,
  next: (s: string, c: unknown) => unknown,
): Promise<unknown> {
  const ours = specifier === PACKAGE || specifier.startsWith(`${PACKAGE}/`);

  // Normal resolution first — this is a *fallback*, not an override. A project
  // that installed its own copy (possibly a different version) must keep using
  // it; silently substituting the CLI's build would be a nasty surprise.
  try {
    return await next(specifier, context);
  } catch (err) {
    if (!ours || !selfUrl) throw err;
    // Subpaths beyond the root are not part of the public API, so everything
    // maps to the single entry point.
    return { url: selfUrl, shortCircuit: true, format: "module" };
  }
}
