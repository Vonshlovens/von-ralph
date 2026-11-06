import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite-plus";

// SvelteKit 3: the Kit config lives in the plugin options (no svelte.config.js).
export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },
      // A client-only SPA: `ralph serve` serves build/ and falls back to index.html.
      adapter: adapter({ fallback: "index.html" }),
    }),
  ],
  server: {
    // `pnpm --dir web dev` against a running `ralph serve`.
    proxy: { "/v1": process.env.RALPH_SERVE_URL ?? "http://127.0.0.1:7420" },
  },
});
