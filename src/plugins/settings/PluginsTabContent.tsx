// '插件' SettingTab 内容(M-Plugin v3.5)。
// 用户插件管理(UserPluginsSection)+ 自检视图(贡献点统计 + 内置插件清单)。用户插件排最前:用户来这一页主要是管理
// 自己装的插件(VSCode 扩展视图「已安装」在最上),自检信息是次要的诊断内容。

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Badge, Button } from '@/design';
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
import { localizeThrown } from '@/lib/localize-error';
import { localizePluginError } from '../plugin-error-text';
import { GitUrlInstallForm } from '@/plugins/GitUrlInstallForm';
import { useCloseWhenGone } from '@/lib/use-close-when-gone';
import { ResultMessage, type ResultMsg } from '@/lib/result-message';
import { installFromGitLocalized, repoNameFromGitUrl } from '@/plugins/install-from-git';
import { clearPendingInstall, recordPendingInstall, usePendingInstalls } from '../pending-installs-store';
import { coApi } from '@/lib/co-api';
import { useSettingsStore } from './store';

/** 插件市场设置页签 id(core-plugins/PluginsTabPlugin 注册)。 */
export const MARKETPLACE_SETTING_TAB_ID = 'core.marketplace';

interface ContributionRow {
  readonly labelKey: string;
  readonly count: number;
  readonly samplesText: string;
}

const EMPTY_PLUGIN_TAB_STRINGS: string[] = [];
const EMPTY_CONTRIBUTION_SAMPLES: readonly string[] = [];
const EMPTY_DECLARED_PERMISSIONS: readonly PermissionKey[] = [];

const PLUGINS_TAB_ROW_CLASS_NAME = 'flex flex-wrap items-start gap-4 px-4 py-3 text-xs';
const PLUGINS_TAB_ROW_BORDER_CLASS_NAME = `${PLUGINS_TAB_ROW_CLASS_NAME} border-t border-line/50`;

// 贡献点统计行:窄宽时示例列(samplesText)换到下一行占满,而不是被前两列挤成 0 宽。
export const PLUGINS_CONTRIB_ROW_CLASS_NAME = 'flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 text-xs';
const PLUGINS_CONTRIB_ROW_BORDER_CLASS_NAME = `${PLUGINS_CONTRIB_ROW_CLASS_NAME} border-t border-line/50`;

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
  const settingItems = coApp.settingItems.getAll();
  const explorerDecorators = coApp.explorerDecorators.getAll();
  const explorerContextMenu = coApp.explorerContextMenu.getAll();
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
      'plugins_tab.label.setting_items',
      settingItems.length,
      collectContributionSamples(settingItems, 'id'),
    ),
    contributionRow(
      'plugins_tab.label.explorer_decorators',
      explorerDecorators.length,
      EMPTY_CONTRIBUTION_SAMPLES,
    ),
    contributionRow(
      'plugins_tab.label.explorer_context_menu',
      explorerContextMenu.length,
      collectContributionSamples(explorerContextMenu, 'id'),
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
      coApp.settingItems,
      coApp.explorerDecorators,
      coApp.explorerContextMenu,
      coApp.editorActions,
    ],
    snapshot,
  );
}

// 内置插件名 / 描述走 catalog(随语言);第三方插件显示其 manifest 名。
const CORE_PLUGINS: ReadonlyArray<{
  readonly id: string;
  readonly nameKey: string;
  readonly descKey: string;
}> = [
  { id: 'core.editor', nameKey: 'plugins_tab.core.editor_name', descKey: 'plugins_tab.core.editor_desc' },
  { id: 'core.terminal', nameKey: 'plugins_tab.core.terminal_name', descKey: 'plugins_tab.core.terminal_desc' },
  { id: 'core.output', nameKey: 'plugins_tab.core.output_name', descKey: 'plugins_tab.core.output_desc' },
  { id: 'core.plugins', nameKey: 'plugins_tab.core.plugins_name', descKey: 'plugins_tab.core.plugins_desc' },
];

