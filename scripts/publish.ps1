# Publish the SpacetimeDB module to Maincloud.
# Usage (from AgentBox\):  .\scripts\publish.ps1            # keep data unless the schema change breaks it
#                          .\scripts\publish.ps1 -Wipe      # delete ALL data, then publish
# Needs: spacetime CLI, `spacetime login` as the owner of the database.
param([switch]$Wipe)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Read STDB_DB from .env (falls back to legacy-data).
$db = 'legacy-data'
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*STDB_DB\s*=' } | Select-Object -First 1
    if ($line) { $db = ($line -split '=', 2)[1].Trim() }
}

$clear = if ($Wipe) { 'always' } else { 'on-conflict' }
Write-Host "Publishing spacetimedb/ to Maincloud database '$db' (clear data: $clear)"

Push-Location (Join-Path $root 'spacetimedb')
try {
    if (-not (Test-Path 'node_modules')) { npm install }
    npx tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Type check failed; not publishing.' }
    # The value must be attached with '=' (the CLI treats it as optional).
    spacetime publish $db --server maincloud "--delete-data=$clear" -y
    if ($LASTEXITCODE -ne 0) { throw 'spacetime publish failed.' }
}
finally {
    Pop-Location
}

Write-Host "Done. Regenerate dashboard bindings if the schema changed:"
Write-Host "  spacetime generate --lang typescript --out-dir dashboard/src/module_bindings --module-path spacetimedb"
