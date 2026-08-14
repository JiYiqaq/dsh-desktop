// 主窗口 preload：把「检查更新」按钮插到 Web GUI 设置按钮上方（不遮挡原 UI，不修改 DSH 本体）
//
// 定位策略（三层兜底）：
//   1) [data-slot="settings.trigger"] 的按钮（DSH slot 语义标识，最稳）
//   2) button[class*="rail"]
//   3) 几何：左侧栏最底部的图标按钮
// 找不到设置按钮就完全不注入（托盘菜单入口仍在，避免再遮挡任何原有 UI）。
//
// 配色跟随页面明暗主题：浅色 = 深灰图标 + 透明底；深色 = 浅灰图标 + 透明底。
// 有新版本时主进程推送 update:available → 图标右上角亮红点。
const { ipcRenderer } = require('electron');

const BTN_ID = 'dsh-desktop-update-btn';

// 依据 body 背景亮度判断当前明暗主题
function themeIsLight() {
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return true;
    return Number(m[1]) + Number(m[2]) + Number(m[3]) > 384;
  } catch { return true; }
}

function findSettingsBtn() {
  const slot = document.querySelector('[data-slot="settings.trigger"]');
  if (slot) {
    const b = slot.closest('button');
    if (b) return b;
  }
  const rail = document.querySelector('button[class*="rail"]');
  if (rail) return rail;
  let best = null;
  let bestY = -1;
  for (const b of document.querySelectorAll('button')) {
    const r = b.getBoundingClientRect();
    if (r.width < 20 || r.width > 64 || r.height < 20 || r.height > 64) continue;
    if (r.x > 80) continue;
    if (r.y > bestY) { bestY = r.y; best = b; }
  }
  return best;
}

let styleInjected = false;
function ensureStyle() {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.textContent = `
    #${BTN_ID}.dsh-light:hover { background: #eef2f8 !important; border-color: rgba(15, 20, 28, 0.22) !important; }
    #${BTN_ID}.dsh-dark:hover { background: rgba(40, 52, 80, 0.95) !important; border-color: rgba(120, 140, 180, 0.45) !important; }
    #${BTN_ID} .dsh-dot {
      position: absolute; top: 3px; right: 4px;
      width: 7px; height: 7px; border-radius: 50%;
      background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.8);
      display: none;
    }
    #${BTN_ID}.dsh-has-update .dsh-dot { display: block; }
  `;
  (document.head || document.documentElement).appendChild(style);
  styleInjected = true;
}

function makeButton(light) {
  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.type = 'button';
  btn.title = '检查 DSH 更新';
  btn.className = light ? 'dsh-light' : 'dsh-dark';
  btn.innerHTML = '<span class="dsh-ico">↻</span><span class="dsh-label">检查更新</span><span class="dsh-dot"></span>';
  const cs = btn.style;
  cs.position = 'fixed'; // 不参与 DSH 布局：fixed 跟随设置按钮位置
  cs.zIndex = '2147483000';
  cs.display = 'inline-flex';
  cs.alignItems = 'center';
  cs.justifyContent = 'center';
  cs.gap = '5px';
  cs.height = '30px';
  cs.padding = '0 12px';
  cs.borderRadius = '15px';
  cs.fontSize = '13px';
  cs.lineHeight = '1';
  cs.cursor = 'pointer';
  cs.fontFamily = 'inherit';
  cs.background = light ? 'rgba(255, 255, 255, 0.9)' : 'rgba(23, 30, 45, 0.85)';
  cs.border = light ? '1px solid rgba(15, 20, 28, 0.14)' : '1px solid rgba(120, 140, 180, 0.25)';
  cs.color = light ? '#4a5568' : '#aab4c8';
  return btn;
}

// 把按钮放到设置按钮正上方（左对齐，间距 8px）；位置变化时跟随
function alignToSettings(btn) {
  const settings = findSettingsBtn();
  if (!settings) return false;
  const r = settings.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const left = Math.round(r.left);
  const top = Math.round(r.top) - 30 - 8; // 按钮高 30 + 间距 8
  btn.style.left = left + 'px';
  btn.style.top = top + 'px';
  return true;
}

// 插入（若未插入）：挂到 body（fixed 定位，不影响 DSH 布局），并立即对齐
function tryInject() {
  let btn = document.getElementById(BTN_ID);
  if (!btn || !btn.isConnected) {
    const settings = findSettingsBtn();
    if (!settings) return; // 设置按钮未出现：不注入（托盘入口仍在）
    ensureStyle();
    btn = makeButton(themeIsLight());
    btn.addEventListener('click', () => ipcRenderer.send('update:open-window'));
    (document.body || document.documentElement).appendChild(btn);
  }
  alignToSettings(btn);
}

// React 异步渲染：轮询最多 20 秒等设置按钮出现
let tries = 0;
const bootTimer = setInterval(() => {
  tries++;
  tryInject();
  if (document.getElementById(BTN_ID) || tries > 40) clearInterval(bootTimer);
}, 500);

// 保活 + 跟随：设置按钮移动（侧边栏收展/窗口缩放）或按钮被移除时校正
setInterval(() => {
  const btn = document.getElementById(BTN_ID);
  if (!btn || !btn.isConnected) tryInject();
  else alignToSettings(btn);
}, 1000);

// 主进程发现新版 → 亮红点 + 更新提示
ipcRenderer.on('update:available', (_e, info) => {
  const btn = document.getElementById(BTN_ID);
  if (btn) {
    btn.classList.add('dsh-has-update');
    btn.title = `DSH 有新版本：v${info.current} → v${info.latest}，点击一键更新`;
  }
});
