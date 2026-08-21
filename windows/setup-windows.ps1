<#
.SYNOPSIS
    Prepare a Windows machine to be an ojee-remote device.

.DESCRIPTION
    Run ONCE, as Administrator, on the Windows side of a dual-boot (or on any
    Windows box you want to reach).

    Windows hosts RDP natively and — unlike gnome-remote-desktop — streams
    EVERY monitor in one session. So the Windows side needs no capture agent at
    all: guacd talks straight to it and the client gets the merged canvas for
    free. That is why this script is short and the Linux side is not.

    What it does:
      1. Enables the RDP host and the Remote Desktop Services firewall group.
      2. Restricts inbound 3389 to the Tailscale CGNAT range (100.64.0.0/10),
         so the port is unreachable from anything that is not a tailnet peer.
      3. Sets the Tailscale interface's network profile to Private, because
         Windows silently blocks inbound RDP on a Public profile.
      4. Stops the machine sleeping on AC, so it is actually there when you
         connect to it.
      5. Verifies Tailscale is installed and reports the address to use.

    It does NOT install Tailscale or create users — those want a human.

.PARAMETER Undo
    Reverse everything: disable RDP, remove the firewall rule, restore sleep.

.EXAMPLE
    # In an elevated PowerShell:
    Set-ExecutionPolicy -Scope Process Bypass -Force
    .\setup-windows.ps1
#>

[CmdletBinding()]
param(
    [switch]$Undo
)

$ErrorActionPreference = 'Stop'
$RuleName = 'ojee-remote RDP (tailnet only)'
$TailnetV4 = '100.64.0.0/10'
$TailnetV6 = 'fd7a:115c:a1e0::/48'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this in an ELEVATED PowerShell (right-click -> Run as administrator).'
    }
}

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Ok($msg)   { Write-Host "  + $msg" -ForegroundColor Green }

Assert-Admin

if ($Undo) {
    Write-Host "`nReverting ojee-remote Windows setup`n"
    Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 1
    Write-Ok 'RDP host disabled'
    Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Ok 'firewall rule removed'
    powercfg /change standby-timeout-ac 30
    Write-Ok 'AC sleep restored to 30 minutes'
    Write-Host "`nDone.`n"
    exit 0
}

Write-Host "`nojee-remote — Windows device setup`n"

# ── 0. edition check ───────────────────────────────────────────────────
# Windows Home cannot HOST RDP (it can only connect out). Catching this here
# saves a confusing hour of "the port is open but nothing answers".
$edition = (Get-ComputerInfo -Property WindowsProductName).WindowsProductName
Write-Step "Edition: $edition"
if ($edition -match 'Home') {
    Write-Warn 'Windows Home cannot host RDP — only Pro/Enterprise/Education can.'
    Write-Warn 'Install a VNC server instead and add the device with "protocol": "vnc".'
    throw 'Unsupported edition for RDP hosting.'
}

# ── 1. enable the RDP host ─────────────────────────────────────────────
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Write-Ok 'RDP host enabled'

# NLA on. guacd is configured with security=nla for this device, and NLA also
# means the machine will not spin up a session for an unauthenticated caller.
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' `
    -Name UserAuthentication -Value 1
Write-Ok 'Network Level Authentication required'

Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue
Write-Ok 'Remote Desktop firewall group enabled'

# ── 2. restrict 3389 to the tailnet ────────────────────────────────────
# The built-in Remote Desktop rules allow the whole local subnet. Narrowing to
# the CGNAT range means a machine on the same café wifi cannot even see the
# port, which matters far more on a laptop than on a desktop.
Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $RuleName `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3389 `
    -RemoteAddress $TailnetV4, $TailnetV6 `
    -Profile Any | Out-Null
Write-Ok "inbound 3389 restricted to $TailnetV4"

# Tighten the built-ins so they cannot re-open the port to the local subnet.
Get-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue |
    Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' } |
    ForEach-Object {
        Set-NetFirewallRule -Name $_.Name -RemoteAddress $TailnetV4, $TailnetV6
    }
Write-Ok 'built-in Remote Desktop rules narrowed to the tailnet too'

# ── 3. Tailscale interface profile ─────────────────────────────────────
# Windows blocks inbound RDP on a Public profile. The Tailscale adapter often
# lands there by default, which produces a port that is open in the firewall
# and still refuses connections — a genuinely confusing failure.
$ts = Get-NetAdapter | Where-Object { $_.InterfaceDescription -match 'Tailscale' -or $_.Name -match 'Tailscale' }
if ($ts) {
    Get-NetConnectionProfile -InterfaceIndex $ts.ifIndex -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.NetworkCategory -ne 'Private') {
                Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private
                Write-Ok "Tailscale adapter profile set to Private (was $($_.NetworkCategory))"
            } else {
                Write-Ok 'Tailscale adapter profile already Private'
            }
        }
} else {
    Write-Warn 'No Tailscale adapter found. Install Tailscale and sign into the same tailnet:'
    Write-Warn '  https://tailscale.com/download/windows'
}

# ── 4. stay awake on AC ────────────────────────────────────────────────
# A device that sleeps is a device that is offline exactly when you reach for
# it. Only on AC — battery behaviour is left alone deliberately.
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Ok 'sleep and hibernate disabled while on AC'

# ── 5. report the address ──────────────────────────────────────────────
Write-Host ''
$tsIp = $null
$tsExe = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tsExe -and (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) {
    $tsExe = "$env:ProgramFiles\Tailscale\tailscale.exe"
}
if ($tsExe) {
    try { $tsIp = (& $tsExe ip -4 2>$null | Select-Object -First 1).Trim() } catch { }
}

if ($tsIp) {
    Write-Host "Add this to the gateway's devices.json:`n" -ForegroundColor Green
    Write-Host @"
  {
    "id": "windows",
    "name": "Windows",
    "transport": "rdp",
    "protocol": "rdp",
    "host": "$tsIp",
    "port": 3389,
    "username": "$env:USERNAME",
    "password": "<your Windows password>",
    "monitors": "multimon"
  }
"@
    Write-Host ''
    Write-Host '  "multimon" is the point: Windows streams every monitor in one' -ForegroundColor DarkGray
    Write-Host '  session, so switching screens is a client-side crop with no' -ForegroundColor DarkGray
    Write-Host '  reconnect at all.' -ForegroundColor DarkGray
} else {
    Write-Warn 'Could not read the Tailscale IP. Run `tailscale ip -4` once signed in.'
}

Write-Host "`nDone. Reboot is not required.`n"
