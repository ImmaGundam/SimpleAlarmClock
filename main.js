const { app, BrowserWindow, ipcMain, shell, Notification, powerSaveBlocker, screen } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

let mainWindow;

// ── Alarm file path (shared with OS scheduler) ───────────────────
// Stored in user data dir so it survives app updates
function getAlarmFilePath() {
  return path.join(app.getPath('userData'), 'scheduled_alarm.json');
}

// Write alarm info so the OS scheduler knows when to wake/launch
function writeAlarmFile(alarmTimeStr) {
  const data = {
    time:      alarmTimeStr,          // "HH:MM:SS"
    setAt:     new Date().toISOString(),
    platform:  process.platform,
    appPath:   app.getPath('exe'),    // full path to this exe
  };
  try {
    fs.writeFileSync(getAlarmFilePath(), JSON.stringify(data, null, 2), 'utf8');
    console.log('[AlarmClock] Alarm file written:', getAlarmFilePath());
  } catch(e) {
    console.error('[AlarmClock] Failed to write alarm file:', e.message);
  }
}

// Clear alarm file when alarm is cancelled/stopped
function clearAlarmFile() {
  try {
    if (fs.existsSync(getAlarmFilePath())) {
      fs.unlinkSync(getAlarmFilePath());
      console.log('[AlarmClock] Alarm file cleared');
    }
  } catch(e) {}
}

// On startup — check if we were launched by the scheduler to fire an alarm
function checkScheduledAlarm() {
  try {
    const fp = getAlarmFilePath();
    if (!fs.existsSync(fp)) return false;
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!data.time) return false;

    const now = new Date();
    const [h, m] = data.time.split(':').map(Number);
    const alarmMs = new Date(now);
    alarmMs.setHours(h, m, 0, 0);

    // Fire if within 2 minutes of alarm time (handles scheduler imprecision)
    const diff = Math.abs(now - alarmMs);
    if (diff <= 2 * 60 * 1000) {
      console.log('[AlarmClock] Launched by scheduler — alarm should fire');
      return true;
    }
    return false;
  } catch(e) {
    return false;
  }
}

// ── Window ───────────────────────────────────────────────────────
let launchedByScheduler = false;

