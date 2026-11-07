# Windows desktop port

This branch adds an initial Windows x64 desktop build using Bops' existing Electron and Next.js app. It is a development build, not a published Windows release.

## Run and build

On Windows, install Node.js 24 LTS and run from the repository:

```powershell
npm ci
npm run app
```

The app starts its local server automatically. For an installer with a bundled production server:

```powershell
npm run test:windows
npm run test:desktop-agents
npm run app:build:win
```

The installer is `dist-desktop/Bops-<version>-windows-x64-setup.exe`, using the version in package.json. The unpacked app is `dist-desktop/win-unpacked/Bops.exe`. Both bundle their runtime. To sign the build, supply Windows signing credentials to electron-builder.

`npm run app:build:win -- --dir` builds only the unpacked app. `--skip-build` reuses the existing Next build, and should only be used if its source and build settings are current. Windows uses port 3211 by default; set `BOPS_DESKTOP_PORT` to select another port. `npm run smoke:windows` checks the packaged app with an isolated Electron profile and a spare port, without signing in or calling a model. Its screenshot goes to `.scratch/windows-smoke/sign-in.png`.

## Interim signing

For local development builds on Windows with the Windows SDK signing tools installed:

```powershell
npm run app:build:win:interim
```

Add `-- -SkipBuild` to reuse the current production server build. This creates or reuses a one-year **Bops Development** self-signed code-signing certificate in `Cert:\CurrentUser\My`, with a non-exportable private key. Electron Builder signs the app, uninstaller and installer using SHA-256 and an RFC 3161 timestamp before generating the installer blockmap. The command checks the installer and app signatures and writes the installer's SHA-256 checksum alongside it.

Only the public certificate is exported to `dist-desktop/Bops-development-signing.cer`. No trusted-root or trusted-publisher stores are modified. Windows will report the self-signed issuer as untrusted, and SmartScreen warnings can remain. This is for interim testing; a public release still needs a trusted signing identity. The private key stays with this Windows account and PC. Run `npm run app:build:win:interim -- -VerifyOnly` to check the existing artifacts without rebuilding. To use an existing code-signing certificate instead, set `BOPS_WINDOWS_SIGNING_THUMBPRINT` to its thumbprint and run the normal Windows build.

