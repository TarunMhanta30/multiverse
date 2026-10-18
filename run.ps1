# Multiverse: start everything on Windows. Needs Python 3.11+ and Docker Desktop (running).
# Run:  powershell -ExecutionPolicy Bypass -File run.ps1      then open http://localhost:8765
Set-Location $PSScriptRoot
$ports = docker ps --format "{{.Ports}}" 2>$null
if (-not ($ports -match "6380->6379")) {
  Write-Host "Starting FalkorDB in Docker on port 6380..."
  docker run -d --rm --name multiverse-falkordb -p 6380:6379 -p 3001:3000 falkordb/falkordb:latest | Out-Null
  Start-Sleep -Seconds 4
}
python -m pip install -r requirements.txt
python check_setup.py
python world.py
python app.py