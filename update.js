// 更新窗口渲染进程：状态展示 + 检查/一键更新 + 进度日志
const $ = (id) => document.getElementById(id);

const status = $('status');
const logEl = $('log');

function setStatus(text, cls) {
  status.textContent = text;
  status.className = 'status ' + (cls || '');
}

function addLog(text, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(busy) {
  $('btnCheck').disabled = busy;
  $('btnUpdate').disabled = busy;
}

async function refresh() {
  const st = await window.dshUpdate.getState();
  $('cur').textContent = st.current || '未知';
  $('latest').textContent = st.latest || '未知';
}

async function doCheck() {
  setBusy(true);
  setStatus('正在检查 npm registry…');
  const r = await window.dshUpdate.check();
  setBusy(false);
  $('cur').textContent = r.current || '未知';
  if (!r.online) {
    $('latest').textContent = '获取失败';
    setStatus('无法连接 npm registry（已尝试官方源与 npmmirror 镜像）', 'err');
    return;
  }
  $('latest').textContent = r.latest;
  if (r.hasUpdate) {
    if (r.publishComplete) {
      setStatus(`发现新版本：${r.current} → ${r.latest}`, 'warn');
      $('btnUpdate').disabled = false;
    } else {
      const n = r.missingCount || 0;
      setStatus(`新版 ${r.latest} 已发布，但官方仍在推送依赖子包（还缺 ${n} 个），暂不能更新，请稍后再检查`, 'warn');
      $('btnUpdate').disabled = true;
    }
  } else {
    setStatus(`已是最新版本（${r.current}）`, 'ok');
    $('btnUpdate').disabled = true;
  }
}

async function doUpdate() {
  setBusy(true);
  $('btnUpdate').disabled = true;
  addLog('开始更新…', 'ok');
  const r = await window.dshUpdate.start();
  if (!r.ok) {
    addLog('更新失败：' + (r.error || '未知错误'), 'err');
    setStatus('更新失败，见日志', 'err');
    setBusy(false);
    await refresh();
    return;
  }
  setStatus('更新完成', 'ok');
  addLog('更新完成。主窗口将自动刷新加载新版本。', 'ok');
  setBusy(false);
  await refresh();
}

window.dshUpdate.onProgress((msg) => addLog(msg));
window.dshUpdate.onDone((result) => {
  if (!result.ok) addLog('失败：' + result.error, 'err');
});

$('btnCheck').addEventListener('click', doCheck);
$('btnUpdate').addEventListener('click', doUpdate);

refresh().then(doCheck);
