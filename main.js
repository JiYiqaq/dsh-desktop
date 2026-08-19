// dsh-desktop — DeepSeek Harness 桌面壳（Electron）
//
// 功能：
//   1. 独立窗口加载 DSH Web GUI（http://127.0.0.1:3080，无地址栏/菜单栏）
//   2. 服务探测与自愈：探测失败时 spawn `dsh web`（复用 autostart 的启动方式），
//      就绪后自动加载；窗口关闭 = 最小化到托盘，托盘「退出」才真正退出
//   3. 单实例保护：重复双击只激活已有窗口
//   4. smoke 模式：DSH_DESKTOP_SMOKE=1 时做无头验证（探测/自愈结果写入 JSON 后退出）
//   5. 检查更新：托盘菜单 → 独立更新窗口（本地页面）→ 一键更新（临时实例 heal
//      镜像 → 重启 3080 → 同步 autostart fallback）；启动后静默检查一次，有新版
//      用托盘气泡提醒
//
// 顶层显式默认值：路径变了改这里，或用同名环境变量覆盖（DSH_DESKTOP_URL、
// DSH_HOME、DSH_WORKDIR）。命令行参数：--silent 静默启动（只驻托盘，不显示窗口，
// 开机自启用）；--remote-debugging-port=<n> 调试用。

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, net } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// userData 覆盖（调试/测试用：与正式实例隔离，避免单例锁冲突）
const USER_DATA_OVERRIDE = process.env.DSH_DESKTOP_USERDATA || '';
if (USER_DATA_OVERRIDE) app.setPath('userData', USER_DATA_OVERRIDE);

// 探测 node.exe 安装位置（找不到就退回 PATH 解析）
function findNodeExe() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  for (const candidate of [
    'C:\\Program Files\\nodejs\\node.exe',
    path.join(programFiles, 'nodejs', 'node.exe'),
  ]) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* 继续 */ }
  }
  return 'node';
}

// ---- 顶层显式默认值（可用环境变量覆盖；不依赖特定机器路径） ----
const NODE_EXE = findNodeExe();
const NPX_EXE = NODE_EXE.endsWith('node.exe') ? NODE_EXE.replace(/node\.exe$/, 'npx.cmd') : 'npx.cmd';
// Windows 下 shell:true 时 Node 会把「命令 + 参数」拼成一行交给 cmd；
// 路径含空格（C:\Program Files\...）必须加引号，否则被截断成 'C:\Program'（"不是内部或外部命令"）
const shellQuote = (exe) => (process.platform === 'win32' && /\s/.test(exe) ? `"${exe}"` : exe);
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), 'AppData', 'Local', 'DeepSeek-Harness');
const DSH_URL = process.env.DSH_DESKTOP_URL || 'http://127.0.0.1:3080';
const DSH_BIN = path.join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const WORK_DIR = process.env.DSH_WORKDIR || os.homedir();
const STARTUP_POLL_MS = 500;      // 服务就绪轮询间隔
const STARTUP_TIMEOUT_MS = 60000; // 服务就绪等待上限
const PROBE_TIMEOUT_MS = 1500;    // 单次探测超时
const SMOKE_MODE = process.env.DSH_DESKTOP_SMOKE === '1';
const SMOKE_OUT = process.env.DSH_DESKTOP_SMOKE_OUT || '';
// --silent：开机自启模式——窗口保持隐藏，只驻托盘；点托盘才显示窗口
const START_SILENT = process.argv.includes('--silent');

// ---- 更新功能默认值 ----
const UPDATE_TEMP_PORT = 3081;         // 更新时临时实例端口（heal 镜像用）
const UPDATE_PORT_TIMEOUT_MS = 600000; // 冷装依赖树很大（数十个 dsh-* 包），120s 会误判失败
const UPDATE_BALLOON_DELAY_MS = 8000;  // 启动后静默检查延迟（给网络留时间）
const REGISTRY_URLS = [                // 检查更新数据源：官方 registry 优先，镜像兜底
  'https://registry.npmjs.org/@deepseek-ai/dsh/latest',
  'https://registry.npmmirror.com/@deepseek-ai/dsh/latest',
];
const UPDATE_RECHECK_MS = 30 * 60 * 1000; // 官方未推送完时的静默重查间隔（30 分钟）
const AUTOSTART_SCRIPT = path.join(WORK_DIR, 'autostart', 'launch-dsh-web.ps1');

let mainWindow = null;
let tray = null;
let dshProc = null;    // 桌面壳自己 spawn 的 dsh 进程（退出时只清理它，绝不动外部服务）
let isQuitting = false;

