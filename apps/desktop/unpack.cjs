// Unpacks the staged server (see scripts/build-desktop.mjs) into a writable
// folder, renaming its _node_modules folders back to node_modules. Done once
// per build: a marker records which build is unpacked.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const d of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, d.name);
    const b = path.join(to, d.name === "_node_modules" ? "node_modules" : d.name);
    if (d.isDirectory()) copyTree(a, b);
    else if (d.isFile()) fs.copyFileSync(a, b);
  }
}

/** Returns the unpacked server's folder (`dest`). */
function unpackServer(src, dest) {
  const stamp = fs.readFileSync(path.join(src, "STAGED"), "utf8");
  const marker = path.join(dest, ".unpacked");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === stamp) return dest;
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(src, dest);
  fs.writeFileSync(marker, stamp);
  return dest;
}

module.exports = { unpackServer };
