#Requires -Version 5.1
[CmdletBinding()]
param([switch]$SkipBuild, [switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Build and sign the Windows app on Windows.' }
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$bopsRoot = Split-Path -Parent $PSScriptRoot
$bopsSignTool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $bopsSignTool) {
    $bopsSdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $bopsSignTool = Get-ChildItem -LiteralPath $bopsSdkBin -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
}
if (-not $bopsSignTool) { throw 'Install the Windows SDK signing tools (signtool.exe) first.' }

# Keep the private key local. Do not add the certificate to a trusted store.
$bopsSubject = 'CN=Bops Development'
$bopsFriendlyName = 'Bops interim Windows code signing'
$bopsCert = Get-ChildItem -Path Cert:\CurrentUser\My |
    Where-Object {
        $_.Subject -eq $bopsSubject -and $_.Issuer -eq $bopsSubject -and
        $_.FriendlyName -eq $bopsFriendlyName -and $_.HasPrivateKey -and
        ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3') -and
        $_.NotBefore -le (Get-Date) -and $_.NotAfter -gt (Get-Date).AddDays(7)
    } | Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $bopsCert) {
    if ($VerifyOnly) { throw 'The local Bops development signing certificate is missing.' }
    $bopsCert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $bopsSubject `
        -FriendlyName $bopsFriendlyName -CertStoreLocation Cert:\CurrentUser\My `
        -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable `
        -NotAfter (Get-Date).AddYears(1)
}

$bopsPreviousThumbprint = $env:BOPS_WINDOWS_SIGNING_THUMBPRINT
$bopsPreviousSignTool = $env:SIGNTOOL_PATH
Push-Location -LiteralPath $bopsRoot
try {
    $env:BOPS_WINDOWS_SIGNING_THUMBPRINT = $bopsCert.Thumbprint
    $env:SIGNTOOL_PATH = $bopsSignTool
    if (-not $VerifyOnly) {
        $bopsBuildArgs = @('scripts/build-windows.mjs')
        if ($SkipBuild) { $bopsBuildArgs += '--skip-build' }
        & node @bopsBuildArgs
        if ($LASTEXITCODE -ne 0) { throw "Windows build failed with exit code $LASTEXITCODE." }
    }

    $bopsPackage = Get-Content -LiteralPath (Join-Path $bopsRoot 'package.json') -Raw | ConvertFrom-Json
    $bopsOutput = Join-Path $bopsRoot 'dist-desktop'
    $bopsInstaller = Join-Path $bopsOutput "Bops-$($bopsPackage.version)-windows-x64-setup.exe"
    foreach ($bopsFile in @($bopsInstaller, (Join-Path $bopsOutput 'win-unpacked\Bops.exe'))) {
        $bopsSignature = Get-AuthenticodeSignature -LiteralPath $bopsFile
        if ($bopsSignature.SignerCertificate.Thumbprint -ne $bopsCert.Thumbprint -or
            -not $bopsSignature.TimeStamperCertificate -or
            $bopsSignature.Status -in @('NotSigned', 'HashMismatch', 'NotSupported', 'Incompatible')) {
            throw "Missing or invalid timestamped signature: $bopsFile ($($bopsSignature.Status))."
        }
        # SignTool verifies the file hash too. Only the expected self-signed root error is allowed.
        $bopsProcessInfo = New-Object System.Diagnostics.ProcessStartInfo
        $bopsProcessInfo.FileName = $bopsSignTool
        $bopsProcessInfo.Arguments = 'verify /pa /all /debug /v "' + $bopsFile + '"'
        $bopsProcessInfo.UseShellExecute = $false
        $bopsProcessInfo.CreateNoWindow = $true
        $bopsProcessInfo.RedirectStandardOutput = $true
        $bopsProcessInfo.RedirectStandardError = $true
        $bopsVerifier = [System.Diagnostics.Process]::Start($bopsProcessInfo)
        try {
            $bopsStdout = $bopsVerifier.StandardOutput.ReadToEndAsync()
            $bopsStderr = $bopsVerifier.StandardError.ReadToEndAsync()
            $bopsVerification = $bopsStdout.GetAwaiter().GetResult() + $bopsStderr.GetAwaiter().GetResult()
            $bopsVerifier.WaitForExit()
            $bopsVerificationExit = $bopsVerifier.ExitCode
        } finally { $bopsVerifier.Dispose() }
        $bopsExpectedTrustError = 'SignTool Error: A certificate chain processed, but terminated in a root\s+certificate which is not trusted by the trust provider\.'
        $bopsErrorCount = [regex]::Matches($bopsVerification, 'SignTool Error:').Count
        if ($bopsVerificationExit -ne 0 -and ($bopsErrorCount -ne 1 -or $bopsVerification -notmatch $bopsExpectedTrustError)) {
            throw "Signature verification failed: $bopsVerification"
        }
        Write-Host "Signed: $bopsFile (Windows trust: $($bopsSignature.Status))"
    }
    Export-Certificate -Cert $bopsCert -FilePath (Join-Path $bopsOutput 'Bops-development-signing.cer') -Type CERT | Out-Null
    $bopsHasher = [Security.Cryptography.SHA256]::Create()
    $bopsInstallerStream = [IO.File]::OpenRead($bopsInstaller)
    try { $bopsHash = [BitConverter]::ToString($bopsHasher.ComputeHash($bopsInstallerStream)).Replace('-', '').ToLowerInvariant() }
    finally { $bopsInstallerStream.Dispose(); $bopsHasher.Dispose() }
    Set-Content -LiteralPath "$bopsInstaller.sha256" -Encoding ASCII -Value "$bopsHash  $([IO.Path]::GetFileName($bopsInstaller))"
    Write-Host "Certificate: $($bopsCert.Thumbprint); expires $($bopsCert.NotAfter.ToString('yyyy-MM-dd'))"
    Write-Warning 'Interim self-signing does not establish a publicly trusted publisher or remove SmartScreen warnings.'
} finally {
    $env:BOPS_WINDOWS_SIGNING_THUMBPRINT = $bopsPreviousThumbprint
    $env:SIGNTOOL_PATH = $bopsPreviousSignTool
    Pop-Location
}
