// 浏览器同一主机最多只有 6 条 HTTP/1.1 连接，多页看板共用一条流，给页面加载留出连接。
// mux 的每行数据是「订阅号 事件名 JSON」，这里只拆前两个空格，正文原样转发。
'use strict';

const c = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const mux = new EventSource(`mux?c=${c}`), subs = new Map(), tabs = new Set();
// 一次都没连上过时报错带上 opened: false，页面据此判断是不是 worker 根本发不出请求（见 01-state.js 的 checkStreamWorker）
let opened = false, erred = false;
const post = (route, body) => fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ c, ...body }) });

// 同一订阅号的 sub、unsub 一个接一个发：两个请求各走各的连接，后发的退订先到的话，
// 先发的订阅后到就会在服务端留下一个没人管的 client（一直被轮询，服务也不会空闲退出）
const chains = new Map();
function inOrder(id, request) {
  const next = (chains.get(id) || Promise.resolve()).then(request).catch(() => {});
  chains.set(id, next);
  next.then(() => { if (chains.get(id) === next) chains.delete(id); });
}
function subscribe(id, sub, wait = 0) {
  inOrder(id, async () => {
    if (subs.get(id) !== sub) return; // 排队时已经退订或被替换
    sub.sent = true;
    let status;
    try { status = (await post('sub', { s: id, q: sub.q })).status; } catch { status = 0; }
    if (status === 200 || status === 404 || subs.get(id) !== sub) return;
    // 请求本身没成（网络错误、服务出错）：长连接还开着就退避重试，退订了就停；查询不合规之类的告诉页面
    if (status === 0 || status >= 500) {
      const next = Math.min(10000, wait * 2 || 1000);
      setTimeout(() => { if (subs.get(id) === sub && mux.readyState === 1) subscribe(id, sub, next); }, next);
      return;
    }
    sub.port.postMessage({ id, state: 'closed' }); subs.delete(id);
  });
}
function unsubscribe(id) {
  const sub = subs.get(id);
  if (!sub) return;
  subs.delete(id);
  if (sub.sent) inOrder(id, () => post('unsub', { s: id }));
}
function bye(tab) {
  for (const [id, sub] of subs) if (sub.tab === tab) unsubscribe(id);
}

mux.onopen = () => { opened = true; for (const [id, sub] of subs) subscribe(id, sub); };
mux.onmessage = ({ data }) => {
  const first = data.indexOf(' '), second = data.indexOf(' ', first + 1);
  const id = data.slice(0, first), event = data.slice(first + 1, second), sub = subs.get(id);
  if (sub) sub.port.postMessage(event === 'open' ? { id, state: 'open' } : { id, event, data: data.slice(second + 1) });
};
mux.onerror = () => {
  erred = true;
  for (const [id, sub] of subs) sub.port.postMessage({ id, state: mux.readyState === 2 ? 'closed' : 'error', opened });
};
onconnect = ({ ports: [port] }) => {
  port.onmessage = ({ data }) => {
    if (data.tab && !tabs.has(data.tab) && navigator.locks) {
      tabs.add(data.tab);
      navigator.locks.request('foreman-board-tab-' + data.tab, () => { tabs.delete(data.tab); bye(data.tab); });
    }
    if (data.op === 'sub') {
      const sub = { port, q: data.q, tab: data.tab }; subs.set(data.id, sub);
      if (mux.readyState === 1) subscribe(data.id, sub);
      // 已经报过错、又从没连上过：马上告诉新来的页面，不用等下一次重连（约 3 秒）
      else if (erred && !opened) port.postMessage({ id: data.id, state: 'error', opened });
    } else if (data.op === 'unsub') unsubscribe(data.id);
    else if (data.op === 'bye') bye(data.tab);
  };
  port.start();
};
