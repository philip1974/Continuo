// '插件' SettingTab 内容(M-Plugin v3.5)。
// 自检视图:贡献点统计 + 内置插件清单 + 用户插件管理(UserPluginsSection)。

import { useState, useEffect } from 'react';
import { Button } from '@/design';
import { ConfirmDialog } from '@/lib/ConfirmDialog';
import { coApp } from '../co-app';
import { useMultiRegistry } from '../registries/useRegistry';
import { getUserPluginManager } from '../PluginManager';
import { useUserPluginList } from '../use-user-plugin-list';
import { getUserPermissionStore } from '../permissions/co-permission-store';
import { PermissionEditorModal } from '../permissions/PermissionEditorModal';
import type { PluginListItem } from '../PluginManager';
import type { PermissionKey } from '../permissions';
import { useT } from '@/i18n';
import { localizeErrorByCode, localizeThrown } from '@/lib/localize-error';
import { GitUrlInstallForm } from '@/plugins/GitUrlInstallForm';
import { useCloseWhenGone } from '@/lib/use-close-when-gone';
import { ResultMessage, type ResultMsg } from '@/lib/result-message';
import { installFromGitLocalized } from '@/plugins/install-from-git';
import type { InstallFromGitResult } from '../../../electron/shared/plugins-channels';
import { pruneLandedPendingMap } from '@/marketplace/prune-landed-pending';

interface ContributionRow {
  readonly labelKey: string;
  readonly count: number;
  readonly samplesText: string;
}

const EMPTY_PLUGIN_TAB_STRINGS: string[] = [];
const EMPTY_CONTRIBUTION_SAMPLES: readonly string[] = [];
const EMPTY_DECLARED_PERMISSIONS: readonly PermissionKey[] = [];
const NO_PENDING_INSTALLS: ReadonlyMap<string, InstallFromGitResult> =
  new Map();

const PLUGINS_TAB_ROW_CLASS_NAME = 'flex items-start gap-4 px-4 py-3 text-xs';
const PLUGINS_TAB_ROW_BORDER_CLASS_NAME = `${PLUGINS_TAB_ROW_CLASS_NAME} border-t border-line/50`;

export function pluginsTabRowClassName(hasTopBorder: boolean): string {
  return hasTopBorder ? PLUGINS_TAB_ROW_BORDER_CLASS_NAME : PLUGINS_TAB_ROW_CLASS_NAME;
}

export function collectContributionSamples<T, K extends keyof T>(
  items: readonly T[],
  key: K,
): string[] {
  if (items.length === 0) return EMPTY_PLUGIN_TAB_STRINGS;
  const samples = new Array<string>(items.length);
  for (let i = 0; i < items.length; i++) {
    samples[i] = String(items[i]![key]);
  }
  return samples;
}

export function formatContributionSamples(samples: readonly string[]): string {
  if (samples.length === 0) return '—';
  if (samples.length === 1) return samples[0]!;
  return samples.join(' · ');
}

function contributionRow(
  labelKey: string,
  count: number,
  samples: readonly string[],
): ContributionRow {
  return {
    labelKey,
    count,
    samplesText: formatContributionSamples(samples),
  };
}

