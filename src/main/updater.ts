import { app } from 'electron';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { log } from './logger';
import {
  extractHotPackage,
  hotStagingDir,
  installHotShell,
  shellVersion,
} from './hot-shell';
import {
  extractRuntimePatch,
  extractTarGz,
  findRuntimeDir,
  readManifest,
  runtimeVersionOf,
  writePendingPatch,
} from './runtime-patch';
import {
  installedAppDir,
  profilesModulesDir,
  updateConfigFile,
  updateStateFile,
  updatesDir,
  userDataDir,
  userPluginsDir,
} from './paths';

/**
 * 更新：两条通道，优先「热更新」，兜底「完整安装包」。
 *
 * ┌ 热更新（hot）：下载一份新壳代码（几百 KB）→ 解压到用户数据目录 → **重启进程即生效**。
 * │   不跑安装包、不需要管理员权限、不必等 269MB 运行时解压（运行时根本没动），
 * │   重启后几秒就能用。适合改外壳逻辑/界面。
 * └ 完整安装包（installer）：下载 Setup.exe（约 145MB）→ 静默覆盖安装 → 自动重启。
 *     运行时或 Electron 版本变了、跨大版本升级（热更新包 baseVersion 不匹配）时使用。
 *
 * 云端 JSON 约定（详见 resources/update-config.json 与 README）：
 *   {
 *     "version": "1.1.1",
 *     "notes": "更新说明",
 *     "files": { "win32-x64": { "url": "...Setup.exe", "sha256": "…", "size": 151658875 } },
 *     "hot":   { "version": "1.1.1",
 *                "url": "https://…/hot-1.1.1.tar", "sha256": "…", "size": 185000,
 *                "baseVersion": "1.1.0" }
 *   }
 *   - 只有 hot 没有 files：纯热更新（小改动无需重打安装包）
 *   - 安装版低于 baseVersion 时，hot 会被忽略并自动降级到安装包通道
 */

export type UpdatePhase =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'applying'
  | 'error';

export interface UpdateFileInfo {
  url: string;
  sha256?: string;
  size?: number;
  /**
   * 超过托管单文件上限时的分片清单（相对 url 同级目录的文件名）。
   * 客户端按数组顺序依次下载、拼成整包，再统一校验 size / sha256。
   * 之前只有 plugins 声明了这个字段，但**下载侧根本没实现**——
   * 大包（跨版本运行时补丁动辄上百 MB）因此一直发不出去。
   */
  parts?: string[];
}

/** 热更新包（只需重启即可生效） */
export interface HotUpdateInfo extends UpdateFileInfo {
  version: string;
  /**
   * 最低支持的已安装版本（floor，不是"必须等于"）。
   * 留空表示不限制。热更新包是自包含的完整 out/，所以一般填最早支持热更新的版本即可。
   */
  baseVersion?: string;
  notes?: string;
}

/** 运行时差分补丁（dsh 本体升级，重启应用生效） */
export interface RuntimeUpdateInfo extends UpdateFileInfo {
  version: string;
  /** 精确基线：补丁只含差异，只能从 baseVersion 这一版升上来 */
  baseVersion?: string;
  notes?: string;
  /**
   * dsh 0.1.7 起，require-builtin 原生模块按 **V8 指纹**校验宿主 Electron
   * （白名单：43.0.0 / 44.0.0 / 45.0.0-alpha.6），不在表内直接 fatal 拒绝启动。
   * 补丁可声明自己只支持这些 Electron 版本，壳在**下载前**据此跳过——
   * 否则用户下完上百 MB、重启后 dsh 起不来（实测踩过）。
   */
  requiresElectron?: string[];
}

/** 插件包（可选安装） */
export interface PluginsUpdateInfo extends UpdateFileInfo {
  version: string;
  /** 插件包名（如 @dsh-desktop/updater）；留空表示按解压出的目录名就地安装 */
  name?: string;
}

const asArray = <T>(v: T | T[] | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);

export interface UpdateFeed {
  version: string;
  notes?: string;
  releaseDate?: string;
  mandatory?: boolean;
  minSupportedVersion?: string;
  files?: Record<string, UpdateFileInfo>;
  /**
   * 热更新包。可以是单个包，也可以是**升级链**（数组）——
   * 客户端会自动挑「自己能用」且**版本最高**的那一个，像 OTA 一样一级级爬上来。
   *
   * baseVersion 的语义是「**最低**支持的已安装版本」（不是"必须等于"）：
   *   只要 app.getVersion() >= baseVersion 就能用。
   *   热更新包是 out/ 的完整副本、自包含，所以通常填最早支持热更新的那个版本即可，
   *   以后每次发版都不用再改（只有当外壳开始依赖更新的 Electron 能力时才需要抬这个下限）。
   */
  hot?: HotUpdateInfo | HotUpdateInfo[];
  /**
   * 运行时差分补丁。单个包或**升级链**（数组）。
   * 差分补丁的 baseVersion 是「**精确**基线」（必须等于当前运行时版本），
   * 因为补丁只含差异文件；客户端会挑 baseVersion 与当前运行时一致的那一档，
   * 应用后重启，下次再从新基线继续爬。
   */
  runtime?: RuntimeUpdateInfo | RuntimeUpdateInfo[];
  /**
   * 插件包（可选安装）。单个对象或**数组**（一次挂多个插件）。
   * 数组写法是本项目的扩展：老 feed 的单对象写法继续支持（客户端统一 asArray 归一化）。
   */
  plugins?: PluginsUpdateInfo | PluginsUpdateInfo[];
  url?: string;
  sha256?: string;
  size?: number;
}

/**
 * 更新通道。云端是静态托管（Cloudflare Pages），**通道靠不同的 JSON 文件区分**：
 *   latest.json（stable）/ latest-beta.json / latest-dev.json
 * （`?channel=` 参数对静态源无效 —— 老版本带过这个参数，服务器根本不看。）
 */
export type UpdateChannel = 'stable' | 'beta' | 'dev' | 'nightly';

export const UPDATE_CHANNELS: UpdateChannel[] = ['stable', 'beta', 'dev', 'nightly'];

// nightly = 从 deepseek-harness **master 源码**编译（官方 npm 没有 nightly 标签，
// 见 scripts/fetch-nightly.mjs）。它的 dsh 版本形如 `0.2.0-rc.2+nightly.639ed01`：
// 加号后面是 semver 构建元数据，**不参与版本比较**，所以排序上等同于上游版本。

/** 通道 → 文件名中缀。stable 为空：保持 latest.json，与老客户端完全兼容 */
function channelSuffix(channel: UpdateChannel): string {
  return channel === 'stable' ? '' : `-${channel}`;
}

/** 非预期值一律回落 stable（配错通道不该让更新功能消失） */
export function normalizeChannel(raw: unknown): UpdateChannel {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'dev' || v === 'beta' || v === 'nightly' ? v : 'stable';
}

/**
 * 通道取值优先级：环境变量（联调）> 用户选择（设置页）> 配置文件 > stable。
 */
function resolveChannel(raw: unknown): UpdateChannel {
  return normalizeChannel(process.env.DSH_DESKTOP_CHANNEL ?? readChannelOverride() ?? raw);
}
/**
 * 用户级通道偏好文件。
 *
 * 为什么不写应用目录里的 update-config.json：
 *   - 打包态在 `resources/`（装在 Program Files 时普通用户没写权限）；
 *   - dev 态直接就是仓库文件（改一下就污染 git diff）。
 * 用户数据目录两样问题都没有，且与应用自带的默认值天然分层。
 */
function channelFile(): string {
  return path.join(userDataDir(), 'update-channel.json');
}

/** 读用户选过的通道；没有/损坏 → null（回落到配置文件的默认值） */
function readChannelOverride(): UpdateChannel | null {
  try {
    const raw = JSON.parse(fs.readFileSync(channelFile(), 'utf8')) as { channel?: unknown };
    return raw?.channel ? normalizeChannel(raw.channel) : null;
  } catch {
    return null;
  }
}

/**
 * 按通道算出实际请求的 feed 地址。
 *
 * 两种写法都支持：
 *   - 占位符：`https://host/latest{channel}.json` → stable 得 latest.json、beta 得 latest-beta.json
 *   - 无占位符：自动在最后一个路径段的扩展名前插入中缀（latest.json → latest-dev.json）
 * 解析不了就原样返回（不至于因为 URL 形态奇怪而整体不可用）。
 */
export function feedUrlForChannel(baseUrl: string, channel: UpdateChannel): string {
  if (baseUrl.includes('{channel}')) {
    return baseUrl.replace('{channel}', channelSuffix(channel));
  }
  try {
    const u = new URL(baseUrl);
    const segs = u.pathname.split('/');
    const last = segs[segs.length - 1] ?? '';
    const dot = last.lastIndexOf('.');
    const name = dot > 0 ? last.slice(0, dot) : last;
    const ext = dot > 0 ? last.slice(dot) : '';
    segs[segs.length - 1] = `${name}${channelSuffix(channel)}${ext}`;
    u.pathname = segs.join('/');
    return u.toString();
  } catch {
    return baseUrl;
  }
}

export interface UpdateConfig {
  feedUrl: string;
  /** 更新通道（默认 stable） */
  channel?: UpdateChannel;
  checkOnStartup?: boolean;
  checkIntervalHours?: number;
  autoDownload?: boolean;
  /** 允许 http 明文源（仅建议本地联调时打开；生产走 https） */
  allowInsecureHttp?: boolean;
  /** 关掉热更新通道，只用完整安装包 */
  disableHotUpdate?: boolean;
  /**
   * 更新就绪后是否自动重启（默认 false）。
   * 默认行为：只提示 + 托盘菜单等你决定，绝不替你重启，「稍后」即下次启动自动生效。
   * 无人值守/企业批量部署可打开（或用 DSH_DESKTOP_UPDATE_AUTO_RESTART=1）。
   */
  autoRestart?: boolean;
  /** 「N 分钟后自动重启」里的 N（秒），默认 60 */
  restartDelaySeconds?: number;
}

