/**
 * 「技能与 MCP」管理面板 —— 客户端（浏览器）入口。
 *
 * 注册到 slot `settings.section`：设置页左侧多一个「技能与 MCP」导航项。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 这两样在 DSH 里都是**文件/配置驱动、没有界面**的：
 *   · 技能 = 若干技能根目录下的 `<name>/SKILL.md`，要自己知道放哪、frontmatter 怎么写
 *   · MCP  = 补丁层里的 `- insert:` YAML 条目，手写极易把 YAML 写坏（dsh 会起不来）
 * 这里把它们收敛成可点、可填、可删的界面。
 *
 * ── 布局 ────────────────────────────────────────────────────────────────────
 * 与「桌面适配」面板同一套：宿主设计变量（--dsw-alias-*）+ settings-form 的行结构，
 * 深浅色主题自动跟随，和插件市场观感一致。
 *
 * 数据来自 preload 暴露的 window.dshDesktop.{listSkills,createSkill,...}；
 * 外壳没暴露时优雅降级为一行提示，不影响设置页其它部分。
 */
window.__ModuleLoader__.load({
  id: '@dsh-desktop/skill-mcp',
  factory: (require) => {
    var exports = {};
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var h = react.createElement;

    var NS = 'dsh-desktop-skill-mcp';

    var ZH = {
      nav: '技能与 MCP',
      skills: '技能',
      skillsHint: '放在用户技能目录下的 SKILL.md，Harness 启动时自动发现。',
      mcp: 'MCP 服务器',
      mcpHint: 'Model Context Protocol 服务器。改完需要重启 Harness 才生效。',
      unavailable: '当前外壳未提供管理接口（需 10.1.9 及以上）',
      loading: '正在加载…',
      empty: '还没有技能。点「新建」创建一个。',
      emptyMcp: '还没有配置 MCP 服务器。点「添加」新增一个。',
      create: '新建',
      add: '添加',
      del: '删除',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      openDir: '打开技能目录',
      name: '名称',
      description: '说明',
      nameHint: '小写字母、数字、连字符；会成为目录名',
      descHint: '一句话说明它做什么、什么时候该用',
      serverName: '服务器名',
      serverNameHint: '工具命名空间前缀，如 filesystem',
      transport: '传输方式',
      command: '命令',
      args: '参数',
      argsHint: '每行一个',
      env: '环境变量',
      envHint: '每行 KEY=value',
      url: '地址',
      cwd: '工作目录',
      enabled: '启用',
      confirmDelete: '确定删除技能',
      confirmDeleteMcp: '确定删除 MCP 服务器',
      sourceUser: '用户',
      sourceProject: '项目',
      saved: '已保存',
      needRestart: 'MCP 改动需要重启 Harness 才生效。',
      fail: '操作失败',
    };
    var EN = {
      nav: 'Skills & MCP',
      skills: 'Skills',
      skillsHint: 'SKILL.md files under the user skill directory; discovered at Harness startup.',
      mcp: 'MCP servers',
      mcpHint: 'Model Context Protocol servers. Restart Harness to apply changes.',
      unavailable: 'Management API unavailable (needs shell 10.1.9+)',
      loading: 'Loading…',
      empty: 'No skills yet. Click New to create one.',
      emptyMcp: 'No MCP servers configured. Click Add to add one.',
      create: 'New',
      add: 'Add',
      del: 'Delete',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      openDir: 'Open skills folder',
      name: 'Name',
      description: 'Description',
      nameHint: 'Lowercase letters, digits, hyphens; becomes the folder name',
      descHint: 'One line: what it does and when to use it',
      serverName: 'Server name',
      serverNameHint: 'Tool namespace prefix, e.g. filesystem',
      transport: 'Transport',
      command: 'Command',
      args: 'Arguments',
      argsHint: 'One per line',
      env: 'Environment',
      envHint: 'KEY=value per line',
      url: 'URL',
      cwd: 'Working directory',
      enabled: 'Enabled',
      confirmDelete: 'Delete skill',
      confirmDeleteMcp: 'Delete MCP server',
      sourceUser: 'user',
      sourceProject: 'project',
      saved: 'Saved',
      needRestart: 'MCP changes take effect after restarting Harness.',
      fail: 'Failed',
    };

    exports.name = 'dsh-desktop-skill-mcp';
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
      } catch (e) { /* 宿主没有 locale 服务时退回内置中文 */ }

      var bridge = (typeof window !== 'undefined' && window.dshDesktop) || null;

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-desktop-skill-mcp',
            order: 92, // 紧挨「桌面」（91）
            label: function () { return t('nav'); },
            locale: NS,
          },
          function () { return h(Panel, { t: t, bridge: bridge }); },
        );
      });
    };

    // -----------------------------------------------------------------------
    // 界面
    // -----------------------------------------------------------------------
    var Panel = function (props) {
      var t = props.t;
      var bridge = props.bridge;
      var supported = !!bridge && typeof bridge.listSkills === 'function';
      if (!supported) return h('p', { style: hintStyle }, t('unavailable'));

      return h('div', null,
        h(SkillsSection, { t: t, bridge: bridge }),
        h('div', { style: dividerStyle }),
        h(McpSection, { t: t, bridge: bridge }),
      );
    };

    // ── 技能 ────────────────────────────────────────────────────────────────
    var SkillsSection = function (props) {
      var t = props.t, bridge = props.bridge;
      var s = react.useState({ items: [], loading: true, error: '', creating: false, busy: '' });
      var st = s[0], setSt = s[1];
      var draft = react.useState({ name: '', description: '' });
      var d = draft[0], setDraft = draft[1];

      var load = react.useCallback(function () {
        setSt(function (p) { return Object.assign({}, p, { loading: true, error: '' }); });
        Promise.resolve(bridge.listSkills())
          .then(function (r) {
            setSt(function (p) {
              return Object.assign({}, p, {
                items: (r && r.skills) || [],
                loading: false,
                error: (r && r.error) || '',
              });
            });
          })
          .catch(function (e) {
            setSt(function (p) { return Object.assign({}, p, { loading: false, error: String(e) }); });
          });
      }, [bridge]);
      react.useEffect(function () { load(); }, [load]);

      var create = function () {
        if (!d.name) return;
        setSt(function (p) { return Object.assign({}, p, { busy: '__create', error: '' }); });
        Promise.resolve(bridge.createSkill(d.name, d.description))
          .then(function (r) {
            if (r && r.error) throw new Error(r.error);
            setDraft({ name: '', description: '' });
            setSt(function (p) { return Object.assign({}, p, { creating: false, busy: '' }); });
            load();
          })
          .catch(function (e) {
            setSt(function (p) { return Object.assign({}, p, { busy: '', error: String(e.message || e) }); });
          });
      };

      var remove = function (name) {
        if (!window.confirm(t('confirmDelete') + '「' + name + '」？')) return;
        setSt(function (p) { return Object.assign({}, p, { busy: name, error: '' }); });
        Promise.resolve(bridge.deleteSkill(name))
          .then(function (r) {
            if (r && r.error) throw new Error(r.error);
            setSt(function (p) { return Object.assign({}, p, { busy: '' }); });
            load();
          })
          .catch(function (e) {
            setSt(function (p) { return Object.assign({}, p, { busy: '', error: String(e.message || e) }); });
          });
      };

      return h('div', null,
        h(GroupHead, { title: t('skills'), desc: t('skillsHint') }),
        h('div', { style: actionsStyle },
          h('button', {
            type: 'button', style: ghostBtn,
            onClick: function () { setSt(function (p) { return Object.assign({}, p, { creating: !p.creating }); }); },
          }, t('create')),
          h('button', {
            type: 'button', style: ghostBtn,
            onClick: function () { Promise.resolve(bridge.openSkillsDir()).catch(function () {}); },
          }, t('openDir')),
        ),
        st.creating ? h('div', { style: formBox },
          h(Field, { label: t('name'), hint: t('nameHint'),
            input: h('input', { style: inputStyle, value: d.name,
              onChange: function (e) { setDraft(Object.assign({}, d, { name: e.target.value })); } }) }),
          h(Field, { label: t('description'), hint: t('descHint'),
            input: h('input', { style: inputStyle, value: d.description,
              onChange: function (e) { setDraft(Object.assign({}, d, { description: e.target.value })); } }) }),
          h('div', { style: actionsStyle },
            h('button', { type: 'button', style: primaryBtn, disabled: st.busy === '__create', onClick: create },
              st.busy === '__create' ? t('saving') : t('save')),
            h('button', { type: 'button', style: ghostBtn,
              onClick: function () { setSt(function (p) { return Object.assign({}, p, { creating: false }); }); } }, t('cancel')),
          ),
        ) : null,
        st.loading ? h('p', { style: hintStyle }, t('loading'))
          : st.items.length === 0 ? h('p', { style: hintStyle }, t('empty'))
          : h('div', null, st.items.map(function (it) {
              return h('div', { key: it.file, style: rowStyle },
                h('div', { style: rowTextStyle },
                  h('div', { style: rowLabelStyle },
                    it.name,
                    h('span', { style: badgeStyle },
                      it.source === 'user-dsh' ? t('sourceUser') : t('sourceProject')),
                  ),
                  it.description ? h('div', { style: rowDescStyle }, it.description) : null,
                ),
                it.removable
                  ? h('button', { type: 'button', style: dangerBtn, disabled: st.busy === it.name,
                      onClick: function () { remove(it.name); } }, t('del'))
                  : null,
              );
            })),
        st.error ? h('p', { style: errorStyle }, t('fail') + '：' + st.error) : null,
      );
    };

    // ── MCP ─────────────────────────────────────────────────────────────────
    var McpSection = function (props) {
      var t = props.t, bridge = props.bridge;
      var s = react.useState({ servers: [], loading: true, error: '', editing: null, busy: false });
      var st = s[0], setSt = s[1];

      var load = react.useCallback(function () {
        Promise.resolve(bridge.listMcpServers())
          .then(function (r) {
            setSt(function (p) {
              return Object.assign({}, p, {
                servers: (r && r.servers) || [], loading: false, error: (r && r.error) || '',
              });
            });
          })
          .catch(function (e) {
            setSt(function (p) { return Object.assign({}, p, { loading: false, error: String(e) }); });
          });
      }, [bridge]);
      react.useEffect(function () { load(); }, [load]);

      var blank = function () {
        return { id: '', serverName: '', enabled: true, transport: 'stdio', command: '', args: [], env: {}, url: '' };
      };

      var persist = function (next, done) {
        setSt(function (p) { return Object.assign({}, p, { busy: true, error: '' }); });
        Promise.resolve(bridge.saveMcpServers(next))
          .then(function (r) {
            if (r && r.error) throw new Error(r.error);
            setSt(function (p) { return Object.assign({}, p, { busy: false, servers: (r && r.servers) || next, editing: null }); });
            if (done) done();
          })
          .catch(function (e) {
            setSt(function (p) { return Object.assign({}, p, { busy: false, error: String(e.message || e) }); });
          });
      };

      var saveEditing = function () {
        var e = st.editing;
        if (!e) return;
        var item = {
          id: e.id || 'mcp-' + e.serverName,
          serverName: e.serverName,
          enabled: e.enabled !== false,
          transport: e.transport,
        };
        if (e.transport === 'stdio') {
          item.command = e.command;
          item.args = (e.argsText || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
          var env = {};
          (e.envText || '').split(/\r?\n/).forEach(function (line) {
            var i = line.indexOf('=');
            if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
          });
          if (Object.keys(env).length) item.env = env;
          if (e.cwd) item.cwd = e.cwd;
        } else {
          item.url = e.url;
        }
        var next = st.servers.filter(function (x) { return x.serverName !== (st.editing.originalName || e.serverName); });
        next.push(item);
        persist(next);
      };

      return h('div', null,
        h(GroupHead, { title: t('mcp'), desc: t('mcpHint') }),
        h('div', { style: actionsStyle },
          h('button', { type: 'button', style: ghostBtn,
            onClick: function () { setSt(function (p) { return Object.assign({}, p, { editing: blank() }); }); } }, t('add')),
        ),
        st.editing ? h('div', { style: formBox },
          h(Field, { label: t('serverName'), hint: t('serverNameHint'),
            input: h('input', { style: inputStyle, value: st.editing.serverName || '',
              onChange: function (e) { setSt(function (p) { return Object.assign({}, p, { editing: Object.assign({}, p.editing, { serverName: e.target.value }) }); }); } }) }),
          h(Field, { label: t('transport'),
            input: h('select', { style: inputStyle, value: st.editing.transport,
              onChange: function (e) { setSt(function (p) { return Object.assign({}, p, { editing: Object.assign({}, p.editing, { transport: e.target.value }) }); }); } },
              h('option', { value: 'stdio' }, 'stdio'),
              h('option', { value: 'streamable-http' }, 'streamable-http')) }),
          st.editing.transport === 'stdio' ? h('div', null,
            h(Field, { label: t('command'),
              input: h('input', { style: inputStyle, value: st.editing.command || '',
                onChange: function (e) { setSt(function (p) { return Object.assign({}, p, { editing: Object.assign({}, p.editing, { command: e.target.value }) }); }); } }) }),
            h(Field, { label: t('args'), hint: t('argsHint'),
              input: h('textarea', { style: textareaStyle, rows: 3, value: st.editing.argsText || '',
                onChange: function (e) { setSt(function (p) { return Object.assign({}, p, { editing: Object.assign({}, p.editing, { argsText: e.target.value }) }); }); } }) }),
            h(Field, { label: t('env'), hint: t('envHint'),
              input: h('textarea', { style: textareaStyle, rows: 2, value: st.editing.envText || '',
                onChange: function (e) { setSt(function (p) { return Object.assign({}, p, { editing: Object.assign({}, p.editing, { envText: e.target.value }) }); }); } }) }),
          ) : h(Field, { label: t('url'),
            input: h('input', { style: inputStyle, value: st.editing.url || '',
              onChange: function (e) { setSt(function (p) { return Object.assign({}, p, { editing: Object.assign({}, p.editing, { url: e.target.value }) }); }); } }) }),
          h('div', { style: actionsStyle },
            h('button', { type: 'button', style: primaryBtn, disabled: st.busy, onClick: saveEditing },
              st.busy ? t('saving') : t('save')),
            h('button', { type: 'button', style: ghostBtn,
              onClick: function () { setSt(function (p) { return Object.assign({}, p, { editing: null }); }); } }, t('cancel')),
          ),
        ) : null,
        st.loading ? h('p', { style: hintStyle }, t('loading'))
          : st.servers.length === 0 ? h('p', { style: hintStyle }, t('emptyMcp'))
          : h('div', null, st.servers.map(function (it) {
              return h('div', { key: it.serverName, style: rowStyle },
                h('div', { style: rowTextStyle },
                  h('div', { style: rowLabelStyle }, it.serverName,
                    h('span', { style: badgeStyle }, it.transport)),
                  h('div', { style: rowDescStyle },
                    it.transport === 'stdio'
                      ? [it.command].concat(it.args || []).join(' ')
                      : String(it.url || '')),
                ),
                h('div', { style: rowBtnGroup },
                  h('button', { type: 'button', style: ghostBtn,
                    onClick: function () {
                      setSt(function (p) { return Object.assign({}, p, { editing: Object.assign({}, it, {
                        originalName: it.serverName,
                        argsText: (it.args || []).join('\n'),
                        envText: Object.entries(it.env || {}).map(function (kv) { return kv[0] + '=' + kv[1]; }).join('\n'),
                      }) }); });
                    } }, '编辑'),
                  h('button', { type: 'button', style: dangerBtn,
                    onClick: function () {
                      if (!window.confirm(t('confirmDeleteMcp') + '「' + it.serverName + '」？')) return;
                      persist(st.servers.filter(function (x) { return x.serverName !== it.serverName; }));
                    } }, t('del')),
                ),
              );
            })),
        h('p', { style: hintStyle }, t('needRestart')),
        st.error ? h('p', { style: errorStyle }, t('fail') + '：' + st.error) : null,
      );
    };

    // ── 小组件 ──────────────────────────────────────────────────────────────
    function GroupHead(props) {
      return h('div', { style: groupHeadStyle },
        h('span', { style: groupTitleStyle }, props.title),
        h('span', { style: groupDescStyle }, props.desc),
      );
    }
    function Field(props) {
      return h('div', { style: fieldStyle },
        h('div', { style: fieldLabelStyle }, props.label),
        props.input,
        props.hint ? h('div', { style: fieldHintStyle }, props.hint) : null,
      );
    }

    // ── 样式（一律走宿主设计变量）────────────────────────────────────────────
    var hintStyle = { margin: '0 0 10px', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' };
    var dividerStyle = { margin: '24px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2)' };
    var groupHeadStyle = { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '0 0 6px' };
    var groupTitleStyle = { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' };
    var groupDescStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' };
    var rowStyle = {
      display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0',
      borderTop: '0.5px solid var(--dsw-alias-border-l2)',
    };
    var rowTextStyle = { flex: '1', minWidth: 0 };
    var rowLabelStyle = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' };
    var rowDescStyle = { marginTop: '2px', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' };
    var rowBtnGroup = { display: 'flex', gap: '6px', flex: 'none' };
    var badgeStyle = {
      fontSize: '11px', padding: '1px 6px', borderRadius: '9px',
      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-tertiary)',
    };
    var formBox = {
      margin: '10px 0', padding: '12px', borderRadius: 'var(--dsw-radius-md)',
      background: 'var(--dsw-alias-bg-layer-2)', display: 'flex', flexDirection: 'column', gap: '10px',
    };
    var fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
    var fieldLabelStyle = { fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' };
    var fieldHintStyle = { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' };
    var inputStyle = {
      height: '30px', padding: '0 10px', font: 'inherit', fontSize: '13px',
      border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-md)',
      background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
    };
    var textareaStyle = Object.assign({}, inputStyle, { height: 'auto', padding: '6px 10px', resize: 'vertical' });
    var actionsStyle = { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' };
    var ghostBtn = {
      appearance: 'none', border: '0.5px solid var(--dsw-alias-border-l4)', background: 'none',
      color: 'var(--dsw-alias-label-primary)', borderRadius: 'var(--dsw-radius-md)',
      padding: '4px 12px', font: 'inherit', fontSize: '12px', cursor: 'pointer',
    };
    var primaryBtn = {
      appearance: 'none', border: '1px solid transparent', background: 'var(--dsw-alias-label-primary)',
      color: 'var(--dsw-alias-bg-layer-3)', borderRadius: 'var(--dsw-radius-md)',
      padding: '4px 14px', font: 'inherit', fontSize: '12px', cursor: 'pointer',
    };
    var dangerBtn = Object.assign({}, ghostBtn, { color: 'var(--dsw-alias-state-error-primary)' });
    var errorStyle = { margin: '8px 0 0', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' };

    return exports;
  },
});
