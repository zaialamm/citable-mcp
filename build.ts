/**
 * Builds the npm bin: mcp/server.ts → mcp/dist/server.js (ESM, Node ≥ 20.18, deps external).
 * Run from mcp/:  bun build.ts   (also runs on `npm publish` via prepublishOnly)
 */
const pkg = (await Bun.file("./package.json").json()) as { version: string };
const result = await Bun.build({
  entrypoints: ["./server.ts"],
  define: { "process.env.CITABLE_MCP_VERSION": JSON.stringify(pkg.version) },
  target: "node",
  format: "esm",
  packages: "external",
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const artifact = result.outputs[0];
if (!artifact) throw new Error("bundler produced no output");
// The source shebang points at bun; the published bin must run under node.
const js = (await artifact.text()).replace(/^#!.*\n/, "");
await Bun.write("dist/server.js", `#!/usr/bin/env node\n${js}`);
console.log(`built dist/server.js (${(js.length / 1024).toFixed(1)} kB)`);