const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'dsh-desktop.log'), line + '\n');
  } catch { /* 日志写失败不影响主流程 */ }
  console.log(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOf = (url) => new URL(url).port || '3080';

// 探测服务：只要 TCP 能连上并收到任意 HTTP 响应，即视为服务在监听
function probeService(timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(DSH_URL, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

// spawn `dsh web`：优先 $DSH_HOME 下的 bin.js，缺失时退回 npx（与 autostart 脚本一致）
function spawnDsh() {
  const useBin = fs.existsSync(DSH_BIN);
  // npx.cmd 需要 shell 启动（bin.js 用 node 直跑不需要）；shell 模式下路径要加引号防空格截断
  const useShell = !useBin;
  const exe = useShell ? shellQuote(NPX_EXE) : NODE_EXE;
  const args = useBin
    ? [DSH_BIN, 'web', '--port', portOf(DSH_URL)]
    : ['--yes', '@deepseek-ai/dsh@latest', 'web', '--port', portOf(DSH_URL)];
  const env = {
    ...process.env,
    DSH_HOME,
    OLLAMA_LOCAL_API_KEY: process.env.OLLAMA_LOCAL_API_KEY || 'ollama',
  };
  const logFd = fs.openSync(path.join(app.getPath('userData'), 'dsh-service.log'), 'a');
  const child = spawn(exe, args, {
    cwd: WORK_DIR,
    env,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    shell: useShell,
  });
  fs.closeSync(logFd); // 子进程已继承句柄副本，父进程及时释放，避免日志文件被锁
  log(`spawned dsh web (${useBin ? 'bin.js' : 'npx'}) pid=${child.pid}`);
  child.on('exit', (code) => { log(`dsh child exited code=${code}`); dshProc = null; });
  child.on('error', (err) => log(`dsh child error: ${err.message}`));
  return child;
}

// 保证服务在监听：已在则直接返回 true；否则启动并轮询直到就绪或超时
async function ensureService() {
  if (await probeService()) return true;
  if (!dshProc) dshProc = spawnDsh();
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeService()) return true;
    await sleep(STARTUP_POLL_MS);
  }
  return false;
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: ICON_PATH,
    autoHideMenuBar: true, // 无菜单栏，Alt 键临时呼出
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-inject.js'), // 左下角「检查更新」按钮 + 新版红点
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => {
    if (!START_SILENT) mainWindow.show(); // 静默启动保持隐藏，等托盘点击
  });
  // 关闭 = 最小化到托盘（除非正在退出）
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  // 外部链接交给系统浏览器，不在壳内开新窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const img = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  log('tray created');
  tray.setToolTip('DeepSeek Harness');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: showWindow },
    { label: '检查 DSH 更新…', click: openUpdateWindow },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
    else showWindow();
  });
}

const ERROR_PAGE = (logDir) => `
<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek Harness</title></head>
<body style="font-family:system-ui;background:#0f1420;color:#e6e9f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:520px;padding:24px">
  <h2 style="margin:0 0 12px">DSH 服务未能启动</h2>
  <p style="color:#9aa4b8;line-height:1.6">等待 ${DSH_URL} 就绪超过 ${Math.round(STARTUP_TIMEOUT_MS / 1000)} 秒。<br>请检查日志后重试（菜单栏 Alt → 重新加载）。</p>
  <p style="color:#6b7688;font-size:12px">服务日志：${logDir}</p>
</div></body></html>`;

async function start() {
  log(`startup mode: ${START_SILENT ? 'silent (tray only)' : 'normal'}`);
  createWindow();
  const ok = await ensureService();
  if (ok) {
    log(`service ready, loading ${DSH_URL}`);
    mainWindow.loadURL(DSH_URL);
  } else {
    log(`service NOT ready after timeout, showing error page`);
    const logDir = path.join(app.getPath('userData'), 'dsh-service.log');
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ERROR_PAGE(logDir)));
    if (!START_SILENT) mainWindow.show();
  }
  // 兜底：若 ready-to-show 因首帧失败（如 GPU 崩溃）未触发，4 秒后强制显示（仅非静默模式）
  setTimeout(() => {
    if (!START_SILENT && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log('ready-to-show fallback: force show');
      mainWindow.show();
    }
  }, 4000);
}

// 杀掉桌面壳自己 spawn 的进程树（不碰外部服务）
function killOwnDsh() {
  if (dshProc && dshProc.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(dshProc.pid), '/T', '/F'], { windowsHide: true });
      log(`taskkill sent for dsh pid=${dshProc.pid}`);
    } catch (e) { log(`taskkill failed: ${e.message}`); }
    dshProc = null;
  }
}

