import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  clean: true,
  format: ["esm"],
  dts: true,
  sourcemap: true,
  target: "node20",
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