export interface UpdateState {
  phase: UpdatePhase;
  /** 当前生效的壳版本（热更新壳优先） */
  currentVersion: string;
  feedUrl?: string;
  /** 当前订阅的更新通道（切换后随状态广播，渲染端据此高亮） */
  channel?: UpdateChannel;
  latestVersion?: string;
  notes?: string;
  mandatory?: boolean;
  /** 下载进度 0-100 */
  percent?: number;
  /** 实时下载速度（字节/秒，EMA 平滑；采样不足时缺省 0） */
  speed?: number;
  message?: string;
  checkedAt?: number;
  setupPath?: string;
  /** 这次更新是否走热更新通道 */
  viaHot?: boolean;
  /** 热更新目标版本 */
  hotVersion?: string;
  /** 热更新包是否已就绪（等重启生效） */
  hotReady?: boolean;
  /** 运行时差分补丁是否已就绪（等重启生效） */
  runtimeReady?: boolean;
  /** 当前运行时版本（dsh 本体） */
  runtimeVersion?: string;
  /** 待应用的运行时版本 */
  runtimeTarget?: string;
  /** 新插件是否已落位（重启后生效） */
  pluginsReady?: boolean;
  /** 待安装的插件名 */
  pluginsTarget?: string;
  /** 已计划的重启时间戳（毫秒）；有值说明正在倒计时，可在托盘取消 */
  restartAt?: number;
  /** 倒计时剩余秒数（仅用于显示） */
  restartIn?: number;
  /**
   * 应用内更新提示（1.1.21 起取代系统对话框）。
   * 渲染端据 phase 渲染 harness 风格横幅：
   *   - phase=available + prompt → 「发现新版本」横幅（按 channels 给按钮）
   *   - phase=downloaded → 「已就绪」横幅（重启 / 安装）
   */
  prompt?: UpdatePrompt | null;
}

/** 应用内更新提示内容（随 UpdateState 推给渲染端） */
export interface UpdatePrompt {
  kind: 'update' | 'restart' | 'installer';
  version: string;
  notes?: string;
  releaseDate?: string;
  mandatory: boolean;
  /** 可用通道（kind=update 时有效）：hot > runtime > installer */
  viaHot: boolean;
  rtVersion?: string;
  installer: boolean;
  /** 该版本曾被用户跳过（仅 mandatory 时仍会提示） */
  skipped: boolean;
}

export interface UpdaterOptions {
  /** 状态变化（用于托盘提示 / 界面广播） */
  onState: (state: UpdateState) => void;
  /** 安装/重启前释放资源：停 dsh 子进程、销毁托盘、持久化状态 */
  onBeforeInstall: () => Promise<void>;
  /** 安装包已启动，现在可以退出进程（完整安装包通道用） */
  onExit: () => void;
  /** 重启进程以应用热更新（app.relaunch + exit） */
  onRestart: () => void;
  /** 托盘气泡通知 */
  notify: (title: string, body: string) => void;
}

interface PersistedState {
  skippedVersion?: string;
  lastCheckAt?: number;
  lastInstallAt?: number;
}

/** 默认占位源：未配置时更新功能整体关闭（不会每次启动都去请求） */
const PLACEHOLDER_HOSTS = ['example.com', 'example.org', 'your-domain.com'];

// 更新源是 Cloudflare 免费版（无中国节点），国内晚高峰单次请求偶尔超 15s（实测踩过）：
// 放宽到 30s，且 fetchFeed 对网络层失败自动重试一次。
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** 启动后延迟多久检查更新：别和 dsh 启动抢 I/O */
const STARTUP_DELAY_MS = 25_000;

// ---------------------------------------------------------------------------
// GitHub Releases 直链下载加速（多源融合）
// ---------------------------------------------------------------------------
// GitHub 的 release-assets CDN 在国内时好时坏，安装包/运行时挂上 GitHub 外链后
// 需要加速兜底。设计：竞速探测 —— 客户端对全部镜像同时发 Range 0-0 探测，
// 最先通过（206 且总长吻合 / 200 全量）的镜像胜出；全部镜像失败 → 回 GitHub 直连；
// 直连下载也失败 → 不会的，直连本身就是最后兜底（镜像下载失败会再回直连重试一轮）。
//
// 两种拼接格式并存：
//  - 自建镜像（路径路由）：https://gh-proxy.xrc-nb.cc.cd/<owner>/<repo>/releases/download/...
//    即把原链的 https://github.com/ 换成镜像域（镜像内部 302 到 /release/<签名资产>）；
//  - 公共镜像（前缀路由）：https://ghfast.top/https://github.com/<owner>/<repo>/releases/download/...
//    即前缀 + 完整原 URL。
// feed JSON 里也可能直接挂镜像 URL（老客户端零改动加速）——所以 expand 前先剥前缀
// 还原出原链，再展开完整候选清单，保证新旧客户端殊途同归。

const GITHUB_RELEASE_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//;

interface GhMirror {
  label: string;
  /** 由 GitHub 原链构造镜像 URL */
  build: (origin: string) => string;
  /** 若 url 挂在本镜像域下则还原出 GitHub 原链，否则 null */
  strip: (url: string) => string | null;
}

const GH_MIRROR_SELF_HOST = 'https://gh-proxy.xrc-nb.cc.cd/';

// 顺序即优先级：gh-proxy.com 实测并发 6 片最稳（2026-09-26 复现：自建镜像 Worker
// 转发大偏移 Range 时间歇性回 200+1124B 错误页，竞速探测挡不住「探测通过、下载变卦」，
// 因此主加速站定为直连 gh-proxy.com；自建镜像保留在候选链中，修好后自然被竞速选中）。
const GH_MIRRORS: GhMirror[] = [
  ...['gh-proxy.com', 'ghfast.top', 'ghproxy.net'].map((host) => {
    const prefix = `https://${host}/`;
    return {
      label: host,
      build: (o: string) => prefix + o,
      strip: (u: string) => {
        if (!u.startsWith(prefix)) return null;
        const origin = u.slice(prefix.length);
        return GITHUB_RELEASE_URL_RE.test(origin) ? origin : null;
      },
    };
  }),
  {
    label: '自建镜像',
    build: (o) => GH_MIRROR_SELF_HOST + o.replace(/^https?:\/\/github\.com\//, ''),
    strip: (u) => {
      if (!u.startsWith(GH_MIRROR_SELF_HOST)) return null;
      const origin = `https://github.com/${u.slice(GH_MIRROR_SELF_HOST.length).replace(/^\/+/, '')}`;
      return GITHUB_RELEASE_URL_RE.test(origin) ? origin : null;
    },
  },
];

/** 探测候选的耗时上限：镜像挂了就快速放弃，别拖累竞速 */
const MIRROR_PROBE_TIMEOUT_MS = 8_000;

/**
 * 剥掉 feed 里可能已挂的镜像前缀还原出原链，再展开 [镜像×N, 原链] 候选清单。
 * 非 GitHub Releases 直链（Pages 本站文件、热更包等）原样返回，零开销直通。
 */
function expandDownloadCandidates(url: string): { origin: string; mirrors: Array<{ url: string; label: string }> } {
  let origin = url;
  for (const m of GH_MIRRORS) {
    const stripped = m.strip(url);
    if (stripped) {
      origin = stripped;
      break;
    }
  }
  if (!GITHUB_RELEASE_URL_RE.test(origin)) return { origin: url, mirrors: [] };
  return { origin, mirrors: GH_MIRRORS.map((m) => ({ url: m.build(origin), label: m.label })) };
}

/** 下载速度文案：≥1MB/s 用 MB/s（一位小数），否则 KB/s；无有效速度返回空串 */
function fmtSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  const mb = bytesPerSec / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bytesPerSec / 1024)} KB/s`;
}

// ---------------------------------------------------------------------------
// 版本比较（支持 1.0.10 > 1.0.9、1.1.0-rc.1 < 1.1.0）
// ---------------------------------------------------------------------------

function parseVersion(v: string): { nums: number[]; pre: string[] } {
  let s = String(v)
    .trim()
    .replace(/^v/i, '');
  // 平台变体后缀（如 Win7 特供包的 `-w7`）不是预发布：它和同版本号的正式版是
  // 同一份代码的另一个构建。若当预发布处理，正式版会永远"大于"它
  // （正式版 > 预发布版分支），导致 Win7 机器被同版本号反复提示更新（实测踩过）。
  s = s.replace(/-w7$/i, '');
  const [core, ...rest] = s.split('-');
  const nums = core.split('.').map((str) => {
    const n = parseInt(str.replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pre = rest.join('-').split('.').filter(Boolean);
  return { nums, pre };
}

/** a > b → 正数；a < b → 负数；相等 → 0 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = va.nums[i] ?? 0;
    const y = vb.nums[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // 正式版 > 预发布版（1.1.0 > 1.1.0-rc.1）
  if (va.pre.length === 0 && vb.pre.length > 0) return 1;
  if (va.pre.length > 0 && vb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const dx = parseInt(x, 10);
      const dy = parseInt(y, 10);
      if (dx !== dy) return dx > dy ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function isPlaceholder(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PLACEHOLDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return true;
  }
}

function assertUrlAllowed(raw: string, allowHttp: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`更新源地址不合法：${raw}`);
  }
  const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol === 'https:') return u.toString();
  if (u.protocol === 'http:' && (allowHttp || isLocal)) return u.toString();
  throw new Error(`更新源必须使用 https（当前 ${u.protocol}//）`);
}

