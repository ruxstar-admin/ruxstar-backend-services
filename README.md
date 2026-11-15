# Ruxstar API

## Setting up the production database

`npm run setup:prod` prepares a new, empty `ruxstar_prod` database once: every index, the Ruxstar admin account, and every
module's settings with the app's default prices, fees, refund hours, limits and GST rules, all **switched off** (not live,
signups closed). It only writes to `ruxstar_prod` (or the database named with `--db <name>`, which must also be
`MONGODB_DB`), refuses a database that already has people or orders unless `--resume` is given, and never changes a value
already stored. Without `--apply` it only prints what it would write.

It reads nothing from `.env`; set everything in the PowerShell window you run it from.

1. Set the environment variables. The two secrets are typed at a hidden prompt, so they stay out of the shell history.

   ```powershell
   Set-Location <path to>\ruxstar-backend-services
   $env:MONGODB_URI = [System.Net.NetworkCredential]::new("", (Read-Host "MongoDB connection string for ruxstar_prod" -AsSecureString)).Password
   $env:MONGODB_DB = "ruxstar_prod"
   $env:ADMIN_PHONE = "+91XXXXXXXXXX"
   $env:ADMIN_NAME = "<admin's full name>"
   $env:ADMIN_USERNAME = "<username, 3 to 20 lowercase letters, digits, _ or .>"
   $env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", (Read-Host "Admin password (8+ characters, a letter and a number)" -AsSecureString)).Password
   $env:ADMIN_EMAIL = "<admin's email>"   # optional
   ```

2. Dry run. Writes nothing; prints one line per step with what it would write.

   ```powershell
   Set-Location <path to>\ruxstar-backend-services; npm run setup:prod
   ```

3. Apply. If it stops partway, fix the problem it names and run the second command; it fills in only what is missing,
   and changes nothing when everything is there.

   ```powershell
   Set-Location <path to>\ruxstar-backend-services; npm run setup:prod -- --apply
   Set-Location <path to>\ruxstar-backend-services; npm run setup:prod -- --apply --resume
   ```

4. Sign in to the console and review the prices. On the website, sign in with the admin's number and password and open
   `https://ruxstar.com/admin`: under Modules check each module's commission, platform fee, payout fee and minimum,
   delivery rates and rules; under GST add Ruxstar's GSTIN and address and check the rates. The same from PowerShell:

   ```powershell
   $api = "https://<API origin>"
   $web = @{ "x-client" = "web" }
   $login = @{ phone = "<admin's 10-digit number, without +91>"; password = $env:ADMIN_PASSWORD } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "$api/v1/account/login" -Headers $web -ContentType "application/json" -Body $login -SessionVariable console | Out-Null
   (Invoke-RestMethod -Uri "$api/v1/ruxstar/modules" -Headers $web -WebSession $console).data | ConvertTo-Json -Depth 6
   (Invoke-RestMethod -Uri "$api/v1/ruxstar/gst" -Headers $web -WebSession $console).data | ConvertTo-Json -Depth 8
   ```

   Change a value with the same session. Commission is in basis points (1000 is 10%) and money in paise (500 is ₹5); send
   only what changes:

   ```powershell
   Invoke-RestMethod -Method Patch -Uri "$api/v1/ruxstar/modules/pod" -Headers ($web + @{ "idempotency-key" = "$([guid]::NewGuid())" }) -ContentType "application/json" -Body '{"commissionBps":<basis points>,"platformFee":<paise>}' -WebSession $console
   ```

5. Switch modules on, one at a time, when they are ready: in the console under Modules, or with the same session. Module
   names are `pod`, `events`, `coaching`, `stays`, `turf`, `shop`, `delivery` and `ledger`.

   ```powershell
   Invoke-RestMethod -Method Patch -Uri "$api/v1/ruxstar/modules/pod" -Headers ($web + @{ "idempotency-key" = "$([guid]::NewGuid())" }) -ContentType "application/json" -Body '{"live":true,"signupsOpen":true}' -WebSession $console
   ```

   Then clear the secrets from the window:

   ```powershell
   Remove-Item Env:MONGODB_URI, Env:ADMIN_PASSWORD
   ```
