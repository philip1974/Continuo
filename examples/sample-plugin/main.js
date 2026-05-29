// LM 示例插件:演示 9 个贡献点 + loadData/saveData。
//
// 安装:把整个目录拷到 ${userData}/plugins/com.example.sample/,
// 重启 LM,Settings → 插件 → 启用 'Sample Plugin'。
//
// SDK 入口:LM 把 Plugin 基类 + React 暴露在 globalThis.co 上(M-Plugin v4.1)。
// 解构出来后写起来跟 ESM import 一样自然。

const { Plugin, React, PermissionError, z } = globalThis.co;
const h = React.createElement;

function formatDemoError(err) {
  const message = err?.message ?? String(err);
  const name =
    err?.name && err.name !== 'Error'
      ? err.name
      : message.includes('ScopeError')
        ? 'ScopeError'
        : 'Error';
  return `${name}: ${message}`;
}

function SampleV03Settings({ plugin }) {
  const [output, setOutput] = React.useState('Ready.');
  const append = (line) => setOutput((prev) => `${prev}\n${line}`);
  const reset = (line) => setOutput(line);

  const buttonClass =
    'rounded border border-border bg-surface px-2 py-1 text-xs hover:bg-surface-hover';

  // v0.3 SDK demo: path-scope + streaming exec + persistent data store
  const runScopedFsDemo = async () => {
    try {
      reset('Requesting rw scope for /tmp...');
      const decision = await plugin.app.fs.requestScope([
        { path: '/tmp', mode: 'rw' },
      ]);
      if (decision !== 'grant') {
        append('scope denied');
        return;
      }
      await plugin.app.fs.writeFile(
        '/tmp/sample-plugin-demo.txt',
        'hello from v0.3',
      );
      const text = await plugin.app.fs.readFile('/tmp/sample-plugin-demo.txt');
      append(`read back: ${text}`);
    } catch (err) {
      reset(formatDemoError(err));
    }
  };

  const runFsWithoutRequestScope = async () => {
    try {
      reset('Reading /tmp/x without requestScope...');
      const text = await plugin.app.fs.readFile('/tmp/x');
      append(`unexpected success: ${text}`);
    } catch (err) {
      reset(formatDemoError(err));
    }
  };

  const runStreamingExecDemo = async () => {
    try {
      reset('Streaming exec output:');
      const script = [
        '(async()=>{',
        'for(let i=0;i<5;i++){',
        "process.stdout.write('chunk'+i+'\\n');",
        'await new Promise(r=>setTimeout(r,500));',
        '}',
        '})().catch(e=>{console.error(e);process.exit(1);})',
      ].join('');
      const { chunks, done } = await plugin.app.shell.execStream('node', [
        '-e',
        script,
      ]);
      for await (const item of chunks) {
        const text = new TextDecoder().decode(item.chunk);
        append(`${item.stream}: ${text.trimEnd()}`);
      }
      const result = await done;
      append(`[exited ${result.exitCode ?? result.signal}]`);
    } catch (err) {
      reset(formatDemoError(err));
    }
  };

  const persistCounter = async () => {
    try {
      const data = (await plugin.loadData()) ?? {};
      const counter = Number(data.counter ?? 0) + 1;
      await plugin.saveData({ ...data, counter, lastCounterAt: Date.now() });
      reset(`persistent counter: ${counter}`);
    } catch (err) {
      reset(formatDemoError(err));
    }
  };

  return h(
    'div',
    { className: 'space-y-2 text-xs' },
    h('p', null, `${plugin.manifest.name} v${plugin.manifest.version}`),
    h('p', { className: 'text-fg-dim' }, plugin.manifest.description),
    h('p', { className: 'text-fg-dim' }, '快捷键:⌘⇧H 触发 hello'),
    h(
      'div',
      { className: 'flex flex-wrap gap-2 pt-2' },
      h('button', { className: buttonClass, onClick: runScopedFsDemo }, 'Run scoped fs demo'),
      h('button', { className: buttonClass, onClick: runFsWithoutRequestScope }, 'Run fs without requestScope'),
      h('button', { className: buttonClass, onClick: runStreamingExecDemo }, 'Run streaming exec demo'),
      h('button', { className: buttonClass, onClick: persistCounter }, 'Persist counter'),
    ),
    h(
      'pre',
      {
        className:
          'max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface-muted p-2 text-xs',
      },
      output,
    ),
  );
}

