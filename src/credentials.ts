/**
 * The one credential, and where it can come from.
 *
 * Both runtimes call OpenRouter, so both need `OPENROUTER_API_KEY`; there is no
 * alternative provider path. (An older message claimed a node could "go through
 * opencode" instead — opencode was removed, and that advice never worked.)
 *
 * The subtle failure this module exists for: an MCP server is spawned by its
 * host, so it inherits the host's environment at launch. A key exported in some
 * other terminal — or exported after the host started — is invisible to it, and
 * every run fails with the key "set". Hence `loadKeyFiles()`: the same
 * env-file convention the registry uses, extended to the home locations where a
 * long-lived agent process can actually find it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Where a key may live, lowest precedence last. A real env var always wins. */
export function keyFileCandidates(cwd: string): string[] {
  return [
    join(cwd, ".ensemble", ".env"),
    join(cwd, ".env"),
    join(homedir(), ".config", "ensemble", ".env"),
    join(homedir(), ".env"),
  ];
}

/**
 * Loads env files without letting them clobber real environment variables.
 *
 * Returns the files it read, so a caller can tell the user where a key came
 * from — "it worked but I don't know why" is its own support burden.
 */
export function loadKeyFiles(cwd: string = process.cwd()): string[] {
  const loaded: string[] = [];
  for (const file of keyFileCandidates(cwd)) {
    if (!existsSync(file)) continue;
    try {
      const before = { ...process.env };
      process.loadEnvFile(file);
      // Node's loader overwrites; restore so an explicitly exported variable and
      // an earlier (higher-precedence) file both beat a later one.
      for (const [key, value] of Object.entries(before)) {
        if (value !== undefined) process.env[key] = value;
      }
      loaded.push(file);
    } catch {
      // A malformed env file must not stop the run; the missing-key error below
      // is a far better diagnostic than a parse failure here.
    }
  }
  return loaded;
}

export function hasApiKey(): boolean {
  return Boolean(process.env["OPENROUTER_API_KEY"]);
}

/**
 * The message shown wherever the key is missing — one text, so the CLI, the
 * validator, and the MCP server cannot drift into giving different advice.
 */
export function missingKeyMessage(context?: "mcp"): string {
  const lines = [
    "OPENROUTER_API_KEY is not set — every node calls OpenRouter, so nothing can run without it.",
    "",
    "Set it in any of these (a real environment variable always wins):",
    ...keyFileCandidates(process.cwd()).map((f) => `  ${f}`),
    "  or export OPENROUTER_API_KEY=sk-or-…   (https://openrouter.ai/keys)",
  ];
  if (context === "mcp") {
    lines.push(
      "",
      "Note: this MCP server was spawned by your editor/host and inherited its",
      "environment at launch, so exporting the key in another terminal will not",
      "reach it. Put it in one of the files above, or restart the host.",
    );
  }
  return lines.join("\n");
}
