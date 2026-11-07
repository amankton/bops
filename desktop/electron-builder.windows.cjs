const { build } = require("../package.json");
const fs = require("node:fs");
const signingThumbprint = process.env.BOPS_WINDOWS_SIGNING_THUMBPRINT;
if (signingThumbprint && !/^[a-f\d]{40}$/i.test(signingThumbprint)) {
  throw new Error("BOPS_WINDOWS_SIGNING_THUMBPRINT must be a certificate's 40-character thumbprint.");
}

// Keep the server resources shared with macOS. Optional tools must be Windows builds or Linux VM assets.
module.exports = {
  extends: null,
  ...build,
  publish: null,
  ...(signingThumbprint ? { forceCodeSigning: true } : {}),
  extraResources: [
    ...build.extraResources.slice(0, 4),
    ...(fs.existsSync("vendor/orgo-relay/orgo-relay.exe") ? [{ from: "vendor/orgo-relay/orgo-relay.exe", to: "bin/orgo-relay.exe" }] : []),
    ...(fs.existsSync("vendor/ingot") ? [build.extraResources[5]] : []),
    ...(fs.existsSync("dist-runner") ? [build.extraResources[6]] : []),
  ],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "desktop/icon.png",
    artifactName: "Bops-${version}-windows-${arch}-setup.${ext}",
    ...(signingThumbprint ? {
      signtoolOptions: {
        certificateSha1: signingThumbprint,
        signingHashAlgorithms: ["sha256"],
        rfc3161TimeStampServer: "http://timestamp.digicert.com",
      },
    } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
};
