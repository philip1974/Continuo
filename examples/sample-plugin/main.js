// LM 示例插件:演示 9 个贡献点 + loadData/saveData。
//
// 安装:把整个目录拷到 ${userData}/plugins/com.example.sample/,
// 重启 LM,Settings → 插件 → 启用 'Sample Plugin'。
//
// SDK 入口:LM 把 Plugin 基类 + React 暴露在 globalThis.co 上(M-Plugin v4.1)。
// 解构出来后写起来跟 ESM import 一样自然。

const { Plugin, React, PermissionError } = globalThis.co;
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
    // 每秒 dispose + re-register 触发 StatusBar 订阅 → 重渲。
    // (StatusBar item.render 是闭包,改局部变量不会自动重渲;
    //  re-register 让 registry.notify() 推送新订阅)
    let clockDisposable = null;
    const renderClock = () => {
      clockDisposable?.dispose();
      clockDisposable = this.addStatusBarItem({
        id: 'sample.clock',
        side: 'right',
        priority: 50,
        render: () =>
          h(
            'span',
            { className: 'text-fg-dim' },
            `🕐 ${new Date().toLocaleTimeString()}`,
          ),
      });
      this.app.events.emit('sample.tick', Date.now());
    };
    renderClock();
    const interval = setInterval(renderClock, 1000);
    this.register({
      dispose: () => {
        clearInterval(interval);
        clockDisposable?.dispose();
      },
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

    // ── 9. v5 Phase 3 demo:runtime gating ────────────
    // manifest 声明 fs+network,用户授哪些就调哪些;未授调用抛
    // PermissionError,plugin 必须 try/catch 优雅降级。
    this.addCommand({
      id: 'sample.read-tmp',
      title: 'Sample: 读 /tmp 目录(需 fs)',
      fn: async () => {
        try {
          const entries = await this.app.fs.listDir('/tmp');
          alert(`/tmp 共 ${entries.length} 项(前 3:${entries
            .slice(0, 3)
            .map((e) => e.name)
            .join(', ')})`);
        } catch (err) {
          if (err instanceof PermissionError) {
            alert(`fs 权限未授,请在 Settings → 插件 → [权限] 编辑后重试`);
          } else {
            alert(`fs 调用失败:${err.message}`);
          }
        }
      },
    });

    this.addCommand({
      id: 'sample.fetch-zen',
      title: 'Sample: 拉 GitHub Zen(需 network)',
      fn: async () => {
        try {
          const r = await this.app.network.fetch(
            'https://api.github.com/zen',
          );
          const text = await r.text();
          alert(`GitHub Zen: ${text}`);
        } catch (err) {
          if (err instanceof PermissionError) {
            alert(`network 权限未授,请在 Settings → 插件 → [权限] 编辑后重试`);
          } else {
            alert(`network 调用失败:${err.message}`);
          }
        }
      },
    });
  }

  // 父类 _deactivate 自动 LIFO 清理 disposables;此处可选 onunload 加业务卸载
}
