// '插件' SettingTab 内容(M-Plugin v3.5)。
// 自检视图:贡献点统计 + 内置插件清单 + 用户插件占位(等 v4 IPC)。

import { useEffect, useState } from 'react';
import { Button, Input } from '@/design';
import { ConfirmDialog } from '@/panels/Explorer/ConfirmDialog';
import { coApi } from '@/lib/co-api';
import { coApp } from '../co-app';
import { getUserPluginManager } from '../co-plugin-manager';
import { getUserPermissionStore } from '../permissions/co-permission-store';
import { PermissionEditorModal } from '../permissions/PermissionEditorModal';
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
      count: coApp.panels.getAll().length,
      samples: coApp.panels.getAll().map((p) => p.type),
    },
    {
      label: '命令',
      count: coApp.commands.getAll().length,
      samples: coApp.commands.getAll().map((c) => c.id),
    },
    {
      label: 'StatusBar 项',
      count: [
        ...coApp.statusBar.getBySide('left'),
        ...coApp.statusBar.getBySide('right'),
      ].length,
      samples: [
        ...coApp.statusBar.getBySide('left'),
        ...coApp.statusBar.getBySide('right'),
      ].map((x) => x.id),
    },
    {
      label: 'Ribbon 图标',
      count: coApp.ribbon.getAll().length,
      samples: coApp.ribbon.getAll().map((r) => r.id),
    },
    {
      label: '设置 Tab',
      count: coApp.settingTabs.getAll().length,
      samples: coApp.settingTabs.getAll().map((t) => t.id),
    },
    {
      label: 'Explorer 装饰器',
      count: coApp.explorerDecorators.getAll().length,
      samples: [],
    },
    {
      label: 'Editor Action',
      count: coApp.editorActions.getAll().length,
      samples: coApp.editorActions.getAll().map((a) => a.id),
    },
  ];
}

