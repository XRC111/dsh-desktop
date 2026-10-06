/**
 * 技能（skill）与 MCP 服务器管理 —— 宿主侧。
 *
 * ── 为什么要它 ──────────────────────────────────────────────────────────────
 * 这两样在 DSH 里都是**文件/配置驱动**的，没有界面：
 *
 *   · 技能：放在若干「技能根目录」下的 \`<name>/SKILL.md\`，靠 dsh-skill-filesystem
 *     扫描发现。用户要加一个技能，得自己知道该放哪个目录、frontmatter 怎么写。
 *   · MCP：是补丁层里的 \`- insert:\` 条目（name = @deepseek-ai/dsh-mcp-client），
 *     要手写 YAML，还要塞进 desktop-patch.yml —— 而那个文件会被热更新覆盖。
 *
 * 本模块把这两件事收敛成可读写的 JSON + 目录操作，界面只管调它。
 *
 * ── 存储位置（都在用户数据目录，热更新不会碰）──────────────────────────────
 *   技能：$DSH_HOME/skills/<name>/SKILL.md        ← dsh 的 user-dsh 根，天然被发现
 *   MCP ：$APPDATA/DSH-Desktop/mcp-servers.json   ← 本模块自己的文件
 *
 * MCP 为什么不直接写 desktop-patch.yml：那个文件是**仓库产物**，热更新会整份覆盖，
 * 用户配置会被抹掉。所以配置存自己的 JSON，启动时由 patch-guard 生成 YAML 追加进
 * 「生效补丁」（desktop-patch.effective.yml）。用户改的东西永远在 JSON 里。
 */
import * as fs from 'fs';
import * as path from 'path';
import { dshHomeDir, userDataDir } from './paths';
import { log } from './logger';

// ---------------------------------------------------------------------------
// 技能
// ---------------------------------------------------------------------------

/** 一个被发现的技能。 */
export interface SkillInfo {
  /** 技能名（目录名 / frontmatter 的 name） */
  name: string;
  description: string;
  /** SKILL.md 的绝对路径 */
  file: string;
  /** 所在根目录 */
  root: string;
  /** 来源标记：user-dsh / custom / project-* / bundled */
  source: string;
  /** 是否可被本模块删除（用户自己放的那些；bundled 与项目内的不动） */
  removable: boolean;
  /** 正文长度（字节），用于界面显示「有多大」 */
  bytes: number;
}

/** 用户级技能根：dsh 的 user-dsh 根，放这里一定被发现。 */
export function userSkillsDir(): string {
  return path.join(dshHomeDir(), 'skills');
}

/**
 * 把一个标量渲染成 YAML 值。
 *
 * 为什么自己写而不是引 js-yaml：本模块只生成**一种固定形状**的 YAML
 * （insert 数组 + 字符串/数字/字符串数组/字符串字典），引一个无类型的依赖
 * 只为这一处不划算。而这里的正确性要求很高 —— 转义错了 dsh 会直接起不来。
 *
 * 规则：能安全裸写的就裸写，否则用双引号并把需要转义的字符转掉。
 */
function yamlScalar(v: string | number | boolean): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  // 裸写安全：非空、首尾无空格、不含会改变结构的字符、不是 YAML 关键字
  const unsafe = /^[\s]|[\s]$/.test(s) ||
    /[:#\-?\[\]{},&*!|>'\"%@`\n\r\t]/.test(s) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /^[-+]?\d/.test(s) ||
    s === '';
  if (!unsafe) return s;
  // 双引号风格：转义 \\ 和 \"，换行/制表符转义序列
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return '"' + escaped + '"';
}

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 *
 * 只取 name / description —— 其余字段（allowed-tools 等）界面不展示也不该丢，
 * 所以**只读不改**，写回时整份保留。
 */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  // 只按行取 name / description —— 够用且不会因为 frontmatter 里其它字段的复杂语法而失败。
  // 注意 description 可能是多行块（| 或 >），那种情况只取首行（界面本来也显示不下）。
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (kv === null) continue;
    let value = kv[2].trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') value = '';
    // 去掉包裹的引号（单/双）
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    if (kv[1] === 'name') out.name = value;
    else out.description = value;
  }
  return out;
}

