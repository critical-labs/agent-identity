import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts", server: "src/server.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  splitting: false,
  clean: true,
  dts: { entry: { index: "src/index.ts" } },
  noExternal: [/^@agent-identity\//],
  banner: { js: "#!/usr/bin/env node" },
});
