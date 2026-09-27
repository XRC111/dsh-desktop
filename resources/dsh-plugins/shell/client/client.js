/**
 * DSH Desktop 桌面适配面板 —— 客户端（浏览器）入口。
 *
 * 以 dsh 的 __ModuleLoader__ 产物格式提供（与 @dsh-desktop/updater 同构），
 * react / ui-primitives 由宿主模块表通过 require 提供，不需要打包器。
 *
 * 注册到 slot `settings.section`：设置页左侧多一个「桌面」导航项，
 * 里面是外壳各项桌面适配的开关（默认全开，可单独关掉）。
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

    var NS = 'dsh-desktop-shell';

    var ZH = {
      nav: '桌面',
      title: '桌面适配',
      hint: '这些是桌面外壳为 Harness 增加的能力，默认全部开启；关掉只影响对应的那一项，随时可以再打开。',
      unavailable: '当前外壳未提供桌面适配接口（需 10.1.2 及以上）',
      on: '已开启',
      off: '已关闭',
      saveFailed: '保存失败',
      reloadHint: '部分开关需要重启应用后完全生效。',
      restart: '重启应用',
      restarting: '正在重启…',
    };
    var EN = {
      nav: 'Desktop',
      title: 'Desktop integration',
      hint: 'These are capabilities the desktop shell adds to Harness. All are on by default; turning one off only affects that item and can be re-enabled anytime.',
      unavailable: 'Desktop API unavailable (needs shell 10.1.2+)',
      on: 'On',
      off: 'Off',
      saveFailed: 'Save failed',
      reloadHint: 'Some toggles take full effect after restarting the app.',
      restart: 'Restart app',
      restarting: 'Restarting…',
    };

    exports.name = 'dsh-desktop-shell';
    // 只依赖最基础的两个服务，避免在老宿主上被整个卸载
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
        setSnap(function (s) { return Object.assign({}, s, { busy: id, error: '' }); });
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
              return Object.assign({}, s, { busy: '', error: t('saveFailed') + '：' + String(err) });
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
        return h('div', { style: sectionStyle }, h('div', { style: hintStyle }, t('unavailable')));
      }

      var rows = (snap.defs || []).map(function (d) {
        var on = !!snap.values[d.id];
        return h(Row, {
          key: d.id,
          label: d.label,
          desc: d.desc,
          on: on,
          busy: snap.busy === d.id,
          t: t,
          onToggle: function () { toggle(d.id, !on); },
        });
      });

      return h(
        'div',
        { style: sectionStyle },
        h('div', { style: titleStyle }, t('title')),
        h('div', { style: hintStyle }, t('hint')),
        h('div', { style: listStyle }, rows),
        h('div', { style: footerStyle },
          h('span', { style: hintStyle }, t('reloadHint')),
          h('button', {
            type: 'button',
            onClick: restart,
            disabled: snap.busy === '__restart',
            style: buttonStyle,
          }, snap.busy === '__restart' ? t('restarting') : t('restart')),
        ),
        snap.error ? h('div', { style: errorStyle }, snap.error) : null,
      );
    };

    function Row(props) {
      var on = props.on;
      return h(
        'div',
        { style: rowStyle },
        h('div', { style: rowTextStyle },
          h('div', { style: rowLabelStyle }, props.label),
          h('div', { style: rowDescStyle }, props.desc),
        ),
        h('button', {
          type: 'button',
          onClick: props.onToggle,
          disabled: !!props.busy,
          'aria-pressed': on ? 'true' : 'false',
          title: on ? props.t('on') : props.t('off'),
          style: on ? switchOnStyle : switchOffStyle,
        }, h('span', { style: on ? knobOnStyle : knobOffStyle })),
      );
    }

    // 只用原生元素与中性配色，避免与 dsh 主题冲突
    var sectionStyle = { display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 0' };
    var titleStyle = { fontSize: '14px', fontWeight: 600 };
    var hintStyle = { fontSize: '12px', opacity: 0.7, lineHeight: 1.6 };
    var listStyle = { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px' };
    var rowStyle = {
      display: 'flex', alignItems: 'center', gap: '12px',
      padding: '10px 0', borderBottom: '1px solid rgba(127,127,127,.14)',
    };
    var rowTextStyle = { flex: '1 1 auto', minWidth: 0 };
    var rowLabelStyle = { fontSize: '13px', fontWeight: 500 };
    var rowDescStyle = { fontSize: '12px', opacity: 0.65, marginTop: '2px', lineHeight: 1.5 };
    var switchBase = {
      flex: 'none', width: '36px', height: '20px', borderRadius: '10px',
      border: 'none', padding: '2px', cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', transition: 'background .15s',
    };
    var switchOnStyle = Object.assign({}, switchBase, { background: '#2563eb', justifyContent: 'flex-end' });
    var switchOffStyle = Object.assign({}, switchBase, { background: 'rgba(127,127,127,.35)', justifyContent: 'flex-start' });
    var knobBase = { width: '16px', height: '16px', borderRadius: '50%', background: '#fff', display: 'block' };
    var knobOnStyle = Object.assign({}, knobBase, {});
    var knobOffStyle = Object.assign({}, knobBase, {});
    var footerStyle = { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px', flexWrap: 'wrap' };
    var buttonStyle = {
      border: '1px solid rgba(127,127,127,.35)', background: 'transparent',
      color: 'inherit', borderRadius: '6px', padding: '5px 12px',
      fontSize: '13px', cursor: 'pointer',
    };
    var errorStyle = { fontSize: '12px', color: '#e5484d', marginTop: '4px' };

    return exports;
  },
});
