/**
 * 临时 E2E 工具：连 CDP 在 harness 页面（http://127.0.0.1:3080）执行 JS。
 *
 * 用法：
 *   node scripts/cdp-eval.mjs "<expression>"        # 自动 awaitPromise
 *   node scripts/cdp-eval.mjs --shot out.png        # 截图
 */
const listUrl = 'http://127.0.0.1:9222/json/list';

async function pickTarget() {
  const list = await (await fetch(listUrl)).json();
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3080'));
  if (!page) throw new Error('未找到 harness 页面 target: ' + JSON.stringify(list.map((t) => t.url)));
  return page;
}

function waitFor(ws, event) {
  return new Promise((resolve) => {
    const h = (e) => {
      ws.removeEventListener(event, h);
      resolve(e);
    };
    ws.addEventListener(event, h);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const target = await pickTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await waitFor(ws, 'open');

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  if (args[0] === '--shot') {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs');
    fs.writeFileSync(args[1] || 'shot.png', Buffer.from(res.result.data, 'base64'));
    console.log('截图已保存:', args[1] || 'shot.png');
  } else {
    const expr = args[0];
    if (!expr) throw new Error('缺少表达式');
    const res = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result?.exceptionDetails) {
      console.error('执行异常:', JSON.stringify(res.result.exceptionDetails, null, 2));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(res.result?.result?.value, null, 2));
    }
  }
  try { ws.close(); } catch {}
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
