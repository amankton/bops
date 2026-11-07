import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
if (process.platform !== "win32") throw new Error("Build the Windows app on Windows.");
const args = process.argv.slice(2);
if (args.some((arg) => !["--dir", "--skip-build"].includes(arg))) throw new Error("Options: --dir (unpacked app), --skip-build (reuse the current Next build).");
function run(script, argv, env = {}) {
  const result = spawnSync(process.execPath, [script, ...argv], { cwd: root, env: { ...process.env, ...env }, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!args.includes("--skip-build")) run("node_modules/next/dist/bin/next", ["build"], { NEXT_PUBLIC_BOPS_BRAINS: "1" });
const standalone = join(root, ".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) throw new Error("Build the Next standalone server first.");
// Match the Mac release's allowlist. Never ship a developer's state, env files or traced source tree.
const allowed = new Set([".next", "cloud", "LICENSE", "node_modules", "package.json", "public", "server.js", "slack", "vm"]);
for (const entry of readdirSync(standalone)) if (!allowed.has(entry)) rmSync(join(standalone, entry), { force: true, recursive: true });
const secrets = [];
for (const envFile of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (!existsSync(envFile)) continue;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) {
    if (value.length >= 12 && /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|DATABASE_URL/i.test(key)) secrets.push({ key, bytes: Buffer.from(value) });
  }
}
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (entry.isFile() && secrets.length) {
      const contents = readFileSync(file);
      for (const secret of secrets) if (contents.includes(secret.bytes)) throw new Error(`The build contains ${secret.key}. Refusing to package it.`);
    }
  }
}
for (const dir of [standalone, join(root, ".next", "static"), join(root, "public")]) check(dir);
rmSync(join(root, "desktop", "repo.json"), { force: true });
run("node_modules/electron-builder/cli.js", ["--config", "desktop/electron-builder.windows.cjs", "--win", ...(args.includes("--dir") ? ["--dir"] : []), "--publish", "never"]);
