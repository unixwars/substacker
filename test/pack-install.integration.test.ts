import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

// Packs substacker-core, installs the tarball in an empty project and imports
// every subpath it exports. Catches undeclared dependencies and files missing
// from the package. Needs the npm registry for the tarball's dependencies.

const root = join(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let work = "";
let project = "";
let tarball = "";

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "substacker-pack-"));
  project = join(work, "consumer");
  run("node", ["-e", `require('node:fs').mkdirSync(${JSON.stringify(project)})`], work);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  // `prepack` in the package builds dist before packing.
  run(npm, ["pack", "-w", "substacker-core", "--pack-destination", work, "--silent"], root);
  tarball = join(work, readdirSync(work).find((f) => f.endsWith(".tgz"))!);
  run(npm, ["install", tarball, "--no-audit", "--no-fund"], project);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

it("imports every subpath of the installed tarball", () => {
  const pkg = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")) as {
    exports: Record<string, unknown>;
  };
  const subpaths = Object.keys(pkg.exports);
  expect(subpaths).toContain(".");
  for (const sub of subpaths) {
    const spec = sub === "." ? "substacker-core" : `substacker-core/${sub.slice(2)}`;
    const out = run("node", ["--input-type=module", "-e", `const m = await import(${JSON.stringify(spec)}); console.log(Object.keys(m).length)`], project);
    expect(Number(out.trim())).toBeGreaterThan(0);
  }
});

it("does not ship tests or sources", () => {
  const listing = run("tar", ["-tzf", tarball], work);
  expect(listing).not.toMatch(/\.test\./);
  expect(listing).not.toMatch(/package\/src\//);
});
