/**
 * The docs are the repo's own markdown, read when a page is built. Nothing is copied into
 * this app, so the site can never say something the README and the plugin references don't.
 * Links between those files become links between pages; links to code go to GitHub.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { Marked, type Tokens } from "marked";

export const GITHUB = "https://github.com/ghostmind-labo/ensemble";
export const NPM = "https://www.npmjs.com/package/@ghostmind-dev/ensemble";
const RAW_IMAGES = "https://raw.githubusercontent.com/ghostmind-labo/ensemble/main/docs/images/";

/** The repo root: DOCS_ROOT in the container, the repo two levels up on the host. */
export function root(): string {
  const configured = process.env["DOCS_ROOT"];
  if (configured && existsSync(join(configured, "README.md"))) return configured;
  return resolve(process.cwd(), "../..");
}

export interface Page {
  slug: string;
  title: string;
  group: "Start" | "Guides" | "Reference";
  /** Relative to the repo root. */
  file: string;
  blurb: string;
}

const SKILLS = "plugin/skills";
export const PAGES: Page[] = [
  { slug: "overview", title: "Overview", group: "Start", file: "README.md", blurb: "What ensemble is, four demos, and the whole surface at a glance." },
  { slug: "build", title: "Build a runner", group: "Guides", file: `${SKILLS}/ensemble-build/SKILL.md`, blurb: "From a use case to a validated, dry-run runner, step by step." },
  { slug: "questions", title: "Design the questions", group: "Guides", file: `${SKILLS}/ensemble-questions/SKILL.md`, blurb: "Writing choice, score and noul questions Jev answers well." },
  { slug: "runs", title: "Read and tune runs", group: "Guides", file: `${SKILLS}/ensemble-runs/SKILL.md`, blurb: "What run.json says, and what to change when a decision is off." },
  { slug: "agent", title: "The agent as a component", group: "Guides", file: "docs/agent.md", blurb: "Drop an independent @ghostmind-dev/agent into a work node; ensemble supervises it." },
  { slug: "patterns", title: "Patterns", group: "Reference", file: `${SKILLS}/ensemble-build/references/patterns.md`, blurb: "Complete worked graphs for the common shapes." },
  { slug: "api", title: "API", group: "Reference", file: `${SKILLS}/ensemble-build/references/api.md`, blurb: "Every field, node kind, edge, option and export." },
  { slug: "errors", title: "Errors and fixes", group: "Reference", file: `${SKILLS}/ensemble-build/references/errors.md`, blurb: "Each validate message, what causes it, and the fix." },
  { slug: "discovery", title: "Models, skills and MCP", group: "Reference", file: `${SKILLS}/ensemble-build/references/discovery.md`, blurb: "Finding models, skills and MCP servers to wire in." },
];

export const GROUPS = ["Start", "Guides", "Reference"] as const;
export const pageBySlug = (slug: string): Page | undefined => PAGES.find((page) => page.slug === slug);

const slugify = (text: string): string =>
  text.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");

/** A link as written in `from`, pointed at where it lives on this site or on GitHub. */
export function rewrite(href: string, from: string): string {
  if (href.startsWith(RAW_IMAGES)) return `/images/${href.slice(RAW_IMAGES.length)}`;
  if (/^([a-z]+:|#|\/)/i.test(href)) return href;
  const [path = "", hash] = href.split("#");
  const target = posix.normalize(posix.join(posix.dirname(from), path));
  const anchor = hash ? `#${hash}` : "";
  const page = PAGES.find((candidate) => candidate.file === target);
  if (page) return `/docs/${page.slug}${anchor}`;
  if (target.startsWith("docs/images/")) return `/images/${posix.basename(target)}`;
  return `${GITHUB}/blob/main/${target}${anchor}`;
}

export interface Rendered {
  html: string;
  toc: Array<{ id: string; text: string }>;
  /** The first heading, when the page has one — shown as the title instead of the nav label. */
  heading?: string;
}

export function render(page: Page): Rendered {
  const source = readFileSync(join(root(), page.file), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  const toc: Rendered["toc"] = [];
  const seen = new Map<string, number>();
  let heading: string | undefined;
  let opened = false;

  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        const base = slugify(token.text) || "section";
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count ? `${base}-${count}` : base;
        // A page's title is a `#` that opens it, not one met after its first section (the README's demos).
        if (token.depth === 1 && !heading && !toc.length && !opened) heading = inner.replace(/<[^>]+>/g, "");
        if (token.depth === 2) opened = true;
        if (token.depth === 2 || (token.depth === 1 && page.slug === "overview")) toc.push({ id, text: inner.replace(/<[^>]+>/g, "") });
        return `<h${token.depth} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${token.depth}>\n`;
      },
      link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link) {
        const href = rewrite(token.href, page.file);
        const external = /^https?:/.test(href) ? ' target="_blank" rel="noopener"' : "";
        return `<a href="${href}"${token.title ? ` title="${token.title}"` : ""}${external}>${this.parser.parseInline(token.tokens)}</a>`;
      },
      image(token: Tokens.Image) {
        return `<img src="${rewrite(token.href, page.file)}" alt="${token.text}" loading="lazy">`;
      },
    },
  });

  let html = marked.parse(source, { async: false }) as string;
  // Raw HTML in the README points its images at GitHub; serve them from here instead.
  html = html.replaceAll(RAW_IMAGES, "/images/");
  return { html, toc, ...(heading ? { heading } : {}) };
}