/** 扫一个根目录下的技能。容错：坏掉的条目跳过而不是整批失败。 */
function scanRoot(root: string, source: string, removable: boolean): SkillInfo[] {
  const out: SkillInfo[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const file = path.join(dir, 'SKILL.md');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // 没有 SKILL.md 就不是技能
    }
    const fm = parseFrontmatter(text);
    out.push({
      name: fm.name ?? e.name,
      description: fm.description ?? '',
      file,
      root,
      source,
      removable,
      bytes: Buffer.byteLength(text, 'utf8'),
    });
  }
  return out;
}

/**
 * 列出所有技能。
 *
 * 与 dsh-skill-filesystem 的根顺序保持一致（项目级优先），但这里**不做优先级去重** ——
 * 界面要让用户看见「同名技能在多个根里都存在」这种真实情况，去重会掩盖问题。
 */
export function listSkills(projectCwd?: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  // 用户级（可删）
  out.push(...scanRoot(userSkillsDir(), 'user-dsh', true));
  // 项目级（不可删：属于仓库内容）
  if (projectCwd) {
    out.push(...scanRoot(path.join(projectCwd, '.dsh', 'skills'), 'project-dsh', false));
    out.push(...scanRoot(path.join(projectCwd, '.agents', 'skills'), 'project-agents', false));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 校验技能名：必须是安全的目录名，防路径穿越。 */
function assertSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      '技能名只能用「小写字母、数字、连字符」，且以字母或数字开头（实际是目录名）：' + name,
    );
  }
}

/**
 * 新建一个技能（只建在用户级根目录）。
 *
 * 生成一份带 frontmatter 的模板 —— 空文件的话用户还得自己回忆格式，
 * 而 frontmatter 写错会导致技能被发现却描述为空（很难查）。
 */
export function createSkill(name: string, description: string): SkillInfo {
  assertSkillName(name);
  const dir = path.join(userSkillsDir(), name);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(dir)) throw new Error('同名技能已存在：' + name);
  fs.mkdirSync(dir, { recursive: true });
  const body = [
    '---',
    'name: ' + name,
    'description: ' + (description || '（在这里写一句话说明这个技能做什么、什么时候该用）'),
    '---',
    '',
    '# ' + name,
    '',
    '（在这里写技能正文。写给模型看的：步骤、注意事项、可直接照做的命令。）',
    '',
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  log('已新建技能：' + file);
  return {
    name,
    description,
    file,
    root: userSkillsDir(),
    source: 'user-dsh',
    removable: true,
    bytes: Buffer.byteLength(body, 'utf8'),
  };
}

/** 删除一个用户级技能。只允许删用户级根下的，避免误删仓库内容。 */
export function deleteSkill(name: string): void {
  assertSkillName(name);
  const dir = path.join(userSkillsDir(), name);
  const root = path.resolve(userSkillsDir());
  const target = path.resolve(dir);
  // 双保险：解析后的绝对路径必须真的在用户级根目录之内
  if (!target.startsWith(root + path.sep)) {
    throw new Error('拒绝删除：目标不在用户技能目录内 —— ' + target);
  }
  if (!fs.existsSync(dir)) throw new Error('技能不存在：' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  log('已删除技能：' + dir);
}

// ---------------------------------------------------------------------------
// MCP 服务器
// ---------------------------------------------------------------------------

export type McpTransport = 'stdio' | 'streamable-http';

export interface McpServer {
  /** 补丁条目 id，也是界面上的稳定标识（mcp-<serverName>） */
  id: string;
  /** 传给 dsh-mcp-client 的 serverName（工具命名空间前缀） */
  serverName: string;
  enabled: boolean;
  transport: McpTransport;
  /** stdio：可执行文件 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** streamable-http：地址 */
  url?: string;
  headers?: Record<string, string>;
  /** 可选：工具调用超时 */
  toolCallTimeoutMs?: number;
  /** 最近一次连接结果（由 dsh 日志侧回填，界面展示用） */
  lastStatus?: string;
}

interface McpFile {
  version: 1;
  servers: McpServer[];
}

export function mcpConfigFile(): string {
  return path.join(userDataDir(), 'mcp-servers.json');
}

/** 读 MCP 配置。文件不存在/损坏都返回空列表（不阻断启动）。 */
export function listMcpServers(): McpServer[] {
  try {
    const raw = fs.readFileSync(mcpConfigFile(), 'utf8');
    const data = JSON.parse(raw) as Partial<McpFile>;
    if (!Array.isArray(data.servers)) return [];
    return data.servers;
  } catch {
    return [];
  }
}

/** 校验一个 MCP 服务器条目。界面提交前必须过这一关 —— 写坏配置会让 dsh 起不来。 */
export function validateMcpServer(s: McpServer): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s.serverName ?? '')) {
    throw new Error('serverName 只能用字母数字与 . _ -，且以字母数字开头：' + s.serverName);
  }
  if (s.transport === 'stdio') {
    if (!s.command) throw new Error('stdio 传输必须填 command');
  } else if (s.transport === 'streamable-http') {
    if (!s.url) throw new Error('streamable-http 传输必须填 url');
    if (!/^https?:\/\//.test(s.url)) throw new Error('url 必须以 http:// 或 https:// 开头');
  } else {
    throw new Error('未知传输类型：' + String(s.transport));
  }
}