// ---- 更新功能：检查 npm registry + 一键更新 ----
let updateWin = null;
let updateBusy = false;
let latestVersion = null;              // 最近一次检查得到的 npm 最新版
let latestPublishComplete = false;     // 最新版的 dsh-* 子包是否已全部推送完成（决定红点）
let updateRecheckTimer = null;         // 推送未完成时的静默重查定时器

// 本机 DSH 版本：读 profiles Junction 上 dsh 的 package.json
function readLocalVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(DSH_BIN), '..', 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch { return null; }
}

// 查 npm registry 最新版（官方源优先，npmmirror 镜像兜底）
async function fetchLatestVersion() {
  for (const url of REGISTRY_URLS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await net.fetch(url, { signal: ac.signal });
      if (res.ok) {
        const j = await res.json();
        if (typeof j.version === 'string') return { version: j.version, source: url };
      }
    } catch { /* 换下一个源 */ } finally { clearTimeout(timer); }
  }
  return null;
}

// ---- 官方推送完整性检查 ----
// 背景：dsh 是 monorepo，新版本发布时 @deepseek-ai/dsh-* 各子包逐个上架；
// 主包先出、子包后出，此时"检查更新"会误报有新版但实际装不上（ETARGET）。
// 规则：只有全部子包都能查到目标版本，才算推送完成，才允许亮红点/开始更新。
function scopedNameToPath(name) {
  return name.replace('/', '%2f'); // '@deepseek-ai/dsh-x' -> '@deepseek-ai%2fdsh-x'
}

async function fetchJson(url, accept = null, timeoutMs = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = accept ? { accept } : {};
    const res = await net.fetch(url, { signal: ac.signal, headers });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

async function verifyDshPublishComplete(version, registryBase) {
  // 完整性核对优先官方源（镜像的 search 接口可能缺失/滞后导致误判"未推送完"）；
  // 官方不可达时退回本次"最新版"数据源。任一源拿到子包列表即用它逐包核对。
  const bases = [];
  if (!/npmmirror/.test(registryBase)) bases.push(registryBase);
  bases.push('https://registry.npmjs.org/');
  let lastError = 'scope search failed';
  for (const base of bases) {
    const search = await fetchJson(`${base}-/v1/search?text=scope:deepseek-ai&size=250`);
    if (!search || !Array.isArray(search.objects)) { lastError = `search failed (${base})`; continue; }
    const names = search.objects
      .map((o) => o && o.package && o.package.name)
      .filter((n) => typeof n === 'string' && n.startsWith('@deepseek-ai/dsh'));
    if (names.length === 0) { lastError = `no dsh packages found (${base})`; continue; }
    const missing = [];
    await Promise.all(names.map(async (name) => {
      const pack = await fetchJson(`${base}${scopedNameToPath(name)}`, 'application/vnd.npm.install-v1+json');
      const ok = pack && pack.versions && typeof pack.versions[version] === 'object';
      if (!ok) missing.push(name);
    }));
    missing.sort();
    return { complete: missing.length === 0, missing };
  }
  return { complete: false, missing: [], error: lastError };
}

async function runCheck() {
  const current = readLocalVersion();
  const r = await fetchLatestVersion();
  latestVersion = r ? r.version : null;
  latestPublishComplete = false;
  let publishInfo = null;
  if (r && latestVersion !== current) {
    const registryBase = r.source.replace(/@deepseek-ai\/dsh\/latest$/, '');
    publishInfo = await verifyDshPublishComplete(latestVersion, registryBase);
    latestPublishComplete = publishInfo.complete;
    if (publishInfo.complete) {
      log(`update ${latestVersion}: official publish verified complete`);
    } else {
      const shown = publishInfo.missing.slice(0, 8).join(', ');
      const errSuffix = publishInfo.error ? ` (${publishInfo.error})` : '';
      log(`update ${latestVersion} exists but official publish incomplete${errSuffix}, missing ${publishInfo.missing.length}: ${shown}${publishInfo.missing.length > 8 ? ' …' : ''} [source=${r.source}]`);
    }
  }
  return {
    current,
    latest: latestVersion,
    online: r !== null,
    hasUpdate: !!(r && latestVersion !== current),
    publishComplete: latestPublishComplete,
    missingCount: publishInfo ? publishInfo.missing.length : 0,
    missing: publishInfo ? publishInfo.missing.slice(0, 8) : [],
    source: r ? r.source : null,
  };
}

// TCP 探测端口是否在监听
function probePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = require('node:net').connect({ port, host: '127.0.0.1' });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

async function waitPort(port, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await sleep(intervalMs);
  }
  return false;
}