export function PluginsTabContent() {
  const contribs = useContributionSnapshot();
  const t = useT();

  return (
    <div className="space-y-8">
      {/* ── 第三方插件 ──────────────────────────────── */}
      <UserPluginsSection />

      {/* ── 贡献点统计 ──────────────────────────────── */}
      <section data-plugins-section="contributions">
        <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
          {t('plugins_tab.section.contributions')}
        </h3>
        <div className="rounded-md border border-line bg-panel-soft/40">
          {contribs.map((row, i) => (
            <div
              key={row.labelKey}
              className={i > 0 ? PLUGINS_CONTRIB_ROW_BORDER_CLASS_NAME : PLUGINS_CONTRIB_ROW_CLASS_NAME}
            >
              <div className="w-32 shrink-0 text-fg-muted">{t(row.labelKey)}</div>
              <div className="w-8 shrink-0 text-right tabular-nums text-fg">{row.count}</div>
              <div className="min-w-32 flex-1 truncate font-mono text-2xs text-fg-dim">
                {row.samplesText}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 内置插件清单 ─────────────────────────────── */}
      <section data-plugins-section="builtin">
        <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
          {t('plugins_tab.section.builtin')}
        </h3>
        <div className="rounded-md border border-line bg-panel-soft/40">
          {CORE_PLUGINS.map((p, i) => (
            <div key={p.id} className={pluginsTabRowClassName(i > 0)}>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">{t(p.nameKey)}</div>
                <div className="mt-1 text-fg-muted">{t(p.descKey)}</div>
              </div>
              <Badge size="xs" className="min-w-0 max-w-[40%]">
                <code className="truncate">{p.id}</code>
              </Badge>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** 切到「插件市场」设置页签;本页随之卸载,焦点交给导航里的市场页签(不掉到 body)。 */
function openMarketplaceTab(e: MouseEvent<HTMLButtonElement>): void {
  const doc = e.currentTarget.ownerDocument;
  useSettingsStore.getState().setActiveTabId(MARKETPLACE_SETTING_TAB_ID);
  requestAnimationFrame(() => {
    doc.querySelector<HTMLElement>(`[data-setting-tab="${MARKETPLACE_SETTING_TAB_ID}"]`)?.focus();
  });
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
  // 已安装、待重启后才进列表的插件(按 id;连续安装多个时各占一行)。与市场共用会话级 store(切页不丢、
  // 市场装的这里也显示);落地摘除在 store 层。渲染时仍按列表过滤,兜住落地到摘除之间的一帧。
  const pendingInstalls = usePendingInstalls((s) => s.byId);
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

  // 卸载成功后被卸载行(连同焦点所在的「卸载」按钮)消失 → 焦点移到原位置的下一行(没有则上一行)的「卸载」,
  // 列表空了则移到本段标题。等该 id 真正离开列表(列表变化可能早于 / 晚于 uninstall 结算)再移。
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [focusAfterUninstall, setFocusAfterUninstall] = useState<{ id: string; index: number } | null>(null);
  useEffect(() => {
    if (focusAfterUninstall === null || hasPluginId(plugins, focusAfterUninstall.id)) return;
    setFocusAfterUninstall(null);
    const buttons = listRef.current?.querySelectorAll<HTMLElement>('[data-plugin-uninstall]');
    const next = buttons && buttons.length > 0 ? buttons[Math.min(focusAfterUninstall.index, buttons.length - 1)] : null;
    (next ?? sectionHeadingRef.current)?.focus();
  }, [focusAfterUninstall, plugins]);

  const onConfirmUninstall = async () => {
    if (!uninstallTarget || !mgr) return;
    const target = uninstallTarget;
    const index = plugins.findIndex((p) => p.id === target.id);
    setUninstallTarget(null);
    try {
      await mgr.uninstall(target.id);
      clearPendingInstall(target.id);
      // a11y:卸载成功经 live region(role=status)播报;焦点移到相邻行(见上)。
      setInstallMsg({ text: t('plugins_tab.uninstall.success', { name: target.manifest.name }), isError: false });
      setFocusAfterUninstall({ id: target.id, index: Math.max(index, 0) });
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

  // 「覆盖并更新」确认(Git URL 安装撞上已在列表的插件):install 等用户决定后再继续(安装按钮保持忙碌,
  // 确认后成功即清空输入框;关闭后焦点由 GitUrlInstallForm 还给输入框)。
  const [updatePrompt, setUpdatePrompt] = useState<{ name: string; installed: string; version: string } | null>(null);
  const updateDecision = useRef<((confirmed: boolean) => void) | null>(null);
  const askUpdate = (prompt: { name: string; installed: string; version: string }) =>
    new Promise<boolean>((resolve) => {
      updateDecision.current = resolve;
      setUpdatePrompt(prompt);
    });
  const settleUpdate = (confirmed: boolean) => {
    const resolve = updateDecision.current;
    updateDecision.current = null;
    setUpdatePrompt(null);
    resolve?.(confirmed);
  };

  const install = async (url: string): Promise<boolean> => {
    setInstallMsg(null);
    // i18n(复查 P1):installFromGit 各错误站点的 Error.message 是硬编码中文,经 installFromGitLocalized
    // 按稳定 code 经 catalog 翻译(reject 分支同样处理)。
    let r = await installFromGitLocalized(url);
    if (!r.ok && r.alreadyInstalled && r.existing) {
      // 已在盘上:main 带回仓库 manifest。该 id 已在本窗口列表(读 manager 最新列表)→ 对齐 VSCode「再次安装 = 覆盖 / 更新」:
      // 同版本提示已是最新;否则确认后覆盖安装(watcher 热重载,新增权限照常走授权确认)。不在列表(其它窗口装的)→ 下面的原提示。
      const existing = r.existing;
      const listed = (mgr?.listAll() ?? plugins).find((p) => p.id === existing.id);
      if (listed) {
        if (listed.manifest.version === existing.version) {
          setInstallMsg({ text: t('plugins_tab.install.up_to_date', { name: existing.name, version: existing.version }), isError: false });
          return false;
        }
        if (!(await askUpdate({ name: existing.name, installed: listed.manifest.version, version: existing.version }))) {
          return false;
        }
        r = await installFromGitLocalized(url, true);
      }
    }
    if (!r.ok) {
      setInstallMsg(
        r.alreadyInstalled
          ? {
              text: t('marketplace.install_already_installed', { name: r.existing?.name ?? repoNameFromGitUrl(url) }),
              isError: false,
            }
          : // 内部错误码不进用户文案(code 已随 data-code / 日志带走),只显示本地化原因。
            { text: t('plugins_tab.error.generic', { message: r.message }), isError: true },
      );
      return false;
    }
    // 已在列表(覆盖重装)→ watcher 热重载即生效、不记待重启;全新安装要等重启后的扫描(reload 对未知 id 抛错)。
    // 文案按此区分(判定读 manager 最新列表,见 recordPendingInstall)。
    const alreadyListed = !recordPendingInstall(r.data);
    setInstallMsg({
      text: t(alreadyListed ? 'plugins_tab.install.updated' : 'plugins_tab.install.success', {
        name: r.data.name,
        version: r.data.version,
      }),
      isError: false,
    });
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
  // 「启用」重试按钮(仅 failed 行)在重试成功后随状态消失:焦点那时掉到 body → 交给同一行的启用 / 禁用切换按钮
  //(对齐 VSCode 扩展页:操作后焦点仍在该扩展的操作按钮上)。焦点已被用户移到别处则不抢。
  const [retryFocusId, setRetryFocusId] = useState<string | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (retryFocusId === null || !list) return;
    // 按属性值比对而非拼选择器(插件 id 可含选择器特殊字符)。
    const find = (attr: string) =>
      Array.from(list.querySelectorAll<HTMLElement>(`[${attr}]`)).find((el) => el.getAttribute(attr) === retryFocusId);
    if (find('data-plugin-retry')) return;
    setRetryFocusId(null);
    const active = list.ownerDocument.activeElement;
    if (active === null || active === list.ownerDocument.body) find('data-plugin-toggle')?.focus();
  }, [retryFocusId, plugins]);

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
    <section data-plugins-section="user">
      {/* tabIndex=-1:卸载掉最后一个插件后焦点的落点(程序化聚焦,不进 Tab 序)。 */}
      <h3
        ref={sectionHeadingRef}
        tabIndex={-1}
        className="mb-3 border-b border-line pb-3 text-base font-medium text-fg outline-none"
      >
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
        // 空态给下一步(VSCode 扩展视图空态引导去市场):切到「插件市场」设置页签。
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line bg-panel-soft/40 px-4 py-8 text-center text-xs text-fg-dim">
          <span>{t('plugins_tab.user.no_plugins')}</span>
          <Button variant="secondary" size="sm" onClick={openMarketplaceTab}>
            {t('plugins_tab.user.browse_marketplace')}
          </Button>
        </div>
      ) : (
        <div ref={listRef} className="rounded-md border border-line bg-panel-soft/40">
          {pendingRows.map((pending, i) => (
            <div key={pending.id} className={pluginsTabRowClassName(i > 0)}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-fg">{pending.name}</span>
                  <Badge size="xs" className="min-w-0 max-w-full">
                    <code className="truncate">{pending.id}</code>
                  </Badge>
                  <span className="text-2xs text-fg-dim">v{pending.version}</span>
                </div>
                <div className="mt-1 text-fg-muted">{t('plugins_tab.user.pending_hint')}</div>
              </div>
              {/* main 走与 ⌘Q 相同的退出流程(脏文件确认),通过后重新启动;失败(用户取消不算失败)经 live region 反馈。 */}
              <Button
                variant="primary"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  void coApi.window
                    .relaunchApp()
                    .then((r) => {
                      if (!r.ok) reportActionError(r);
                    })
                    .catch(reportActionError);
                }}
              >
                {t('plugins_tab.btn.restart_now')}
              </Button>
            </div>
          ))}
          {plugins.map((p, i) => (
            <div key={p.id} className={pluginsTabRowClassName(i > 0 || pendingRows.length > 0)}>
              {/* min-w-48:窄宽时右侧操作按钮换到下一行,而不是把插件名 / 描述挤成一行一个词。 */}
              <div className="min-w-48 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-fg">{p.manifest.name}</span>
                  <Badge size="xs" className="min-w-0 max-w-full">
                    <code className="truncate">{p.id}</code>
                  </Badge>
                  <span className="text-2xs text-fg-dim">v{p.manifest.version}</span>
                </div>
                {p.manifest.description && (
                  <div className="mt-1 text-fg-muted">{p.manifest.description}</div>
                )}
                {p.error && (
                  // a11y(A68,A41 同族):插件运行时错误异步出现(激活失败等),焦点常在别处 →
                  // role=alert(失败=assertive)主动播报,否则 SR 用户不知插件状态变坏。
                  <div role="alert" data-code={p.error.code} className="mt-1 text-2xs text-error">
                    {/* i18n(I4):error 结构化 {code,message},渲染时按 locale 出可读文案(不再给用户看
                        `CODE: message`;原始 code 留在 data-code 供排查,BDD: plugin-failure-notify)。 */}
                    {localizePluginError(p.error)}
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
                {p.awaitingGrantElsewhere && (
                  // 别的窗口装的、授权弹窗在那个窗口:这里的「启用」不是「被禁用了」,说明为何未加载与两条出路。
                  <div role="status" className="mt-1 text-2xs text-fg-muted">
                    {t('plugins_tab.user.awaiting_grant_elsewhere')}
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
                {p.status === 'failed' && (
                  // FAILED:启用按钮仍可点(权限拒绝时会清 deny + 复弹 Modal)
                  <Button
                    variant="primary"
                    size="sm"
                    data-plugin-retry={p.id}
                    onClick={() => {
                      setRetryFocusId(p.id);
                      void runLifecycle('retry', p.id, () => mgr?.enable(p.id))();
                    }}
                    title={t('plugins_tab.action.retry_enable_tooltip')}
                    aria-label={t('plugins_tab.action.row_button_aria', {
                      action: t('plugins_tab.btn.enable'),
                      name: p.manifest.name,
                    })}
                  >
                    {t('plugins_tab.btn.enable')}
                  </Button>
                )}
                {/* 启用 / 禁用是同一个按钮(固定槽位,只换文字与动作):切换后同一 DOM 元素保留焦点,不掉到 body(对齐 VSCode
                    扩展页)。FAILED 也可禁用:激活失败的插件不再每次启动重试;渲染出错时仍在运行的实例也能停掉
                    (BDD: plugin-failure-notify)。 */}
                {(() => {
                  const enabling = p.status === 'disabled';
                  const action = t(enabling ? 'plugins_tab.btn.enable' : 'plugins_tab.btn.disable');
                  return (
                    <Button
                      variant={enabling ? 'primary' : 'ghost'}
                      size="sm"
                      data-plugin-toggle={p.id}
                      onClick={
                        enabling
                          ? runLifecycle('enable', p.id, () => mgr?.enable(p.id))
                          : runLifecycle('disable', p.id, () => mgr?.disable(p.id))
                      }
                      aria-label={t('plugins_tab.action.row_button_aria', { action, name: p.manifest.name })}
                    >
                      {action}
                    </Button>
                  );
                })()}
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
                  data-plugin-uninstall={p.id}
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
            <>
              {/* 以名称称呼(用户认得的),id 作副文本。 */}
              <span data-uninstall-body>{t('plugins_tab.uninstall.body', { name: uninstallTarget.manifest.name })}</span>
              <code className="mt-1 block break-all font-mono text-2xs text-fg-dim">{uninstallTarget.id}</code>
            </>
          ) : null
        }
        confirmLabel={t('plugins_tab.uninstall.confirm')}
        destructive
        onConfirm={onConfirmUninstall}
        onCancel={() => setUninstallTarget(null)}
      />
      <ConfirmDialog
        open={updatePrompt !== null}
        title={t('plugins_tab.install.update_confirm_title')}
        description={
          updatePrompt
            ? t('plugins_tab.install.update_confirm_body', {
                name: updatePrompt.name,
                installed: updatePrompt.installed,
                version: updatePrompt.version,
              })
            : null
        }
        confirmLabel={t('plugins_tab.install.update_confirm')}
        onConfirm={() => settleUpdate(true)}
        onCancel={() => settleUpdate(false)}
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