function snapshot(): readonly ContributionRow[] {
  // 每个 registry 只取一次快照(打磨 R4):原先 count 与 samples 各调一遍、
  // statusBar 左右各取两遍 → 重复分配/排序。局部快照后 count=.length,
  // samples 单趟收集,行为完全等价。
  const panels = coApp.panels.getAll();
  const commands = coApp.commands.getAll();
  const statusItems = coApp.statusBar.getAll();
  const ribbon = coApp.ribbon.getAll();
  const settingTabs = coApp.settingTabs.getAll();
  const explorerDecorators = coApp.explorerDecorators.getAll();
  const editorActions = coApp.editorActions.getAll();
  return [
    contributionRow(
      'plugins_tab.label.panels',
      panels.length,
      collectContributionSamples(panels, 'type'),
    ),
    contributionRow(
      'plugins_tab.label.commands',
      commands.length,
      collectContributionSamples(commands, 'id'),
    ),
    contributionRow(
      'plugins_tab.label.statusbar',
      statusItems.length,
      collectContributionSamples(statusItems, 'id'),
    ),
    contributionRow(
      'plugins_tab.label.ribbon',
      ribbon.length,
      collectContributionSamples(ribbon, 'id'),
    ),
    contributionRow(
      'plugins_tab.label.setting_tabs',
      settingTabs.length,
      collectContributionSamples(settingTabs, 'id'),
    ),
    contributionRow(
      'plugins_tab.label.explorer_decorators',
      explorerDecorators.length,
      EMPTY_CONTRIBUTION_SAMPLES,
    ),
    contributionRow(
      'plugins_tab.label.editor_actions',
      editorActions.length,
      collectContributionSamples(editorActions, 'id'),
    ),
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
      coApp.explorerDecorators,
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
  {
    id: 'core.plugins',
    name: 'Plugin management',
    nameKey: 'plugins_tab.core.plugins_name',
    descKey: 'plugins_tab.core.plugins_desc',
  },
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
            <div key={row.labelKey} className={pluginsTabRowClassName(i > 0)}>
              <div className="w-32 shrink-0 text-fg-muted">{t(row.labelKey)}</div>
              <div className="w-8 shrink-0 text-right tabular-nums text-fg">{row.count}</div>
              <div className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-dim">
                {row.samplesText}
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
            <div key={p.id} className={pluginsTabRowClassName(i > 0)}>
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

export function hasPluginId(plugins: readonly PluginListItem[], id: string): boolean {
  for (const plugin of plugins) {
    if (plugin.id === id) return true;
  }
  return false;
}

export function hasPluginVersion(
  plugins: readonly PluginListItem[],
  id: string,
  version: string,
): boolean {
  for (const plugin of plugins) {
    if (plugin.id === id && plugin.manifest.version === version) return true;
  }
  return false;
}

function UserPluginsSection() {
  const t = useT();
  const plugins = useUserPluginList();
  const mgr = getUserPluginManager();
  // a11y(A42):结果消息带严重度 → 渲染时按语义选 live region(成功 status/polite,失败 alert)。
  const [installMsg, setInstallMsg] = useState<ResultMsg | null>(null);
  // 已安装、待重启后才进列表的插件(按 id;连续安装多个时各占一行)。
  const [pendingInstalls, setPendingInstalls] = useState<
    ReadonlyMap<string, InstallFromGitResult>
  >(NO_PENDING_INSTALLS);
  // 已进列表(落地)即从待重启记录摘除(与市场同一规则,见 prune-landed-pending):只过滤不摘除时,卸载后过滤重新
  // 成立,「已安装,重启后加载」幽灵行回来。渲染时仍过滤,覆盖落地到摘除之间的一帧。
  useEffect(() => {
    setPendingInstalls((prev) => pruneLandedPendingMap(prev, (id) => hasPluginId(plugins, id)));
  }, [plugins]);
  const pendingRows = [...pendingInstalls.values()].filter((p) => !hasPluginId(plugins, p.id));
  const [uninstallTarget, setUninstallTarget] = useState<PluginListItem | null>(null);
  const [permEditTarget, setPermEditTarget] = useState<PluginListItem | null>(null);
  const permStore = getUserPermissionStore();

  // race(R102,R50 同族):权限编辑弹窗持有打开时捕获的 PluginListItem。弹窗打开期间该插件被
  // 另一窗口/操作卸载时,plugins 列表随 manager 通知刷新,但 permEditTarget 仍是旧 item → 弹窗仍可保存,
  // 把已卸载插件的 ghost 权限写回 _permissions.json,同 id 日后重装意外继承非当前意图的授权。
  // 插件从 live 列表消失即自动关闭弹窗(覆盖列表变化);保存瞬间也 pluginStillExists 复检(覆盖
  // 本 effect 关闭前的同帧点击),同 KeybindingsTabContent R50。
  useCloseWhenGone(permEditTarget, plugins, (live, p) => hasPluginId(live, p.id), () =>
    setPermEditTarget(null),
  );

  // race(R103,R102 同族):卸载确认弹窗持有打开瞬间的 uninstallTarget 旧快照。弹窗打开期间该插件被
  // 另一窗口/操作卸载(列表变化后从 plugins 消失),或卸载+重装同 id(version 变化=不同实例),
  // 迟到的确认会对当前新实例执行 mgr.uninstall(target.id) → 删掉用户从未确认的新插件。live 列表中
  // 同 id+同 version 的条目不再存在即自动关弹窗。用 id+version 作同一实例校验(PluginListItem 无稳定
  // 实例 token,重装通常改 version;同 version 重装不可区分,极罕见,按 id 语义仍合理)。
  // 注:不在 onConfirmUninstall 里再复检 —— React passive effect 在 commit 后、paint 前 flush,plugins
  // 一变本 effect 即先关弹窗,用户无从在「plugins 已变而弹窗仍开」的画面上点确认,故 effect 已充分。
  useCloseWhenGone(
    uninstallTarget,
    plugins,
    (live, p) => hasPluginVersion(live, p.id, p.manifest.version),
    () => setUninstallTarget(null),
  );

  const onConfirmUninstall = async () => {
    if (!uninstallTarget || !mgr) return;
    const target = uninstallTarget;
    setUninstallTarget(null);
    try {
      await mgr.uninstall(target.id);
    } catch (err) {
      console.warn(`[plugins-tab] uninstall ${target.id} failed`, err);
      // i18n(I10,I1-I9 同族,catch 抛错路径):uninstall 抛回带 code 的 Error
      // (main RM_FAILED message 是中文「删除失败:…」/ NOT_SUPPORTED),只 errorMessage()
      // 会丢 code 且把中文/英文 raw 塞进本地化外壳 → 双向泄漏。有 code 时按 code 经 catalog
      // 本地化,无 code(如 "Plugin x not found")回退原文。
      const message = localizeThrown(err);
      setInstallMsg({
        text: t('plugins_tab.install.uninstall_fail', { message }),
        isError: true,
      });
    }
  };

  const install = async (url: string): Promise<boolean> => {
    setInstallMsg(null);
    // i18n(复查 P1):installFromGit 各错误站点的 Error.message 是硬编码中文,经 installFromGitLocalized
    // 按稳定 code 经 catalog 翻译(reject 分支同样处理)。
    const r = await installFromGitLocalized(url);
    if (!r.ok) {
      setInstallMsg({
        text: t('plugins_tab.error.generic', { message: `[${r.code}] ${r.message}` }),
        isError: true,
      });
      return false;
    }
    setInstallMsg({
      text: t('plugins_tab.install.success', {
        name: r.data.name,
        version: r.data.version,
      }),
      isError: false,
    });
    setPendingInstalls((prev) => new Map(prev).set(r.data.id, r.data));
    return true;
  };

  // a11y(A47,A46 同族):生命周期操作(reload/disable/enable/retry)失败此前只 console.warn,
  // 用户看似无响应。统一把失败经 installMsg live region(A42:role=alert)反馈,带 code 本地化。
  const reportActionError = (err: unknown) => {
    const message = localizeThrown(err);
    setInstallMsg({
      text: t('plugins_tab.error.generic', { message }),
      isError: true,
    });
  };
  // 行内生命周期按钮共用:执行 → 失败 console.warn + 经 live region 反馈(此前 4 个按钮各写一遍)。
  const runLifecycle = (label: string, id: string, op: () => Promise<unknown> | undefined) => async () => {
    try {
      await op();
    } catch (err) {
      console.warn(`[plugins-tab] ${label} ${id} failed`, err);
      reportActionError(err);
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
        <div className="mt-1 text-xs text-fg-muted">{t('plugins_tab.section.install_warning')}</div>
        <GitUrlInstallForm
          // a11y(A5 同族):placeholder 是 URL 示例(格式提示)非标签 → 用 section 标题作
          // aria-label,给屏幕阅读器「从 Git URL 安装」的可访问名。
          ariaLabel={t('plugins_tab.section.install_from_git')}
          placeholder="https://github.com/user/plugin.git"
          installLabel={t('plugins_tab.install.install')}
          installingLabel={t('plugins_tab.install.installing')}
          install={install}
        />
        {/* a11y(A42,A41 同族):异步安装/卸载结果须 live region 主动播报(焦点仍在按钮/对话框)。 */}
        <ResultMessage msg={installMsg} className="mt-2 text-xs text-fg-muted" />
      </div>
      {plugins.length === 0 && pendingRows.length === 0 ? (
        <div className="rounded-md border border-dashed border-line bg-panel-soft/40 px-4 py-8 text-center text-xs text-fg-dim">
          {t('plugins_tab.user.no_plugins')}
        </div>
      ) : (
        <div className="rounded-md border border-line bg-panel-soft/40">
          {pendingRows.map((pending, i) => (
            <div key={pending.id} className={pluginsTabRowClassName(i > 0)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-fg">{pending.name}</span>
                  <code className="rounded bg-panel-soft/70 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-fg-muted/70">
                    {pending.id}
                  </code>
                  <span className="text-2xs text-fg-dim">v{pending.version}</span>
                </div>
                <div className="mt-1 text-fg-muted">{t('plugins_tab.user.pending_hint')}</div>
              </div>
            </div>
          ))}
          {plugins.map((p, i) => (
            <div key={p.id} className={pluginsTabRowClassName(i > 0 || pendingRows.length > 0)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-fg">{p.manifest.name}</span>
                  <code className="rounded bg-panel-soft/70 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-fg-muted/70">
                    {p.id}
                  </code>
                  <span className="text-2xs text-fg-dim">v{p.manifest.version}</span>
                </div>
                {p.manifest.description && (
                  <div className="mt-1 text-fg-muted">{p.manifest.description}</div>
                )}
                {p.error && (
                  // a11y(A68,A41 同族):插件运行时错误异步出现(激活失败等),焦点常在别处 →
                  // role=alert(失败=assertive)主动播报,否则 SR 用户不知插件状态变坏。
                  <div role="alert" className="mt-1 text-2xs text-error">
                    {/* i18n(I4):error 结构化 {code,message},按 code 经 catalog 渲染;
                        未收录 code(PERMISSION_DENIED/IMPORT_FAILED/EXCEPTION 等动态
                        message)保留旧 `code: message` 格式作 fallback。 */}
                    {localizeErrorByCode(p.error.code, `${p.error.code}: ${p.error.message}`)}
                  </div>
                )}
                {p.warning && (
                  // a11y(A68):部分授权等警告异步出现 → role=status(可覆盖警告=polite)。
                  <div role="status" className="mt-1 text-2xs text-warning">
                    {/* a11y(A84,A73 同族装饰符号):⚠ 是纯视觉装饰,严重度由 role/文本表达 →
                        aria-hidden,否则混进 live region 播报成"warning sign …"噪声。 */}
                    <span aria-hidden="true">⚠</span> {t(p.warning.code, p.warning.params)}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={runLifecycle('reload', p.id, () => mgr?.reload(p.id))}
                  title={t('plugins_tab.action.reload_tooltip')}
                  // a11y(A75):行内操作按钮可见文本通用(多行同名),aria-label 补插件名以区分。
                  aria-label={t('plugins_tab.action.row_button_aria', {
                    action: t('plugins_tab.btn.reload'),
                    name: p.manifest.name,
                  })}
                >
                  {t('plugins_tab.btn.reload')}
                </Button>
                {p.status === 'enabled' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={runLifecycle('disable', p.id, () => mgr?.disable(p.id))}
                    aria-label={t('plugins_tab.action.row_button_aria', {
                      action: t('plugins_tab.btn.disable'),
                      name: p.manifest.name,
                    })}
                  >
                    {t('plugins_tab.btn.disable')}
                  </Button>
                ) : p.status === 'disabled' ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={runLifecycle('enable', p.id, () => mgr?.enable(p.id))}
                    aria-label={t('plugins_tab.action.row_button_aria', {
                      action: t('plugins_tab.btn.enable'),
                      name: p.manifest.name,
                    })}
                  >
                    {t('plugins_tab.btn.enable')}
                  </Button>
                ) : (
                  // FAILED:启用按钮仍可点(权限拒绝时会清 deny + 复弹 Modal)
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={runLifecycle('retry', p.id, () => mgr?.enable(p.id))}
                    title={t('plugins_tab.action.retry_enable_tooltip')}
                    aria-label={t('plugins_tab.action.row_button_aria', {
                      action: t('plugins_tab.btn.enable'),
                      name: p.manifest.name,
                    })}
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
                    aria-label={t('plugins_tab.action.row_button_aria', {
                      action: t('plugins_tab.btn.permissions'),
                      name: p.manifest.name,
                    })}
                  >
                    {t('plugins_tab.btn.permissions')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setUninstallTarget(p)}
                  title={t('plugins_tab.action.uninstall_tooltip')}
                  aria-label={t('plugins_tab.action.row_button_aria', {
                    action: t('plugins_tab.btn.uninstall'),
                    name: p.manifest.name,
                  })}
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
          declared={permEditTarget?.manifest.permissions ?? EMPTY_DECLARED_PERMISSIONS}
          store={permStore}
          onClose={() => setPermEditTarget(null)}
          pluginStillExists={() =>
            permEditTarget !== null && hasPluginId(plugins, permEditTarget.id)
          }
        />
      )}
    </section>
  );
}
