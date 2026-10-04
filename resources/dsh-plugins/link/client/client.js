/**
 * 远程联动面板 —— 客户端（浏览器）入口。
 *
 * 以 dsh 的 __ModuleLoader__ 产物格式提供（与 @dsh-desktop/shell 同构）：
 * react 与 ui-primitives 由宿主模块表通过 require 提供，不需要打包器。
 *
 * 注册到 slot `settings.section`：设置页左侧多一个「远程联动」导航项。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────────────────────
 * 不是 window.dshDesktop（那是外壳 preload），而是**宿主插件的 HTTP 路由**：
 *   GET  /api/dsh-link/status
 *   POST /api/dsh-link/start | /stop | /code
 * 这些挂在已鉴权的 Connection 上，和 /api/session/uploadFileBinary 同级。
 *
 * ⚠️ 用普通同源 fetch，**不要**自己塞 token：页面加载时浏览器已经用启动 token
 *    换好了签名 cookie，同源请求自动带上。实测（起真实 dsh 打这两个路由）：
 *    带 cookie 200，不带任何凭据 401。所以这里只需要 fetch(path)。
 *
 * ── 文案 ────────────────────────────────────────────────────────────────────
 * 安全说明必须**照实写**：凭据加密传输 ≠ 端到端加密。界面是用户唯一会读的地方，
 * 在这里含糊其辞比不写更糟。
 */
