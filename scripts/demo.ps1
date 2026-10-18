# Demo: two users under one account, different plans, shared account limit, live plan change.
$base = "http://localhost:3000"
$json = "application/json"

$acc = Invoke-RestMethod -Method Post -Uri "$base/accounts" -ContentType $json -Body '{"name":"Demo Co"}'
$h = @{ "x-api-key" = $acc.apiKey }
Write-Host "Account created: $($acc.name) (plan $($acc.plan.name))" -ForegroundColor Cyan

$plans = (Invoke-RestMethod -Uri "$base/plans" -Headers $h).plans
$premium = ($plans | Where-Object { $_.name -eq "Premium" }).id

Invoke-RestMethod -Method Post -Uri "$base/users" -Headers $h -ContentType $json -Body '{"externalId":"alice"}' | Out-Null
$bobBody = @{ externalId = "bob"; planId = $premium } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/users" -Headers $h -ContentType $json -Body $bobBody | Out-Null
Write-Host "Users: alice (Basic: 1000/month, 20 per request), bob (Premium: 10000/month, 200 per request)" -ForegroundColor Cyan

function Consume($user, $units) {
  $body = @{ userId = $user; units = $units; requestId = [guid]::NewGuid().ToString() } | ConvertTo-Json
  $r = Invoke-RestMethod -Method Post -Uri "$base/consume" -Headers $h -ContentType $json -Body $body
  if ($r.accepted) {
    $line = "$user asks $units -> ACCEPTED"
    $color = "Green"
  } else {
    $line = "$user asks $units -> REJECTED by $($r.rejection.level) $($r.rejection.rule)"
    $color = "Yellow"
  }
  Write-Host ("{0} | user remaining {1} | account remaining {2}" -f $line, $r.user.remaining, $r.account.remaining) -ForegroundColor $color
}

Write-Host "`n1) Accepted action" -ForegroundColor Cyan
Consume "alice" 10

Write-Host "`n2) Rejected by the USER limit (alice max 20 per request)" -ForegroundColor Cyan
Consume "alice" 25

Write-Host "`n3) Switch the account to a small custom plan (120 per month)" -ForegroundColor Cyan
$tinyBody = @{ name = "Tiny"; type = "account"; monthlyAllowance = 120; maxPerRequest = 100 } | ConvertTo-Json
$tiny = Invoke-RestMethod -Method Post -Uri "$base/plans" -Headers $h -ContentType $json -Body $tinyBody
$switch = @{ planId = $tiny.id } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri "$base/account/plan" -Headers $h -ContentType $json -Body $switch | Out-Null
Consume "bob" 100

Write-Host "`n4) Rejected by the shared ACCOUNT limit (bob has plenty, the account does not)" -ForegroundColor Cyan
Consume "bob" 50

Write-Host "`n5) Raise the plan allowance. Same request, different result, no client change" -ForegroundColor Cyan
$raise = @{ monthlyAllowance = 1000 } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri "$base/plans/$($tiny.id)" -Headers $h -ContentType $json -Body $raise | Out-Null
Consume "bob" 50

Write-Host "`nUsage summary:" -ForegroundColor Cyan
$u = Invoke-RestMethod -Uri "$base/usage" -Headers $h
Write-Host ("account: consumed {0}, remaining {1}" -f $u.account.consumed, $u.account.remaining)
$u.users | ForEach-Object { Write-Host ("{0}: consumed {1}, remaining {2}" -f $_.userId, $_.consumed, $_.remaining) }
