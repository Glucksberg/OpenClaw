---
summary: "Windows support: native (PowerShell) and WSL2 install paths, auto-start, and gateway config"
read_when:
  - Installing OpenClaw on Windows
  - Running OpenClaw natively on Windows without WSL2
  - Looking for Windows companion app status
  - Setting up auto-start on Windows
title: "Windows"
---

# Windows

OpenClaw runs on Windows in two ways:

- **Native Windows** -- Node.js + PowerShell, no WSL2 needed. Simpler setup, works on any Windows 10+ machine.
- **WSL2** -- runs inside a Linux VM. Better compatibility with Linux-only tooling and skills.

Both paths use the same Gateway, config format, and channels.

<Tip>
If you just want OpenClaw running quickly and do not need Linux-specific tools, **native Windows** is the easiest path.
</Tip>

---

## Native Windows (no WSL2)

### 1) Install Node.js

Download and install [Node.js 22+](https://nodejs.org/) (LTS recommended). The installer adds `node` and `npm` to your PATH automatically.

Verify in PowerShell:

```powershell
node -v    # should print v22.x or higher
npm -v
```

### 2) Install OpenClaw

<Tabs>
  <Tab title="Installer script (recommended)">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    To skip onboarding and just install the binary:

    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```

    For all flags, see [Installer internals](/install/installer).

  </Tab>
  <Tab title="npm">
    ```powershell
    npm install -g openclaw@latest
    openclaw onboard
    ```
  </Tab>
</Tabs>

After install, verify:

```powershell
openclaw --version
openclaw doctor
```

<Accordion title="openclaw not found after install">
  If `openclaw` is not recognized, the npm global bin directory is not in your PATH.

Find it:

```powershell
npm prefix -g
```

Add the output path to your system PATH (System Properties > Environment Variables > Path > Edit > New).

Then open a new PowerShell window and retry.
</Accordion>

### 3) Configure the Gateway

```powershell
openclaw config set gateway.mode local
```

Or run the interactive wizard:

```powershell
openclaw configure
```

Config file location: `%USERPROFILE%\.openclaw\openclaw.json`

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

### 4) Start the Gateway

```powershell
openclaw gateway run
```

To run the gateway in the background (detached), see [Auto-start on Windows](#auto-start-on-windows) below.

Verify:

```powershell
openclaw status
openclaw gateway status
```

### Auto-start on Windows

There is no systemd on native Windows, so use one of these approaches to keep the gateway running after login.

#### Task Scheduler (recommended)

Task Scheduler is built into Windows and is the most reliable option.

<Steps>
  <Step title="Create a wrapper script">
    Save the following as `%USERPROFILE%\openclaw-gateway.cmd`:

    ```batch
    @echo off
    openclaw gateway run --port 18789
    ```

  </Step>
  <Step title="Create a scheduled task (PowerShell as Administrator)">
    ```powershell
    $Action = New-ScheduledTaskAction -Execute "cmd.exe" `
      -Argument "/c `"$env:USERPROFILE\openclaw-gateway.cmd`"" `
      -WorkingDirectory $env:USERPROFILE

    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

    $Settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -RestartCount 3 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName "OpenClaw Gateway" `
      -Action $Action -Trigger $Trigger -Settings $Settings `
      -Description "OpenClaw Gateway auto-start" -RunLevel Limited
    ```

  </Step>
  <Step title="Verify">
    ```powershell
    Get-ScheduledTask -TaskName "OpenClaw Gateway"
    ```

    Reboot or manually start the task to confirm.

  </Step>
</Steps>

To remove:

```powershell
Unregister-ScheduledTask -TaskName "OpenClaw Gateway" -Confirm:$false
```

#### Startup folder shortcut

For a simpler (but less robust) approach, place a shortcut in the Startup folder:

```powershell
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\OpenClaw Gateway.lnk"
)
$Shortcut.TargetPath = "cmd.exe"
$Shortcut.Arguments = "/c openclaw gateway run --port 18789"
$Shortcut.WorkingDirectory = $env:USERPROFILE
$Shortcut.WindowStyle = 7  # minimized
$Shortcut.Save()
```

This starts the gateway at login but does not restart it if it crashes.

#### NSSM (Windows service)

[NSSM](https://nssm.cc/) wraps any program as a Windows service. This is useful for headless servers or when you need the gateway running before anyone logs in.

```powershell
# Install NSSM (e.g. via Chocolatey)
choco install nssm -y

