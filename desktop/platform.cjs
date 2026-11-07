const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function renderEndpoint(userData, platform = process.platform) {
  if (platform === "win32") return `\\\\.\\pipe\\bops-render-${crypto.createHash("sha256").update(userData).digest("hex").slice(0, 24)}`;
  const file = path.join(userData, "render.sock");
  return Buffer.byteLength(file) < 100 ? file : path.join(require("node:os").tmpdir(), "bops-render.sock");
}

/** Junctions work without Developer Mode or elevation; regular files are refreshed on every launch. */
function linkServer(dir, home, platform = process.platform) {
  fs.mkdirSync(path.join(home, ".data"), { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name === ".data" || name.startsWith(".env")) continue;
    const source = path.join(dir, name);
    const target = path.join(home, name);
    const st = fs.lstatSync(target, { throwIfNoEntry: false });
    if (platform === "win32" && !fs.statSync(source).isDirectory()) {
      if (st?.isSymbolicLink()) fs.unlinkSync(target);
      fs.copyFileSync(source, target);
      continue;
    }
    if (st && !st.isSymbolicLink()) continue;
    if (st && path.resolve(fs.readlinkSync(target)) === path.resolve(source)) continue;
    if (st) fs.unlinkSync(target);
    fs.symlinkSync(source, target, platform === "win32" ? "junction" : undefined);
  }
}

module.exports = { renderEndpoint, linkServer };