function useContributionSnapshot(): readonly ContributionRow[] {
  const [snap, setSnap] = useState(() => snapshot());
  useEffect(() => {
    // 任一 registry 变 → 重新计算。subscribe 全部,挂接到一个 setSnap。
    const refresh = () => setSnap(snapshot());
    const u1 = coApp.panels.subscribe(refresh);
    const u2 = coApp.commands.subscribe(refresh);
    const u3 = coApp.statusBar.subscribe(refresh);
    const u4 = coApp.ribbon.subscribe(refresh);
    const u5 = coApp.settingTabs.subscribe(refresh);
    const u6 = coApp.editorActions.subscribe(refresh);
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
    <div className="space-y-8">
      {/* ── 贡献点统计 ──────────────────────────────── */}
      <section>
        <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
          已注册贡献点
        </h3>
        <div className="rounded-md border border-line bg-panel-soft/40">
          {contribs.map((row, i) => (
            <div
              key={row.label}
              className={[
                'flex items-start gap-4 px-4 py-3 text-xs',
                i > 0 ? 'border-t border-line/50' : '',
              ].join(' ')}
            >
              <div className="w-32 shrink-0 text-fg-muted">{row.label}</div>
              <div className="w-8 shrink-0 text-right tabular-nums text-fg">
                {row.count}
              </div>
              <div className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-dim">
                {row.samples.length > 0 ? row.samples.join(' · ') : '—'}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 内置插件清单 ─────────────────────────────── */}
      <section>
        <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
          内置插件
        </h3>
        <div className="rounded-md border border-line bg-panel-soft/40">
          {CORE_PLUGINS.map((p, i) => (
            <div
              key={p.id}
              className={[
                'flex items-start gap-4 px-4 py-3 text-xs',
                i > 0 ? 'border-t border-line/50' : '',
              ].join(' ')}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">{p.name}</div>
                <div className="mt-1 text-fg-muted">{p.desc}</div>
              </div>
              <code className="shrink-0 rounded bg-panel-soft/70 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-fg-muted/70">
                {p.id}
              </code>
            </div>
          ))}
        </div>
      </section>

      {/* ── 第三方插件 ──────────────────────────────── */}
      <UserPluginsSection />
    </div>
  );
}

function useUserPlugins(): {
  plugins: readonly PluginListItem[];
  refresh: () => void;
} {
  const [snap, setSnap] = useState<readonly PluginListItem[]>(() => {
    const m = getUserPluginManager();
    return m ? m.listAll() : [];
  });
  const refresh = () => {
    const m = getUserPluginManager();
    setSnap(m ? m.listAll() : []);
  };
  useEffect(() => {
    // 挂载时刷一次(manager 可能在组件 mount 之后才 init 完)
    refresh();
    // 1 秒轮询兜底,捕获 manager.init 异步完成的迟到入表
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, []);
  return { plugins: snap, refresh };
}

function UserPluginsSection() {
  const { plugins, refresh } = useUserPlugins();
  const mgr = getUserPluginManager();
  const [gitUrl, setGitUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<{
    id: string;
    name: string;
    version: string;
  } | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<PluginListItem | null>(
    null,
  );
  const [permEditTarget, setPermEditTarget] = useState<PluginListItem | null>(
    null,
  );
  const permStore = getUserPermissionStore();

  const onConfirmUninstall = async () => {
    if (!uninstallTarget || !mgr) return;
    const target = uninstallTarget;
    setUninstallTarget(null);
    try {
      await mgr.uninstall(target.id);
    } catch (err) {
      console.warn(`[plugins-tab] uninstall ${target.id} failed`, err);
      setInstallMsg(
        `✘ 卸载失败:${err instanceof Error ? err.message : String(err)}`,
      );
    }
    refresh();
  };

  const onInstall = async () => {
    if (!gitUrl.trim()) return;
    setInstalling(true);
    setInstallMsg(null);
    try {
      const r = await coApi.plugins.installFromGit(gitUrl.trim());
      if (!r.ok) {
        setInstallMsg(`✘ [${r.code}] ${r.message}`);
      } else {
        setInstallMsg(
          `✔ 已安装 ${r.data.name} v${r.data.version} — 重启 LM 后插件加载`,
        );
        setPendingInstall(r.data);
        setGitUrl('');
      }
    } catch (err) {
      setInstallMsg(`✘ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section>
      <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
        第三方插件
      </h3>
      {/* git URL 安装(对齐 demo (3) 的「从 GIT URL 安装」段:浅底 + 标题 +
       *  输入框 + 按钮 + 警告 banner) */}
      <div className="mb-4 rounded-md border border-line bg-panel-soft/40 p-4">
        <div className="text-sm font-medium text-fg">从 Git URL 安装</div>
        <div className="mt-1 text-xs text-fg-muted">
          可以直接通过 Git 链接进行安装。注意第三方仓库可能存在安全风险,请保持信任源代码及其开发者。
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Input
            size="sm"
            placeholder="https://github.com/user/plugin.git"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            disabled={installing}
            className="flex-1"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={onInstall}
            disabled={installing || !gitUrl.trim()}
          >
            {installing ? '安装中…' : '安装'}
          </Button>
        </div>
        {installMsg && (
          <div className="mt-2 text-xs text-fg-muted">{installMsg}</div>
        )}
      </div>
      {plugins.length === 0 && !pendingInstall ? (
        <div className="rounded-md border border-dashed border-line bg-panel-soft/40 px-4 py-8 text-center text-xs text-fg-dim">
          暂无第三方插件。从上方「git URL 安装」添加。
        </div>
      ) : (
        <div className="rounded-md border border-line bg-panel-soft/40">
          {pendingInstall && (
            <div className="flex items-start gap-4 px-4 py-3 text-xs">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-fg">
                    {pendingInstall.name}
                  </span>
                  <code className="rounded bg-panel-soft/70 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-fg-muted/70">
                    {pendingInstall.id}
                  </code>
                  <span className="text-2xs text-fg-dim">
                    v{pendingInstall.version}
                  </span>
                </div>
                <div className="mt-1 text-fg-muted">
                  ⏳ 已安装,重启 LM 后出现在列表并可启用
                </div>
              </div>
            </div>
          )}
          {plugins.map((p, i) => (
            <div
              key={p.id}
              className={[
                'flex items-start gap-4 px-4 py-3 text-xs',
                i > 0 || pendingInstall ? 'border-t border-line/50' : '',
              ].join(' ')}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-fg">{p.manifest.name}</span>
                  <code className="rounded bg-panel-soft/70 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-fg-muted/70">
                    {p.id}
                  </code>
                  <span className="text-2xs text-fg-dim">
                    v{p.manifest.version}
                  </span>
                </div>
                {p.manifest.description && (
                  <div className="mt-1 text-fg-muted">{p.manifest.description}</div>
                )}
                {p.error && (
                  <div className="mt-1 text-2xs text-error">
                    {p.error}
                  </div>
                )}
                {p.warning && (
                  <div className="mt-1 text-2xs text-warning">
                    ⚠ {p.warning}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      await mgr?.reload(p.id);
                    } catch (err) {
                      console.warn(`[plugins-tab] reload ${p.id} failed`, err);
                    }
                    refresh();
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
                      try {
                        await mgr?.disable(p.id);
                      } catch (err) {
                        console.warn(`[plugins-tab] disable ${p.id} failed`, err);
                      }
                      refresh();
                    }}
                  >
                    禁用
                  </Button>
                ) : p.status === 'disabled' ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={async () => {
                      try {
                        await mgr?.enable(p.id);
                      } catch (err) {
                        console.warn(`[plugins-tab] enable ${p.id} failed`, err);
                      }
                      refresh();
                    }}
                  >
                    启用
                  </Button>
                ) : (
                  // FAILED:启用按钮仍可点(权限拒绝时会清 deny + 复弹 Modal)
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={async () => {
                      try {
                        await mgr?.enable(p.id);
                      } catch (err) {
                        console.warn(`[plugins-tab] retry ${p.id} failed`, err);
                      }
                      refresh();
                    }}
                    title="重试启用(权限拒绝时会重弹授权)"
                  >
                    启用
                  </Button>
                )}
                {(p.manifest.permissions?.length ?? 0) > 0 && permStore && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPermEditTarget(p)}
                    title="编辑该插件的权限授权"
                  >
                    权限
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setUninstallTarget(p)}
                  title="卸载该插件(删除磁盘目录)"
                >
                  卸载
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={uninstallTarget !== null}
        title="卸载插件?"
        description={
          uninstallTarget ? (
            <>
              将永久删除 <code className="text-fg">{uninstallTarget.id}</code>{' '}
              的安装目录及其所有数据。该操作不可撤销,需重新从 git URL 安装才能恢复。
            </>
          ) : null
        }
        confirmLabel="卸载"
        destructive
        onConfirm={onConfirmUninstall}
        onCancel={() => setUninstallTarget(null)}
      />
      {permStore && (
        <PermissionEditorModal
          open={permEditTarget !== null}
          pluginId={permEditTarget?.id ?? null}
          declared={permEditTarget?.manifest.permissions ?? []}
          store={permStore}
          onClose={() => setPermEditTarget(null)}
        />
      )}
    </section>
  );
}
