/**
 * DSH Desktop 桌面适配面板 —— 客户端（浏览器）入口。
 *
 * 以 dsh 的 __ModuleLoader__ 产物格式提供（与 @dsh-desktop/updater 同构），
 * react / ui-primitives 由宿主模块表通过 require 提供，不需要打包器。
 *
 * 注册到 slot `settings.section`：设置页左侧多一个「桌面」导航项。
 *
 * ── 布局（对齐 dshmarket）────────────────────────────────────────────────────
 * 刻意用宿主的 UI 原语（Switch / SegmentedControl）与**设计变量**
 * （--dsw-alias-*），而不是自己写死颜色 —— 这样深浅色主题、
 * 圆角与间距都由宿主统一，和插件市场的观感完全一致。
 *
 * 结构：每个开关是「一行」：左侧标题 + 说明，右侧 Switch；
 * 行与行之间用 0.5px 分隔线（与宿主 settings-form 的 .field 一致）。
 * 分组用 SegmentedControl 同款的浅底块，避免一堆开关糊成一片。
 *
 * 数据来自 preload 暴露的 window.dshDesktop.getFeatures / setFeature；
 * 外壳没暴露时优雅降级为一行提示，不影响设置页其它部分。
 */
window.__ModuleLoader__.load({
  id: '@dsh-desktop/shell',
  factory: (require) => {
    var exports = {};
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var h = react.createElement;

    // UI 原语（宿主注入）。老版本可能缺某些导出，缺了就退回原生元素，
    // 绝不因为取不到原语而把整个设置页搞崩。
    var P = null;
    try { P = require('@deepseek-ai/dsh-client-ui-primitives'); } catch (e) { P = null; }
    var Switch = P && P.Switch ? P.Switch : null;

    var NS = 'dsh-desktop-shell';

    var ZH = {
      nav: '桌面',
      title: '桌面适配',
      hint: '外壳为 Harness 增加的能力。改完立即生效，不需要重启。',
      unavailable: '当前外壳未提供桌面适配接口（需 10.1.2 及以上）',
      on: '已开启',
      off: '已关闭',
      saveFailed: '保存失败',
      groupBase: '基础适配',
      groupBaseDesc: '外链、托盘、通知、窗口外观',
      groupCu: 'AI 操作本机',
      groupCuDesc: 'computer use —— 让模型看屏幕、动鼠标键盘',
      cuWarn: '下面这些能力会**真实改变你的系统状态**。默认只开「看屏幕」（只读），其余请按需逐项打开。',
      restart: '重启应用',
      restarting: '正在重启…',
      reloadHint: '部分改动需要重启应用才完全生效。',
    };
    var EN = {
      nav: 'Desktop',
      title: 'Desktop integration',
      hint: 'Capabilities the desktop shell adds to Harness. Changes apply immediately.',
      unavailable: 'Desktop API unavailable (needs shell 10.1.2+)',
      on: 'On',
      off: 'Off',
      saveFailed: 'Save failed',
      groupBase: 'Basics',
      groupBaseDesc: 'Links, tray, notifications, window chrome',
      groupCu: 'Computer use',
      groupCuDesc: 'Let the model see the screen and drive mouse/keyboard',
      cuWarn: 'These capabilities **really change your system state**. Only screen capture (read-only) is on by default.',
      restart: 'Restart app',
      restarting: 'Restarting…',
      reloadHint: 'Some changes need an app restart to fully apply.',
    };

    // 分组定义：id 前缀 → 组。顺序即显示顺序。
    var GROUPS = [
      { id: 'base', match: function (id) { return id.indexOf('computerUse') !== 0; }, title: 'groupBase', desc: 'groupBaseDesc' },
      { id: 'cu', match: function (id) { return id.indexOf('computerUse') === 0; }, title: 'groupCu', desc: 'groupCuDesc', warn: 'cuWarn' },
    ];

    exports.name = 'dsh-desktop-shell';
    exports.inject = ['slots', 'locale'];

    exports.apply = function (ctx) {
      var t = function (key) { return ZH[key] || key; };
      try {
        if (ctx.effect) ctx.effect(function () {
          return ctx.locale.register(NS, { zh: ZH, en: EN });
        }, NS + ': dictionaries');
        else ctx.locale.register(NS, { zh: ZH, en: EN });
        var bound = ctx.locale.bind(NS);
        if (typeof bound === 'function') t = bound;
      } catch (e) {
        /* 宿主没有 locale 服务时退回内置中文文案 */
      }

      var bridge = (typeof window !== 'undefined' && window.dshDesktop) || null;

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-desktop-shell',
            order: 91, // 紧挨「桌面更新」（90）
            label: function () { return t('nav'); },
            locale: NS,
          },
          function () { return h(ShellSection, { t: t, bridge: bridge }); },
        );
      });
    };

    // ---------------------------------------------------------------------
    // 界面
    // ---------------------------------------------------------------------
    var ShellSection = function (props) {
      var t = props.t;
      var bridge = props.bridge;
      var state = react.useState({ values: {}, defs: [], busy: '', error: '' });
      var snap = state[0];
      var setSnap = state[1];

      var supported = !!bridge && typeof bridge.getFeatures === 'function';

      var load = react.useCallback(function () {
        if (!supported) return;
        Promise.resolve(bridge.getFeatures())
          .then(function (r) {
            setSnap(function (s) {
              return Object.assign({}, s, {
                values: (r && r.values) || {},
                defs: (r && r.defs) || [],
                error: '',
              });
            });
          })
          .catch(function (err) {
            setSnap(function (s) { return Object.assign({}, s, { error: String(err) }); });
          });
      }, [bridge, supported]);

      react.useEffect(function () { load(); }, [load]);

      var toggle = function (id, next) {
        if (!supported || typeof bridge.setFeature !== 'function') return;
        // 乐观更新：先把界面切过去，失败再回滚 —— Switch 点下去要立刻有反馈
        setSnap(function (s) {
          var v = Object.assign({}, s.values);
          v[id] = next;
          return Object.assign({}, s, { values: v, busy: id, error: '' });
        });
        Promise.resolve(bridge.setFeature(id, next))
          .then(function (r) {
            setSnap(function (s) {
              return Object.assign({}, s, {
                values: (r && r.values) || s.values,
                defs: (r && r.defs) || s.defs,
                busy: '',
              });
            });
          })
          .catch(function (err) {
            setSnap(function (s) {
              var v = Object.assign({}, s.values);
              v[id] = !next; // 回滚
              return Object.assign({}, s, { values: v, busy: '', error: t('saveFailed') + '：' + String(err) });
            });
          });
      };

      var restart = function () {
        if (!bridge || typeof bridge.restart !== 'function') return;
        setSnap(function (s) { return Object.assign({}, s, { busy: '__restart' }); });
        Promise.resolve(bridge.restart()).catch(function (err) {
          setSnap(function (s) {
            return Object.assign({}, s, { busy: '', error: t('saveFailed') + '：' + String(err) });
          });
        });
      };

      if (!supported) {
        return h('p', { style: hintStyle }, t('unavailable'));
      }

      var defs = snap.defs || [];
      var nodes = [];
      GROUPS.forEach(function (g) {
        var items = defs.filter(function (d) { return g.match(d.id); });
        if (!items.length) return;
        nodes.push(h(GroupHead, { key: 'gh-' + g.id, title: t(g.title), desc: t(g.desc) }));
        if (g.warn) nodes.push(h('p', { key: 'gw-' + g.id, style: warnStyle }, t(g.warn)));
        items.forEach(function (d) {
          nodes.push(h(Row, {
            key: d.id,
            label: d.label,
            desc: d.desc,
            on: !!snap.values[d.id],
            busy: snap.busy === d.id,
            t: t,
            onToggle: function () { toggle(d.id, !snap.values[d.id]); },
          }));
        });
      });

      return h(
        'div',
        null,
        h('p', { style: hintStyle }, t('hint')),
        h('div', { style: formStyle }, nodes),
        h('div', { style: footerStyle },
          h('span', { style: hintStyle }, t('reloadHint')),
          h('button', {
            type: 'button',
            onClick: restart,
            disabled: snap.busy === '__restart',
            style: ghostButtonStyle,
          }, snap.busy === '__restart' ? t('restarting') : t('restart')),
        ),
        snap.error ? h('p', { style: errorStyle }, snap.error) : null,
      );
    };

    /** 分组标题：小号大写字母 + 说明，视觉上把开关分成两簇 */
    function GroupHead(props) {
      return h('div', { style: groupHeadStyle },
        h('span', { style: groupTitleStyle }, props.title),
        h('span', { style: groupDescStyle }, props.desc),
      );
    }

    /** 一行开关：左标题+说明，右 Switch。分隔线在行之间（与宿主 settings-form 一致） */
    function Row(props) {
      var on = props.on;
      var control = Switch
        ? h(Switch, { checked: on, onChange: props.onToggle, label: props.label, disabled: !!props.busy, title: on ? props.t('on') : props.t('off') })
        : h(FallbackSwitch, { on: on, disabled: !!props.busy, onClick: props.onToggle, t: props.t });
      return h('div', { style: rowStyle },
        h('div', { style: rowTextStyle },
          h('div', { style: rowLabelStyle }, props.label),
          props.desc ? h('div', { style: rowDescStyle }, props.desc) : null,
        ),
        h('div', { style: rowControlStyle }, control),
      );
    }

    /** 原语缺失时的兜底开关（样式尽量贴近宿主 Switch） */
    function FallbackSwitch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.on ? 'true' : 'false',
        disabled: props.disabled,
        onClick: props.onClick,
        title: props.on ? props.t('on') : props.t('off'),
        style: props.on ? fallbackOnStyle : fallbackOffStyle,
      }, h('span', { style: fallbackKnobStyle }));
    }

    // ---------------------------------------------------------------------
    // 样式：一律走宿主设计变量（--dsw-alias-*），深浅色主题自动跟随
    // ---------------------------------------------------------------------
    var formStyle = { display: 'flex', flexDirection: 'column', marginTop: '4px' };
    var hintStyle = { margin: '0 0 12px', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' };
    var warnStyle = {
      margin: '0 0 4px', padding: '8px 12px', fontSize: '12px', lineHeight: 1.6,
      color: 'var(--dsw-alias-label-secondary)',
      background: 'var(--dsw-alias-bg-layer-2)',
      borderRadius: 'var(--dsw-radius-md)',
    };
    var groupHeadStyle = { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '16px 0 4px' };
    var groupTitleStyle = { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' };
    var groupDescStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' };
    var rowStyle = {
      display: 'flex', alignItems: 'center', gap: '16px', padding: '12px 0',
      borderTop: '0.5px solid var(--dsw-alias-border-l2)',
    };
    var rowTextStyle = { flex: '1', minWidth: 0 };
    var rowLabelStyle = { fontSize: '13px', fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' };
    var rowDescStyle = { marginTop: '2px', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' };
    var rowControlStyle = { flex: 'none', display: 'flex', alignItems: 'center' };
    var footerStyle = { display: 'flex', alignItems: 'center', gap: '12px', paddingTop: '16px', flexWrap: 'wrap' };
    var ghostButtonStyle = {
      appearance: 'none', border: '0.5px solid var(--dsw-alias-border-l4)',
      background: 'none', color: 'var(--dsw-alias-label-primary)',
      borderRadius: 'var(--dsw-radius-md)', padding: '5px 14px',
      font: 'inherit', fontSize: '13px', lineHeight: 1.5, cursor: 'pointer',
    };
    var errorStyle = { margin: '8px 0 0', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' };

    var fallbackBase = {
      flex: 'none', width: '36px', height: '20px', borderRadius: '10px',
      border: 'none', padding: '2px', cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center',
    };
    var fallbackOnStyle = Object.assign({}, fallbackBase, { background: 'var(--dsw-alias-brand-primary)', justifyContent: 'flex-end' });
    var fallbackOffStyle = Object.assign({}, fallbackBase, { background: 'var(--dsw-alias-border-l3)', justifyContent: 'flex-start' });
    var fallbackKnobStyle = { width: '16px', height: '16px', borderRadius: '50%', background: 'var(--dsw-alias-label-primary-foreground)', display: 'block' };

    return exports;
  },
});