window.__ModuleLoader__.load({
  id: '@dsh-desktop/link',
  factory: (require) => {
    var exports = {};
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var h = react.createElement;

    // UI 原语（宿主注入）。缺了就退回原生元素，绝不因为取不到原语把设置页搞崩。
    var P = null;
    try { P = require('@deepseek-ai/dsh-client-ui-primitives'); } catch (e) { P = null; }
    var Button = P && P.Button ? P.Button : null;
    var Input = P && P.Input ? P.Input : null;

    var NS = 'dsh-desktop-link';
    var API = '/api/dsh-link';

    var ZH = {
      nav: '远程联动',
      title: '远程联动',
      hint: '让手机与桌面互为远程设备：桌面的模型能操作手机，手机的模型能操作桌面。',
      notRunning: '服务未启动',
      running: '服务运行中',
      port: '端口',
      addresses: '局域网地址',
      start: '启动服务',
      stop: '停止服务',
      newCode: '换一个配对码',
      code: '配对码',
      codeHint: '在手机上执行 link_connect 时填这个码。一次性，5 分钟内有效，用过即废。',
      codeExpired: '配对码已过期，点「换一个配对码」。',
      connected: '已连接设备',
      none: '暂无设备接入',
      encrypted: '凭据加密',
      encryptedHint: '握手时用 ECDH 派生的会话密钥（AES-256-GCM）封装 API Key 等机密字段，被动嗅探拿不到。但它不防中间人 —— 公钥没有签名。所以准确的说法是「凭据加密传输」，不是端到端加密。',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败',
      failed: '操作失败',
      refresh: '刷新',
      steps: '配对步骤',
      step1: '在桌面点「启动服务」，拿到配对码',
      step2: '在手机上说 link_connect，填地址、端口与配对码',
      step3: '连上后桌面就能用 phone_* 工具操作手机',
    };
    var EN = {
      nav: 'Remote link',
      title: 'Remote link',
      hint: 'Let phone and desktop act as remote devices for each other.',
      notRunning: 'Service stopped',
      running: 'Service running',
      port: 'Port',
      addresses: 'LAN addresses',
      start: 'Start service',
      stop: 'Stop service',
      newCode: 'New pairing code',
      code: 'Pairing code',
      codeHint: 'Enter this on the phone in link_connect. One-shot, valid for 5 minutes.',
      codeExpired: 'Code expired — generate a new one.',
      connected: 'Connected device',
      none: 'No device paired',
      encrypted: 'Credential encryption',
      encryptedHint: 'Secrets (API keys) are sealed with an ECDH-derived AES-256-GCM session key, so passive sniffing cannot read them. It is NOT end-to-end encrypted, though: the public keys are unsigned, so there is no MITM protection.',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      failed: 'Failed',
      refresh: 'Refresh',
      steps: 'How to pair',
      step1: 'Press "Start service" here to get a pairing code',
      step2: 'On the phone run link_connect with the address, port and code',
      step3: 'The desktop can then drive the phone via phone_* tools',
    };

    exports.name = 'dsh-desktop-link';
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
      } catch (e) { /* 没有 locale 服务就用内置中文 */ }

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-desktop-link',
            order: 92, // 紧挨「桌面」（91）与「桌面更新」（90）
            label: function () { return t('nav'); },
            locale: NS,
          },
          function () { return h(LinkSection, { t: t }); },
        );
      });
    };

    // ---------------------------------------------------------------------
    // 界面
    // ---------------------------------------------------------------------

    /**
     * 调一个联动路由。
     * @param path - 形如 '/status'。
     * @param method - HTTP 方法。
     * @returns Promise，解析为路由的 value。
     */
    var call = function (path, method) {
      return fetch(API + path, {
        method: method || 'GET',
        ...(method && method !== 'GET'
          ? { headers: { 'content-type': 'application/json' }, body: '{}' }
          : {}),
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok || !body || body.ok !== true) {
            var msg = (body && body.error) || ('HTTP ' + res.status);
            throw new Error(msg);
          }
          return body.value;
        });
      });
    };

    var cardStyle = {
      border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.25))',
      borderRadius: '10px',
      padding: '14px 16px',
      marginBottom: '12px',
    };
    var rowStyle = { display: 'flex', alignItems: 'baseline', gap: '10px', margin: '6px 0' };
    var labelStyle = { opacity: 0.65, minWidth: '5.5em', fontSize: '13px' };
    var monoStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
    var codeStyle = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '30px', letterSpacing: '6px', fontWeight: 600,
    };
    var hintStyle = { opacity: 0.6, fontSize: '12.5px', lineHeight: 1.6, margin: '6px 0 0' };
    var warnStyle = { fontSize: '13px', lineHeight: 1.65, margin: '6px 0 0' };
    var errStyle = { color: 'var(--dsw-alias-danger, #d33)', fontSize: '13px', margin: '6px 0 0' };
    var titleStyle = { fontSize: '15px', fontWeight: 600, marginBottom: '2px' };
    var secStyle = { marginBottom: '18px' };

    /**
     * 统一按钮：有宿主原语就用它（样式随主题），没有就退回原生 button。
     * 单独包一层是为了避免在每个调用点写 `Button ? Button : 'button'` 这种三元 ——
     * 那种写法既难读，也很容易把 props 写错。
     */
    var Btn = function (props) {
      if (Button) {
        return h(Button, {
          variant: props.variant || 'outline',
          disabled: props.disabled,
          onClick: props.onClick,
        }, props.children);
      }
      return h('button', {
        disabled: props.disabled,
        onClick: props.onClick,
        style: { cursor: props.disabled ? 'default' : 'pointer' },
      }, props.children);
    };

    /** 「复制」按钮：剪贴板不可用时（非 https / 无权限）明确提示，不假装成功。 */
    var CopyButton = function (props) {
      var state = react.useState('');
      var tip = state[0];
      var setTip = state[1];
      var onCopy = function () {
        var text = String(props.text || '');
        var done = function (ok) {
          setTip(ok ? props.t('copied') : props.t('copyFailed'));
          setTimeout(function () { setTip(''); }, 1500);
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
            return;
          }
        } catch (e) { /* 落到下面的兜底 */ }
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          done(ok);
        } catch (e) { done(false); }
      };
      return h(Btn, { variant: 'ghost', onClick: onCopy }, tip || props.t('copy'));
    };

    /** 一行「标签：值」。 */
    var Row = function (props) {
      return h('div', { style: rowStyle },
        h('span', { style: labelStyle }, props.label),
        h('span', { style: props.mono ? monoStyle : null }, props.children),
      );
    };

    var LinkSection = function (props) {
      var t = props.t;
      var state = react.useState({ snap: null, error: '', busy: '' });
      var st = state[0];
      var setSt = state[1];

      var load = react.useCallback(function () {
        call('/status')
          .then(function (v) {
            setSt(function (s) { return Object.assign({}, s, { snap: v, error: '' }); });
          })
          .catch(function (err) {
            setSt(function (s) { return Object.assign({}, s, { error: String(err && err.message || err) }); });
          });
      }, []);

      react.useEffect(function () {
        load();
        // 服务在跑时自动刷新：配对码会过期、手机会随时连上来，
        // 界面停在一个过期状态会让人以为坏了。
        var timer = setInterval(function () {
          call('/status').then(function (v) {
            setSt(function (s) { return Object.assign({}, s, { snap: v }); });
          }).catch(function () { /* 轮询失败不打扰用户 */ });
        }, 4000);
        return function () { clearInterval(timer); };
      }, [load]);

      var act = function (key, path, method) {
        setSt(function (s) { return Object.assign({}, s, { busy: key, error: '' }); });
        call(path, method)
          .then(function (v) {
            setSt(function (s) { return Object.assign({}, s, { snap: Object.assign({}, s.snap, v), busy: '' }); });
            load();
          })
          .catch(function (err) {
            setSt(function (s) {
              return Object.assign({}, s, { busy: '', error: t('failed') + '：' + String(err && err.message || err) });
            });
          });
      };

      var snap = st.snap || {};
      var nodes = [];
      nodes.push(h('div', { key: 'head', style: secStyle },
        h('div', { style: titleStyle }, t('title')),
        h('p', { style: hintStyle }, t('hint')),
      ));

      // ── 状态与开关 ──────────────────────────────────────────────────────
      var running = !!snap.running;
      nodes.push(h('div', { key: 'svc', style: cardStyle },
        h('div', { style: rowStyle },
          h('span', { style: labelStyle }, '状态'),
          h('span', null, running ? t('running') : t('notRunning')),
          h('span', { style: { flex: 1 } }),
          running
            ? h(Btn, { variant: 'outline', disabled: st.busy === 'stop', onClick: function () { act('stop', '/stop', 'POST'); } }, t('stop'))
            : h(Btn, { variant: 'primary', disabled: st.busy === 'start', onClick: function () { act('start', '/start', 'POST'); } }, t('start')),
        ),
        running && snap.port ? h(Row, { label: t('port'), mono: true }, String(snap.port)) : null,
        running && snap.addresses && snap.addresses.length
          ? h(Row, { label: t('addresses'), mono: true },
            snap.addresses.join('  ') + ' ',
            h(CopyButton, { text: snap.addresses.join(','), t: t }))
          : null,
      ));

      // ── 配对码 ──────────────────────────────────────────────────────────
      if (running) {
        var codeNodes = [];
        if (snap.code) {
          codeNodes.push(h('div', { key: 'c', style: rowStyle },
            h('span', { style: codeStyle }, snap.code),
            h(CopyButton, { text: snap.code, t: t }),
          ));
          codeNodes.push(h('p', { key: 'ch', style: hintStyle }, t('codeHint')));
        } else {
          codeNodes.push(h('p', { key: 'e', style: hintStyle }, t('codeExpired')));
        }
        codeNodes.push(h('div', { key: 'b', style: { marginTop: '10px' } },
          h(Btn, {
            variant: 'ghost',
            disabled: st.busy === 'code',
            onClick: function () { act('code', '/code', 'POST'); },
          }, t('newCode'))));
        nodes.push(h('div', { key: 'code', style: cardStyle },
          h('div', { style: titleStyle }, t('code')),
          codeNodes,
        ));
      }

      // ── 已连设备 ────────────────────────────────────────────────────────
      var conn = snap.connected;
      nodes.push(h('div', { key: 'dev', style: cardStyle },
        h('div', { style: titleStyle }, t('connected')),
        conn
          ? h('div', null,
            h(Row, { label: '设备' }, (conn.device && conn.device.name) || '未知'),
            h(Row, { label: '平台', mono: true }, (conn.device && conn.device.platform) || '未知'),
            h(Row, { label: t('encrypted') }, conn.encrypted ? '✓' : '—'),
            conn.methods && conn.methods.length
              ? h(Row, { label: '能力', mono: true }, conn.methods.length + ' 项')
              : null)
          : h('p', { style: hintStyle }, t('none')),
        h('p', { style: hintStyle }, t('encryptedHint')),
      ));

      // ── 步骤 ────────────────────────────────────────────────────────────
      nodes.push(h('div', { key: 'steps', style: cardStyle },
        h('div', { style: titleStyle }, t('steps')),
        h('ol', { style: { margin: '8px 0 0', paddingLeft: '20px', fontSize: '13px', lineHeight: 1.8 } },
          h('li', null, t('step1')),
          h('li', null, t('step2')),
          h('li', null, t('step3')),
        ),
      ));

      if (st.error) nodes.push(h('p', { key: 'err', style: errStyle }, st.error));
      if (!st.snap) nodes.push(h('p', { key: 'loading', style: hintStyle }, '…'));

      return h('div', null, nodes);
    };

    return exports;
  },
});