References: [Microsoft self-signed certificates](https://learn.microsoft.com/en-us/powershell/module/pki/new-selfsignedcertificate), [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool).

## What changed

- Windows native window controls, inherited Windows PATH and shell-free Node startup.
- A bundled server using directory junctions and refreshed files, without Developer Mode or administrator access. User state stays outside the installation folder.
- Windows named pipes for the authenticated browser rendering service.
- A per-user NSIS installer, Start menu entry and optional desktop shortcut.
- Windows DPAPI storage for sign-in keys, saved passwords and channel tokens. Ciphertext lives in `%USERPROFILE%/.bops/vault`, scoped to the Windows account; values never travel on a subprocess command line. Orgo account scoping remains in keychain.ts. This is encrypted file storage, not Windows Credential Manager.
- Saving through Bops' authenticated local restart API before terminating the server process tree on normal quit or restart.
- Windows settings links and primary PC/storage labels. The internal `mac` state names and bridge remain for compatibility.
- **Your PC** lists Windows displays and open windows. Select a source to view it live. Skills open their folders in File Explorer.
- **New thread** uses Codex or Claude Code with Podman when **This PC** is selected. The bot's browser shows the active guest in view-only mode. Windows keeps the PC awake during the agent run.

The platform tests exercise real DPAPI encryption/decryption, updates, account isolation, corrupt ciphertext, deletion, named pipe connections and server file refresh while preserving state.

## Remaining work

- **Native application automation:** Windows local computer tasks use Podman. The Windows screen viewer shows host windows live. Automated host-window watches and native application control are macOS features.
- **Relay:** not included by default. Supply a verified Windows relay at `vendor/orgo-relay/orgo-relay.exe` to bundle it. Never rename or ship the Mac binary as a Windows executable.
- **Cloud runner installation and app tooling:** fresh builds do not contain upstream's Linux runner bundle or Ingot binaries. Existing cloud tasks and desktop orchestration do not require local bot control, but runner setup and app tooling need these optional assets. Provide a separately built and verified Linux runner bundle plus its checksum in `dist-runner`, and the Linux Ingot binaries in `vendor/ingot`. Do not create Linux runner bundles from Windows native dependencies. End-to-end signed-in tasks and cloud integrations still require testing with an account.
- **Updates and signing:** the macOS update feed is disabled on Windows. Interim self-signing is available above. Add a Windows release feed, publicly trusted Authenticode signing and a Windows-compatible updater before public distribution.
- **Recovery:** a server left behind by a crashed Windows app is reported as a busy port. Bops checks ownership before stopping a process.

Local data is under `%APPDATA%/Bops/server/.data`; diagnostics are available through the startup trouble screen's logs button. Self-hosting settings can be put in `%APPDATA%/Bops/.env.local`, outside the app. `BOPS_DESKTOP_USER_DATA` overrides the Electron profile directory for isolated development and smoke tests.

References: [Electron Builder NSIS](https://www.electron.build/docs/nsis/), [Microsoft DPAPI](https://learn.microsoft.com/en-us/dotnet/standard/security/how-to-use-data-protection).

## Desktop agents

Open **Settings → AI plans → Desktop agents**, or open a bot's profile and choose **AI → Desktop agents**.

1. Choose **Add Codex subscription**. Codex uses the installed CLI's existing ChatGPT login and a workspace-write sandbox. Run `codex login` in the CLI if you need to sign in.
2. Choose **Add Hermes** and turn on **Full access for Hermes** to let it run with your Windows account's permissions. Turning the grant off stops its current run. The grant applies to this Windows account, bot and roster entry.
3. Choose **Add Claude subscription**. Claude replies to text through the installed Claude Code CLI, with tools disabled. Run `claude auth login --claudeai` in the CLI if you need to sign in. Bops checks for the Claude account login before sending a prompt and leaves the CLI to manage its credentials.

Choose **Make default** on the agent you want to use, then send the bot a direct text message. Subscription agents require their own account logins and do not switch to API key billing.

Desktop agents run while Bops is open. Windows stops the CLI and its helper processes when a run ends or is cancelled. Prompts travel on stdin, and Bops credentials stay out of the child process. Direct chats pass up to 24 messages as context and have a ten-minute limit. If a desktop run fails, Bops shows the error in chat.

The global Hermes Windows installation is preferred over project-specific launchers. Set `BOPS_CODEX_BIN`, `BOPS_HERMES_BIN` or `BOPS_CLAUDE_BIN` to use a specific native executable, or `BOPS_HERMES_HOME` to choose a Hermes profile. Local agent work folders and access grants live under the signed-in user's `.bops` folder.

`npm run test:desktop-agents` uses fake CLIs to check account routing, literal stdin, denied grants, revocation, failed runs and owner-only controls. `npm run smoke:native-agents` is an optional live check that uses your signed-in Codex account and Hermes configuration; it asks for one Codex reply and one Hermes file write in a disposable folder. It is never run in CI.

Implementation references: [Codex non-interactive CLI and saved authentication](https://developers.openai.com/codex/noninteractive), [Hermes structured CLI output](https://hermes-agent.nousresearch.com/docs/reference/cli-commands#--format-stream-json--structured-jsonl-output), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference).

## This PC routines

1. Start the rootless Podman machine on this PC. Bops uses `podman-machine-default` by default. Set `BOPS_PODMAN_MACHINE` for a different local machine or `BOPS_PODMAN_BIN` for a different Podman executable.
2. Prepare Chief’s CUA Local VM image on that machine. Bops uses the existing `localhost/openmausbot/cua-local-vm:driver-0.20.0-v5` image.
3. In **Settings → This PC → Where your bots work**, choose **This PC**. For a signed-in account, Bops first turns off cloud scheduling. Keep Bops open and Windows awake.
4. Make Codex or Claude Code the bot’s default agent. Open **Routines → New local routine**, choose **Podman Local VM** or **Text reply**, and enter a schedule. Use **Run now** to try it.

Computer tasks start a fresh CUA desktop in Podman and remove it at the end. Open the bot's browser to watch its guest live. The idle browser keeps its own Firefox profile on this PC. Local routines report in Bops. Existing Connected App checks, calendar triggers, Bops skills, external delivery and Hermes routines require a separate integration. Hermes Full access applies to direct desktop chat.

Bops reports missing prerequisites or a failed local run in the routine report. It has no Orgo compute fallback. Selecting cloud computers explicitly restores cloud scheduling.

Reference: [Podman run and rootless networking](https://docs.podman.io/en/latest/markdown/podman-run.1.html).