# Find the full path to openclaw
(Get-Command openclaw).Source

# Install the service (adjust the path)
nssm install OpenClawGateway "C:\Program Files\nodejs\openclaw.cmd" "gateway" "run" "--port" "18789"
nssm set OpenClawGateway AppDirectory $env:USERPROFILE
nssm set OpenClawGateway AppStdout "$env:USERPROFILE\.openclaw\gateway-stdout.log"
nssm set OpenClawGateway AppStderr "$env:USERPROFILE\.openclaw\gateway-stderr.log"
nssm start OpenClawGateway
```

<Warning>
Task Scheduler and NSSM can conflict if both are configured. Use one or the other.
</Warning>

### PowerShell gotchas

PowerShell syntax differs from bash in ways that cause silent failures if you copy Linux examples directly.

**No `&&` operator (PowerShell 5.x).**
PowerShell 5.x (the version shipped with Windows) does not support `&&`. Use `;` to run commands sequentially, or run them as separate lines:

```powershell
# Wrong (fails silently in PS 5.x):
openclaw gateway run && openclaw status

# Correct:
openclaw gateway run; openclaw status

# Or just run them separately:
openclaw gateway run
openclaw status
```

<Note>
PowerShell 7+ (installed separately via `winget install Microsoft.PowerShell`) does support `&&`.
</Note>

**Port conflict guard.**
Before starting the gateway, check whether the port is already in use to avoid duplicate instances:

```powershell
$Port = 18789
$InUse = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
if ($InUse) {
  Write-Host "Port $Port is already in use. Gateway may already be running."
} else {
  openclaw gateway run --port $Port
}
```

**Execution policy.**
If PowerShell blocks script execution, allow it for the current user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### Windows Firewall

If you bind the gateway to a non-loopback address (for LAN or remote access), allow the port through Windows Firewall:

```powershell
New-NetFirewallRule -DisplayName "OpenClaw Gateway" -Direction Inbound `
  -Protocol TCP -LocalPort 18789 -Action Allow
```

---

## WSL2

WSL2 gives you a full Linux environment on Windows. This is recommended if you rely on Linux-only tools, skills, or build chains (Bun, pnpm patches, etc.).

### Install WSL2 + Ubuntu

Open PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Reboot if Windows asks.

### Enable systemd (required for gateway service)

In your WSL terminal:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Then from PowerShell:

```powershell
wsl --shutdown
```

Re-open Ubuntu, then verify:

```bash
systemctl --user status
```

### Install OpenClaw (inside WSL)

Follow the Linux Getting Started flow inside WSL:

<Tabs>
  <Tab title="Installer script">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="From source">
    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    pnpm install
    pnpm ui:build
    pnpm build
    openclaw onboard
    ```
  </Tab>
</Tabs>

Full guide: [Getting Started](/start/getting-started)

### Gateway service install (WSL2)

Inside WSL2:

```bash
openclaw onboard --install-daemon
```

Or:

```bash
openclaw gateway install
```

Repair/migrate:

```bash
openclaw doctor
```

### Expose WSL services over LAN (portproxy)

WSL has its own virtual network. If another machine needs to reach a service
running **inside WSL** (SSH, a local TTS server, or the Gateway), you must
forward a Windows port to the current WSL IP. The WSL IP changes after restarts,
so you may need to refresh the forwarding rule.

Example (PowerShell **as Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Allow the port through Windows Firewall (one-time):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Refresh the portproxy after WSL restarts:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Notes:

- SSH from another machine targets the **Windows host IP** (example: `ssh user@windows-host -p 2222`).
- Remote nodes must point at a **reachable** Gateway URL (not `127.0.0.1`); use
  `openclaw status --all` to confirm.
- Use `listenaddress=0.0.0.0` for LAN access; `127.0.0.1` keeps it local only.
- If you want this automatic, register a Scheduled Task to run the refresh
  step at login.

---

## Common links

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)
- [Install & updates](/install/updating)

## Windows companion app

There is no Windows companion app yet. Contributions are welcome.
