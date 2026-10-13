import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  plugins: [pluginReact()],
  source: { entry: { index: "./src/main.tsx" } },
  html: { title: "Two agent prototypes" },
  output: { distPath: { root: "dist" } },
  // `pnpm server` answers the RPC calls; the dev server only serves the UI.
  server: { port: 3000, proxy: { "/rpc": "http://127.0.0.1:8787" } },
});
