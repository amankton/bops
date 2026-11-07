import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Windows DPAPI binds ciphertext to the current Windows account. Values travel only over stdin/stdout.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $r = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String($r.value)
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($r.operation -eq 'encrypt') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
  } else {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
  }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 }
`;

function crypt(operation: "encrypt" | "decrypt", value: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Windows secure storage timed out.")); }, 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.on("error", () => { clearTimeout(timer); reject(new Error("Windows secure storage could not start.")); });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("Windows secure storage could not protect or read this value."));
      resolve(Buffer.from(out.trim(), "base64"));
    });
    child.stdin.end(JSON.stringify({ operation, value: value.toString("base64") }));
  });
}

export function windowsVault(root = join(process.env.BOPS_DESKTOP_USER_DATA || join(homedir(), ".bops"), "vault")) {
  const file = (account: string) => join(root, `${createHash("sha256").update(`Bops Vault:${account}`).digest("hex")}.bin`);
  return {
    async set(account: string, value: string) {
      const encrypted = await crypt("encrypt", Buffer.from(value, "utf8"));
      mkdirSync(root, { recursive: true });
      const target = file(account);
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, encrypted, { mode: 0o600 });
        renameSync(temp, target);
      } finally { rmSync(temp, { force: true }); }
    },
    async get(account: string): Promise<string | null> {
      const target = file(account);
      if (!existsSync(target)) return null;
      return (await crypt("decrypt", readFileSync(target))).toString("utf8");
    },
    async delete(account: string) { rmSync(file(account), { force: true }); },
  };
}
