# PowerShell script to run user migration
# Usage: .\run-migration.ps1

$PROJECT_ID = "truepay-72060"
$REGION = "us-central1"
$FUNCTION_NAME = "migrateUsersHttp"

$url = "https://${REGION}-${PROJECT_ID}.cloudfunctions.net/${FUNCTION_NAME}/migrateUsers"

Write-Host "🚀 Starting user migration..." -ForegroundColor Green
Write-Host "📡 Calling: $url" -ForegroundColor Cyan
Write-Host ""

try {
    $body = @{} | ConvertTo-Json
    $response = Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType "application/json"
    
    Write-Host "✅ Migration completed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "📊 Results:" -ForegroundColor Yellow
    $response | ConvertTo-Json -Depth 10
    
    if ($response.success) {
        Write-Host ""
        Write-Host "✨ Successfully migrated $($response.updatedUsers) out of $($response.totalUsers) users" -ForegroundColor Green
        if ($response.skippedUsers -gt 0) {
            Write-Host "ℹ️  $($response.skippedUsers) users already had all fields" -ForegroundColor Cyan
        }
    } else {
        Write-Host ""
        Write-Host "❌ Migration failed: $($response.error)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host ""
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "Details: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
    exit 1
}

