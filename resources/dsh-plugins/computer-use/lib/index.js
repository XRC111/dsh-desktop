/**
 * DSH Desktop 计算机操作（computer use）—— 宿主侧工具。
 *
 * 给模型一组「操作本机桌面」的工具：看屏幕、管窗口、动鼠标键盘。
 *
 * ── 设计要点 ────────────────────────────────────────────────────────────────
 *
 * 1) **只用 tools 注入**，attachments 走 ctx.get() 惰性取。
 *    inject 里写 attachments 的话，缺该服务的部署会**整个插件加载失败**；
 *    而截图能降级（没 attachment 就存文件 + 返回路径），所以做成可选依赖。
 *
 * 2) **截图返回真图片**（image content block），不是文件路径 ——
 *    模型能直接看见画面。走 ctx.attachments.saveImage() 拿 durable ref。
 *    没有 attachment 服务时降级为「存到临时文件 + 返回路径」。
 *
 * 3) **坐标一律用屏幕绝对像素**（左上角原点），与 screenshot 返回的 origin 一致。
 *    多显示器下这是主显示器的坐标系（Win32 虚拟屏原点在左上）。
 *
 * 4) **输入合成用 keybd_event / mouse_event**，不用 SendInput ——
 *    后者要构造 INPUT 结构体，koffi 下更容易出错；前两者够用且稳定。
 *
 * ── 安全 ────────────────────────────────────────────────────────────────────
 * 这组工具能完全控制用户的鼠标键盘。默认**只注册只读工具**（看屏幕、列窗口），
 * 会改状态的（点击、输入、切窗口）需要显式开启 —— 见 config.allowInput。
 * 这样默认部署不会让模型意外乱点。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as w32 from './win32.js';

/**
 * 活跃心跳：把「computer use 正在跑」写到一个状态文件里，外壳读它决定是否显示悬浮球、
 * 以及是否抑制主窗口抢焦点。
 *
 * 为什么走文件而不是 IPC / 客户端插件：
 *   computer use 的工具跑在 dsh 子进程里，而抢焦点的是外壳的 Electron 窗口 ——
 *   两边不同进程。客户端插件那条路依赖宿主的事件 API（各版本形状不一，
 *   实测 `ctx.events` 并不存在，会话事件是 `tool/result` 这种 session 事件类型，
 *   要通过 `ctx.sessions` 订阅），耦合太深。
 *   而这个插件**在每次 execute 时天然知道**自己跑了什么 —— 那是确定的信号源。
 *   写文件是最低耦合的跨进程方式，且外壳可以顺手做超时兜底。
 *
 * 文件位置：$DSH_HOME/computer-use-active.json（DSH_HOME 由外壳传入）。
 * 失败一律静默 —— 心跳只影响 UI 提示，绝不能因为它拖垮工具本身。
 */
function heartbeatPath() {
  const home = process.env.DSH_HOME;
  if (!home) return null;
  return path.join(home, 'computer-use-active.json');
}

/** 写一次心跳。active=false 表示结束。 */
function beat(active, action) {
  try {
    const file = heartbeatPath();
    if (!file) return;
    if (!active) {
      // 结束时直接删掉：外壳读不到就是「没在跑」，比写 active:false 更省事
      fs.rmSync(file, { force: true });
      return;
    }
    fs.writeFileSync(
      file,
      JSON.stringify({ active: true, action: action || '', pid: process.pid, at: Date.now() }),
      'utf8',
    );
  } catch {
    /* 心跳失败不影响工具 */
  }
}

const name = 'computer-use';
// 只注入 tools；attachments / 其它服务一律 ctx.get() 惰性取（缺失可降级）
const inject = ['tools'];

// ---------------------------------------------------------------------------
// 键名 → 虚拟键码（只收常用键，够覆盖绝大多数操作）
// ---------------------------------------------------------------------------

