// LM 示例插件:演示 9 个贡献点 + loadData/saveData。
//
// 安装:把整个目录拷到 ${userData}/plugins/com.example.sample/,
// 重启 LM,Settings → 插件 → 启用 'Sample Plugin'。
//
// SDK 入口:LM 把 Plugin 基类 + React 暴露在 globalThis.lm 上(M-Plugin v4.1)。
// 解构出来后写起来跟 ESM import 一样自然。

const { Plugin, React } = globalThis.lm;
const h = React.createElement;

export default class SamplePlugin extends Plugin {
  async onload() {
    // ── 1. 命令 ────────────────────────────────────────
    this.addCommand({
      id: 'sample.hello',
      title: 'Sample: Hello World',
      hotkey: 'mod+shift+h',
      fn: () => {
        alert(
          `Hello from ${this.manifest.name} v${this.manifest.version}!`,
        );
      },
    });

    // ── 2. StatusBar 时钟 ─────────────────────────────
    let now = new Date().toLocaleTimeString();
    const updateClock = () => {
      now = new Date().toLocaleTimeString();
      this.app.events.emit('sample.tick', now);
    };
    const interval = setInterval(updateClock, 1000);
    this.register({ dispose: () => clearInterval(interval) });

    this.addStatusBarItem({
      id: 'sample.clock',
      side: 'right',
      priority: 50,
      render: () => h('span', { className: 'text-fg-dim' }, `🕐 ${now}`),
    });

    // ── 3. Ribbon 图标 ────────────────────────────────
    this.addRibbonAction({
      id: 'sample.action',
      title: 'Sample Action',
      icon: h('span', { className: 'text-base' }, '🧩'),
      onClick: () => this.app.commands.execute('sample.hello'),
    });

    // ── 4. 事件订阅(自家 emit 自家收) ──────────────
    this.registerEvent({
      name: 'sample.tick',
      fn: (_timeStr) => {
        // 每秒触发,这里仅作为订阅链路验证
      },
    });

    // ── 5. Settings tab ──────────────────────────────
    this.addSettingTab({
      id: 'sample',
      title: 'Sample',
      priority: 80,
      render: () =>
        h(
          'div',
          { className: 'space-y-2 text-xs' },
          h('p', null, `${this.manifest.name} v${this.manifest.version}`),
          h('p', { className: 'text-fg-dim' }, this.manifest.description),
          h('p', { className: 'text-fg-dim' }, '快捷键:⌘⇧H 触发 hello'),
        ),
    });

    // ── 6. Explorer 装饰(给 .md 文件加 'MD' badge) ──
    this.registerExplorerDecorator((entry) => {
      if (entry.isDirectory) return null;
      if (!entry.path.endsWith('.md')) return null;
      return { badge: 'MD', badgeColor: 'var(--md-primary)' };
    });

    // ── 7. Editor action(仅 markdown 显示) ─────────
    this.registerEditorAction({
      id: 'sample.uppercase',
      label: '大写',
      when: (ctx) => Boolean(ctx.filePath?.endsWith('.md')),
      fn: () => alert('Uppercase action triggered!'),
    });

    // ── 8. 持久化:loadData/saveData ─────────────────
    const data = await this.loadData();
    if (data) {
      // 上次启动信息可用,演示 loadData 回路
    }
    await this.saveData({ lastLoadedAt: Date.now() });
  }

  // 父类 _deactivate 自动 LIFO 清理 disposables;此处可选 onunload 加业务卸载
}
