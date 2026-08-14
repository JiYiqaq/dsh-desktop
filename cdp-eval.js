// CDP 验证脚本：检查主窗口左下角「检查更新」按钮的注入结果
// 用法: node cdp-eval.js <webSocketDebuggerUrl> '<expression>'
const wsUrl = process.argv[2];
const expr = process.argv[3];
const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => { console.error('timeout'); process.exit(1); }, 15000);
ws.onopen = () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id === 1) {
    console.log(JSON.stringify(m.result?.result?.value ?? m.result, null, 2));
    clearTimeout(timer);
    process.exit(0);
  }
};
ws.onerror = () => { console.error('ws error'); clearTimeout(timer); process.exit(1); };
