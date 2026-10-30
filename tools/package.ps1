# Builds the store upload zip: dist\cricket-ad-muter-<version>.zip
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File tools\package.ps1
#
# Zips entry by entry because Windows PowerShell's Compress-Archive writes
# backslash paths (icons\icon-16.png), which the Chrome Web Store can reject.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json

if ($manifest.homepage_url -match 'YOUR_GITHUB_USERNAME') {
  Write-Warning 'manifest.json homepage_url still has YOUR_GITHUB_USERNAME. Online rule updates and "Report a problem" will be off.'
}

# Only what the extension needs at runtime. Docs, store assets and tools stay out.
$include = @('manifest.json', 'sites.js', 'background.js', 'content.js', 'popup.html', 'popup.css', 'popup.js', 'welcome.html', 'welcome.css', 'welcome.js', 'rules.json', 'icons')

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zipPath = Join-Path $dist ("cricket-ad-muter-{0}.zip" -f $manifest.version)
if (Test-Path $zipPath) { Remove-Item $zipPath }

$zip = [IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($item in $include) {
    $full = Join-Path $root $item
    $files = if (Test-Path $full -PathType Container) { Get-ChildItem $full -File -Recurse } else { Get-Item $full }
    foreach ($f in $files) {
      $entry = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entry, 'Optimal') | Out-Null
    }
  }
} finally {
  $zip.Dispose()
}
Write-Host "Built $zipPath"
