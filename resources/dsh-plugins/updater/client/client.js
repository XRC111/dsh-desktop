/**
 * DSH Desktop 更新面板 —— 客户端（浏览器）入口。
 *
 * 以 dsh 的 __ModuleLoader__ 产物格式提供（与 dshmarket 的 client/client.js 同构），
 * 这样不必引入打包器：react / ui-primitives 由宿主的模块表通过 require 提供。
 *
 * 注册到 slot `settings.section`：在设置页左侧多一个「桌面更新」导航项，
 * 点进去显示外壳版本、Harness 运行时版本、更新源，以及「检查更新」按钮；
 * 有更新落位后出现「重启以应用」。
 *
 * 数据来自桌面外壳 preload 暴露的 window.dshDesktop（外壳没暴露时优雅降级）。
 */
window.__ModuleLoader__.load({
  id: '@dsh-desktop/updater',
  factory: (require) => {
    var exports = {};
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var h = react.createElement;

    // UI 原语（宿主注入）。老版本可能缺某些导出，缺了就退回原生元素，
    // 绝不因为取不到原语而把整个设置页搞崩。
    var primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (e) {
      primitives = null;
    }

    var NS = 'dsh-desktop-updater';

    var ZH = {
      nav: '桌面更新',
      title: 'DSH Desktop',
      shell: '外壳版本',
      dsh: 'Harness 运行时',
      feed: '更新源',
      check: '检查更新',
      checking: '正在检查…',
      restart: '重启以应用',
      restarting: '正在重启…',
      upToDate: '已是最新版本',
      ready: '更新已就绪，点「重启以应用」即可生效',
      failed: '检查失败',
      unavailable: '当前外壳未提供更新接口',
      unknown: '未知',
      channel: '更新通道',
      chanStable: '稳定版',
      chanBeta: '测试版',
      chanDev: '开发版',
      chanHint: '切换后会立即按该通道重新检查一次；测试版与开发版更新更频繁，可能包含未充分验证的改动。',
      chanSwitching: '正在切换通道…',
      chanDone: '已切换到',
      chanUnsupported: '当前外壳版本不支持切换通道（需 1.1.23 及以上）',
      latest: '云端版本',
    };
    var EN = {
      nav: 'Desktop Update',
      title: 'DSH Desktop',
      shell: 'Shell version',
      dsh: 'Harness runtime',
      feed: 'Update source',
      check: 'Check for updates',
      checking: 'Checking…',
      restart: 'Restart to apply',
      restarting: 'Restarting…',
      upToDate: 'Already up to date',
      ready: 'Update ready — click "Restart to apply"',
      failed: 'Check failed',
      unavailable: 'Update API unavailable',
      unknown: 'unknown',
      channel: 'Update channel',
      chanStable: 'Stable',
      chanBeta: 'Beta',
      chanDev: 'Dev',
      chanHint: 'Switching triggers an immediate re-check. Beta and dev update more often and may contain less-validated changes.',
      chanSwitching: 'Switching channel…',
      chanDone: 'Switched to',
      chanUnsupported: 'This shell version cannot switch channels (needs 1.1.23+)',
      latest: 'Latest',
    };

    // 三条通道：stable 走 latest.json，beta/dev 走 latest-<channel>.json（主进程改写 URL）
    var CHANNELS = [
      { id: 'stable', key: 'chanStable' },
      { id: 'beta', key: 'chanBeta' },
      { id: 'dev', key: 'chanDev' },
    ];

    exports.name = 'dsh-desktop-updater';
    // 只依赖最基础的两个服务：slots（注册界面）+ locale（多语言）。
    // 不依赖 theme / settingsScope，避免在老宿主上整个插件被卸载。
    exports.inject = ['slots', 'locale'];

    exports.apply = function (ctx) {
      // 标准做法：把字典注册进宿主的 locale 服务，再用 bind 拿到跟随语言切换的 t
      var t = function (key) {
        return (ZH[key] || key);
      };
      try {
        if (ctx.effect) ctx.effect(function () {
          return ctx.locale.register(NS, { zh: ZH, en: EN });
        }, NS + ': dictionaries');
        else ctx.locale.register(NS, { zh: ZH, en: EN });
        var bound = ctx.locale.bind(NS);
        if (typeof bound === 'function') t = bound;
      } catch (e) {
        // 宿主没有 locale 服务时退回内置中文文案，不影响主功能
      }

      // 桌面外壳通过 preload 暴露的更新接口（主世界可见）
      var bridge = (typeof window !== 'undefined' && window.dshDesktop) || null;

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-desktop-updater',
            order: 90, // 排在插件市场等之后
            label: function () {
              return t('nav');
            },
            locale: NS,
          },
          function () {
            return h(UpdaterSection, { t: t, bridge: bridge });
          },
        );
      });
    };

    // ---------------------------------------------------------------------
    // 界面
    // ---------------------------------------------------------------------
    var UpdaterSection = function (props) {
      var t = props.t;
      var bridge = props.bridge;
      var timerRef = react.useRef(0);

      var state = react.useState({ phase: 'idle', versions: null, message: '', busy: false });
      var snap = state[0];
      var setSnap = state[1];

      // 通道：id + 是否正在切换。老外壳没有 getChannel 时保持空串（UI 自行隐藏这一行）
      var chanState = react.useState({ channel: '', busy: false, supported: false });
      var chan = chanState[0];
      var setChan = chanState[1];

      var refresh = react.useCallback(
        function () {
          if (!bridge || typeof bridge.getVersions !== 'function') return;
          Promise.resolve(bridge.getVersions())
            .then(function (v) {
              setSnap(function (s) {
                return Object.assign({}, s, { versions: v || null });
              });
            })
            .catch(function () {});
        },
        [bridge],
      );

      var refreshChannel = react.useCallback(
        function () {
          if (!bridge || typeof bridge.getChannel !== 'function') return;
          Promise.resolve(bridge.getChannel())
            .then(function (r) {
              setChan(function (s) {
                return Object.assign({}, s, {
                  supported: true,
                  channel: (r && r.channel) || s.channel || 'stable',
                });
              });
            })
            .catch(function () {});
        },
        [bridge],
      );

      react.useEffect(function () {
        refresh();
        refreshChannel();
        var off = null;
        if (bridge && typeof bridge.onUpdateState === 'function') {
          try {
            off = bridge.onUpdateState(function (st) {
              setSnap(function (s) {
                return Object.assign({}, s, {
                  phase: (st && st.phase) || s.phase,
                  message: (st && st.message) || s.message,
                });
              });
              setChan(function (s) {
                return Object.assign({}, s, {
                  channel: (st && st.channel) || s.channel,
                });
              });
              refresh();
            });
          } catch (e) {}
        }
        // 兜底轮询：页面长时间开着时也能跟上状态变化
        timerRef.current = setInterval(refresh, 30000);
        return function () {
          if (off) off();
          if (timerRef.current) clearInterval(timerRef.current);
        };
      }, [bridge, refresh, refreshChannel]);

      var check = function () {
        if (!bridge || typeof bridge.checkUpdate !== 'function') return;
        setSnap(function (s) {
          return Object.assign({}, s, { busy: true, message: t('checking') });
        });
        Promise.resolve(bridge.checkUpdate())
          .then(function (st) {
            var phase = (st && st.phase) || '';
            var msg =
              phase === 'up-to-date'
                ? t('upToDate')
                : phase === 'downloaded'
                  ? t('ready')
                  : phase === 'error'
                    ? t('failed') + '：' + ((st && st.message) || '')
                    : (st && st.message) || '';
            setSnap(function (s) {
              return Object.assign({}, s, { busy: false, phase: phase, message: msg });
            });
            refresh();
          })
          .catch(function (err) {
            setSnap(function (s) {
              return Object.assign({}, s, { busy: false, message: t('failed') + '：' + err });
            });
          });
      };

      /**
       * 切换通道。主进程写回偏好后会立即按新通道检查一次，
       * 所以这里紧接着拉一次状态与版本，把结果直接反馈在页面上。
       */
      var switchChannel = function (id) {
        if (!bridge || typeof bridge.setChannel !== 'function') return;
        if (chan.busy || id === chan.channel) return;
        setChan(function (s) {
          return Object.assign({}, s, { busy: true });
        });
        setSnap(function (s) {
          return Object.assign({}, s, { message: t('chanSwitching') });
        });
        Promise.resolve(bridge.setChannel(id))
          .then(function (r) {
            setChan(function (s) {
              return Object.assign({}, s, { busy: false, channel: (r && r.channel) || id });
            });
            refresh();
            if (typeof bridge.getUpdateState !== 'function') return null;
            return Promise.resolve(bridge.getUpdateState());
          })
          .then(function (st) {
            if (!st) return;
            var phase = (st && st.phase) || '';
            var msg =
              phase === 'up-to-date'
                ? t('upToDate')
                : phase === 'downloaded'
                  ? t('ready')
                  : phase === 'error'
                    ? t('failed') + '：' + ((st && st.message) || '')
                    : (st && st.latestVersion)
                      ? t('latest') + ' ' + st.latestVersion
                      : (st && st.message) || '';
            setSnap(function (s) {
              return Object.assign({}, s, { phase: phase, message: msg });
            });
          })
          .catch(function (err) {
            setChan(function (s) {
              return Object.assign({}, s, { busy: false });
            });
            setSnap(function (s) {
              return Object.assign({}, s, { message: t('failed') + '：' + err });
            });
          });
      };

      var restart = function () {
        if (!bridge || typeof bridge.restart !== 'function') return;
        setSnap(function (s) {
          return Object.assign({}, s, { busy: true, message: t('restarting') });
        });
        Promise.resolve(bridge.restart()).catch(function (err) {
          setSnap(function (s) {
            return Object.assign({}, s, { busy: false, message: t('failed') + '：' + err });
          });
        });
      };

      var v = snap.versions || {};
      var ready = !!(v.hotReady || v.runtimeReady);

      if (!bridge) {
        return h(
          'div',
          { style: sectionStyle },
          h('div', { style: hintStyle }, t('unavailable')),
        );
      }

      return h(
        'div',
        { style: sectionStyle },
        h('div', { style: titleStyle }, t('title')),
        h(Row, { label: t('shell'), value: v.shell || t('unknown') }),
        h(Row, { label: t('dsh'), value: v.dsh || t('unknown') }),
        v.feedUrl ? h(Row, { label: t('feed'), value: v.feedUrl }) : null,
        // 分通道：老外壳没有 getChannel 时整行不显示，页面其余部分照常
        chan.supported && chan.channel
          ? h(
              'div',
              { style: rowStyle },
              h('span', { style: labelStyle }, t('channel')),
              h(
                'span',
                { style: chanButtonsStyle },
                CHANNELS.map(function (c) {
                  var on = c.id === chan.channel;
                  return h(
                    'button',
                    {
                      type: 'button',
                      key: c.id,
                      onClick: function () {
                        switchChannel(c.id);
                      },
                      disabled: !!chan.busy,
                      style: on ? chanButtonOnStyle : chanButtonStyle,
                    },
                    t(c.key),
                  );
                }),
              ),
            )
          : null,
        chan.supported && chan.channel ? h('div', { style: hintStyle }, t('chanHint')) : null,
        h(
          'div',
          { style: actionsStyle },
          h(
            'button',
            { type: 'button', onClick: check, disabled: !!snap.busy, style: buttonStyle },
            t('check'),
          ),
          ready
            ? h(
                'button',
                { type: 'button', onClick: restart, disabled: !!snap.busy, style: primaryButtonStyle },
                t('restart') + readyLabel(v, t),
              )
            : null,
        ),
        snap.message ? h('div', { style: hintStyle }, snap.message) : null,
      );
    };

    function readyLabel(v, t) {
      var parts = [];
      if (v.hotReady && v.hotVersion) parts.push(v.hotVersion);
      if (v.runtimeReady && v.runtimeTarget) parts.push(v.runtimeTarget);
      return parts.length ? '（' + parts.join(' + ') + '）' : '';
    }

    function Row(props) {
      return h(
        'div',
        { style: rowStyle },
        h('span', { style: labelStyle }, props.label),
        h('span', { style: valueStyle }, props.value),
      );
    }

    // 尽量克制：只用原生元素与中性配色，避免与 dsh 主题冲突
    var sectionStyle = { display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' };
    var titleStyle = { fontSize: '14px', fontWeight: 600, marginBottom: '4px' };
    var rowStyle = { display: 'flex', gap: '12px', fontSize: '13px', alignItems: 'baseline' };
    var labelStyle = { opacity: 0.65, minWidth: '120px' };
    var valueStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
    var actionsStyle = { display: 'flex', gap: '8px', marginTop: '6px', flexWrap: 'wrap' };
    var buttonStyle = {
      border: '1px solid rgba(127,127,127,.35)',
      background: 'transparent',
      color: 'inherit',
      borderRadius: '6px',
      padding: '5px 12px',
      fontSize: '13px',
      cursor: 'pointer',
    };
    var primaryButtonStyle = Object.assign({}, buttonStyle, {
      borderColor: 'transparent',
      background: '#2563eb',
      color: '#fff',
    });
    var chanButtonsStyle = { display: 'flex', gap: '6px', flexWrap: 'wrap' };
    var chanButtonStyle = {
      border: '1px solid rgba(127,127,127,.35)',
      background: 'transparent',
      color: 'inherit',
      borderRadius: '6px',
      padding: '3px 10px',
      fontSize: '12px',
      cursor: 'pointer',
    };
    var chanButtonOnStyle = Object.assign({}, chanButtonStyle, {
      borderColor: 'transparent',
      background: '#2563eb',
      color: '#fff',
    });
    var hintStyle = { fontSize: '12px', opacity: 0.7, marginTop: '2px' };

    return exports;
  },
});
