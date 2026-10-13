// Builds the self-contained server the desktop app runs, and stages it in
// apps/desktop/server/ for electron-builder:
//   1. next build with output "standalone" (CAREERFIEND_DESKTOP_BUILD=1)
//   2. copy the static assets the standalone server does not include
//   3. drop what the desktop app never loads (native image optimizer, serverless Chromium, sources)
//   4. rename every node_modules folder to _node_modules: electron-builder never packages folders named
//      node_modules as extra resources. The app renames them back when it unpacks the server (main.cjs).
// Run from the repo root: npm run desktop:server
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dash = path.join(root, "apps", "dashboard");
const out = path.join(root, "apps", "desktop", "server");

// Clear old output first: Next's file tracing would otherwise pick up a previously staged server.
rmSync(out, { recursive: true, force: true });
rmSync(path.join(dash, ".next"), { recursive: true, force: true });
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "build"], {
  cwd: dash,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, CAREERFIEND_DESKTOP_BUILD: "1", NEXT_TELEMETRY_DISABLED: "1" },
});

const standalone = path.join(dash, ".next", "standalone");
cpSync(standalone, out, { recursive: true, verbatimSymlinks: false, dereference: true });
cpSync(path.join(dash, ".next", "static"), path.join(out, "apps", "dashboard", ".next", "static"), { recursive: true });
if (existsSync(path.join(dash, "public"))) cpSync(path.join(dash, "public"), path.join(out, "apps", "dashboard", "public"), { recursive: true });

for (const nm of [path.join(out, "node_modules"), path.join(out, "apps", "dashboard", ".next", "node_modules")]) {
  for (const dir of readdirSync(nm).filter((d) => /^(@img|sharp|@sparticuz)(-[0-9a-f]+)?$/.test(d)))
    rmSync(path.join(nm, dir), { recursive: true, force: true });
}
// File tracing also copies the desktop app's own folder (its build tools and output): never needed.
rmSync(path.join(out, "apps", "desktop"), { recursive: true, force: true });
// Source folders copied by tracing are not needed at run time (the compiled server is in .next).
for (const dir of ["app", "components", "lib"]) rmSync(path.join(out, "apps", "dashboard", dir), { recursive: true, force: true });

// Next links its externals (.next/node_modules/<name>-<hash>) with absolute symlinks into the build
// machine; installers cannot carry symlinks (and these would point nowhere): copy their targets instead.
const resolveLinks = (dir) => {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isSymbolicLink()) {
      const target = realpathSync(p);
      rmSync(p, { force: true });
      cpSync(target, p, { recursive: true, dereference: true });
      if (lstatSync(p).isDirectory()) resolveLinks(p);
    } else if (d.isDirectory()) resolveLinks(p);
  }
};
resolveLinks(out);

// Deepest first, so renaming a parent never moves a folder still to be visited.
const renameModules = (dir) => {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = path.join(dir, d.name);
    renameModules(p);
    if (d.name === "node_modules") renameSync(p, path.join(dir, "_node_modules"));
  }
};
renameModules(out);
writeFileSync(path.join(out, "STAGED"), new Date().toISOString());

const size = (p) => readdirSync(p, { withFileTypes: true }).reduce((n, d) => n + (d.isDirectory() ? size(path.join(p, d.name)) : 0) + 1, 0);
console.log(`Desktop server staged in ${path.relative(root, out)} (${size(out)} files).`);
