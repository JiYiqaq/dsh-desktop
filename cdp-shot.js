// CDP 截屏：连上 Electron 窗口的调试端口，Page.captureScreenshot 存 PNG
// 用法: node cdp-shot.js <webSocketDebuggerUrl> <out.png>
const wsUrl = process.argv[2];
const out = process.argv[3];
const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => { console.error('timeout'); process.exit(1); }, 15000);
ws.onopen = () => {
  ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id === 1) {
    require('node:fs').writeFileSync(out, Buffer.from(m.result.data, 'base64'));
    console.log('saved: ' + out);
    clearTimeout(timer);
    process.exit(0);
  }
};
ws.onerror = (e) => { console.error('ws error'); clearTimeout(timer); process.exit(1); };
