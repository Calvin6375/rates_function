# PowerShell script to update phone numbers only
# Usage: .\run-update-phones.ps1

$url = "https://us-central1-truepay-72060.cloudfunctions.net/updatePhoneNumbersHttp/updatePhoneNumbers"
$body = @{} | ConvertTo-Json

Write-Host "📱 Starting phone number update..." -ForegroundColor Cyan
Write-Host "📡 Calling: $url`n" -ForegroundColor Gray

try {
    $response = Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType "application/json"
    
    Write-Host "✅ Phone number update completed!`n" -ForegroundColor Green
    Write-Host "📊 Results:" -ForegroundColor Cyan
    $response | ConvertTo-Json -Depth 10
    
    if ($response.success) {
        Write-Host "`n✨ Successfully updated $($response.updatedUsers) out of $($response.totalUsers) users" -ForegroundColor Green
        if ($response.skippedUsers -gt 0) {
            Write-Host "ℹ️  $($response.skippedUsers) users already had phone numbers" -ForegroundColor Yellow
        }
    } else {
        Write-Host "`n❌ Update failed: $($response.error)" -ForegroundColor Red
    }
} catch {
    Write-Host "`n❌ Request failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