/** 写 MCP 配置（原子写：先写临时文件再改名，避免半截文件）。 */
export function saveMcpServers(servers: McpServer[]): void {
  const seen = new Set<string>();
  for (const s of servers) {
    validateMcpServer(s);
    if (seen.has(s.serverName)) throw new Error('serverName 重复：' + s.serverName);
    seen.add(s.serverName);
  }
  const file = mcpConfigFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, servers }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  log('MCP 配置已保存：' + servers.length + ' 个服务器 → ' + file);
}

/**
 * 把启用的 MCP 服务器生成成补丁层要的 YAML 片段。
 *
 * 交给 patch-guard 追加到「生效补丁」末尾。生成而不是让用户手写，是因为：
 *   · YAML 缩进/转义错了会让 dsh 直接起不来（补丁解析失败）
 *   · args 里带 Windows 路径（反斜杠 + 盘符），手写极易踩转义
 * 用 js-yaml 生成能保证转义正确。
 *
 * @returns YAML 文本（不含文件头的 ---，因为它是追加到数组里的条目）；没有启用项时返回 ''
 */
export function buildMcpPatchYaml(servers: McpServer[]): string {
  const active = servers.filter((s) => s.enabled !== false);
  if (active.length === 0) return '';

  const entries = active.map((s) => {
    const config: Record<string, unknown> = { serverName: s.serverName };
    if (s.transport === 'stdio') {
      config.transport = 'stdio';
      config.command = s.command;
      if (s.args?.length) config.args = s.args;
      if (s.env && Object.keys(s.env).length) config.env = s.env;
      if (s.cwd) config.cwd = s.cwd;
    } else {
      config.transport = 'streamable-http';
      config.url = s.url;
      if (s.headers && Object.keys(s.headers).length) config.headers = s.headers;
    }
    if (typeof s.toolCallTimeoutMs === 'number') config.toolCallTimeoutMs = s.toolCallTimeoutMs;
    return { id: s.id || 'mcp-' + s.serverName, name: '@deepseek-ai/dsh-mcp-client', config };
  });

  // 补丁顶层是一个 YAML 列表：每个条目顶格以 `- ` 开头（与 desktop-patch.yml
  // 里已有的 `- insert:` 块保持同一缩进风格）。
  // 层级：
  //   `- insert:`               —— 顶格（0 空格）
  //   `    - id: xxx`           —— 4 空格（insert 的值是一个列表）
  //   `      name: xxx`         —— 6 空格（与 id 同级，- 后对齐）
  //   `      config:`           —— 6 空格
  //   `        key: value`      —— 8 空格（config 的子键）
  //   `          - item`        —— 10 空格（config 里的数组项）
  //   `          nested: val`   —— 10 空格（config 里的嵌套对象键）
  const lines: string[] = ['- insert:'];
  for (const e of entries) {
    lines.push('    - id: ' + yamlScalar(e.id));
    lines.push('      name: ' + yamlScalar(e.name));
    lines.push('      config:');
    const c = e.config as Record<string, unknown>;
    for (const [key, value] of Object.entries(c)) {
      if (Array.isArray(value)) {
        lines.push('        ' + key + ':');
        for (const item of value) lines.push('          - ' + yamlScalar(String(item)));
      } else if (value !== null && typeof value === 'object') {
        lines.push('        ' + key + ':');
        for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
          lines.push('          ' + k2 + ': ' + yamlScalar(String(v2)));
        }
      } else {
        lines.push('        ' + key + ': ' + yamlScalar(value as string | number | boolean));
      }
    }
  }
  return (
    '\n# ── MCP 服务器（由「技能与 MCP」面板管理；改这里没用，改 mcp-servers.json）──\n' +
    lines.join('\n') +
    '\n'
  );
}
