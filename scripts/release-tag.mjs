// 发版资产的分组 tag：按日期 + 当日序号命名，避免全部堆在一个 release 里。
//
// ── 为什么改 ────────────────────────────────────────────────────────────────
// 以前所有版本的安装包都传进同一个 `packages` tag，实测已经堆到 35 个资产、
// 横跨十几个版本 —— 想找某一版或想清理旧版都很难，也容易传重/传漏。
//
// ── 命名规则 ────────────────────────────────────────────────────────────────
//   `<日期>-<序号>`，如 `2026.10.01-1`、`2026.10.01-2`
//   日期用**本地时区**（发版的人关心的是自己那天），序号从 1 起，当天已有几个就 +1。
//
// ── 为什么不用「版本号」当 tag ──────────────────────────────────────────────
// 一次发版是**六条通道同时出包**（10.1.x / 10.2.x / 10.3.x / 7.1.x / 7.2.x / 7.3.x），
// 用单个版本号当 tag 名会让人以为只装了那一条。日期+序号更中性，也便于按天回溯。
//
// 用法：
//   node scripts/release-tag.mjs              # 打印「下一个可用 tag」
//   node scripts/release-tag.mjs --list       # 列出已有的日期 tag
import { spawnSync } from 'node:child_process';

const REPO = process.env.DSH_RELEASE_REPO || 'XRC111/dsh-desktop';

/** 本地日期，格式 yyyy.MM.dd */
export function datePart(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

/**
 * 用 GitHub REST API 列 release tag。
 *
 * 公开仓库**不需要 token**（匿名 60 次/小时/IP，发版足够）。有 token 就用，顺带抬高限额。
 * 用 Node 自带的 fetch 而不是 curl：本机 curl 有 schannel 吊销检查的坑
 * （CRYPT_E_NO_REVOCATION_CHECK，整个 HTTPS 直接 HTTP=000），fetch 走 Node 自己的 TLS 栈没这问题。
 */
async function listTagsViaApi() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop-release-tag' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=100', { headers });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('返回不是数组');
  return json.map((x) => x.tag_name).filter(Boolean);
}

/**
 * 列出仓库里已有的 release tag。
 *
 * 三条路，任一成功就返回：
 *   1) `gh release list`（装了 gh CLI 最快；CI 里本来就有 GH_TOKEN）
 *   2) GitHub REST API（**公开仓库无需 token**，Node fetch）
 *   3) curl + token（前两条都不通时的老路）
 *
 * ⚠️ 只有**三条全失败**才返回空数组 —— 那会让序号从 1 重来、可能与已有 tag 撞名，
 *    所以一定打警告，让人至少知道「这次没查到已有 tag」。
 */
export async function listTags() {
  // 1) gh CLI（不带 shell，避免 Node 22 的 DEP0190 警告）
  const gh = spawnSync('gh', ['release', 'list', '--repo', REPO, '--limit', '200', '--json', 'tagName'], {
    encoding: 'utf8',
  });
  if (gh.status === 0) {
    try {
      const tags = JSON.parse(gh.stdout).map((x) => x.tagName);
      if (Array.isArray(tags)) return tags;
    } catch {
      /* 落到 API */
    }
  }

  // 2) REST API（无需 token）
  try {
    return await listTagsViaApi();
  } catch (err) {
    console.error('[release-tag] REST API 查询失败：' + String(err && err.message ? err.message : err));
  }

  // 3) curl + token（老路）
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[release-tag] 警告：gh CLI 与 REST API 都不可用，且没有 GH_TOKEN —— 无法列出已有 release');
    console.error('[release-tag]       序号将从 1 重算，可能与已有 tag 撞名（可设 DSH_RELEASE_TAG 直接指定）');
    return [];
  }
  const api = spawnSync(
    'curl',
    [
      '-sS', '--ssl-no-revoke', '--max-time', '60',
      '-H', 'Authorization: Bearer ' + token,
      '-H', 'Accept: application/vnd.github+json',
      'https://api.github.com/repos/' + REPO + '/releases?per_page=100',
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  try {
    return JSON.parse(api.stdout).map((x) => x.tag_name);
  } catch {
    console.error('[release-tag] 警告：REST API 查询失败，按「无已有 tag」处理');
    return [];
  }
}
/**
 * 算「下一个可用 tag」。
 *
 * @param existing 已有 tag 列表
 * @param today    今天（便于测试注入）
 * @returns 形如 `2026.10.01-1`
 */
export function nextTag(existing, today = new Date()) {
  const base = datePart(today);
  const used = existing
    .filter((t) => typeof t === 'string' && t.startsWith(base + '-'))
    .map((t) => Number(t.slice(base.length + 1)))
    .filter((n) => Number.isInteger(n) && n > 0);
  const next = used.length ? Math.max(...used) + 1 : 1;
  return `${base}-${next}`;
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].endsWith('release-tag.mjs');
if (isMain) {
  const tags = await listTags();
  if (process.argv.includes('--list')) {
    for (const t of tags) {
      if (/^\d{4}\.\d{2}\.\d{2}-\d+$/.test(t)) console.log(t);
    }
  } else {
    // 只输出 tag 本身，方便 shell 里 `$tag = node scripts/release-tag.mjs`
    console.log(nextTag(tags));
  }
}
