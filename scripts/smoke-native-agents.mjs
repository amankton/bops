import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSubscriptionStatus, nativeBinary, runNative } from "../lib/server/native-agents.ts";

const work = mkdtempSync(join(tmpdir(), "bops-native-smoke-"));
try {
  const status = await codexSubscriptionStatus();
  assert.equal(status.signedIn, true, "Sign in to Codex CLI with ChatGPT first.");
  const codex = await runNative({ kind: "codex", binary: nativeBinary("codex"), cwd: work, fullAccess: false, timeoutMs: 90_000, prompt: "Connector smoke check. Reply exactly BOPS_CODEX_READY. Do not use any tools, run commands, read files or delegate." });
  assert.match(codex.text, /BOPS_CODEX_READY/);
  console.log("Live Codex subscription reply passed.");
  const marker = join(work, "hermes-full-access.txt");
  const hermes = await runNative({ kind: "hermes", binary: nativeBinary("hermes"), cwd: work, fullAccess: true, timeoutMs: 90_000, prompt: `Connector smoke check in a disposable folder. Use your file-writing tool to write exactly BOPS_HERMES_READY to this one file: ${marker}. Then reply exactly BOPS_HERMES_READY. Do not access other files, change configuration, use other tools or delegate.` });
  assert.match(hermes.text, /BOPS_HERMES_READY/);
  assert.equal(readFileSync(marker, "utf8").trim(), "BOPS_HERMES_READY");
  console.log("Live Hermes reply and Full access file write passed.");
} finally { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
