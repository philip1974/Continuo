// '插件' SettingTab 内容(M-Plugin v3.5)。
// 自检视图:贡献点统计 + 内置插件清单 + 用户插件占位(等 v4 IPC)。

import { useEffect, useState } from 'react';
import { Button } from '@/design';
import { lmApp } from '../lm-app';
import { getUserPluginManager } from '../lm-plugin-manager';
import type { PluginListItem } from '../PluginManager';

interface ContributionRow {
  readonly label: string;
  readonly count: number;
  readonly samples: readonly string[];
}

function snapshot(): readonly ContributionRow[] {
  return [
    {
      label: 'Panel 类型',
      count: lmApp.panels.getAll().length,
      samples: lmApp.panels.getAll().map((p) => p.type),
    },
    {
      label: '命令',
      count: lmApp.commands.getAll().length,
      samples: lmApp.commands.getAll().map((c) => c.id),
    },
    {
      label: 'StatusBar 项',
      count: [
        ...lmApp.statusBar.getBySide('left'),
        ...lmApp.statusBar.getBySide('right'),
      ].length,
      samples: [
        ...lmApp.statusBar.getBySide('left'),
        ...lmApp.statusBar.getBySide('right'),
      ].map((x) => x.id),
    },
    {
      label: 'Ribbon 图标',
      count: lmApp.ribbon.getAll().length,
      samples: lmApp.ribbon.getAll().map((r) => r.id),
    },
    {
      label: '设置 Tab',
      count: lmApp.settingTabs.getAll().length,
      samples: lmApp.settingTabs.getAll().map((t) => t.id),
    },
    {
      label: 'Explorer 装饰器',
      count: lmApp.explorerDecorators.getAll().length,
      samples: [],
    },
    {
      label: 'Editor Action',
      count: lmApp.editorActions.getAll().length,
      samples: lmApp.editorActions.getAll().map((a) => a.id),
    },
  ];
}

function useContributionSnapshot(): readonly ContributionRow[] {
  const [snap, setSnap] = useState(() => snapshot());
  useEffect(() => {
    // 任一 registry 变 → 重新计算。subscribe 全部,挂接到一个 setSnap。
    const refresh = () => setSnap(snapshot());
    const u1 = lmApp.panels.subscribe(refresh);
    const u2 = lmApp.commands.subscribe(refresh);
    const u3 = lmApp.statusBar.subscribe(refresh);
    const u4 = lmApp.ribbon.subscribe(refresh);
    const u5 = lmApp.settingTabs.subscribe(refresh);
    const u6 = lmApp.editorActions.subscribe(refresh);
    return () => {
      u1();
      u2();
      u3();
      u4();
      u5();
      u6();
    };
  }, []);
  return snap;
}

const CORE_PLUGINS = [
  { id: 'core.editor', name: 'Editor', desc: '内置编辑器面板(markdown / 代码)' },
  { id: 'core.terminal', name: 'Terminal', desc: '内置终端面板(node-pty)' },
  { id: 'core.output', name: 'Output', desc: '内置输出日志面板' },
  { id: 'core.plugins', name: '插件管理', desc: '本 Tab 自身,显示插件系统自检视图' },
];

export function PluginsTabContent() {
  const contribs = useContributionSnapshot();

  return (
    <div className="space-y-6">
      {/* ── 贡献点统计 ──────────────────────────────── */}
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-dim">
          已注册贡献点
        </h3>
        <div className="rounded border border-line bg-panel-soft/40">
          {contribs.map((row, i) => (
            <div
              key={row.label}
              className={[
                'flex items-start gap-3 px-3 py-2 text-xs',
                i > 0 ? 'border-t border-line' : '',
              ].join(' ')}
            >
              <div className="w-32 shrink-0 text-fg-muted">{row.label}</div>
              <div className="w-8 shrink-0 text-right tabular-nums text-fg">
                {row.count}
              </div>
              <div className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-dim">
                {row.samples.length > 0 ? row.samples.join(' · ') : '—'}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 内置插件清单 ─────────────────────────────── */}
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-dim">
          内置插件(随 LM 启动)
        </h3>
        <div className="rounded border border-line bg-panel-soft/40">
          {CORE_PLUGINS.map((p, i) => (
            <div
              key={p.id}
              className={[
                'flex items-start gap-3 px-3 py-2 text-xs',
                i > 0 ? 'border-t border-line' : '',
              ].join(' ')}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium text-fg">{p.name}</div>
                <div className="mt-0.5 text-fg-dim">{p.desc}</div>
              </div>
              <code className="shrink-0 text-[10px] text-fg-dim">{p.id}</code>
            </div>
          ))}
        </div>
      </section>

      {/* ── 第三方插件 ──────────────────────────────── */}
      <UserPluginsSection />
    </div>
  );
}

function useUserPlugins(): readonly PluginListItem[] {
  const [snap, setSnap] = useState<readonly PluginListItem[]>(() => {
    const m = getUserPluginManager();
    return m ? m.listAll() : [];
  });
  // 简单刷新机制:每次组件挂载读最新值。后续如需 reactive 可让 PluginManager
  // 暴露 subscribe(目前 v4.1 enable/disable 触发后调 refresh 即可)。
  const refresh = () => {
    const m = getUserPluginManager();
    setSnap(m ? m.listAll() : []);
  };
  useEffect(() => {
    refresh();
  }, []);
  return snap;
}

function UserPluginsSection() {
  const plugins = useUserPlugins();
  const mgr = getUserPluginManager();

  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-dim">
        第三方插件
      </h3>
      {plugins.length === 0 ? (
        <div className="rounded border border-dashed border-line bg-panel-soft/40 px-3 py-6 text-center text-xs text-fg-dim">
          暂无。把插件目录放到 <code>userData/plugins/&lt;id&gt;/</code>(含
          manifest.json + main.js)即可加载。
        </div>
      ) : (
        <div className="rounded border border-line bg-panel-soft/40">
          {plugins.map((p, i) => (
            <div
              key={p.id}
              className={[
                'flex items-start gap-3 px-3 py-2 text-xs',
                i > 0 ? 'border-t border-line' : '',
              ].join(' ')}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-fg">{p.manifest.name}</span>
                  <code className="text-[10px] text-fg-dim">{p.id}</code>
                  <span className="text-[10px] text-fg-dim">
                    v{p.manifest.version}
                  </span>
                </div>
                {p.manifest.description && (
                  <div className="mt-0.5 text-fg-dim">{p.manifest.description}</div>
                )}
                {p.error && (
                  <div className="mt-1 text-[10px] text-red-400">
                    {p.error}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* 重载按钮:active / disabled / failed 都可触发,
                    用最新 mainText 重新激活(开发体验,M-Plugin v4.3) */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      await mgr?.reload(p.id);
                    } catch (err) {
                      console.warn(`[plugins-tab] reload ${p.id} failed`, err);
                    }
                  }}
                  title="重新加载该插件(拉取最新代码)"
                >
                  重载
                </Button>
                {p.status === 'enabled' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await mgr?.disable(p.id);
                    }}
                  >
                    禁用
                  </Button>
                ) : p.status === 'disabled' ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={async () => {
                      await mgr?.enable(p.id);
                    }}
                  >
                    启用
                  </Button>
                ) : (
                  <span className="text-[10px] text-red-400">FAILED</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