export default class SamplePlugin extends Plugin {
  async onload() {
    // ── 1. 命令 ────────────────────────────────────────
    this.addCommand({
      id: 'sample.hello',
      title: 'Hello World',
      category: 'Sample',
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
      render: () => h(SampleV03Settings, { plugin: this }),
    });

    // ── 6. Explorer 装饰(给 .md 文件加 'MD' badge) ──
    this.registerExplorerDecorator((entry) => {
      if (entry.isDirectory) return null;
      if (!entry.path.endsWith('.md')) return null;
      return { badge: 'MD', badgeColor: 'var(--md-primary)' };
    });

    // ── 6c. Explorer 右键菜单(V1 demo:.md 文件加"复制相对路径") ─
    // plugin 通过 registerExplorerContextMenuItem 给 Explorer 右键菜单
    // 加项。group 决定排序(内置 'new'/'edit'/'plugin'/'danger' 之外的
    // 自定义 group 紧跟 'plugin' 段后)。when 谓词决定显隐。
    this.registerExplorerContextMenuItem({
      id: 'sample.copy-path',
      label: '复制相对路径',
      group: 'plugin',
      when: (ctx) =>
        ctx.target !== null && ctx.target.path.endsWith('.md'),
      fn: async (ctx) => {
        if (!ctx.target) return;
        const rel = ctx.target.path.startsWith(ctx.rootPath)
          ? ctx.target.path.slice(ctx.rootPath.length).replace(/^\/+/, '')
          : ctx.target.path;
        try {
          await this.app.clipboard.writeText(rel);
          alert(`已复制相对路径: ${rel}`);
        } catch (err) {
          if (err instanceof PermissionError) {
            alert('clipboard 权限未授,无法复制');
          } else {
            alert(`复制失败: ${err.message}`);
          }
        }
      },
    });

    // ── 6b. Explorer icon(V2 demo:.secret → 🔐 替换默认 icon) ─
    // plugin 通过 Decoration.icon 贡献任意 ReactNode 替换 file-icon
    // 默认按扩展名映射的图标。typical 用例:git modified 状态、加密标记、
    // 第三方语言扩展自带 icon。
    this.registerExplorerDecorator((entry) => {
      if (entry.isDirectory) return null;
      if (!entry.path.endsWith('.secret')) return null;
      return {
        icon: h(
          'span',
          {
            style: { fontSize: 14, lineHeight: 1 },
            'aria-hidden': 'true',
          },
          '🔐',
        ),
        tooltip: '加密文件(plugin 贡献 icon 演示)',
      };
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
      title: '读 /tmp 目录(需 fs)',
      category: 'Sample',
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
      title: '拉 GitHub Zen(需 network)',
      category: 'Sample',
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

    // ── 10. v5 Phase 4 demo:MCP tool(暴露给 Agent / Claude Code) ──
    // 注册成功后,持 CONTINUO_MCP_TOKEN 的 MCP client 调
    //   tools/list  → 返回 sample.echo
    //   tools/call name=sample.echo arguments={text:"hi"}
    // → 把 input 转回 renderer plugin run 闭包,返回 {echoed, from, ts}。
    try {
      await this.registerMcpTool({
        name: 'sample.echo',
        description: '回显 input.text 并附 plugin id,演示 plugin 注册 MCP tool',
        jsonSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要回显的文本' },
          },
          required: ['text'],
          additionalProperties: false,
        },
        inputSchema: z.object({ text: z.string() }).strict(),
        run: ({ text }) => ({
          echoed: text,
          from: this.manifest.id,
          ts: Date.now(),
        }),
      });
    } catch (err) {
      if (err instanceof PermissionError) {
        console.warn(
          '[sample-plugin] mcp-tools 权限未授,sample.echo 未注册',
        );
      } else {
        console.warn('[sample-plugin] sample.echo 注册失败', err);
      }
    }
  }

  // 父类 _deactivate 自动 LIFO 清理 disposables;此处可选 onunload 加业务卸载
}