export function loadUpdateConfig(): UpdateConfig | null {
  // 环境变量优先，便于联调与私有部署
  const envUrl = process.env.DSH_DESKTOP_UPDATE_URL?.trim();
  if (envUrl) {
    return {
      feedUrl: envUrl,
      // 联调时用 DSH_DESKTOP_CHANNEL=dev 直接切通道，不改配置文件
      channel: resolveChannel(undefined),
      checkOnStartup: true,
      checkIntervalHours: 6,
      allowInsecureHttp: true,
      // 联调方便：有更新就自动下载应用（配合 DSH_DESKTOP_UPDATE_DRYRUN=1 只到"已就位"为止）
      autoDownload: process.env.DSH_DESKTOP_UPDATE_AUTO === '1',
    };
  }

  const file = updateConfigFile();
  if (!fs.existsSync(file)) {
    log(`未找到更新配置 ${file}，热更新关闭`);
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<UpdateConfig>;
    const feedUrl = String(raw.feedUrl ?? '').trim();
    if (!feedUrl) {
      log('更新配置里没有 feedUrl，热更新关闭');
      return null;
    }
    return {
      feedUrl,
      channel: resolveChannel(raw.channel),
      checkOnStartup: raw.checkOnStartup !== false,
      checkIntervalHours:
        typeof raw.checkIntervalHours === 'number' && raw.checkIntervalHours > 0
          ? raw.checkIntervalHours
          : 6,
      autoDownload: raw.autoDownload === true,
      allowInsecureHttp: raw.allowInsecureHttp === true,
      disableHotUpdate: raw.disableHotUpdate === true,
      autoRestart: raw.autoRestart === true,
      restartDelaySeconds:
        typeof raw.restartDelaySeconds === 'number' && raw.restartDelaySeconds > 0
          ? raw.restartDelaySeconds
          : 60,
    };
  } catch (err) {
    log(`解析更新配置失败：${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 更新器
// ---------------------------------------------------------------------------

export class Updater {
  private state: UpdateState;
  private config: UpdateConfig | null = null;
  private persisted: PersistedState = {};
  private timer: NodeJS.Timeout | null = null;
  /** 检查中（与 applyUpdate 各自独立，否则 check 里派发的自动下载会被自己拦住） */
  private checkBusy = false;
  /** 下载/应用中 */
  private applyBusy = false;
  private downloadedFilePath: string | null = null;
  private downloadedVersion: string | null = null;
  /** 计划中的重启时间戳（毫秒），null = 没有计划 */
  private pendingRestartAt: number | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: UpdaterOptions) {
    // 生效版本 = 热更新壳版本（若有）否则安装版：不这样比，热更新后会一直提示同一个版本
    this.state = { phase: 'idle', currentVersion: shellVersion() };
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  init(): void {
    this.persisted = readPersisted();
    this.config = loadUpdateConfig();
    this.applyConfig(true);
  }

  /**
   * 应用当前配置：校验更新源、算出通道化的 feed 地址、安排启动检查与定时检查。
   * 抽成方法是为了切换通道后能整套重来（不必重启应用）。
   */
  private applyConfig(startup: boolean): void {
    if (!this.config) {
      this.setState({ phase: 'disabled', message: '未配置更新源' });
      return;
    }

    const channel = normalizeChannel(this.config.channel);
    this.config.channel = channel;

    let feedUrl: string;
    try {
      // 通道化后的地址才做安全校验：http 白名单针对的是真实请求目标
      feedUrl = assertUrlAllowed(
        feedUrlForChannel(this.config.feedUrl, channel),
        this.config.allowInsecureHttp === true,
      );
    } catch (err) {
      this.setState({ phase: 'disabled', message: String((err as Error).message ?? err) });
      log(`更新源被拒绝：${this.state.message}`);
      return;
    }

    if (isPlaceholder(feedUrl)) {
      this.setState({ phase: 'disabled', feedUrl, message: '更新源仍是示例地址，请在 update-config.json 里改成真实地址' });
      log('更新源仍是占位地址，热更新关闭');
      return;
    }

    this.setState({ phase: 'idle', feedUrl, channel });
    log(`更新源：${feedUrl}（通道 ${channel}）`);

    if (startup) {
      if (this.config.checkOnStartup) {
        const t = setTimeout(() => {
          void this.check({ interactive: false });
        }, STARTUP_DELAY_MS);
        t.unref?.();
      }
      this.scheduleInterval();
    }
  }

  /** 当前通道（供渲染端显示 / 设置页高亮） */
  getChannel(): UpdateChannel {
    return normalizeChannel(this.config?.channel ?? this.state.channel);
  }

  /**
   * 切换更新通道：写回 update-config.json → 重载配置 → 立即按新通道检查一次。
   * 只改 channel 一个字段，其余配置（含 _readme 说明）原样保留。
   */
  async setChannel(channel: UpdateChannel): Promise<UpdateState> {
    const next = normalizeChannel(channel);
    if (next === this.getChannel()) {
      log(`更新通道未变化（${next}），无需切换`);
      return this.getState();
    }

    // 写到用户数据目录（不碰应用目录里的 update-config.json：没权限 / 会污染仓库）
    try {
      fs.writeFileSync(channelFile(), `${JSON.stringify({ channel: next }, null, 2)}\n`, 'utf8');
    } catch (err) {
      // 极端情况（目录不可写）→ 至少让本次会话按新通道走，不阻断用户
      log(`写入更新通道失败（本次会话内生效）：${String(err)}`);
    }

    this.config = loadUpdateConfig();
    this.config = this.config ? { ...this.config, channel: next } : null;
    this.applyConfig(false);
    log(`已切换更新通道 → ${next}`);
    // 切完立刻查一次：新通道多半就有更新可推（例如 stable → beta）
    return this.check({ interactive: true });
  }

  /** 手动检查（托盘菜单 / IPC）。结果统一走状态推送，由应用内横幅/设置卡片呈现 */
  async check(options: { interactive: boolean }): Promise<UpdateState> {
    const interactive = options.interactive;
    if (this.checkBusy) {
      // 已有任务在跑：不弹系统框，设置卡片/横幅会显示「正在检查/下载」状态
      if (interactive) log('手动检查被忽略：上一个更新任务尚未结束');
      return this.getState();
    }

    if (!this.config || this.state.phase === 'disabled') {
      const msg = `未配置更新源（请编辑 ${updateConfigFile()} 或设置环境变量 DSH_DESKTOP_UPDATE_URL）`;
      this.setState({ phase: 'disabled', message: msg });
      if (interactive) log(msg);
      return this.getState();
    }

    this.checkBusy = true;
    this.setState({ phase: 'checking', message: '正在检查更新…' });
    try {
      const feed = await this.fetchFeed();
      this.persisted.lastCheckAt = Date.now();
      writePersisted(this.persisted);

      const current = shellVersion();
      const latest = String(feed.version ?? '').trim();
      if (!latest) throw new Error('云端 JSON 缺少 version 字段');

      const shellOutdated = compareVersions(latest, current) > 0;
      // 「回滚」：云端版本低于当前版本（从 beta/dev 切回 stable 的典型场景）。
      // 只要 hot/rt 任一命中（stable feed 挂了降级热壳 + 运行时降级补丁），就能整体滚回。
      const downgrade = !shellOutdated && compareVersions(latest, current) < 0;
      const skipped = this.persisted.skippedVersion === latest;
      const mandatory =
        feed.mandatory === true ||
        (!!feed.minSupportedVersion && compareVersions(current, feed.minSupportedVersion) < 0);
      const hot = this.pickHot(feed);
      // 关键：外壳已是最新时也要看其它通道（运行时/插件）——
      // 否则「只发运行时补丁」的那种版本会被判成"已是最新"而永远推不出去。
      const rt = this.pickRuntime(feed);
      const plugins = this.pickPlugins(feed);
      const hasPlugins = plugins.length > 0;
      const available = shellOutdated || !!rt || hasPlugins;

      log(
        `更新检查：当前 ${current} / 云端 ${latest} → ${shellOutdated ? '有更新' : '已是最新'}` +
          `${hot ? '（可用热更新）' : ''}${rt ? `（有运行时更新 ${rt.version}）` : ''}` +
          `${hasPlugins ? `（有新插件 ${plugins.map((p) => p.name ?? p.version).join('、')}）` : ''}` +
          `${skipped ? '（该版本已被用户跳过）' : ''}`,
      );

      // 插件：新增能力，静默后台安装（不该要求用户决策）。
      // 关键是**无论有没有其它更新都要装** —— 否则外壳已是最新时插件永远推不下去。
      if (hasPlugins) this.installPluginsQuietly(plugins);

      if (!available) {
        this.setState({
          phase: 'up-to-date',
          latestVersion: latest,
          checkedAt: this.persisted.lastCheckAt,
          prompt: null,
          message: hasPlugins ? '正在安装新插件…' : `已是最新版本（${current}）`,
        });
        // 不再弹系统对话框：手动检查的结果用托盘气泡轻提示（设置卡片同步显示文案）
        if (interactive && !hasPlugins) {
          this.opts.notify('检查更新', `已是最新版本（${current}）`);
        }
        return this.getState();
      }

      const pluginsOnly = !shellOutdated && !rt && hasPlugins;
      // 应用内「发现新版本」横幅（1.1.22 起取代系统对话框）：
      // 跳过的版本不再打扰（强制更新除外）——跳过语义由此真正闭环，而不是
      // 往弹窗里加一行"该版本此前被你跳过"、跳了等于没跳（1.1.20 实测翻车）。
      const hasInstaller = !!pickFileForThisMachine(feed);

      // 死局守卫：云端版本比当前新，但热更、运行时、插件、安装包四条下载通道
      // 全部为空（beta/dev feed 空骨架的设计态——Pages 容量放不下安装包，
      // 安装包只走手动分发）。此时若照常出「发现新版本」横幅，用户一点更新
      // 就会走到 applyInstaller 抛「没有适配的安装包」；不如在检查阶段就把
      // 话说清楚：有新版本，但要手动下载。
      if (shellOutdated && !hot && !rt && !plugins && !hasInstaller) {
        const msg = `${latest} 已发布，但更新源暂未挂载可用安装包，请从发布页手动下载安装`;
        log(`更新检查：${msg}`);
        this.setState({
          // 不进 available（横幅可点必报错），但 message 照常展示准确指引
          phase: 'up-to-date',
          latestVersion: latest,
          checkedAt: this.persisted.lastCheckAt,
          prompt: null,
          message: msg,
        });
        this.opts.notify('DSH Desktop 有新版本', msg);
        return this.getState();
      }

      const showPrompt = !pluginsOnly && (!skipped || mandatory);
      this.setState({
        phase: 'available',
        latestVersion: latest,
        notes: feed.notes,
        mandatory,
        viaHot: !!hot,
        hotVersion: hot?.version,
        checkedAt: this.persisted.lastCheckAt,
        prompt: showPrompt
          ? {
              kind: 'update',
              version: latest,
              notes: feed.notes,
              releaseDate: feed.releaseDate,
              mandatory,
              viaHot: !!hot,
              rtVersion: rt?.version,
              installer: hasInstaller,
              skipped,
            }
          : null,
        message: pluginsOnly
          ? `正在安装新组件 ${plugins.map((p) => p.name ?? p.version).join('、')}…`
          : downgrade && (hot || rt)
            ? `可回滚到稳定版 ${latest}（外壳 + 运行时一并回到稳定线，重启即生效）`
            : !shellOutdated && rt
              ? `发现运行时更新 ${rt.version}（外壳已是最新的 ${current}）`
              : hot
                ? `发现新版本 ${latest}（热更新，重启即生效）`
                : `发现新版本 ${latest}`,
      });

      // 云端有更新但当前设备什么通道都没有（如纯热更 feed 基线不匹配）：
      // 横幅按钮无从谈起，托盘提示兜底说明。
      if (showPrompt && !hot && !rt && !hasInstaller && !hasPlugins) {
        this.opts.notify(
          'DSH Desktop 有新版本',
          `${latest} 已发布，但当前设备暂无可用更新通道，请稍后再试。`,
        );
      }

      // 用户此前跳过过这个版本：横幅不出现，但手动检查时给一句轻量反馈，
      // 让用户知道检查是成功的、更新存在但被自己跳过了。
      if (interactive && skipped && !mandatory) {
        this.opts.notify(
          '检查更新',
          `${latest} 可用，但你此前选择跳过此版本（下一个版本会正常提示）。`,
        );
      }

      if (this.config.autoDownload) {
        void this.applyUpdate({ interactive: false });
      } else if (!skipped && !pluginsOnly) {
        // 仅插件待装时不发"有新版本"气泡：插件在后台静默装，装完托盘会提示重启
        this.opts.notify(
          'DSH Desktop 有新版本',
          downgrade && (hot || rt)
            ? `可回滚到稳定版 ${latest}（外壳 + 运行时一并回滚，热更新重启即生效）。`
            : !shellOutdated && rt
              ? `Harness 运行时 ${rt.version} 已发布，重启即可生效（托盘菜单可立即应用）。`
              : hot
                ? `${latest} 已发布，热更新只需重启即可生效（托盘菜单可立即安装）。`
                : `${latest} 已发布，点击托盘菜单「检查更新」即可安装。`,
        );
      }

      return this.getState();
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      log(`检查更新失败：${message}`);
      this.setState({ phase: 'error', message: `检查更新失败：${message}`, prompt: null });
      return this.getState();
    } finally {
      this.checkBusy = false;
    }
  }

  /**
   * 应用更新。
   *
   * mode:
   *   'auto'（默认）— 云端给了可用的热更新包就走热更新（重启即生效），否则走完整安装包
   *   'hot'         — 强制热更新（没有可用热更新包就报错）
   *   'installer'   — 强制完整安装包
   */
  async applyUpdate(options: {
    interactive: boolean;
    mode?: 'auto' | 'hot' | 'installer' | 'runtime';
  }): Promise<void> {
    if (this.applyBusy) {
      log('已有更新任务在进行中，忽略本次请求');
      return;
    }
    this.applyBusy = true;
    try {
      const feed = await this.fetchFeed();
      const mode = options.mode ?? 'auto';

      // 强制通道：只做那一件事
      if (mode === 'hot') {
        const hot = this.pickHot(feed);
        if (!hot) throw new Error('云端没有可用的热更新包（或它的 baseVersion 与当前安装版不匹配）');
        const v = await this.stageHot(hot, hot.version || feed.version);
        await this.finalizeStaged(options.interactive, [`热更新 ${v}`]);
        return;
      }
      if (mode === 'runtime') {
        const rt = this.pickRuntime(feed);
        if (!rt) throw new Error('云端没有可用的运行时补丁（或它的基线版本与当前运行时不匹配）');
        const v = await this.stageRuntime(rt);
        await this.finalizeStaged(options.interactive, [`运行时 ${v}`]);
        return;
      }
      if (mode === 'installer') {
        await this.applyInstaller(feed, options.interactive);
        return;
      }

      // auto：能热更的都热更（外壳 + 运行时可以一起落位，重启一次同时生效）
        const hot = this.pickHot(feed);
        const rt = this.pickRuntime(feed);
        const plugins = this.pickPlugins(feed);
        if (!hot && !rt && plugins.length === 0) {
          await this.applyInstaller(feed, options.interactive);
          return;
        }
        const labels: string[] = [];
        if (hot) labels.push(`热更新 ${await this.stageHot(hot, hot.version || feed.version)}`);
        if (rt) labels.push(`运行时 ${await this.stageRuntime(rt)}`);
        // 插件属于"新增能力"，不必让用户决策，自动落位后随其它更新一起提示重启。
        // 逐个独立 try：一个插件失败不该拖垮其它插件或外壳/运行时的落位。
        for (const plugin of plugins) {
          const label = plugin.name ?? plugin.version;
          try {
            await this.stagePlugins(plugin);
            labels.push(`插件 ${label}`);
          } catch (err) {
            log(`插件 ${label} 安装失败（不阻断其它更新）：${String((err as Error)?.message ?? err)}`);
          }
        }
        await this.finalizeStaged(options.interactive, labels);
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      log(`更新失败：${message}`);
      this.setState({ phase: 'error', message: `更新失败：${message}` });
    } finally {
      this.applyBusy = false;
    }
  }

  /** 兼容旧调用名 */
  async downloadAndInstall(options: { interactive: boolean }): Promise<void> {
    return this.applyUpdate(options);
  }

  /**
   * 挑出可用的热更新包（OTA 式）：
   *   - `hot` 可以是单个包或升级链（数组）
   *   - baseVersion 当作**最低**支持版本：`app.getVersion() >= baseVersion` 就可用
   *   - 在所有能用的里面挑**版本号最高**的 → 客户端每次都能直接爬到最新，
   *     发版时也不用再为每个旧版本单独配基线
   */
  private pickHot(feed: UpdateFeed): HotUpdateInfo | null {
    if (this.config?.disableHotUpdate) return null;
    const all = asArray(feed.hot).filter((h) => h?.url && h?.version);
    if (all.length === 0) return null;

    const installed = app.getVersion();
    const usable = all.filter((h) => !h.baseVersion || compareVersions(installed, h.baseVersion) >= 0);
    if (usable.length === 0) {
      const floors = all.map((h) => `${h.version}(需≥${h.baseVersion})`).join('、');
      log(`热更新包都不适用当前安装版 ${installed}：${floors} → 改用完整安装包`);
      return null;
    }

    // 能用的里面挑版本最高的；同版本（多档变体）挑 **baseVersion 最高**的那个 ——
    // 也就是「与当前安装版最贴近」的变体。别依赖 feed 数组顺序：老引导器
    // （resolveHotShell 1.1.13 版）按 baseVersion === 安装版 **严格相等**选壳，
    // 挑中 baseVersion 过低的变体会被引导器拒收、重启后仍是旧壳（实测踩过）。
    usable.sort((a, b) => {
      const v = compareVersions(b.version, a.version);
      if (v !== 0) return v;
      return compareVersions(b.baseVersion ?? '0', a.baseVersion ?? '0');
    });
    const best = usable[0];
    if (all.length > 1) log(`热更新升级链里有 ${all.length} 档，当前安装版 ${installed} 可跳到 ${best.version}`);
    return best;
  }

  /**
   * 当前实际在用的运行时目录。
   * 统一走 `findRuntimeDir()`，别再用 `dshRuntimeDir()`（打包态它指向用户数据目录的兜底位置）。
   */
  private currentRuntimeDir(): string {
    return findRuntimeDir();
  }

  /**
   * 挑出需要安装/更新的插件包。
   *
   * 为什么需要这条通道：热更新只换 `out/`（外壳代码），**不包含 resources/**，
   * 所以随包内置在 `resources/dsh-plugins/` 的新插件**到不了已安装的用户**。
   * 插件只能单独下载到用户数据目录（`plugins/`），再由 plugin-installer 落位。
   */
  private pickPlugins(feed: UpdateFeed): PluginsUpdateInfo[] {
    const out: PluginsUpdateInfo[] = [];
    // 一次可挂多个插件包（feed.plugins 为数组）；老 feed 的单对象写法照旧支持。
    for (const info of asArray(feed.plugins)) {
      if (!info?.url && !(info?.parts && info.parts.length)) continue;

      // 判定「已安装」**只认 profile 落位**（profiles/node_modules/<name>）：
      // 用户数据目录里可能有历史残留（如解压到一半的 staging 里有带 package.json 的
      // 半成品），扫那里会把残缺目录误判成"已装好"→ 永远不再安装（实测踩过）。
      //
      // name 可能是独立字段，也可能合并在 version 里（"@scope/pkg@1.2.3"）——
      // gen-update-json 目前只发合并格式，所以要从 lastIndexOf('@') 拆出来。
      const raw = String(info.version ?? '');
      const at = raw.lastIndexOf('@');
      const name = info.name ?? (at > 0 ? raw.slice(0, at) : '');
      const expectedVersion = at > 0 ? raw.slice(at + 1) : raw;
      if (name) {
        const landed = path.join(profilesModulesDir(), ...name.split('/'), 'package.json');
        try {
          const pkg = JSON.parse(fs.readFileSync(landed, 'utf8'));
          if (String(pkg.version) === String(expectedVersion)) {
            log(`插件 ${name} 已落位且版本一致（${pkg.version}）`);
            continue;
          }
          log(`插件 ${name} profile 版本 ${pkg.version} → 需要 ${expectedVersion}`);
        } catch {
          log(`插件 ${name} 未落位到 profile，准备下载安装`);
        }
        out.push(info);
        continue;
      }

      // 连 name 都解析不出来（异常 feed）：保守起见视为需要安装
      log(`插件包待安装：${raw}`);
      out.push(info);
    }
    return out;
  }

  /** 挑出可用的运行时差分补丁（dsh 本体升级，重启时套用） */
  private pickRuntime(feed: UpdateFeed): RuntimeUpdateInfo | null {
    const all = asArray(feed.runtime).filter((r) => r?.url && r?.version);
    // 找运行时目录：必须用**实际在用**的那个。
    // 顺序：安装目录 → 用户数据目录解开的 → dshRuntimeDir() → 开发态
    const candidates = [this.currentRuntimeDir()];
    let cur: string | null = null;
    let curDir = '';
    for (const dir of candidates) {
      const v = runtimeVersionOf(dir);
      if (v) {
        cur = v;
        curDir = dir;
        break;
      }
    }
    if (cur) this.setState({ runtimeVersion: cur });
    if (all.length === 0) return null;
    if (!cur) {
      log(
        `读不到当前运行时版本，跳过运行时更新（找过：${candidates.join('、')}）`,
      );
      return null;
    }
    // 先找「以当前版本为基线」的补丁——**精确匹配，不看升降方向**：
    // 升级链（rc.1→rc.2→…）靠它爬档；降级链（beta 的 0.1.7-rc.2 → stable 的
    // 0.1.5-rc.3）也靠它命中。通道回滚就是往 stable feed 挂这种补丁。
    // 注意顺序：不能先做「已是最新」拦截——降级链的目标版本比当前低，会被误拦。
    const step = all.find((r) => r.baseVersion === cur);
    if (!step) {
      // 没有以当前版本为基线的补丁，且已比链里所有目标版本都新 → 不用升
      const newest = [...all].sort((a, b) => compareVersions(b.version, a.version))[0];
      if (compareVersions(cur, newest.version) >= 0) {
        log(`运行时已是最新（${cur}）`);
        return null;
      }
      log(
        `运行时升级链里没有以当前版本 ${cur}（${curDir}）为基线的补丁` +
          `（链上基线：${all.map((r) => r.baseVersion ?? '?').join('、')}）→ 需要完整安装包或补一档补丁`,
      );
      return null;
    }
    // Electron 指纹守卫：新 dsh 的 require-builtin 只认白名单里的 Electron 构建
    const mine = process.versions.electron || '';
    if (step.requiresElectron?.length && !step.requiresElectron.includes(mine)) {
      log(
        `运行时补丁 ${step.version} 要求 Electron ${step.requiresElectron.join(' / ')}，` +
          `当前 ${mine || '?'}，跳过（避免下载后 dsh 拒绝启动）`,
      );
      return null;
    }
    return step;
  }

  // -------------------------------------------------------------------------
  // 通道一：热更新壳（下载新壳代码 → 重启即生效）
  // -------------------------------------------------------------------------

  /** 只负责「下载 + 落位」，什么时候重启交给 finalizeStaged */
  private async stageHot(hot: HotUpdateInfo, version: string): Promise<string> {
    if (this.state.hotReady && this.state.hotVersion === version) {
      log(`热更新壳 ${version} 此前已就绪，跳过下载`);
      return version;
    }
    const target = await this.download(version, hot, `hot-${version}.tar`);
    this.setState({ phase: 'downloading', percent: 99, viaHot: true, message: '正在解压热更新包…' });
    const staging = hotStagingDir(version);
    await extractHotPackage(target, staging);
    ensureHotManifest(staging, { ...hot, version }, app.getVersion());

    const info = installHotShell(staging);
    this.setState({
      phase: 'downloaded',
      percent: 100,
      viaHot: true,
      hotReady: true,
      hotVersion: info.version,
      setupPath: target,
      message: `热更新 ${info.version} 已就绪，重启即生效`,
    });
    log(`热更新壳 ${info.version} 已就位（重启生效）→ ${info.dir}`);
    return info.version;
  }

  // -------------------------------------------------------------------------
  // 通道二：运行时差分补丁（dsh 本体升级 → 重启时套用）
  // -------------------------------------------------------------------------

  private async stageRuntime(rt: RuntimeUpdateInfo): Promise<string> {
    const version = rt.version;
    if (this.state.runtimeReady && this.state.runtimeTarget === version) {
      log(`运行时补丁 ${version} 此前已就绪，跳过下载`);
      return version;
    }
    const target = await this.downloadWithParts(
      version,
      rt,
      `dsh-runtime-patch-${version}.tar.gz`,
    );
    this.setState({
      phase: 'downloading',
      percent: 99,
      runtimeTarget: version,
      message: '正在解压运行时补丁…',
    });

    const dir = path.join(updatesDir(), `runtime-patch-${version}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await extractRuntimePatch(target, dir);

    const manifest = readManifest(dir);
    const cur = runtimeVersionOf(this.currentRuntimeDir()) ?? '';
    if (manifest.baseVersion !== cur) {
      throw new Error(`补丁基线 ${manifest.baseVersion} 与当前运行时 ${cur} 不一致，已放弃`);
    }
    writePendingPatch({
      version: manifest.version,
      baseVersion: manifest.baseVersion,
      dir,
      url: rt.url,
      at: Date.now(),
    });
    this.setState({
      phase: 'downloaded',
      percent: 100,
      runtimeReady: true,
      runtimeTarget: manifest.version,
      message: `运行时 ${manifest.version} 已就绪，重启时套用`,
    });
    log(
      `运行时补丁 ${manifest.version} 已就绪（重启时套用）：覆盖 ${manifest.files.length} 个文件、删除 ${manifest.deletes.length} 个`,
    );
    return manifest.version;
  }

  /** 所有通道都落位完，统一决定「什么时候重启」 */
  private async finalizeStaged(interactive: boolean, labels: string[]): Promise<void> {
    const what = labels.filter(Boolean).join(' + ');

    // 只有显式打开 autoRestart（无人值守 / 企业批量部署）才自动重启
    if (this.config?.autoRestart) {
      log(`配置里打开了 autoRestart，直接重启以应用：${what}`);
      await this.restartToApply(this.state.hotVersion ?? this.state.runtimeTarget ?? what);
      return;
    }

    // 1.1.21 起「更新已就绪」不再弹系统对话框：状态已置为 downloaded，
    // 应用内横幅（重启 / 稍后）+ 托盘静默提示由渲染端与 notify 承担。
    log(`更新已就绪：${what}${interactive ? '' : '（后台检查）'}`);
    this.opts.notify(
      '更新已就绪',
      `${what} 已下载完成。重启应用（几秒）即可生效，也可以下次启动时自动生效。`,
    );
  }

  /**
   * 后台静默安装插件：不打扰、不弹窗、不阻塞检查流程。
   * 插件是"新增能力"，没必要让用户决策；装完只把状态置为「已就绪，重启生效」。
   */
  private installPluginsQuietly(infos: PluginsUpdateInfo[]): void {
    if (infos.length === 0) return;
    void (async () => {
      const done: string[] = [];
      const failed: string[] = [];
      for (const info of infos) {
        const label = info.name ?? info.version;
        try {
          await this.stagePlugins(info);
          done.push(label);
          log(`插件 ${label} 已静默安装完成，等待重启生效`);
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          failed.push(`${label}（${msg}）`);
          log(`插件 ${label} 安装失败（不影响其它插件）：${msg}`);
        }
      }
      // 关键：无论成败都要把状态收敛，否则托盘会永远停在"正在下载 99%"
      this.setState({
        phase: done.length > 0 ? 'downloaded' : 'error',
        percent: done.length > 0 ? 100 : 0,
        pluginsReady: done.length > 0,
        pluginsTarget: done.length > 0 ? done.join('、') : undefined,
        message:
          done.length > 0
            ? '新插件已就绪，重启应用后生效'
            : `插件安装失败：${failed.join('；')}`,
      });
    })();
  }

  /**
   * 下载插件包并落到用户数据目录（`%APPDATA%\DSH-Desktop\plugins/`）。
   * 落位后由 plugin-installer 在**下次启动**时复制到 profiles/node_modules → dsh 加载。
   */
  private async stagePlugins(info: PluginsUpdateInfo): Promise<void> {
    // 暂存目录**必须放在 plugins 之外**：plugin-installer 会把 plugins 下每个子目录
    // 当插件扫描（没有 package.json 的会兜底成一个错误包名），残留的 staging 会被误装。
    const target = path.join(updatesDir(), 'plugins-staging');
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });

    const downloaded = await this.downloadWithParts(
      info.version,
      info as UpdateFileInfo,
      `plugins-${String(info.version).replace(/[^\w.-]+/g, '_')}.tar.gz`,
    );

    this.setState({ phase: 'downloading', percent: 99, message: '正在解压插件包…' });
    await extractTarGz(downloaded, target);

    // 解出来应该是一个（或几个）插件目录：逐个搬到 plugins/<目录名>
    // 关键：**先确保 plugins/ 存在**——renameSync 不会自动建父目录，
    // 全新机器上 plugins/ 不存在时 rename 会 ENOENT（实测踩过：本机有这目录
    // 所以永远复现不了，用户机器上没有）。
    fs.mkdirSync(userPluginsDir(), { recursive: true });
    const entries = fs.readdirSync(target, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const from = path.join(target, e.name);
      const to = path.join(userPluginsDir(), e.name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(from, to);
      log(`插件已落位：${to}`);
    }
    fs.rmSync(target, { recursive: true, force: true });

    // 清理 plugins/ 下的垃圾：没有 package.json 的目录不可能是插件
    //（一般是历史版本解压中断留下的残留，如 staging/）
    try {
      for (const e of fs.readdirSync(userPluginsDir(), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = path.join(userPluginsDir(), e.name);
        if (!fs.existsSync(path.join(dir, 'package.json'))) {
          fs.rmSync(dir, { recursive: true, force: true });
          log(`清理非插件残留目录：${dir}`);
        }
      }
    } catch {
      /* 清理失败不阻断 */
    }

    this.setState({
      phase: 'downloaded',
      percent: 100,
      pluginsReady: true,
      message: '新插件已就绪，重启应用后生效',
    });
  }

  /** 手动「立即应用」入口（托盘菜单） */
  async applyStagedNow(): Promise<void> {
    const what = [this.state.hotReady ? `热更新 ${this.state.hotVersion ?? ''}` : '', this.state.runtimeReady ? `运行时 ${this.state.runtimeTarget ?? ''}` : '']
      .filter(Boolean)
      .join(' + ');
    this.cancelScheduledRestart(true);
    log(`重启应用以应用：${what || '已就绪的更新'}`);
    await this.restartToApply(what || '更新');
  }

  /**
   * 计划 N 秒后重启应用（期间可在托盘菜单取消）。
   * 用于「N 分钟后自动重启」这个选项 —— 给用户留出保存工作的时间。
   */
  scheduleRestartAfter(seconds: number): void {
    this.cancelScheduledRestart(true);
    this.pendingRestartAt = Date.now() + seconds * 1000;
    log(`已计划 ${seconds}s 后重启以应用热更新（可在托盘取消）`);

    this.restartTimer = setTimeout(() => {
      void this.restartToApply(this.state.hotVersion ?? '热更新');
    }, seconds * 1000);
    this.restartTimer.unref?.();

    this.tickTimer = setInterval(() => this.emitRestartCountdown(), 1000);
    this.tickTimer.unref?.();
    this.emitRestartCountdown();
  }

  /** 取消计划中的重启（用户改主意了） */
  cancelScheduledRestart(silent = false): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.pendingRestartAt) {
      this.pendingRestartAt = null;
      if (!silent) {
        log('已取消计划中的重启');
        this.opts.notify('已取消自动重启', '热更新仍然就绪，你可以随时从托盘菜单重启应用。');
      }
      this.setState({
        restartAt: undefined,
        restartIn: undefined,
        message: this.state.hotReady
          ? `热更新 ${this.state.hotVersion ?? ''} 已就绪（重启生效）`
          : this.state.message,
      });
    }
  }

  /** 立刻重启并应用已就绪的更新（托盘菜单入口） */
  async restartNow(reason = '手动应用更新'): Promise<void> {
    this.cancelScheduledRestart(true);
    log(`重启应用：${reason}`);
    await this.restartToApply(
      this.state.hotVersion ?? this.state.runtimeTarget ?? '更新',
    );
  }

  private emitRestartCountdown(): void {
    if (!this.pendingRestartAt) return;
    const left = Math.max(0, Math.ceil((this.pendingRestartAt - Date.now()) / 1000));
    this.setState({
      restartAt: this.pendingRestartAt,
      restartIn: left,
      message: `将在 ${left} 秒后重启以应用热更新（托盘可取消）`,
    });
  }

  private async restartToApply(version: string): Promise<void> {
    this.setState({
      phase: 'applying',
      viaHot: this.state.hotReady,
      hotReady: this.state.hotReady,
      message: `正在重启以应用 ${version}…`,
    });
    this.persisted.lastInstallAt = Date.now();
    writePersisted(this.persisted);

    if (process.env.DSH_DESKTOP_UPDATE_DRYRUN === '1') {
      log(`试运行：跳过重启（本应重启以应用热更新 ${version}）`);
      this.setState({ phase: 'downloaded', message: '试运行：热更新壳已落位，未重启' });
      return;
    }

    await this.opts.onBeforeInstall();
    // 稍微延迟一点，让托盘/服务收尾完成
    setTimeout(() => this.opts.onRestart(), 600);
  }

  // -------------------------------------------------------------------------
  // 通道二：完整安装包（静默覆盖安装）
  // -------------------------------------------------------------------------

  private async applyInstaller(feed: UpdateFeed, interactive: boolean): Promise<void> {
    if (this.downloadedFilePath && fs.existsSync(this.downloadedFilePath)) {
      await this.applyDownloaded(interactive);
      return;
    }
    const file = pickFileForThisMachine(feed);
    if (!file) {
      // 两种情况分开说：feed 压根没挂安装包（空骨架设计态）vs 挂了但没有
      // 适配本机平台/架构的条目——混成一句话会让排查走错方向。
      const mounted = !!(feed.url || (feed.files && Object.keys(feed.files).length > 0));
      throw new Error(
        mounted
          ? '云端 JSON 里没有适配当前平台/架构的安装包'
          : '该版本未在更新源挂载安装包，请从发布页手动下载安装',
      );
    }

    const target = await this.download(feed.version, file);
    this.downloadedFilePath = target;
    this.downloadedVersion = feed.version;
    this.setState({
      phase: 'downloaded',
      percent: 100,
      setupPath: target,
      message: `已下载 ${feed.version}`,
    });
    await this.applyDownloaded(interactive);
  }

  private async applyDownloaded(interactive: boolean): Promise<void> {
    const setup = this.downloadedFilePath;
    const version = this.downloadedVersion ?? this.state.latestVersion ?? '新版本';
    if (!setup) throw new Error('尚未下载安装包');

    // 1.1.21 起「要现在安装吗」由应用内横幅（phase=downloaded + setupPath）承担；
    // 稍后 → 托盘静默提示，随时可从托盘菜单/横幅安装。
    if (interactive) {
      this.opts.notify('安装包已就绪', `${version} 已下载，可随时在应用内或托盘菜单里安装。`);
    }

    this.setState({ phase: 'applying', message: '正在关闭应用并安装更新…' });
    this.persisted.lastInstallAt = Date.now();
    writePersisted(this.persisted);

    const dir = installedAppDir();

    // 试运行：只验证「下载 + 校验 + 参数拼装」，不真的执行安装程序。
    // 用于联调更新源 / 排障：DSH_DESKTOP_UPDATE_DRYRUN=1
    if (process.env.DSH_DESKTOP_UPDATE_DRYRUN === '1') {
      const args = ['/S', `/D=${dir}`].join(' ');
      log(`试运行：跳过安装，命令行本应为 "${setup}" ${args}`);
      this.setState({
        phase: 'downloaded',
        setupPath: setup,
        message: '试运行：安装包已下载并通过校验，未执行安装',
      });
      return;
    }

    // 先释放文件占用（停 dsh 子进程、销毁托盘），再拉起安装包，
    // 否则安装程序无法覆盖被运行中进程锁住的 exe。
    await this.opts.onBeforeInstall();

    // windowsVerbatimArguments：/D= 的路径不能加引号（NSIS 规定），即使含空格。
    // 安装器侧已把 isForceRun 打开，所以 /S 静默装完会自动重启应用。
    const child = spawn(setup, ['/S', `/D=${dir}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.unref();
    log(`已启动更新安装程序：${setup} /S /D=${dir}`);

    // 给安装程序一点时间起来，再退出本进程
    setTimeout(() => this.opts.onExit(), 1200);
  }

  // -------------------------------------------------------------------------
  // 网络
  // -------------------------------------------------------------------------

  private async fetchFeed(): Promise<UpdateFeed> {
    // 网络层失败（超时/DNS/连接重置）自动重试一次——检查更新是最轻量的请求，
    // 重试成本可忽略，却能吸收掉高峰期的一次性抖动。HTTP/JSON 错误不重试（快速失败）。
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.fetchFeedOnce();
      } catch (err) {
        lastErr = err;
        const msg = String((err as Error)?.message ?? err);
        const networkLike = /timeout|abort|network|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket/i;
        if (attempt === 1 && networkLike.test(msg)) {
          log(`拉取更新源失败（${msg}），2s 后重试一次`);
          await new Promise((r) => setTimeout(r, 2_000));
          continue;
        }
        // 超时类错误给用户能看懂的文案（AbortSignal.timeout 的原始消息是英文天书）
        if (/timeout/i.test(msg)) {
          throw new Error('连接更新源超时（可能是网络波动或高峰期，请稍后重试）');
        }
        throw err;
      }
    }
    throw lastErr; // 理论不可达
  }

  private async fetchFeedOnce(): Promise<UpdateFeed> {
    if (!this.config) throw new Error('未配置更新源');
    const channel = this.getChannel();
    // 通道决定请求哪个 JSON（latest.json / latest-beta.json / latest-dev.json）
    const url = new URL(feedUrlForChannel(this.config.feedUrl, channel));
    // 带上渠道与当前版本，便于服务端分渠道/灰度下发（静态源会忽略这些参数）
    url.searchParams.set('platform', process.platform);
    url.searchParams.set('arch', process.arch);
    url.searchParams.set('version', app.getVersion());
    url.searchParams.set('channel', channel);

    const res = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`更新源返回 HTTP ${res.status}`);

    const text = await res.text();
    let feed: UpdateFeed;
    try {
      feed = JSON.parse(text) as UpdateFeed;
    } catch {
      throw new Error('更新源返回的不是合法 JSON');
    }
    if (!feed || typeof feed !== 'object') throw new Error('更新源返回内容为空');
    return feed;
  }

  /** 多连接下载的全局已收字节计数（downloadMulti 专用，同一时刻只有一个下载在跑） */
  private dlReceived = 0;

  /** 下载速度采样状态：EMA 平滑，同一 version 内累积，换版本自动重置 */
  private speedVersion = '';
  private speedSampleAt = 0;
  private speedSampleBytes = 0;
  private speedEma = 0;

  /**
   * 实时下载速度（字节/秒）：EMA 平滑（新样本权重 0.4），起步直接取首个瞬时值。
   *
   * 两个刻意的保护：
   *  - 采样间隔 <500ms 不更新：回调本身 300ms 节流一次，太密算出来的全是噪声；
   *  - 只有字节增量 > 0 才更新 EMA：分片重试会把 dlReceived 回退（实测见 downloadMulti），
   *    负增量混进 EMA 会把速度拖成 0 甚至负数。
   */
  private speedOf(version: string, received: number): number {
    const now = Date.now();
    if (this.speedVersion !== version) {
      this.speedVersion = version;
      this.speedSampleAt = 0;
      this.speedSampleBytes = 0;
      this.speedEma = 0;
    }
    if (this.speedSampleAt === 0) {
      this.speedSampleAt = now;
      this.speedSampleBytes = received;
      return 0;
    }
    const dt = now - this.speedSampleAt;
    if (dt < 500) return this.speedEma;
    const db = received - this.speedSampleBytes;
    this.speedSampleAt = now;
    this.speedSampleBytes = received;
    if (db > 0) {
      const inst = (db / dt) * 1000;
      this.speedEma = this.speedEma > 0 ? this.speedEma * 0.6 + inst * 0.4 : inst;
    }
    return this.speedEma;
  }

  /** 下载进度上报。
   *  - 无 onProgress：直接 setState（base/span 把本文件进度映射进整体区间，300ms 节流）；
   *  - 有 onProgress：转发给调用方（分片并发时由 downloadWithParts 聚合，节流在聚合层做）。 */
  private reportDownloadProgress(
    version: string,
    received: number,
    total: number,
    st: { lastReport: number },
    progress?: { base?: number; span?: number; onProgress?: (received: number, total: number) => void },
  ): void {
    if (progress?.onProgress) {
      progress.onProgress(received, total);
      return;
    }
    const now = Date.now();
    if (now - st.lastReport < 300) return;
    st.lastReport = now;
    // total 未知时没有可计算的百分比 —— 调用方应尽量先探测出大小（见 download 的 HEAD 兜底），
    // 否则进度条只能一直停在 base（实测踩过：分片没给 size、更新源又不支持 Range → 永远 0%）。
    const base = progress?.base ?? 0;
    const span = progress?.span ?? 100;
    const frac = total > 0 ? Math.min(1, received / total) : 0;
    const percent = Math.min(99, Math.round(base + frac * span));
    const speed = this.speedOf(version, received);
    this.setState({
      phase: 'downloading',
      percent,
      speed,
      message: `正在下载 ${version}… ${percent}%${speed > 0 ? `（${fmtSpeed(speed)}）` : ''}`,
    });
  }

  /**
   * 下载入口（GitHub 加速融合层）：
   *  - 对 GitHub Releases 直链：先竞速探测全部镜像（自建 + 公共），最先通过者胜出；
   *    镜像整包下载失败 → 回退 GitHub 直连再试一轮（镜像可能中途挂，直连是最终兜底）。
   *  - 其它 URL（Pages 本站、热更包、分片）：零开销直通。
   * 真正的下载/分片/续传/校验逻辑全在 downloadVia，本层只管「选哪条路下载」。
   */
  private async download(
    version: string,
    file: UpdateFileInfo,
    fileName?: string,
    progress?: { base?: number; span?: number; onProgress?: (received: number, total: number) => void },
  ): Promise<string> {
    const { origin, mirrors } = expandDownloadCandidates(file.url);
    if (!mirrors.length) return this.downloadVia(version, file, fileName, progress);
    const accelerated = await this.pickAcceleratedUrl(file, origin, mirrors);
    try {
      return await this.downloadVia(version, accelerated, fileName, progress);
    } catch (err) {
      if (accelerated.url === origin) throw err; // 兜底直连本身失败，没有退路
      log(`镜像下载失败（${(err as Error).message}），回退 GitHub 直连重试`);
      // 注意兜底 url 用剥好的 origin 原链，而不是 file.url——feed 里可能挂的就是镜像前缀
      return this.downloadVia(version, { ...file, url: origin }, fileName, progress);
    }
  }

  /**
   * 竞速探测：与全部镜像同时发探测请求，最先通过（206 总长吻合 / 200 全量）的镜像胜出；
   * 全部失败 → 回原链 origin（file 元数据原样保留）。expectSize 未知的文件放行 206
   * （总长交给哈希校验兜底）。
   */
  private async pickAcceleratedUrl(
    file: UpdateFileInfo,
    origin: string,
    mirrors: Array<{ url: string; label: string }>,
  ): Promise<UpdateFileInfo> {
    const expect = file.size || 0;
    log(`GitHub 下载加速：${mirrors.length} 个镜像竞速探测中…`);
    return new Promise((resolve) => {
      let pending = mirrors.length;
      let settled = false;
      for (const m of mirrors) {
        this.probeCandidateOk(m.url, expect)
          .then((ok) => {
            if (!settled && ok) {
              settled = true;
              log(`加速镜像选定：${m.label}（${new URL(m.url).host}）`);
              resolve({ ...file, url: m.url });
            }
          })
          .catch(() => {
            /* 探测失败按不可用处理 */
          })
          .finally(() => {
            if (--pending === 0 && !settled) {
              settled = true;
              log('镜像全部不可用，回退 GitHub 直连');
              resolve({ ...file, url: origin });
            }
          });
      }
    });
  }

  /** 单个候选可用性探测：Range 0-0 必须 206 且总长吻合；200 全量也算可用（回退单流路径） */
  private async probeCandidateOk(url: string, expectSize: number): Promise<boolean> {
    try {
      const res = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(MIRROR_PROBE_TIMEOUT_MS),
      });
      try {
        await res.arrayBuffer();
      } catch {
        /* 读掉 body 便于连接复用 */
      }
      if (res.status === 206) {
        const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
        return expectSize <= 0 || (!!m && Number(m[1]) === expectSize);
      }
      if (res.status === 200) {
        const len = Number(res.headers.get('content-length') || 0);
        return len > 0 && (expectSize <= 0 || len === expectSize);
      }
      return false;
    } catch {
      return false;
    }
  }

  /** 实际下载（探测 Range / 断点续传 / 多连接分片 / 单流回退 / 哈希校验） */
  private async downloadVia(
    version: string,
    file: UpdateFileInfo,
    fileName?: string,
    progress?: { base?: number; span?: number; onProgress?: (received: number, total: number) => void },
  ): Promise<string> {
    const base = progress?.base ?? 0;
    const dir = updatesDir();
    fs.mkdirSync(dir, { recursive: true });

    const name =
      fileName ||
      decodeURIComponent(path.basename(new URL(file.url).pathname)) ||
      `DSH-Desktop-Setup-${version}.exe`;
    const finalPath = path.join(dir, name);
    const partPath = `${finalPath}.part`;

    // 并发分片（onProgress）时进度条归聚合层管，这里只更新文案、别抢 percent
    this.setState({
      phase: 'downloading',
      ...(progress?.onProgress ? {} : { percent: base }),
      message: `正在下载 ${version}…`,
    });
    log(`开始下载更新：${file.url}`);

    // 探测：服务器是否支持 Range（206）+ 真实大小。1 字节请求，成本一次 RTT；
    // 支持 Range 且文件 ≥ 1MB 才值得开多连接，其余走单流。
    let total = file.size || 0;
    let rangeOK = false;
    try {
      const probe = await fetch(file.url, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      try {
        await probe.arrayBuffer();
      } catch {
        /* ignore */
      }
      if (probe.status === 206) {
        rangeOK = true;
        const m = /\/(\d+)\s*$/.exec(probe.headers.get('content-range') ?? '');
        if (m) total = Number(m[1]) || total;
      }
    } catch (err) {
      log(`Range 探测失败（${(err as Error).message}），走单流下载`);
    }
    // 大小还未知（JSON 没给 size 且 Range 探测没拿到）→ HEAD 补一发拿 content-length。
    // 本更新源（dl.666-xrc.cc.cd）实测对 Range 回 200 全量，分片下载全靠这一步拿 total，
    // 否则单流下载没有进度可言（实测踩过：分片下载永远 0%）。
    if (!total) {
      try {
        const head = await fetch(file.url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const len = Number(head.headers.get('content-length') || 0);
        if (head.ok && Number.isFinite(len) && len > 0) {
          total = len;
          log(`HEAD 探测大小：${(len / 1024 / 1024).toFixed(1)} MB`);
        }
      } catch {
        /* ignore：拿不到就只下载不报进度 */
      }
    }

    // 断点续传：本地已有同名产物且校验（或大小）吻合 → 直接复用。
    // 分片下载被打断后重开应用，已完成的片不再从头下载（实测踩过：一片卡死，
    // 重启后 4 片全部重来，141MB 又下一遍）。
    if (fs.existsSync(finalPath)) {
      let reusable = false;
      try {
        await this.verifyDownloaded(finalPath, file);
        reusable = !!file.sha256 || !!(total && fs.statSync(finalPath).size === total);
      } catch {
        /* 校验失败：verifyDownloaded 已把坏文件删了 */
      }
      if (reusable) {
        log(`本地已有完整文件，跳过下载：${name}`);
        return finalPath;
      }
      try {
        fs.rmSync(finalPath, { force: true });
      } catch {
        /* ignore */
      }
    }

    try {
      if (rangeOK && total >= 1024 * 1024) {
        await this.downloadMulti(version, file, partPath, total, progress);
      } else {
        await this.downloadSingle(version, file, partPath, total, progress);
      }
    } catch (err) {
      // 多连接分片重试 3 轮仍失败（高峰期丢包/限速）→ 回退单流整包，别让更新卡死
      if (rangeOK && total >= 1024 * 1024) {
        log(`多连接下载失败（${(err as Error).message}），回退单流整包`);
        try {
          fs.rmSync(partPath, { force: true });
        } catch {
          /* ignore */
        }
        this.setState({
          phase: 'downloading',
          percent: base,
          message: `多连接不稳，改用单流下载 ${version}…`,
        });
        await this.downloadSingle(version, file, partPath, total, progress);
      } else {
        throw err;
      }
    }

    // 统一校验（从磁盘读回，与下载方式无关）
    await this.verifyDownloaded(partPath, file);

    fs.rmSync(finalPath, { force: true });
    fs.renameSync(partPath, finalPath);
    const mb = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(1);
    log(
      `下载完成：${finalPath}（${mb} MB${file.sha256 ? `，sha256=${file.sha256.slice(0, 12)}…` : ''}）`,
    );
    return finalPath;
  }

  /**
   * 统一校验：从磁盘读回算 size / sha256（与下载方式无关，分片合并后也走这里）。
   * 失败就删掉残缺文件，避免下次误用。
   */
  private async verifyDownloaded(filePath: string, file: UpdateFileInfo): Promise<void> {
    const received = fs.statSync(filePath).size;
    if (file.size && received !== file.size) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* ignore */
      }
      throw new Error(`下载大小不符：期望 ${file.size}，实际 ${received}`);
    }
    if (!file.sha256) {
      log('提示：云端 JSON 未提供 sha256，已跳过完整性校验（建议补上）');
      return;
    }
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) {
      hash.update(chunk as Buffer);
    }
    const digest = hash.digest('hex');
    if (digest.toLowerCase() !== file.sha256.trim().toLowerCase()) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* ignore */
      }
      throw new Error(`下载校验失败（sha256 不匹配）：期望 ${file.sha256}，实际 ${digest}`);
    }
  }

  /**
   * 分片下载：云端 JSON 给了 `parts` 时**并发**下载（不分先后，按索引落位）、拼成整包再统一校验。
   *
   * 为什么需要它：免费静态托管单文件上限 25MB，而跨版本运行时补丁动辄上百 MB，
   * 不切片根本传不上去。分片名是**相对整包 URL 的同级文件名**（也允许写完整 URL）。
   *
   * 为什么分片级并发：本更新源对 Range 请求回 200 全量（不支持 206），
   * downloadMulti 的「单文件多连接」永远触发不了 → 多线程只能做在**分片之间**。
   * 每片仍是单流完整 GET，4 路并发；进度按「所有片已收字节 / 所有片总字节」聚合。
   */
  private async downloadWithParts(
    version: string,
    file: UpdateFileInfo,
    fileName: string,
  ): Promise<string> {
    const parts = (file.parts ?? []).filter((p) => !!p);
    if (!parts.length) return this.download(version, file, fileName);

    const dir = updatesDir();
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, fileName);

    const CONC = 4; // 并发分片数：4 路基本能打满家用带宽，也不至于把免费托管打疼
    const slots = parts.map(() => ({ received: 0, total: 0 }));
    const agg = { lastReport: 0, lastPercent: -1 };
    let done = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - agg.lastReport < 300) return;
      agg.lastReport = now;
      const received = slots.reduce((s, x) => s + x.received, 0);
      const total = slots.reduce((s, x) => s + x.total, 0);
      const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0;
      if (!force && percent === agg.lastPercent) return;
      agg.lastPercent = percent;
      const speed = this.speedOf(version, received);
      this.setState({
        phase: 'downloading',
        percent,
        speed,
        message: `正在下载 ${version}… ${percent}%（${done}/${parts.length} 片${speed > 0 ? `，${fmtSpeed(speed)}` : ''}）`,
      });
    };

    const chunks: string[] = new Array(parts.length);
    let cursor = 0;
    let aborted = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (aborted) return;
        const i = cursor++;
        if (i >= parts.length) return;
        const rel = parts[i];
        const url = /^https?:\/\//i.test(rel) ? rel : new URL(rel, file.url).href;
        const label = `${version}（${i + 1}/${parts.length}）`;
        const name = `${fileName}.part${String(i + 1).padStart(2, '0')}`;
        try {
          let chunk = '';
          for (let attempt = 1; attempt <= 3 && !chunk; attempt++) {
            try {
              chunk = await this.download(label, { url }, name, {
                onProgress: (received, total) => {
                  slots[i].received = received;
                  slots[i].total = total;
                  report();
                },
              });
            } catch (err) {
              if (attempt === 3) throw err;
              // 单片失败重试（配合断点续传，只重下没完成的片）
              log(`分片 ${i + 1} 第 ${attempt} 次下载失败（${(err as Error).message}），重试…`);
              await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
          }
          if (!chunk) throw new Error(`分片 ${i + 1} 三次下载均失败`);
          if (aborted) {
            try {
              fs.rmSync(chunk, { force: true });
            } catch {
              /* ignore */
            }
            return;
          }
          // 收尾计满（回调有 300ms 节流，最后一段字节可能没算进来）
          const sz = fs.statSync(chunk).size;
          slots[i] = { received: sz, total: sz };
          done += 1;
          chunks[i] = chunk;
          report();
        } catch (err) {
          aborted = true; // 一片失败就停：其它在途片下完即弃，不再起新片
          throw err;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(CONC, parts.length) }, () => worker()));

      log(`分片下载完成（${parts.length} 片），开始合并 → ${fileName}`);
      this.setState({
        phase: 'downloading',
        percent: 99,
        message: `正在合并 ${parts.length} 个分片…`,
      });
      const joined = `${finalPath}.join`;
      const ws = fs.createWriteStream(joined);
      for (const c of chunks) {
        await pipeline(fs.createReadStream(c), ws, { end: false });
      }
      await new Promise<void>((resolve, reject) => {
        ws.on('error', reject);
        ws.end(() => resolve());
      });
      await this.verifyDownloaded(joined, file);
      fs.rmSync(finalPath, { force: true });
      fs.renameSync(joined, finalPath);
    } finally {
      // 清分片：成功后清 chunk，失败后顺带清掉在途片的 .part 残留
      const prefix = `${path.basename(finalPath)}.part`;
      for (const c of chunks) {
        try {
          if (c) fs.rmSync(c, { force: true });
        } catch {
          /* ignore */
        }
      }
      try {
        for (const n of fs.readdirSync(dir)) {
          if (n.startsWith(prefix)) fs.rmSync(path.join(dir, n), { force: true });
        }
      } catch {
        /* ignore */
      }
    }
    const mb = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(1);
    log(`下载完成（分片合并）：${finalPath}（${mb} MB）`);
    return finalPath;
  }

  /** 单流下载（兜底路径）：小文件、或服务器不支持 Range 时使用 */
  private async downloadSingle(
    version: string,
    file: UpdateFileInfo,
    partPath: string,
    total: number,
    progress?: { base?: number; span?: number; onProgress?: (received: number, total: number) => void },
  ): Promise<void> {
    const res = await fetch(file.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);

    const st = { lastReport: 0 };
    let received = 0;
    // 停滞看门狗：45 秒一个字节都没来就判死（实测踩过：连接假死，
    // AbortSignal 只管握手不管中途停滞，一片能挂 13 个小时）
    const transform = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        received += chunk.length;
        watchdog?.refresh();
        this.reportDownloadProgress(version, received, total, st, progress);
        cb(null, chunk);
      },
    });
    const watchdog = setTimeout(
      () => transform.destroy(new Error('下载停滞（45 秒无数据）')),
      45_000,
    );
    try {
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        transform,
        fs.createWriteStream(partPath),
      );
    } finally {
      clearTimeout(watchdog);
    }
  }

  /**
   * 多连接分片下载（Range 并发）：Cloudflare 免费版在国内高峰期单流很慢，
   * 按 N 个连接并发拉分片、各自独立重试，聚合进度；写入用文件偏移（先 truncate 预分配）。
   * 任一分片重试 3 轮仍失败 → 抛给 download() 回退单流整包。
   */
  private async downloadMulti(
    version: string,
    file: UpdateFileInfo,
    partPath: string,
    total: number,
    progress?: { base?: number; span?: number; onProgress?: (received: number, total: number) => void },
  ): Promise<void> {
    const CHUNK_MIN = 512 * 1024;
    const MAX_CONN = 6;
    const count = Math.max(2, Math.min(MAX_CONN, Math.ceil(total / CHUNK_MIN)));
    const chunkSize = Math.ceil(total / count);
    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < count; i++) {
      ranges.push({ start: i * chunkSize, end: Math.min(total, (i + 1) * chunkSize) - 1 });
    }
    log(`多连接下载：${total} 字节分 ${count} 片并发`);

    this.dlReceived = 0;
    const st = { lastReport: 0 };
    const handle = await fs.promises.open(partPath, 'w');
    try {
      await handle.truncate(total); // 预分配，分片按偏移写入
      await Promise.all(
        ranges.map(async (r, i) => {
          let got = 0; // 本片已写字节（重试时归零重下整片）
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const res = await fetch(file.url, {
                headers: { Range: `bytes=${r.start + got}-${r.end}` },
                signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
              });
              if (res.status !== 206 || !res.body) {
                throw new Error(`分片 ${i + 1} 下载失败：HTTP ${res.status}`);
              }
              for await (const chunk of Readable.fromWeb(res.body as Parameters<
                typeof Readable.fromWeb
              >[0])) {
                const buf = chunk as Buffer;
                await handle.write(buf, 0, buf.length, r.start + got);
                got += buf.length;
                this.dlReceived += buf.length;
                this.reportDownloadProgress(version, this.dlReceived, total, st, progress);
              }
              if (r.start + got !== r.end + 1) {
                throw new Error(`分片 ${i + 1} 长度不齐：期望 ${r.end - r.start + 1}，实际 ${got}`);
              }
              return;
            } catch (err) {
              this.dlReceived -= got; // 回退本片已计进度
              got = 0;
              if (attempt === 3) throw err;
              log(`分片 ${i + 1}/${count} 失败（${(err as Error).message}），${attempt * 1.5}s 后重试`);
              await new Promise((r2) => setTimeout(r2, attempt * 1500));
            }
          }
        }),
      );
    } finally {
      await handle.close();
    }
  }

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  /**
   * 用户跳过某版本：持久化到 update-state.json，横幅随之收起（下次检查不再提示，
   * 强制更新除外）。IPC app:skip-update 调用；恢复方式是安装下一个版本。
   */
  skipUpdate(version: string): void {
    this.persisted.skippedVersion = String(version);
    writePersisted(this.persisted);
    log(`用户跳过版本 ${version}`);
    if (this.state.prompt?.version === String(version)) {
      this.setState({ prompt: null });
    }
  }

  private scheduleInterval(): void {
    if (this.timer) clearInterval(this.timer);
    const hours = this.config?.checkIntervalHours ?? 6;
    this.timer = setInterval(
      () => void this.check({ interactive: false }),
      Math.max(1, hours) * 3600_000,
    );
    this.timer.unref?.();
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    try {
      this.opts.onState(this.getState());
    } catch {
      /* 状态回调不能影响更新流程本身 */
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 选出适配当前平台/架构的安装包：优先 "win32-x64"，其次顶层 url */
export function pickFileForThisMachine(feed: UpdateFeed): UpdateFileInfo | null {
  const key = `${process.platform}-${process.arch}`;
  const files = feed.files ?? {};
  const candidate = files[key] ?? files[`${process.platform}`] ?? null;
  if (candidate?.url) return candidate;
  if (feed.url) return { url: feed.url, sha256: feed.sha256, size: feed.size };
  return null;
}

/**
 * 确保解压出来的热更新目录里有 hot-manifest.json。
 *
 * 正规流程由 `scripts/pack-hot.mjs` 打进包里；这里兜底：万一没带，
 * 就用云端 JSON 的信息 + 当前安装版版本补一个（方便手搓包与联调）。
 */
function ensureHotManifest(
  dir: string,
  hot: HotUpdateInfo,
  baseVersion: string,
): void {
  const file = path.join(dir, 'hot-manifest.json');
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string; baseVersion?: string };
      if (raw.version && raw.baseVersion) return;
    } catch {
      /* 内容坏了就重写 */
    }
  }
  const manifest = {
    version: hot.version,
    baseVersion: hot.baseVersion ?? baseVersion,
    sha256: hot.sha256,
    size: hot.size,
    source: hot.url,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
  log(`热更新包未带 hot-manifest.json，已按云端信息补写（${hot.version}）`);
}

function readPersisted(): PersistedState {
  try {
    return JSON.parse(fs.readFileSync(updateStateFile(), 'utf8')) as PersistedState;
  } catch {
    return {};
  }
}

function writePersisted(state: PersistedState): void {
  try {
    fs.writeFileSync(updateStateFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log(`写入更新状态失败：${String(err)}`);
  }
}
