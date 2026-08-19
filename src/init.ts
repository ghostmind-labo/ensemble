/**
 * `ensemble init` — make a project's `.ensemble/` folder legible to an editor.
 *
 * The problem it solves: a scene lives in `.ensemble/scenes/*.mts` with no
 * `node_modules` and no tsconfig, by design — the import resolves at RUN time
 * against the global install. An editor cannot see that, so it reports
 * `Import "@ghostmind-dev/ensemble" not a dependency`, and because the import
 * fails the `state` schemas never flow into `when: (s) => s.score < 8`, leaving
 * `s` as `any`. Typed state's whole selling point is invisible exactly where it
 * should pay off.
 *
 * Three files fix it, and none of them changes how a run behaves:
 *   - `node_modules/@ghostmind-dev/ensemble` — a symlink to the installed
 *     package, so ordinary node resolution works for the language service.
 *   - `tsconfig.json` — module settings for TypeScript/VS Code.
 *   - `deno.json` — an import map, for editors whose LSP is Deno.
 *
 * Everything is idempotent and additive: existing files are left alone unless
 * `--force`, so running it twice is safe and running it in a live project
 * cannot clobber work.
 */
import { mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync, lstatSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The installed package root — `dist/` and `src/` are both one level down. */
export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export interface InitResult {
  created: string[];
  skipped: string[];
  root: string;
}

const TSCONFIG = {
  // Scenes are ES modules run by Node's native type stripping, so the editor
  // should type-check them the same way the engine loads them.
  compilerOptions: {
    target: "ES2023",
    lib: ["ES2023"],
    module: "ESNext",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    // Scenes import only this package, so do not hunt for ambient @types —
    // asking for "node" without @types/node installed is itself an error.
    types: [],
  },
  include: ["scenes/**/*.mts", "scenes/**/*.ts"],
};

function denoConfig(version: string): unknown {
  return {
    // Deno's LSP resolves npm: specifiers, which is what makes the import (and
    // therefore the typed `state` schemas) resolve in a Deno-backed editor.
    imports: { "@ghostmind-dev/ensemble": `npm:@ghostmind-dev/ensemble@^${version}` },
    nodeModulesDir: "auto",
  };
}

const GITIGNORE = [
  "# Run artifacts and the editor shim — regenerate with `ensemble init`.",
  "runs/",
  "node_modules/",
  ".env",
  "",
].join("\n");

const STARTER = `import { scene, z } from "@ghostmind-dev/ensemble";

export default scene({
  name: "starter",
  // Cheap, fast worker by default; the strong model sits at the gate.
  defaults: { model: "openrouter/deepseek/deepseek-v4-flash" },

  // Shapes are enforced at run time AND type \`s\` in the edges below.
  state: { score: z.number().min(0).max(10), answer: z.string() },

  nodes: {
    writer: { inputs: ["feedback"], outputs: ["answer"] },
    judge: {
      model: "openrouter/z-ai/glm-5.3",
      prompt: "Score the answer 0-10 and give one concrete improvement.",
      inputs: ["answer"],
      outputs: ["score", "feedback"],
    },
  },

  edges: [
    { from: "writer", to: "judge" },
    // Loop-back FIRST: the engine takes the first matching edge.
    { from: "judge", to: "writer", when: (s) => s.score < 8, maxLoops: 2 },
  ],

  entry: "writer",
  exit: "judge",
});
`;

/**
 * Writes the scaffold. `force` overwrites files that already exist; without it
 * they are reported as skipped so nothing of yours is lost.
 */
export function initProject(cwd: string, opts: { force?: boolean; starter?: boolean } = {}): InitResult {
  const root = join(cwd, ".ensemble");
  const created: string[] = [];
  const skipped: string[] = [];

  mkdirSync(join(root, "scenes"), { recursive: true });

  const put = (file: string, body: string): void => {
    const path = join(root, file);
    if (existsSync(path) && !opts.force) {
      skipped.push(relative(cwd, path));
      return;
    }
    writeFileSync(path, body, "utf8");
    created.push(relative(cwd, path));
  };

  const version = (() => {
    try {
      return (JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string })
        .version;
    } catch {
      return "0.0.0";
    }
  })();

  put("tsconfig.json", `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  put("deno.json", `${JSON.stringify(denoConfig(version), null, 2)}\n`);
  put(".gitignore", GITIGNORE);
  if (opts.starter) put(join("scenes", "starter.mts"), STARTER);

  // The symlink is what makes plain TypeScript resolution work with no install.
  const linkDir = join(root, "node_modules", "@ghostmind-dev");
  const link = join(linkDir, "ensemble");
  try {
    mkdirSync(linkDir, { recursive: true });
    const exists = (() => {
      try {
        lstatSync(link);
        return true;
      } catch {
        return false;
      }
    })();
    if (exists && opts.force) rmSync(link, { recursive: true, force: true });
    if (!exists || opts.force) {
      symlinkSync(packageRoot(), link, "dir");
      created.push(relative(cwd, link));
    } else {
      skipped.push(relative(cwd, link));
    }
  } catch {
    // A filesystem without symlinks still gets tsconfig + deno.json; the run
    // path never depended on any of this.
  }

  return { created, skipped, root };
}
