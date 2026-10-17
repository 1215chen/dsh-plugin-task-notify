# Build the DSH task-notify APK from source.
#
# Requirements:
#   - JDK 17+ (javac, jar, keytool)
#   - Node.js 22+ (only to strip a javac debug attribute that d8 34 mishandles)
#   - Android build-tools 34 and platform android-34 under .\_sdk
#
# The Android SDK is not vendored by default. Expected tree:
#   _sdk\build-tools\android-14\{aapt2.exe,d8.bat,zipalign.exe,apksigner.bat}
#   _sdk\platform\android-34\android.jar
#
# Run from the project root (or double-click build-apk.cmd):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\build-apk.ps1
#
# Note: native Android tools are passed paths relative to this project because
# the Windows PowerShell 5.1 -> native-argument bridge mangles absolute paths
# containing non-ASCII characters (the project directory contains Chinese).

param(
    [string]$SdkRoot = "_sdk",
    [string]$Output = "release\DSH-Task-Notify-1.2.0.apk",
    [string]$Keystore = "apk\keystore\dsh-task-notify.p12",
    [string]$StorePassword = $env:DSH_KEYSTORE_PASSWORD
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
$finalOutput = $Output
Push-Location $root
try {
    function Invoke-Native {
        param([string]$File, [string[]]$Arguments)
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "command failed ($LASTEXITCODE): $File $($Arguments -join ' ')"
        }
    }

    if (-not (Test-Path $SdkRoot)) {
        throw "Android SDK not found at '$SdkRoot'. Extract build-tools 34 and platform android-34 there, or pass -SdkRoot."
    }
    $buildTools = Join-Path $SdkRoot "build-tools\android-14"
    if (-not (Test-Path (Join-Path $buildTools "aapt2.exe"))) {
        $candidate = Get-ChildItem (Join-Path $SdkRoot "build-tools") -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName "aapt2.exe") } |
            Sort-Object Name -Descending |
            Select-Object -First 1
        if (-not $candidate) { throw "aapt2.exe not found under $SdkRoot\build-tools" }
        $buildTools = Join-Path $SdkRoot "build-tools" $candidate.Name
    }
    $androidJar = Join-Path $SdkRoot "platform\android-34\android.jar"
    if (-not (Test-Path $androidJar)) {
        $candidate = Get-ChildItem (Join-Path $SdkRoot "platform") -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName "android.jar") } |
            Sort-Object Name -Descending |
            Select-Object -First 1
        if (-not $candidate) { throw "android.jar not found under $SdkRoot\platform" }
        $androidJar = Join-Path $SdkRoot "platform" $candidate.Name "android.jar"
    }

    # All tool-facing paths below are relative to the project root.
    $aapt2 = Join-Path $buildTools "aapt2.exe"
    $d8 = Join-Path $buildTools "d8.bat"
    $zipalign = Join-Path $buildTools "zipalign.exe"
    $apksigner = Join-Path $buildTools "apksigner.bat"
    $androidJarArg = $androidJar

    foreach ($tool in @($aapt2, $d8, $zipalign, $apksigner)) {
        if (-not (Test-Path $tool)) { throw "missing build tool: $tool" }
    }

    $build = "apk\build"
    $gen = "$build\gen"
    $classes = "$build\classes"
    $dex = "$build\dex"
    $resZip = "$build\res.zip"
    $baseApk = "$build\base.apk"
    $unsigned = "$build\unsigned.apk"
    $aligned = "$build\aligned.apk"
    $classesJar = "$build\classes.jar"
    $rJava = "$gen\com\dsh\tasknotify\R.java"

    if (Test-Path $build) { Remove-Item $build -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $gen, $classes, $dex | Out-Null

    Write-Host "==> aapt2 compile"
    Invoke-Native $aapt2 @("compile", "--dir", "apk\res", "-o", $resZip)

    Write-Host "==> aapt2 link"
    Invoke-Native $aapt2 @(
        "link", "-o", $baseApk,
        "-I", $androidJarArg,
        "--manifest", "apk\AndroidManifest.xml",
        "--java", $gen,
        "--min-sdk-version", "26",
        "--target-sdk-version", "34",
        $resZip
    )

    Write-Host "==> javac"
    $sources = @(Get-ChildItem "apk\src\com\dsh\tasknotify" -Filter "*.java" |
        ForEach-Object { "apk\src\com\dsh\tasknotify\$($_.Name)" })
    $javacArgs = @("--release", "8", "-Xlint:-options", "-cp", $androidJarArg, "-d", $classes, $rJava) + $sources
    Invoke-Native "javac" $javacArgs

    Write-Host "==> strip MethodParameters (d8 34 null-name workaround)"
    Invoke-Native "node" @("_tools\strip-method-parameters.mjs", $classes)

    Write-Host "==> jar + d8"
    Invoke-Native "jar" @("--create", "--file", $classesJar, "-C", $classes, ".")
    Invoke-Native $d8 @("--release", "--lib", $androidJarArg, "--min-api", "26", "--output", $dex, $classesJar)

    Write-Host "==> package + zipalign"
    Copy-Item $baseApk $unsigned -Force
    Invoke-Native "jar" @("--update", "--file", $unsigned, "-C", $dex, "classes.dex")
    Invoke-Native $zipalign @("-f", "4", $unsigned, $aligned)

    Write-Host "==> sign"
    if (-not $StorePassword) {
        throw "Signing password is required: pass -StorePassword or set DSH_KEYSTORE_PASSWORD."
    }
    if (-not (Test-Path $Keystore)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Keystore) | Out-Null
        Invoke-Native "keytool" @(
            "-genkeypair", "-keystore", $Keystore, "-storetype", "PKCS12",
            "-alias", "dsh", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
            "-storepass", $StorePassword, "-keypass", $StorePassword,
            "-dname", "CN=DSH Task Notify, OU=Personal, O=DSH, L=Local, ST=Local, C=CN"
        )
    }
    $signedRelative = "release\DSH-Task-Notify-1.2.0.apk"
    New-Item -ItemType Directory -Force -Path "release" | Out-Null
    Invoke-Native $apksigner @(
        "sign",
        "--ks", $Keystore,
        "--ks-type", "PKCS12",
        "--ks-pass", "pass:$StorePassword",
        "--key-pass", "pass:$StorePassword",
        "--out", $signedRelative,
        $aligned
    )
    Invoke-Native $apksigner @("verify", "--verbose", $signedRelative)

    if ($finalOutput -and $finalOutput -ne $signedRelative) {
        $finalDir = Split-Path -Parent $finalOutput
        if ($finalDir) { New-Item -ItemType Directory -Force -Path $finalDir | Out-Null }
        Copy-Item $signedRelative $finalOutput -Force
    } else {
        $finalOutput = $signedRelative
    }

    $hash = (Get-FileHash $finalOutput -Algorithm SHA256).Hash
    $size = (Get-Item $finalOutput).Length
    Write-Host ""
    Write-Host "APK:    $finalOutput"
    Write-Host "Size:   $size bytes"
    Write-Host "SHA256: $hash"
}
finally {
    Pop-Location
}