// 按端口杀监听进程树（PowerShell 拿 owner PID，再 taskkill /T /F）
function killPortTree(port) {
  // $c 可能是多行（多个连接），逐个 taskkill；输出结果写日志，避免"静默没杀掉还假装成功"
  const cmd = [
    `$c = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`,
    `if ($c.Count -eq 0) { Write-Output 'killed=0(no listener)'; exit 0 }`,
    `$killed = 0`,
    `foreach ($x in $c) { & taskkill /pid $x.OwningProcess /T /F *>&1 | ForEach-Object { Write-Output $_ }; if ($LASTEXITCODE -eq 0) { $killed++ } }`,
    `Write-Output "killed=$killed"`,
    `exit 0`,
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  log(`killPortTree(${port}) => ${out || '(no output)'} [exit=${r.status}]`);
  return /killed=[1-9]/.test(out);
}

function sendProgress(msg) {
  log('update: ' + msg);
  if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('update:progress', msg);
}

// 用目标版本起临时实例（boot 会把 profiles Junction 镜像全部 heal 到新版），就绪后停掉
async function healWithTempInstance(version) {
  sendProgress(`正在拉取 v${version} 并以临时端口 ${UPDATE_TEMP_PORT} 启动（切换运行镜像，可能需几十秒）…`);
  const logFd = fs.openSync(path.join(app.getPath('userData'), 'update-npx.log'), 'a');
  spawn(shellQuote(NPX_EXE), ['--yes', `@deepseek-ai/dsh@${version}`, 'web', '--port', String(UPDATE_TEMP_PORT)], {
    cwd: WORK_DIR,
    env: { ...process.env, DSH_HOME },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    shell: true, // npx.cmd 需要 shell 启动；路径已用 shellQuote 加引号，防空格截断
  });
  fs.closeSync(logFd); // 子进程已继承句柄副本，父进程及时释放，避免日志文件被锁
  const ready = await waitPort(UPDATE_TEMP_PORT, UPDATE_PORT_TIMEOUT_MS);
  if (!ready) {
    try { killPortTree(UPDATE_TEMP_PORT); } catch { /* 尽力清理 */ }
    throw new Error(`临时实例在 ${Math.round(UPDATE_PORT_TIMEOUT_MS / 1000)} 秒内未就绪，日志见 update-npx.log`);
  }
  await sleep(1500); // 留出 boot heal Junction 的余量
  sendProgress('临时实例已就绪，镜像切换完成；正在停止临时实例…');
  killPortTree(UPDATE_TEMP_PORT);
  await sleep(1500);
  if (await probePort(UPDATE_TEMP_PORT)) { // 兜底再杀一次
    killPortTree(UPDATE_TEMP_PORT);
    await sleep(1000);
  }
}

// 同步 autostart 脚本里写死的 npx fallback 版本号（否则 fallback 会拉旧版）
function syncAutostartFallback(version) {
  if (!fs.existsSync(AUTOSTART_SCRIPT)) return false;
  const content = fs.readFileSync(AUTOSTART_SCRIPT, 'utf8');
  const re = /@deepseek-ai\/dsh@[0-9][^\s'"]*/;
  if (!re.test(content)) return false;
  fs.writeFileSync(AUTOSTART_SCRIPT, content.replace(re, `@deepseek-ai/dsh@${version}`), 'utf8');
  return true;
}

async function performUpdate(version) {
  await healWithTempInstance(version);
  sendProgress('正在重启 3080 服务（计划任务 watchdog 会自动拉起新版，页面短暂中断属正常）…');
  killPortTree(portOf(DSH_URL));
  if (await waitPort(portOf(DSH_URL), UPDATE_PORT_TIMEOUT_MS)) {
    sendProgress('3080 服务已恢复（新版）。');
  } else {
    sendProgress('3080 未自动恢复——请检查计划任务 DeepSeekHarness-Web-Autostart，或手动启动 dsh web。');
  }
  const synced = syncAutostartFallback(version);
  sendProgress(synced ? '已同步 autostart 脚本的 fallback 版本号。' : 'autostart fallback 行未找到（跳过同步）。');
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendProgress('刷新主窗口加载新版本…');
    mainWindow.webContents.reload();
  }
}

function openUpdateWindow() {
  if (updateWin) { updateWin.show(); updateWin.focus(); return; }
  updateWin = new BrowserWindow({
    width: 620,
    height: 500,
    icon: ICON_PATH,
    autoHideMenuBar: true,
    title: 'DSH 更新',
    webPreferences: {
      preload: path.join(__dirname, 'preload-update.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  updateWin.loadFile(path.join(__dirname, 'update.html'));
  updateWin.on('closed', () => { updateWin = null; });
}

function registerUpdateIpc() {
  ipcMain.on('update:open-window', () => openUpdateWindow()); // 主窗口左下角按钮 → 更新窗口
  ipcMain.handle('update:get-state', () => ({
    current: readLocalVersion(),
    latest: latestVersion,
    busy: updateBusy,
    publishComplete: latestPublishComplete,
  }));
  ipcMain.handle('update:check', () => runCheck());
  ipcMain.handle('update:start', async () => {
    if (updateBusy) return { ok: false, error: '更新已在进行中' };
    if (!latestVersion || latestVersion === readLocalVersion()) {
      return { ok: false, error: '无可用更新（先点「检查更新」）' };
    }
    if (!latestPublishComplete) {
      return { ok: false, error: '官方仍在发布新版本的依赖子包，请稍后再检查' };
    }
    updateBusy = true;
    try {
      await performUpdate(latestVersion);
      if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('update:done', { ok: true });
      return { ok: true };
    } catch (e) {
      sendProgress('错误：' + e.message);
      if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('update:done', { ok: false, error: e.message });
      return { ok: false, error: e.message };
    } finally {
      updateBusy = false;
    }
  });
}

// 启动后静默检查一次：有新版且官方推送完成才提醒（气泡 + 红点）
async function silentUpdateCheck() {
  if (updateRecheckTimer) { clearTimeout(updateRecheckTimer); updateRecheckTimer = null; }
  try {
    const r = await runCheck();
    if (r.hasUpdate && r.publishComplete) {
      log(`update available: ${r.current} -> ${r.latest}`);
      try {
        tray.displayBalloon({
          title: 'DSH 有新版本',
          content: `v${r.current} → v${r.latest}，托盘菜单「检查 DSH 更新」一键升级`,
        });
      } catch { /* 系统禁用通知时静默跳过 */ }
      // 主窗口左下角按钮亮红点
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', { current: r.current, latest: r.latest });
      }
      return; // 已提醒，不再重查
    }
    // 有新版但官方未推送完（或离线未查明）→ 定时重查，等推送完成再亮红点
    if ((r.hasUpdate && !r.publishComplete) || !r.online) {
      log(`red dot held: hasUpdate=${r.hasUpdate} publishComplete=${r.publishComplete} online=${r.online}; recheck in ${UPDATE_RECHECK_MS / 60000} min`);
      updateRecheckTimer = setTimeout(silentUpdateCheck, UPDATE_RECHECK_MS);
    }
  } catch (e) { log('silent update check failed: ' + e.message); }
}

// ---- 单实例保护 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.setAppUserModelId('io.dsh.desktop');

  if (SMOKE_MODE) {
    // smoke：无窗口验证（探测 + 自愈），结果写 JSON 后退出
    app.whenReady().then(async () => {
      if (process.env.DSH_DESKTOP_SMOKE_UPDATE === '1') {
        // 只测检查更新（不碰 3080/更新流程）
        const r = await runCheck();
        log('smoke update result: ' + JSON.stringify(r));
        if (SMOKE_OUT) fs.writeFileSync(SMOKE_OUT, JSON.stringify(r, null, 2));
        app.exit(r.online ? 0 : 1);
        return;
      }
      const up = await ensureService();
      const result = {
        serviceUp: up,
        spawnedByShell: dshProc !== null,
        spawnedPid: dshProc ? dshProc.pid : null,
        url: DSH_URL,
        dshBinExists: fs.existsSync(DSH_BIN),
      };
      log('smoke result: ' + JSON.stringify(result));
      if (SMOKE_OUT) fs.writeFileSync(SMOKE_OUT, JSON.stringify(result, null, 2));
      killOwnDsh(); // app.exit 不触发 will-quit，这里显式清理
      app.exit(up ? 0 : 1);
    });
  } else {
    app.whenReady().then(async () => {
      createTray();
      registerUpdateIpc();
      await start();
      setTimeout(silentUpdateCheck, UPDATE_BALLOON_DELAY_MS); // 静默检查：有新版弹托盘气泡
    });
  }

  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', killOwnDsh);
  // 托盘常驻：全部窗口关闭不退出（关窗口已被拦截为隐藏，这里是兜底）
  app.on('window-all-closed', () => { /* keep running in tray */ });
}
