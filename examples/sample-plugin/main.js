// LM 示例插件:演示 9 个贡献点 + loadData/saveData。
//
// 安装:把整个目录拷到 ${userData}/plugins/com.example.sample/,
// 重启 LM,Settings → 插件 → 启用 'Sample Plugin'。
//
// 注意:
// - 必须 export default class extends Plugin,Plugin 来自 LM 内部模块。
//   生产 LM 会用动态 import + Blob URL 加载本文件,this.* 都已绑好。
// - 所有 register* / addCommand 等返回 Disposable,LM 自动收集,
//   插件 disable 时全部 LIFO 清理,无需手动 cleanup。
// - 本示例使用 LM 全局暴露的 React + Plugin 基类(通过解构 import 拿到)。

// LM 在 renderer 通过 Blob URL import 本文件,React 不在 import path 内,
// 但 LM 会把 Plugin 基类挂在 globalThis.lm 上以便 ESM 直接拿到。
// 暂时简化:用相对路径 import LM 内部模块(开发期 alias / 生产 bundle 时
// 由打包工具处理)。最终方案是 LM 暴露 'lm' 模块。
//
// 演示 API 形态(伪代码,实际使用时按 LM 的 plugin SDK 文档对接):

export default class SamplePlugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this._disposables = [];
  }

  async onload() {
    const { app } = this;

    // ── 1. 命令 ────────────────────────────────────────
    this._disposables.push(
      app.commands.register({
        id: 'sample.hello',
        title: 'Sample: Hello World',
        hotkey: 'mod+shift+h',
        fn: () => {
          alert(`Hello from ${this.manifest.name} v${this.manifest.version}!`);
        },
      }),
    );

    // ── 2. StatusBar 时钟 ─────────────────────────────
    let now = new Date().toLocaleTimeString();
    const updateClock = () => {
      now = new Date().toLocaleTimeString();
      app.events.emit('sample.tick', now);
    };
    const interval = setInterval(updateClock, 1000);
    this._disposables.push({ dispose: () => clearInterval(interval) });

    this._disposables.push(
      app.statusBar.register({
        id: 'sample.clock',
        side: 'right',
        priority: 50,
        render: () =>
          // React.createElement 写法,因为本插件无 JSX 编译
          this._react('span', { className: 'text-fg-dim' }, `🕐 ${now}`),
      }),
    );

    // ── 3. Ribbon 图标 ────────────────────────────────
    this._disposables.push(
      app.ribbon.register({
        id: 'sample.action',
        title: 'Sample Action',
        icon: this._react('span', { className: 'text-base' }, '🧩'),
        onClick: () => app.commands.execute('sample.hello'),
      }),
    );

    // ── 4. 事件订阅(自家 emit 自家收) ──────────────
    this._disposables.push(
      app.events.on('sample.tick', (timeStr) => {
        // 每秒触发,这里仅 console 演示;生产可更新视图等
        // console.debug('[sample] tick', timeStr);
      }),
    );

    // ── 5. Settings tab ──────────────────────────────
    this._disposables.push(
      app.settingTabs.register({
        id: 'sample',
        title: 'Sample',
        priority: 80,
        render: () =>
          this._react(
            'div',
            { className: 'space-y-2 text-xs' },
            this._react('p', null, `${this.manifest.name} v${this.manifest.version}`),
            this._react('p', { className: 'text-fg-dim' }, this.manifest.description),
            this._react(
              'p',
              { className: 'text-fg-dim' },
              '快捷键:⌘⇧H 触发 hello',
            ),
          ),
      }),
    );

    // ── 6. Explorer 装饰(给 .md 文件加 'MD' badge) ──
    this._disposables.push(
      app.explorerDecorators.register((entry) => {
        if (entry.isDirectory) return null;
        if (!entry.path.endsWith('.md')) return null;
        return { badge: 'MD', badgeColor: 'var(--md-primary)' };
      }),
    );

    // ── 7. Editor action(仅 markdown 显示) ─────────
    this._disposables.push(
      app.editorActions.register({
        id: 'sample.uppercase',
        label: '大写',
        when: (ctx) => ctx.filePath?.endsWith('.md') ?? false,
        fn: () => alert('Uppercase action triggered!'),
      }),
    );

    // ── 8. 持久化:loadData/saveData ─────────────────
    const data = await app.dataStore.read(this.manifest.id);
    if (data) {
      // console.debug('[sample] loaded data:', data);
    }
    await app.dataStore.write(this.manifest.id, {
      lastLoadedAt: Date.now(),
    });
  }

  async onunload() {
    // 父类已 LIFO 清理 disposables;这里不需要重复。
    // (注:本示例没继承真 Plugin 父类,因为 SDK 还未通过 'lm' 模块暴露;
    // 真接入时 extends Plugin,disposables 由父类 register() 收集。)
    for (let i = this._disposables.length - 1; i >= 0; i--) {
      try { this._disposables[i].dispose(); } catch {}
    }
    this._disposables = [];
  }

  // 临时 helper:本示例直接用 React.createElement(LM 把 React 挂全局
  // 给 plugin 用,见 doc/10 §13 第 4 个开放问题)。生产 LM 完成后
  // 改为 ESM import 'react'。
  _react(type, props, ...children) {
    return globalThis.React?.createElement(type, props, ...children) ?? null;
  }
}