const VK = {
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  printscreen: 0x2c, capslock: 0x14, numlock: 0x90, scrolllock: 0x91,
};
// 需要扩展键标志的（左右区分、小键盘等）
const EXTENDED = new Set(['up', 'down', 'left', 'right', 'insert', 'delete', 'del', 'home', 'end', 'pageup', 'pagedown', 'win', 'meta', 'printscreen']);

function vkOf(key) {
  const k = String(key).toLowerCase().trim();
  if (k in VK) return VK[k];
  // 单字符：字母数字直接取 ASCII 大写；其它符号交给 VkKeyScan 类规则（这里用常见映射兜底）
  if (k.length === 1) {
    const c = k.toUpperCase();
    if (/[A-Z0-9]/.test(c)) return c.charCodeAt(0);
    const punct = {
      '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, '\\': 0xdc, ';': 0xba,
      "'": 0xde, ',': 0xbc, '.': 0xbe, '/': 0xbf, '`': 0xc0,
    };
    if (k in punct) return punct[k];
  }
  throw new Error(`不认识的键：${key}（可用：字母数字、${Object.keys(VK).join('/')}）`);
}

// ---------------------------------------------------------------------------
// 输出 schema 片段
// ---------------------------------------------------------------------------

// ⚠️ dsh 的 JSON schema 校验器要求 **additionalProperties 必须显式 true/false**
// （不给或给 undefined 都会报 JsonSchemaError）。实测踩过。
const textOut = (props) => ({
  schema: { type: 'object', additionalProperties: false, properties: props },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

// ---------------------------------------------------------------------------
// 截图：优先做成 attachment（模型能直接看），失败则落盘
// ---------------------------------------------------------------------------

async function screenshotToContent(ctx, opts) {
  const cap = w32.capture({
    ...(opts.hwnd ? { hwnd: opts.hwnd } : {}),
    ...(opts.grid ? { grid: true } : {}),
  });
  const label = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;

  // 首选：交给 attachment 服务 → image content block（模型原生看图）
  const attachments = ctx.get?.('attachments');
  if (attachments && typeof attachments.saveImage === 'function') {
    try {
      const ref = await attachments.saveImage({
        data: new Uint8Array(cap.png),
        mediaType: 'image/png',
        name: label,
      });
      return {
        content: [{ type: 'image', attachment: ref }],
        meta: { width: cap.width, height: cap.height, origin: cap.origin },
      };
    } catch (err) {
      // 落盘降级（下面统一处理）
      ctx.logger?.warn?.(`computer-use：截图存为附件失败，改为落盘：${String(err)}`);
    }
  }

  // 降级：写文件 + 返回路径（模型可用自己的文件工具读）
  const dir = path.join(os.tmpdir(), 'dsh-computer-use');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, label);
  fs.writeFileSync(file, cap.png);
  return {
    content: [
      {
        type: 'text',
        text:
          `已截屏并保存到 ${file}\n尺寸 ${cap.width}×${cap.height}，原点 (${cap.origin.x}, ${cap.origin.y})。\n` +
          `（当前部署没有可用的图片附件服务，所以只给了文件路径）`,
      },
    ],
    meta: { width: cap.width, height: cap.height, origin: cap.origin, file },
  };
}

// ---------------------------------------------------------------------------
// 截图暂存表：execute 返回纯 JSON 值（不能带 bytes），render 再取出真正的图片内容。
// 用 Map 而不是往 value 里塞 base64 —— value 会进 durable log，塞图片会把会话撑爆。
// ---------------------------------------------------------------------------

const shots = new Map();

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  if (!w32.isSupported()) {
    ctx.logger?.info?.('computer-use：非 Windows 平台，跳过注册');
    return;
  }
  // ── 能力开关（由外壳的设置页写入，经 patch-guard 注入到这里）─────────────
  // 按**能力粒度**分，而不是一个总开关：用户可以只给看屏幕、不给动鼠标。
  // 全部默认关（除了截图由外壳默认开）；config 缺省时一律按关处理。
  const on = (k) => config?.[k] === true;
  const allowScreenshot = config?.allowScreenshot !== false; // 截图默认开（只读）
  const allowMouse = on('allowMouse');
  const allowKeyboard = on('allowKeyboard');
  const allowWindows = on('allowWindows');
  const allowUnattended = on('allowUnattended');

  // 兼容旧的单一开关：allowInput=true 视为「全开」（老配置不至于失效）
  const legacyAll = config?.allowInput === true;
  const canMouse = allowMouse || legacyAll;
  const canKeyboard = allowKeyboard || legacyAll;
  const canWindows = allowWindows || legacyAll;

  // ── 只读：列窗口 ──────────────────────────────────────────────────────────
  // ── 活跃心跳包装 ────────────────────────────────────────────────────────
  // 把 register 包一层：每个工具 execute 前后自动打心跳，工具实现本身不用改。
  // 这样「哪个工具在跑」这个信息只在一处维护，新增工具也不会漏。
  const registerRaw = ctx.tools.register.bind(ctx.tools);
  const ACTION_LABEL = {
    screen_shot: '正在截图',
    screen_windows: '正在查看窗口列表',
    screen_elements: '正在识别界面元素',
    screen_activate: '正在切换窗口',
    screen_resize: '正在调整窗口',
    mouse_move: '正在移动鼠标',
    mouse_click: '正在点击',
    mouse_scroll: '正在滚动',
    key_press: '正在按键',
    key_type: '正在输入文本',
  };
  ctx.tools.register = (tool) => {
    const inner = tool.execute;
    if (typeof inner === 'function') {
      tool.execute = async function (args, ...rest) {
        beat(true, ACTION_LABEL[tool.name] || '正在操作本机');
        try {
          return await inner.call(this, args, ...rest);
        } finally {
          // 只读工具（截图/列表）不改变系统状态，不算「正在操作」；
          // 会动鼠标键盘/窗口的才需要在结束后保持一段可见状态。
          if (/^(screen_|mouse_move)/.test(tool.name)) beat(false);
        }
      };
    }
    return registerRaw(tool);
  };

  ctx.tools.register(defineTool({
    name: 'screen_windows',
    description:
      '列出当前屏幕上所有可见窗口（标题、类名、进程、位置、是否最小化）。' +
      '用返回的 hwnd 配合 screen_activate / screen_shot 操作指定窗口。',
    parameters: {
      match: { type: 'string', description: '可选：按标题子串过滤（不区分大小写）' },
    },
    output: textOut({
      windows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hwnd: { type: 'string' },
            title: { type: 'string' },
            className: { type: 'string' },
            pid: { type: 'integer' },
            rect: {
              type: 'object',
              additionalProperties: false,
              properties: {
                left: { type: 'integer' },
                top: { type: 'integer' },
                right: { type: 'integer' },
                bottom: { type: 'integer' },
              },
            },
            minimized: { type: 'boolean' },
          },
        },
      },
    }),
    execute(args) {
      const wins = w32.listWindows();
      const q = args?.match ? String(args.match).toLowerCase() : '';
      const list = q ? wins.filter((w) => w.title.toLowerCase().includes(q)) : wins;
      return Promise.resolve({
        windows: list.map((w) => ({
          hwnd: w.hwnd,
          title: w.title,
          className: w.className,
          pid: w.pid,
          rect: w.rect,
          minimized: w.minimized,
        })),
      });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.match ? `列出窗口（匹配「${args.match}」）` : '列出窗口',
      kind: 'read',
      rawInput: args,
    }),
  }));

  // ── 只读：枚举 UI 元素（精确坐标，治「点偏」）──────────────────────────────
  ctx.tools.register(defineTool({
    name: 'screen_elements',
    description:
      '列出屏幕上所有**可交互** UI 元素及其**精确屏幕坐标**（来自 UI Automation，误差 0）。' +
      '**点按钮前先用它拿坐标**，比从截图目测准得多 —— 按钮通常只有 24-32px 高，' +
      '目测误差 10-40px 必然点偏。返回里 cx/cy 就是可直接传给 mouse_click 的中心点。' +
      'clickable=true 表示该元素支持 Invoke（能点）。',
    parameters: {
      filter: { type: 'string', description: '可选：按名称子串过滤（不区分大小写），如「保存」' },
      hwnd: { type: 'string', description: '可选：只枚举该窗口内（来自 screen_windows）' },
      types: { type: 'string', description: '可选：只要这些控件类型，如 Button,Edit,MenuItem' },
      max: { type: 'integer', description: '最多返回条数，默认 200' },
    },
    output: textOut({
      elements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            type: { type: 'string' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            w: { type: 'integer' },
            h: { type: 'integer' },
            cx: { type: 'integer' },
            cy: { type: 'integer' },
            enabled: { type: 'boolean' },
            clickable: { type: 'boolean' },
          },
        },
      },
    }),
    execute(args) {
      const list = w32.listElements({
        filter: args?.filter,
        hwnd: args?.hwnd,
        types: args?.types,
        max: args?.max,
      });
      return Promise.resolve({
        elements: list.map((e) => ({
          name: String(e.name ?? ''),
          type: String(e.type ?? ''),
          x: Number(e.x) | 0, y: Number(e.y) | 0,
          w: Number(e.w) | 0, h: Number(e.h) | 0,
          cx: Number(e.cx) | 0, cy: Number(e.cy) | 0,
          enabled: e.enabled === true,
          clickable: e.clickable === true,
        })),
      });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.filter ? `列出 UI 元素（匹配「${args.filter}」）` : '列出 UI 元素',
      kind: 'read',
      rawInput: args,
    }),
  }));

  // ── 只读：截屏（受 allowScreenshot，默认开）────────────────────────────────
  if (allowScreenshot) {
  ctx.tools.register(defineTool({
    name: 'screen_shot',
    description:
      '截取屏幕画面并**直接看到图片**。省略 hwnd 截整个屏幕；给 hwnd 只截那个窗口。' +
      '用于观察当前界面状态、确认操作结果。',
    parameters: {
      hwnd: { type: 'string', description: '可选：窗口句柄（来自 screen_windows）' },
      grid: {
        type: 'boolean',
        description:
          '可选：叠加坐标网格（每 100px 一条线，边缘带刻度数字）。' +
          '要从截图估坐标时建议打开 —— 可以读数而不是估数。' +
          '更准的做法是先用 screen_elements 拿精确坐标。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          width: { type: 'integer' },
          height: { type: 'integer' },
          originX: { type: 'integer' },
          originY: { type: 'integer' },
          // 图片本身不能进 value（value 必须是**纯 JSON**，且会进 durable log），
          // 所以只带一个不透明的键，真正的 bytes 放在下面的 render 闭包里。
          shotId: { type: 'string' },
        },
      },
      // render 是产出 image content block 的**正规位置**（契约就是 ContentBlock[]）
      render(_args, value) {
        const shot = shots.get(value?.shotId);
        if (!shot) {
          return [{ type: 'text', text: `截图 ${value?.width ?? '?'}×${value?.height ?? '?'}（图片已过期）` }];
        }
        shots.delete(value.shotId); // 一次性：避免内存里堆积大图
        return shot.content;
      },
    },
    async execute(args) {
      const r = await screenshotToContent(ctx, { hwnd: args?.hwnd, grid: args?.grid === true });
      const shotId = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      shots.set(shotId, r);
      return {
        width: r.meta.width,
        height: r.meta.height,
        originX: r.meta.origin?.x ?? 0,
        originY: r.meta.origin?.y ?? 0,
        shotId,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.hwnd ? '截取窗口' : '截取屏幕',
      kind: 'read',
      rawInput: args,
    }),
  }));
  } else {
    ctx.logger?.info?.('computer-use：截图已按设置关闭（screen_shot 未注册）');
  }

  // ── 以下会改变系统状态，逐组按开关注册 ─────────────────────────────────────
  // 设计：按**能力粒度**分开，而不是一个总开关 —— 用户可以只给点鼠标、不给打字。

  // ── 窗口组（allowWindows / 旧 allowInput）──────────────────────────────────
  if (canWindows) {
  // 切窗口
  ctx.tools.register(defineTool({
    name: 'screen_activate',
    description: '把指定窗口切到前台并获得焦点（必要时先还原最小化）。',
    parameters: {
      hwnd: { type: 'string', required: true, description: '窗口句柄' },
    },
    output: textOut({ hwnd: { type: 'string' }, foreground: { type: 'string' } }),
    execute(args) {
      return Promise.resolve(w32.activateWindow(args.hwnd));
    },
    presentCall: (args) => ({ card: 'generic', title: '切换窗口', kind: 'other', rawInput: args }),
  }));

  // 移动/缩放窗口
  ctx.tools.register(defineTool({
    name: 'screen_resize',
    description: '移动或缩放指定窗口到给定的屏幕坐标与尺寸。',
    parameters: {
      hwnd: { type: 'string', required: true },
      x: { type: 'integer', required: true },
      y: { type: 'integer', required: true },
      width: { type: 'integer', required: true },
      height: { type: 'integer', required: true },
    },
    output: textOut({ hwnd: { type: 'string' }, ok: { type: 'boolean' } }),
    execute(args) {
      return Promise.resolve(w32.moveWindow(args.hwnd, args.x, args.y, args.width, args.height));
    },
    presentCall: (args) => ({ card: 'generic', title: '调整窗口', kind: 'other', rawInput: args }),
  }));
  }

  // ── 鼠标组（allowMouse / 旧 allowInput）────────────────────────────────────
  if (canMouse) {
  // 鼠标移动
  ctx.tools.register(defineTool({
    name: 'mouse_move',
    description: '把鼠标指针移动到屏幕绝对坐标（左上角为原点）。',
    parameters: {
      x: { type: 'integer', required: true },
      y: { type: 'integer', required: true },
    },
    output: textOut({ x: { type: 'integer' }, y: { type: 'integer' } }),
    execute(args) {
      return Promise.resolve(w32.mouseMove(args.x, args.y));
    },
    presentCall: (args) => ({ card: 'generic', title: `移动鼠标到 (${args.x}, ${args.y})`, kind: 'other', rawInput: args }),
  }));

  // 鼠标点击
  ctx.tools.register(defineTool({
    name: 'mouse_click',
    description:
      '在屏幕坐标处点击鼠标。省略 x/y 则在当前位置点。' +
      'button 可选 left（默认）/ right / middle；double=true 双击。' +
      '强烈建议带 hwnd：点击落在**当前前台窗口**上，若目标不在前台，' +
      '这一下会点到挡在上面的窗口（实测点击坐标正确但落到了别的窗口）。' +
      '带 hwnd 会先切前台并等切换生效。',
    parameters: {
      x: { type: 'integer', description: '可选：先移动到该 x' },
      y: { type: 'integer', description: '可选：先移动到该 y' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left' },
      double: { type: 'boolean', description: '是否双击' },
      hwnd: {
        type: 'string',
        description: '可选：先切该窗口到前台再点击（强烈建议传，避免点到别的窗口）',
      },
    },
    output: textOut({
      at: {
        type: 'object',
        additionalProperties: false,
        properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      },
    }),
    execute(args) {
      // 前台守卫（内含自动重试）：坐标算对了但前台不是目标时，这一下会落到挡在
      // 上面的窗口上。ensureForeground 失败会抛结构化错误。
      w32.ensureForeground(args?.hwnd);
      return Promise.resolve(
        w32.mouseClick(
          typeof args?.x === 'number' ? args.x : undefined,
          typeof args?.y === 'number' ? args.y : undefined,
          args?.button ?? 'left',
          args?.double === true,
        ),
      );
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `${args?.double ? '双击' : '点击'}${args?.button === 'right' ? '右键' : ''}`,
      kind: 'other',
      rawInput: args,
    }),
  }));

  // 滚轮
  ctx.tools.register(defineTool({
    name: 'mouse_scroll',
    description: '滚动鼠标滚轮。delta 为正向上滚、负向下滚，一格通常是 120。',
    parameters: { delta: { type: 'integer', required: true } },
    output: textOut({ delta: { type: 'integer' } }),
    execute(args) {
      return Promise.resolve(w32.mouseWheel(args.delta));
    },
    presentCall: (args) => ({ card: 'generic', title: `滚动 ${args.delta}`, kind: 'other', rawInput: args }),
  }));
  }

  // ── 键盘组（allowKeyboard / 旧 allowInput）──────────────────────────────────
  if (canKeyboard) {
  // 按键 / 组合键
  ctx.tools.register(defineTool({
    name: 'key_press',
    description:
      '按一次键，或按组合键。keys 是数组：单个键直接按；多个键则前面的按住、最后一个按下抬起，' +
      '例如 ["ctrl","c"] 表示 Ctrl+C，["enter"] 表示回车。' +
      '强烈建议带 hwnd：按键是发给**当前前台窗口**的，若中途有弹窗抢走焦点，' +
      '按键就会落到别的窗口上，表现为「组合键无效」。带 hwnd 会先把目标切到前台并确认。',
    parameters: {
      keys: { type: 'array', required: true, items: { type: 'string' }, description: '键名数组' },
      hwnd: {
        type: 'string',
        description: '可选：先把该窗口切到前台再发按键（强烈建议传，避免按键落到抢焦点的弹窗上）',
      },
    },
    output: textOut({
      keys: { type: 'array', items: { type: 'string' } },
      // 把「按键实际发给了谁」报出来 —— 这是诊断「组合键无效」的唯一线索
      foreground: { type: 'string' },
    }),
    execute(args) {
      const keys = Array.isArray(args?.keys) ? args.keys : [];
      if (keys.length === 0) throw new Error('keys 不能为空');
      const codes = keys.map((k) => ({ k, vk: vkOf(k), ext: EXTENDED.has(String(k).toLowerCase()) }));
      // ⚠️ 必须**一次 SendInput 发完整序列**，不能逐个 keybd_event：
      //    逐个发是多次独立系统调用，中间只要目标窗口失焦（弹窗抢焦点、窗口切换），
      //    修饰键就会落到别的窗口上，目标窗口只收到不带修饰键的主键 ——
      //    实测表现为「ctrl+home / shift+end 无效」（文本框收到裸的 end）。
      //    原子注入由系统保证不会与焦点变化交错。详见 win32.sendKeySteps。
      // 带 hwnd 时先把目标切到前台 —— 按键只发给前台窗口，
      // 不先切的话，任何抢焦点的弹窗（实测：NSIS Error 对话框）都会把按键吃掉。
      // activateAndWait 会等前台**真的**切过去再返回；直接 activateWindow 后立刻发按键
      // 会因为切换是异步的而落到旧窗口上（实测：0,0）。
      //
      // ⚠️ 但 activateAndWait 的返回值只是**那一刻**的快照。DSH 自己的 Electron GUI
      // （或 IM 宿主）可能在注入前又把前台抢回去。所以注入前再校验一次，
      // 不一致就报错，绝不带着「以为成功」继续 —— 否则输入会落到用户当前窗口上。
      w32.ensureForeground(args?.hwnd);

      const steps = [];
      for (let i = 0; i < codes.length - 1; i++) steps.push({ vk: codes[i].vk, up: false, extended: codes[i].ext });
      const last = codes[codes.length - 1];
      steps.push({ vk: last.vk, up: false, extended: last.ext });
      steps.push({ vk: last.vk, up: true, extended: last.ext });
      for (let i = codes.length - 2; i >= 0; i--) steps.push({ vk: codes[i].vk, up: true, extended: codes[i].ext });
      w32.sendKeySteps(steps);
      // 回报**注入时刻**的真实前台（不是激活时的旧快照），调用方据此判断有没有被抢焦点
      return Promise.resolve({ keys, foreground: w32.foregroundWindow().hwnd });
    },
    presentCall: (args) => ({ card: 'generic', title: `按键 ${(args?.keys ?? []).join('+')}`, kind: 'other', rawInput: args }),
  }));

  // 输入文本
  ctx.tools.register(defineTool({
    name: 'key_type',
    description:
      '输入一段文本。**支持中文与任意 Unicode**（走 KEYEVENTF_UNICODE 注入，' +
      '不经过键盘布局与 IME）。' +
      '强烈建议带 hwnd：按键是发给**当前前台窗口**的，若中途有弹窗或 GUI 抢走焦点，' +
      '文本就会落到别的窗口上（实测过整段中文进错窗口、字数统计为 0）。' +
      '带 hwnd 会先切前台、等切换生效，并在注入前再校验一次。',
    parameters: {
      text: { type: 'string', required: true },
      hwnd: {
        type: 'string',
        description: '可选：先把该窗口切到前台再输入（强烈建议传，避免文本落到别的窗口）',
      },
    },
    output: textOut({
      typed: { type: 'integer' },
      skipped: { type: 'array', items: { type: 'string' } },
      foreground: { type: 'string' },
    }),
    execute(args) {
      const text = String(args?.text ?? '');
      if (!text) return Promise.resolve({ typed: 0 });

      // 策略：**全部走 Unicode 注入**。
      //
      // 为什么不按「ASCII 用 VkKeyScanW、非 ASCII 用 Unicode」拆：
      // 两条路径混用会让 IME/输入法状态在中间插入不可预期的行为（实测过：
      // 中文之后紧跟的 ASCII 会被输入法当候选字吃掉）。整段走同一条路径最稳，
      // 而 Unicode 注入对 ASCII 同样有效（它绕过键盘布局，直接注入字符）。
      //
      // 代价：不触发键盘快捷键语义（不会产生 Ctrl+C 这种组合键效果）——
      // 需要快捷键请用 key_press。这里只负责「打字」。
      // 与 key_press 同样的前台守卫：先切、等生效、注入前再校验。
      // 文本注入比按键更危险 —— 几百字进错窗口几乎无法察觉，只能靠事后截图发现。
      w32.ensureForeground(args?.hwnd);

      const r = w32.typeUnicode(text);
      if (r.failed) {
        throw new Error(`输入中断：已发送 ${r.sent} 个字符后 SendInput 失败。`);
      }
      // 回报注入时刻的真实前台，让调用方能核对文本到底进了哪个窗口
      return Promise.resolve({ typed: r.sent, foreground: w32.foregroundWindow().hwnd });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `输入文本（${String(args?.text ?? '').length} 字）`,
      kind: 'other',
      rawInput: args,
    }),
  }));
  }

  // 未开启的能力记一条日志，便于用户在「会话日志」里确认当前授权范围
  const off = [];
  if (!allowScreenshot) off.push('截图');
  if (!canMouse) off.push('鼠标');
  if (!canKeyboard) off.push('键盘');
  if (!canWindows) off.push('窗口');
  if (off.length) {
    ctx.logger?.info?.(
      'computer-use：本次未启用 ' + off.join('、') +
        '（改设置：设置 → 桌面 →「AI 操作本机」）',
    );
  }
  if (!allowUnattended) {
    ctx.logger?.info?.('computer-use：仅在本窗口处于前台时允许操作（无人值守已关闭）');
  }
}

export { name, inject, apply };
