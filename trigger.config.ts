import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_bovzrrbowxlpesdbuqar",
  runtime: "node",
  logLevel: "log",
  maxDuration: 3600,
  dirs: ["./src/trigger"],
});