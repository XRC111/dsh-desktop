// 发版后核验：把线上所有 feed 里**每一个 URL** 都拉一遍，确认真的能下。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// README 9.3 写的是「发版后必须核验」，但以前只能靠人肉 curl 一两个 feed 看看版本号。
// 真正的翻车形态是：版本号对了，可**某一条链接是 404** —— 比如安装包忘了传、
// 运行时差分的切片缺了 part03、热壳没打包。这种错只有点到「更新」的用户才会遇到。
// 这个脚本把所有链接都探一遍（Range 取 1 字节），任何一条不是 200/206 就退出码 1。
//
// 用法：
//   node scripts/verify-feeds.mjs
//   node scripts/verify-feeds.mjs --base-url https://dl.666-xrc.cc.cd
//   node scripts/verify-feeds.mjs --only latest,latest-w7
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

const BASE = arg('base-url', 'https://dl.666-xrc.cc.cd').replace(/\/+$/, '');
const ALL = ['latest', 'latest-beta', 'latest-dev', 'latest-w7', 'latest-w7-beta', 'latest-w7-dev', 'latest-nightly'];
const FEEDS = arg('only', '') ? arg('only', '').split(',').map((s) => s.trim()).filter(Boolean) : ALL;
const TIMEOUT_MS = Number(arg('timeout', '30000'));

/** feed 里的 hot / runtime / plugins 既可能是数组，也可能是对象（单变体时是对象） */
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

async function probe(url) {
  try {
    const r = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return r.status;
  } catch (err) {
    return 'ERR ' + String(err && err.message ? err.message : err).slice(0, 40);
  }
}

function collect(feed, j) {
  const out = [];
  const push = (label, url) => {
    if (url) out.push([label, url]);
  };
  for (const [k, v] of Object.entries(j.files || {})) push(feed + ' 安装包[' + k + ']', v.url);
  for (const h of arr(j.hot)) push(feed + ' 热壳 ' + h.version + '@' + (h.baseVersion ?? '?'), h.url);
  for (const r of arr(j.runtime)) {
    const parts = arr(r.parts);
    if (parts.length) {
      parts.forEach((p, i) =>
        push(feed + ' 运行时差分 ' + r.baseVersion + '→' + r.version + ' 片' + (i + 1),
             typeof p === 'string' ? BASE + '/' + p : p.url),
      );
    } else {
      push(feed + ' 运行时差分 ' + r.version, r.url);
    }
  }
  for (const p of arr(j.plugins)) push(feed + ' 插件 ' + p.version, p.url);
  return out;
}

(async () => {
  let total = 0;
  let bad = 0;
  for (const feed of FEEDS) {
    let j;
    try {
      const res = await fetch(BASE + '/' + feed + '.json?cb=' + Date.now(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      j = await res.json();
    } catch (err) {
      console.log(feed.padEnd(16), '✗ feed 拉不到：' + String(err && err.message ? err.message : err));
      bad++;
      continue;
    }

    const items = collect(feed, j);
    const results = await Promise.all(items.map(async ([label, url]) => [label, url, await probe(url)]));
    const failed = results.filter(([, , s]) => s !== 200 && s !== 206);
    total += results.length;
    bad += failed.length;

    const head = 'v=' + String(j.version).padEnd(8) + ' 链接 ' + String(results.length).padStart(2) + ' 条';
    if (failed.length === 0) {
      console.log(feed.padEnd(16), '✓', head, '全部可下');
    } else {
      console.log(feed.padEnd(16), '✗', head, '有 ' + failed.length + ' 条下不到：');
      for (const [label, url, s] of failed) console.log('     ', String(s).padEnd(6), label, url);
    }
  }

  console.log('---');
  console.log(bad === 0 ? '核验通过：' + total + ' 条链接全部可下' : '核验失败：' + total + ' 条里有 ' + bad + ' 条有问题');
  process.exit(bad === 0 ? 0 : 1);
})();
