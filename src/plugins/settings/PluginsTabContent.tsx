// '插件' SettingTab 内容(M-Plugin v3.5)。
// 自检视图:贡献点统计 + 内置插件清单 + 用户插件占位(等 v4 IPC)。

import { useEffect, useState } from 'react';
import { Button, Input } from '@/design';
import { ConfirmDialog } from '@/panels/Explorer/ConfirmDialog';
import { coApi } from '@/lib/co-api';
import { coApp } from '../co-app';
import { useMultiRegistry } from '../registries/useRegistry';
import { getUserPluginManager } from '../PluginManager';
import { getUserPermissionStore } from '../permissions/co-permission-store';
import { PermissionEditorModal } from '../permissions/PermissionEditorModal';
import type { PluginListItem } from '../PluginManager';
import { useT } from '@/i18n';
import { errorMessage } from '../../../electron/shared/error-message';

interface ContributionRow {
  readonly labelKey: string;
  readonly count: number;
  readonly samples: readonly string[];
}

function snapshot(): readonly ContributionRow[] {
  return [
    {
      labelKey: 'plugins_tab.label.panels',
      count: coApp.panels.getAll().length,
      samples: coApp.panels.getAll().map((p) => p.type),
    },
    {
      labelKey: 'plugins_tab.label.commands',
      count: coApp.commands.getAll().length,
      samples: coApp.commands.getAll().map((c) => c.id),
    },
    {
      labelKey: 'plugins_tab.label.statusbar',
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
      labelKey: 'plugins_tab.label.ribbon',
      count: coApp.ribbon.getAll().length,
      samples: coApp.ribbon.getAll().map((r) => r.id),
    },
    {
      labelKey: 'plugins_tab.label.setting_tabs',
      count: coApp.settingTabs.getAll().length,
      samples: coApp.settingTabs.getAll().map((t) => t.id),
    },
    {
      labelKey: 'plugins_tab.label.explorer_decorators',
      count: coApp.explorerDecorators.getAll().length,
      samples: [],
    },
    {
      labelKey: 'plugins_tab.label.editor_actions',
      count: coApp.editorActions.getAll().length,
      samples: coApp.editorActions.getAll().map((a) => a.id),
    },
  ];
}

function useContributionSnapshot(): readonly ContributionRow[] {
  return useMultiRegistry(
    [
      coApp.panels,
      coApp.commands,
      coApp.statusBar,
      coApp.ribbon,
      coApp.settingTabs,
      coApp.editorActions,
    ],
    snapshot,
  );
}

const CORE_PLUGINS: ReadonlyArray<{
  readonly id: string;
  readonly nameKey?: string;
  readonly name: string;
  readonly descKey: string;
}> = [
  { id: 'core.editor', name: 'Editor', descKey: 'plugins_tab.core.editor_desc' },
  { id: 'core.terminal', name: 'Terminal', descKey: 'plugins_tab.core.terminal_desc' },
  { id: 'core.output', name: 'Output', descKey: 'plugins_tab.core.output_desc' },
  { id: 'core.plugins', name: 'Plugin management', nameKey: 'plugins_tab.core.plugins_name', descKey: 'plugins_tab.core.plugins_desc' },
];

export function PluginsTabContent() {
  const contribs = useContributionSnapshot();
  const t = useT();

  return (
    <div className="space-y-8">
      {/* ── 贡献点统计 ──────────────────────────────── */}
      <section>
        <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
          {t('plugins_tab.section.contributions')}
        </h3>
        <div className="rounded-md border border-line bg-panel-soft/40">
          {contribs.map((row, i) => (
            <div
              key={row.labelKey}
              className={[
                'flex items-start gap-4 px-4 py-3 text-xs',
                i > 0 ? 'border-t border-line/50' : '',
              ].join(' ')}
            >
              <div className="w-32 shrink-0 text-fg-muted">{t(row.labelKey)}</div>
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
          {t('plugins_tab.section.builtin')}
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
                <div className="text-sm font-medium text-fg">
                  {p.nameKey ? t(p.nameKey) : p.name}
                </div>
                <div className="mt-1 text-fg-muted">{t(p.descKey)}</div>
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
  const t = useT();
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
        t('plugins_tab.install.uninstall_fail', {
          message: errorMessage(err),
        }),
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
        setInstallMsg(t('plugins_tab.error.generic', { message: `[${r.code}] ${r.message}` }));
      } else {
        setInstallMsg(
          t('plugins_tab.install.success', {
            name: r.data.name,
            version: r.data.version,
          }),
        );
        setPendingInstall(r.data);
        setGitUrl('');
      }
    } catch (err) {
      setInstallMsg(
        t('plugins_tab.error.generic', {
          message: errorMessage(err),
        }),
      );
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section>
      <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
        {t('plugins_tab.section.user')}
      </h3>
      {/* git URL 安装(对齐 demo (3) 的「从 GIT URL 安装」段:浅底 + 标题 +
       *  输入框 + 按钮 + 警告 banner) */}
      <div className="mb-4 rounded-md border border-line bg-panel-soft/40 p-4">
        <div className="text-sm font-medium text-fg">
          {t('plugins_tab.section.install_from_git')}
        </div>
        <div className="mt-1 text-xs text-fg-muted">
          {t('plugins_tab.section.install_warning')}
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
            {installing
              ? t('plugins_tab.install.installing')
              : t('plugins_tab.install.install')}
          </Button>
        </div>
        {installMsg && (
          <div className="mt-2 text-xs text-fg-muted">{installMsg}</div>
        )}
      </div>
      {plugins.length === 0 && !pendingInstall ? (
        <div className="rounded-md border border-dashed border-line bg-panel-soft/40 px-4 py-8 text-center text-xs text-fg-dim">
          {t('plugins_tab.user.no_plugins')}
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
                  {t('plugins_tab.user.pending_hint')}
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
                  title={t('plugins_tab.action.reload_tooltip')}
                >
                  {t('plugins_tab.btn.reload')}
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
                    {t('plugins_tab.btn.disable')}
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
                    {t('plugins_tab.btn.enable')}
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
                    title={t('plugins_tab.action.retry_enable_tooltip')}
                  >
                    {t('plugins_tab.btn.enable')}
                  </Button>
                )}
                {(p.manifest.permissions?.length ?? 0) > 0 && permStore && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPermEditTarget(p)}
                    title={t('plugins_tab.action.edit_permissions_tooltip')}
                  >
                    {t('plugins_tab.btn.permissions')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setUninstallTarget(p)}
                  title={t('plugins_tab.action.uninstall_tooltip')}
                >
                  {t('plugins_tab.btn.uninstall')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={uninstallTarget !== null}
        title={t('plugins_tab.uninstall.title')}
        description={
          uninstallTarget ? (
            <>{t('plugins_tab.uninstall.body', { id: uninstallTarget.id })}</>
          ) : null
        }
        confirmLabel={t('plugins_tab.uninstall.confirm')}
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
