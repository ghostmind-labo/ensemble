import { defineConfig } from "astro/config";

// A static site. The tunnel reaches it under its public hostname, so Vite must accept that Host.
export default defineConfig({
  site: process.env.PUBLIC_URL,
  vite: {
    server: { allowedHosts: true },
    preview: { allowedHosts: true },
  },
});