function createWindow() {
  launchedByScheduler = checkScheduledAlarm();

  // ── High-DPI / 2K / 4K scaling ─────────────────────────────────────────────
  // Bump the page zoom at QHD (≥2560 px) by 40 %, at 4K (≥3840 px) by 80 %.
  // Window dimensions scale to match so the card is never clipped.
  const disp  = screen.getPrimaryDisplay();
  const dispW = disp.size.width;
  let zoomFactor = 1.0;
  if      (dispW >= 3840) zoomFactor = 1.8;   // 4K
  else if (dispW >= 2560) zoomFactor = 1.4;   // 2K / QHD  (+40 %)

  const baseW = 420, baseH = 620;
  const winW  = Math.round(baseW * zoomFactor);
  const winH  = Math.round(baseH * zoomFactor);

  mainWindow = new BrowserWindow({
    width:     winW,
    height:    winH,
    minWidth:  Math.round(340 * zoomFactor),
    minHeight: Math.round(500 * zoomFactor),
    title: 'SimpleAlarmClock',
    frame: false,
    transparent: true,           // OS compositor transparency (see-through background)
    backgroundColor: '#00000000',
    // Windows 10 22H2 + / Electron 26+: native Acrylic blur over the desktop
    ...(process.platform === 'win32' && { backgroundMaterial: 'acrylic' }),
    // Windows 11 / macOS: OS-level rounded window corners
    roundedCorners: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:simplealarmclock',
    },
    show: false,
    resizable: true,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    // Apply zoom for high-DPI displays before showing
    if (zoomFactor !== 1.0) mainWindow.webContents.setZoomFactor(zoomFactor);
    mainWindow.show();
    // Tell renderer if we were woken by the scheduler
    if (launchedByScheduler) {
      mainWindow.webContents.send('scheduler-alarm-fire');
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC: alarm state → write/clear alarm file + power blocker ────
let powerBlockerId = null;

ipcMain.on('alarm-active', (_evt, { active, time }) => {
  if (active) {
    if (time) writeAlarmFile(time);
    if (powerBlockerId === null) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      console.log('[AlarmClock] Power save blocker started');
    }
  } else {
    clearAlarmFile();
    if (powerBlockerId !== null) {
      powerSaveBlocker.stop(powerBlockerId);
      console.log('[AlarmClock] Power save blocker stopped');
      powerBlockerId = null;
    }
  }
});

// ── IPC: renderer asks for alarm file path (for setup scripts UI) ─
ipcMain.handle('get-alarm-file-path', () => getAlarmFilePath());
ipcMain.handle('get-app-exe-path',    () => app.getPath('exe'));
ipcMain.handle('get-platform',        () => process.platform);


// ══════════════════════════════════════════════════════════════════════════════
//  WAKE FROM SLEEP SCHEDULER — platform-specific setup/remove/check
//  All logic lives here; renderer just calls IPC and shows the result.
// ══════════════════════════════════════════════════════════════════════════════
const { execSync, exec } = require('child_process');

const TASK_NAME    = 'SimpleAlarmClock';
const LINUX_UNIT   = 'simplealarmclock-alarm';
const LAUNCH_AGENT = `${require('os').homedir()}/Library/LaunchAgents/com.simplealarmclock.alarm.plist`;

// ── Shared: launcher script paths ────────────────────────────
function getLauncherPath() {
  const ud = app.getPath('userData');
  if (process.platform === 'win32')  return path.join(ud, 'alarm-launcher.ps1');
  if (process.platform === 'linux')  return path.join(ud, 'alarm-launcher.sh');
  if (process.platform === 'darwin') return path.join(ud, 'alarm-launcher.sh');
  return path.join(ud, 'alarm-launcher.sh');
}

// ── Windows: write launcher PS1 + register Task Scheduler ────
function setupWindows() {
  const launcher  = getLauncherPath();
  const alarmFile = getAlarmFilePath();
  const exePath   = app.getPath('exe');

  // Build PS1 with string concat — avoids JS interpolating PowerShell $variables
  const ps1Lines = [
    '$AlarmFile = "' + alarmFile + '"',
    '$AppExe    = "' + exePath + '"',
    'if (-not (Test-Path $AlarmFile)) { exit 0 }',
    'try {',
    '  $data = Get-Content $AlarmFile -Raw | ConvertFrom-Json',
    '  if (-not $data.time) { exit 0 }',
    '  $now   = Get-Date',
    "  $parts = $data.time -split ':'",
    '  $alarmDT = Get-Date -Hour ([int]$parts[0]) -Minute ([int]$parts[1]) -Second 0',
    '  $diff = [Math]::Abs(($now - $alarmDT).TotalSeconds)',
    '  if ($diff -le 90) { Start-Process -FilePath $AppExe -WindowStyle Normal }',
    '} catch {}',
  ];
  fs.writeFileSync(launcher, ps1Lines.join('\r\n'), 'utf8');

  // Build registration command with string concat
  const arg = '-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File \\"' + launcher + '\\"';
  const registerLines = [
    "$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '" + arg + "'",
    "$trig = New-ScheduledTaskTrigger -Daily -At '00:00'",
    '$trig.Repetition = (New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1) -At \'00:00\' -Daily).Repetition',
    '$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable',
    '$prin = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest',
    "if (Get-ScheduledTask -TaskName '" + TASK_NAME + "' -EA SilentlyContinue) { Unregister-ScheduledTask -TaskName '" + TASK_NAME + "' -Confirm:$false }",
    "Register-ScheduledTask -TaskName '" + TASK_NAME + "' -Action $act -Trigger $trig -Settings $set -Principal $prin -Description 'SimpleAlarmClock wake alarm' | Out-Null",
  ].join('; ');

  execSync('powershell -NonInteractive -ExecutionPolicy Bypass -Command "' + registerLines + '"', { timeout: 30000 });
  return { ok: true, message: 'Task Scheduler entry created.', needsWakeTimers: true };
}

function removeWindows() {
  execSync('powershell -NonInteractive -ExecutionPolicy Bypass -Command '
    + '"if (Get-ScheduledTask -TaskName \'' + TASK_NAME + '\' -EA SilentlyContinue) '
    + '{ Unregister-ScheduledTask -TaskName \'' + TASK_NAME + '\' -Confirm:$false }"',
    { timeout: 15000 });
  try { fs.unlinkSync(getLauncherPath()); } catch(_e) {}
  return { ok: true, message: 'Task Scheduler entry removed.' };
}

function checkWindows() {
  try {
    const out = execSync(
      'powershell -NonInteractive -ExecutionPolicy Bypass -Command '
      + '"(Get-ScheduledTask -TaskName \'' + TASK_NAME + '\' -EA SilentlyContinue) -ne $null"',
      { timeout: 10000 }
    ).toString().trim();
    return { installed: out === 'True', note: out === 'True' ? '' : 'Not set up' };
  } catch(_e) { return { installed: false, note: 'Could not query Task Scheduler' }; }
}

// ── Linux: write launcher + systemd user timer (or cron fallback) ─
function hasSystemd() {
  try { execSync('systemctl --user status 2>/dev/null', { timeout: 3000 }); return true; }
  catch(_e) { return false; }
}

function setupLinux() {
  const launcher  = getLauncherPath();
  const alarmFile = getAlarmFilePath();
  const exePath   = app.getPath('exe');
  const unitDir   = path.join(require('os').homedir(), '.config', 'systemd', 'user');
  const serviceFile = path.join(unitDir, `${LINUX_UNIT}.service`);
  const timerFile   = path.join(unitDir, `${LINUX_UNIT}.timer`);

  // Write launcher script — use string concat to avoid JS interpolating bash ${} syntax
  const sh = [
    '#!/usr/bin/env bash',
    'ALARM_FILE="' + alarmFile + '"',
    'APP_EXE="' + exePath + '"',
    '[ ! -f "$ALARM_FILE" ] && exit 0',
    'ALARM_TIME=$(python3 -c "import json; d=json.load(open(\'$ALARM_FILE\')); print(d.get(\'time\',[]))" 2>/dev/null)',
    '[ -z "$ALARM_TIME" ] && exit 0',
    'NOW_SEC=$(date +%s)',
    'IFS=: read -r AH AM AS <<< "$ALARM_TIME"',
    'TODAY=$(date +%Y-%m-%d)',
    'ALARM_EPOCH=$(date -d "${TODAY} ${AH}:${AM}:00" +%s 2>/dev/null)',
    'DIFF=$(( NOW_SEC - ALARM_EPOCH ))',
    'ABS=${DIFF#-}',
    'if [[ $ABS -le 90 ]]; then',
    '  export DISPLAY=${DISPLAY:-:0}',
    '  export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}',
    '  exec "$APP_EXE" &',
    'fi',
  ].join('\n');

  fs.writeFileSync(launcher, sh, { mode: 0o755 });

  const useSystemd = hasSystemd();

  if (useSystemd) {
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(serviceFile,
      `[Unit]\nDescription=SimpleAlarmClock alarm launcher\nAfter=graphical-session.target\n`
      + `[Service]\nType=oneshot\nExecStart=${launcher}\nEnvironment=DISPLAY=:0\n`);
    fs.writeFileSync(timerFile,
      `[Unit]\nDescription=SimpleAlarmClock alarm timer\n`
      + `[Timer]\nOnCalendar=*-*-* *:*:00\nAccuracySec=10s\nPersistent=true\nWakeSystem=true\n`
      + `[Install]\nWantedBy=timers.target\n`);
    execSync(`systemctl --user daemon-reload && systemctl --user enable --now ${LINUX_UNIT}.timer`, { timeout: 15000 });
    return { ok: true, message: 'systemd user timer installed (WakeSystem=true).' };
  } else {
    // cron fallback
    const marker = '# SimpleAlarmClock';
    let crontab = '';
    try { crontab = execSync('crontab -l 2>/dev/null', { timeout: 5000 }).toString(); } catch(_e) {}
    crontab = crontab.split('\n').filter(l => !l.includes(marker)).join('\n');
    crontab += `\n* * * * * ${launcher} ${marker}\n`;
    execSync(`echo ${JSON.stringify(crontab)} | crontab -`, { timeout: 5000 });
    return { ok: true, message: 'cron job installed (every minute). Note: cron cannot wake from sleep.' };
  }
}

function removeLinux() {
  const useSystemd = hasSystemd();
  if (useSystemd) {
    try {
      execSync(`systemctl --user stop ${LINUX_UNIT}.timer 2>/dev/null; `
        + `systemctl --user disable ${LINUX_UNIT}.timer 2>/dev/null`, { timeout: 10000 });
      const unitDir = path.join(require('os').homedir(), '.config', 'systemd', 'user');
      ['.service', '.timer'].forEach(ext => {
        try { fs.unlinkSync(path.join(unitDir, LINUX_UNIT + ext)); } catch(_e) {}
      });
      execSync('systemctl --user daemon-reload', { timeout: 5000 });
    } catch(_e) {}
  } else {
    try {
      const marker = '# SimpleAlarmClock';
      let crontab = execSync('crontab -l 2>/dev/null', { timeout: 5000 }).toString();
      crontab = crontab.split('\n').filter(l => !l.includes(marker)).join('\n');
      execSync(`echo ${JSON.stringify(crontab)} | crontab -`, { timeout: 5000 });
    } catch(_e) {}
  }
  try { fs.unlinkSync(getLauncherPath()); } catch(_e) {}
  return { ok: true, message: 'Wake scheduler removed.' };
}

function checkLinux() {
  if (hasSystemd()) {
    try {
      const out = execSync(`systemctl --user is-enabled ${LINUX_UNIT}.timer 2>/dev/null`,
        { timeout: 5000 }).toString().trim();
      return { installed: out === 'enabled', note: out === 'enabled' ? '' : 'Not set up' };
    } catch(_e) { return { installed: false, note: 'Not set up' }; }
  } else {
    try {
      const ct = execSync('crontab -l 2>/dev/null', { timeout: 5000 }).toString();
      const installed = ct.includes('SimpleAlarmClock');
      return { installed, note: installed ? '(via cron — cannot wake from sleep)' : 'Not set up' };
    } catch(_e) { return { installed: false, note: 'Not set up' }; }
  }
}

// ── macOS: launchd agent ──────────────────────────────────────
function setupMac() {
  const launcher  = getLauncherPath();
  const alarmFile = getAlarmFilePath();
  const exePath   = app.getPath('exe');
  const agentsDir = path.join(require('os').homedir(), 'Library', 'LaunchAgents');

  const sh = [
    '#!/usr/bin/env bash',
    'ALARM_FILE="' + alarmFile + '"',
    'APP_EXE="' + exePath + '"',
    '[ ! -f "$ALARM_FILE" ] && exit 0',
    'ALARM_TIME=$(python3 -c "import json; d=json.load(open(\'$ALARM_FILE\')); print(d.get(\'time\',[]))" 2>/dev/null)',
    '[ -z "$ALARM_TIME" ] && exit 0',
    'NOW_SEC=$(date +%s)',
    'IFS=: read -r AH AM <<< "$ALARM_TIME"',
    'TODAY=$(date +%Y-%m-%d)',
    'ALARM_EPOCH=$(date -j -f "%Y-%m-%d %H:%M:%S" "${TODAY} ${AH}:${AM}:00" +%s 2>/dev/null)',
    'DIFF=$(( NOW_SEC - ALARM_EPOCH ))',
    'ABS=${DIFF#-}',
    '[[ $ABS -le 90 ]] && open -a "$APP_EXE"',
  ].join('\n');

  fs.writeFileSync(launcher, sh, { mode: 0o755 });
  fs.mkdirSync(agentsDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.simplealarmclock.alarm</string>
  <key>ProgramArguments</key><array><string>${launcher}</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><false/>
</dict></plist>`;

  fs.writeFileSync(LAUNCH_AGENT, plist, 'utf8');
  execSync(`launchctl load "${LAUNCH_AGENT}"`, { timeout: 10000 });
  return { ok: true, message: 'launchd agent installed (runs every minute).' };
}

function removeMac() {
  try { execSync(`launchctl unload "${LAUNCH_AGENT}" 2>/dev/null`, { timeout: 5000 }); } catch(_e) {}
  try { fs.unlinkSync(LAUNCH_AGENT); } catch(_e) {}
  try { fs.unlinkSync(getLauncherPath()); } catch(_e) {}
  return { ok: true, message: 'launchd agent removed.' };
}

function checkMac() {
  const installed = fs.existsSync(LAUNCH_AGENT);
  return { installed, note: installed ? '' : 'Not set up' };
}

// ── IPC: open OS power/sleep settings (cross-platform) ──────────────────────
ipcMain.handle('open-wake-timers-settings', async () => {
  try {
    if (process.platform === 'win32') {
      // Opens Advanced Power Settings dialog directly at Sleep section
      exec('control.exe powercfg.cpl,,3');
    } else if (process.platform === 'linux') {
      // Try common power manager GUIs across distros
      const cmds = [
        'gnome-control-center power',           // GNOME (Ubuntu, Kali, Fedora)
        'systemsettings5 powerdevilglobalconfig',// KDE Plasma
        'xfce4-power-manager-settings',         // XFCE (Kali default on some spins)
        'cinnamon-settings power',              // Cinnamon (Mint)
        'mate-power-preferences',               // MATE
        'xdg-open x-scheme-handler/power',      // generic fallback
      ];
      // Try each until one works
      (function tryNext(i) {
        if (i >= cmds.length) return;
        exec(cmds[i], (err) => { if (err) tryNext(i + 1); });
      })(0);
    } else if (process.platform === 'darwin') {
      // Opens Energy Saver / Battery pane in System Settings
      exec('open "x-apple.systempreferences:com.apple.preference.battery"');
    }
    return { ok: true };
  } catch(e) {
    return { ok: false, message: e.message };
  }
});

// ── IPC handlers ──────────────────────────────────────────────
ipcMain.handle('setup-wake-scheduler', async () => {
  try {
    if (process.platform === 'win32')  return setupWindows();
    if (process.platform === 'linux')  return setupLinux();
    if (process.platform === 'darwin') return setupMac();
    return { ok: false, message: 'Unsupported platform: ' + process.platform };
  } catch(e) {
    return { ok: false, message: e.message, detail: e.stack };
  }
});

ipcMain.handle('remove-wake-scheduler', async () => {
  try {
    if (process.platform === 'win32')  return removeWindows();
    if (process.platform === 'linux')  return removeLinux();
    if (process.platform === 'darwin') return removeMac();
    return { ok: false, message: 'Unsupported platform: ' + process.platform };
  } catch(e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('check-wake-scheduler', async () => {
  try {
    if (process.platform === 'win32')  return checkWindows();
    if (process.platform === 'linux')  return checkLinux();
    if (process.platform === 'darwin') return checkMac();
    return { installed: false, note: 'Unsupported platform' };
  } catch(e) {
    return { installed: false, note: e.message };
  }
});

// ── IPC: OS-level window opacity (true desktop see-through) ──────────────────
// Renderer calls this instead of document.body.style.opacity so the window
// background becomes genuinely transparent rather than fading all DOM content.
// NOTE: preload.js must expose:  setWindowOpacity: (v) => ipcRenderer.invoke('set-window-opacity', v)
ipcMain.handle('set-window-opacity', (_evt, value) => {
  if (mainWindow) mainWindow.setOpacity(Math.max(0.1, Math.min(1.0, Number(value))));
});

// ── IPC: window controls ─────────────────────────────────────────
ipcMain.on('window-minimize',        () => mainWindow && mainWindow.minimize());
ipcMain.on('window-toggle-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow && mainWindow.close());

// ── IPC: system notification ──────────────────────────────────────
ipcMain.on('show-notification', (_evt, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.ico') }).show();
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
