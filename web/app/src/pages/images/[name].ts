// The repo's docs/images, served by the site, so pages don't depend on GitHub for their pictures.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { APIRoute } from "astro";
import { root } from "../../lib/docs";

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif" };

export function getStaticPaths() {
  return readdirSync(join(root(), "docs/images"))
    .filter((name) => extname(name).toLowerCase() in TYPES)
    .map((name) => ({ params: { name } }));
}

export const GET: APIRoute = ({ params }) => {
  const name = String(params.name);
  return new Response(readFileSync(join(root(), "docs/images", name)), {
    headers: { "content-type": TYPES[extname(name).toLowerCase()] ?? "application/octet-stream" },
  });
};
