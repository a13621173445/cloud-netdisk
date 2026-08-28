$base = 'C:\Users\Administrator\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6a8fe67d3ffafff7a675dffb\github-netdisk'

$files = @(
    '.gitignore',
    '.nojekyll',
    'CNAME',
    'README.md',
    'index.html',
    '.github/workflows/send-email.yml',
    'netdisk/index.html',
    'netdisk/login.html',
    'netdisk/account.html',
    'netdisk/admin.html',
    'netdisk/eula.html',
    'netdisk/register.html',
    'netdisk/reset-confirm.html',
    'netdisk/reset.html',
    'netdisk/shared.html',
    'netdisk/sponsor.html',
    'netdisk/verify.html',
    'netdisk/css/style.css',
    'netdisk/js/config.js',
    'netdisk/js/github.js',
    'netdisk/js/netdisk.js',
    'netdisk/js/ui.js',
    'netdisk/data/files.json',
    'netdisk/data/sessions.json',
    'netdisk/data/users.json',
    'netdisk/storage/.gitkeep'
)

$result = @()
foreach ($f in $files) {
    $path = Join-Path $base $f
    if (Test-Path $path) {
        $content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
        $result += @{path=$f; content=$content}
    }
}

$json = $result | ConvertTo-Json -Compress
Write-Host "FILE_COUNT: $($result.Count)"
# Output the JSON for the first 10 files to verify
$result[0..2] | ConvertTo-Json