import { defineConfig, type Options } from "tsup";

const common = {
  format: ["esm"],
  platform: "node",
  target: "node20",
  splitting: false,
  noExternal: [/^@agent-identity\//],
} satisfies Options;

export default defineConfig([
  {
    ...common,
    entry: { index: "src/index.ts" },
    clean: true,
    dts: true,
  },
  {
    ...common,
    entry: { cli: "src/cli.ts", server: "src/server.ts" },
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
