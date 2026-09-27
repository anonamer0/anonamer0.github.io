# 發布到手機:把「合約風控助手」最新的網頁檔複製過來,推上 GitHub Pages
# 只複製下面這幾個檔案,交易紀錄、伺服器程式都不會上傳
$src = Join-Path $PSScriptRoot '..\合約風控助手'
$files = 'index.html', 'app.js', 'manifest.webmanifest', 'icon.png', 'icon-192.png', 'icon-512.png'
foreach ($f in $files) { Copy-Item (Join-Path $src $f) $PSScriptRoot -Force }
if (-not (Test-Path (Join-Path $PSScriptRoot '.nojekyll'))) { New-Item -ItemType File (Join-Path $PSScriptRoot '.nojekyll') | Out-Null }
git -C $PSScriptRoot add -A
git -C $PSScriptRoot commit -m ("更新 " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
git -C $PSScriptRoot push -u origin main
