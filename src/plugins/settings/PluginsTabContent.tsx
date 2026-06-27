// '插件' SettingTab 内容(M-Plugin v3.5)。
// 自检视图:贡献点统计 + 内置插件清单 + 用户插件占位(等 v4 IPC)。

import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@/design';
import { clampGitUrl } from '../../../electron/shared/plugins-channels';
import { ConfirmDialog } from '@/panels/Explorer/ConfirmDialog';
import { coApi } from '@/lib/co-api';
import { coApp } from '../co-app';
import { useMultiRegistry } from '../registries/useRegistry';
import { getUserPluginManager } from '../PluginManager';
import { getUserPermissionStore } from '../permissions/co-permission-store';
import { PermissionEditorModal } from '../permissions/PermissionEditorModal';
import { useUpdateStore } from '@/marketplace/update-store';
import type { PluginListItem } from '../PluginManager';
import { useT, useTWithFallback } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { SR_ONLY_STYLE } from '@/lib/sr-only';
import { errorMessage } from '../../../electron/shared/error-message';

interface ContributionRow {
  readonly labelKey: string;
  readonly count: number;
  readonly samples: readonly string[];
}

function snapshot(): readonly ContributionRow[] {
  // 每个 registry 只取一次快照(打磨 R4):getAll()/getBySide() 都 Array.from
  // (+sort),原先 count 与 samples 各调一遍、statusBar 左右各取两遍 → 重复
  // 分配/排序。局部快照后 count=.length、samples=.map,行为完全等价。
  const panels = coApp.panels.getAll();
  const commands = coApp.commands.getAll();
  const statusItems = [
    ...coApp.statusBar.getBySide('left'),
    ...coApp.statusBar.getBySide('right'),
  ];
  const ribbon = coApp.ribbon.getAll();
  const settingTabs = coApp.settingTabs.getAll();
  const explorerDecorators = coApp.explorerDecorators.getAll();
  const editorActions = coApp.editorActions.getAll();
  return [
    {
      labelKey: 'plugins_tab.label.panels',
      count: panels.length,
      samples: panels.map((p) => p.type),
    },
    {
      labelKey: 'plugins_tab.label.commands',
      count: commands.length,
      samples: commands.map((c) => c.id),
    },
    {
      labelKey: 'plugins_tab.label.statusbar',
      count: statusItems.length,
      samples: statusItems.map((x) => x.id),
    },
    {
      labelKey: 'plugins_tab.label.ribbon',
      count: ribbon.length,
      samples: ribbon.map((r) => r.id),
    },
    {
      labelKey: 'plugins_tab.label.setting_tabs',
      count: settingTabs.length,
      samples: settingTabs.map((t) => t.id),
    },
    {
      labelKey: 'plugins_tab.label.explorer_decorators',
      count: explorerDecorators.length,
      samples: [],
    },
    {
      labelKey: 'plugins_tab.label.editor_actions',
      count: editorActions.length,
      samples: editorActions.map((a) => a.id),
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

/**
 * 两个插件列表渲染等价(打磨 R2:轮询无变化时保持引用稳定)。逐项比较所有被
 * UI 渲染的可变字段(id/status/error/warning) + manifest 引用(reload 会换新
 * manifest ref)。任一 status/warning 变化即判不等 → 换引用 re-render,不会掩盖
 * 「loading→active→failed」「partial-grant ⚠」等真实状态更新(正是打磨在防的
 * UI 陈旧态)。
 */
export function samePluginList(
  a: readonly PluginListItem[],
  b: readonly PluginListItem[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!; // i < a.length 且 a.length===b.length,两侧索引必有值
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.status !== y.status ||
      x.error !== y.error ||
      x.warning !== y.warning ||
      x.manifest !== y.manifest
    ) {
      return false;
    }
  }
  return true;
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
    // listAll() 每次返回新数组;1s 轮询直接 setSnap 会让整个插件列表每秒
    // re-render。函数式更新只在列表渲染态实际变化时换引用。(codex 打磨 R2)
    const next = m ? m.listAll() : [];
    setSnap((prev) => (samePluginList(prev, next) ? prev : next));
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
  const tf = useTWithFallback();
  const { plugins, refresh } = useUserPlugins();
  const mgr = getUserPluginManager();
  const [gitUrl, setGitUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  // race(R8):同步 in-flight 闸门。disabled={installing} 是 render 后状态,异步滞后 —— 同一事件
  // 循环内双击/Enter 会在 setInstalling(true) 生效前两次进 onInstall,启动两次 installFromGit
  // (主进程 install lock 要等 clone+manifest 解析才按 pluginId 串行,期间已双 clone,第二个常
  // EEXIST 把成功覆盖成失败)。ref 同步占位:进入即标记,重入直接 return。
  const installingRef = useRef(false);
  // a11y(A42):结果消息带严重度 → 渲染时按语义选 live region(成功 status/polite,失败 alert)。
  const [installMsg, setInstallMsg] = useState<{
    text: string;
    isError: boolean;
  } | null>(null);
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

  // race(R102,R50 同族):权限编辑弹窗持有打开时捕获的 PluginListItem。弹窗打开期间该插件被
  // 另一窗口/操作卸载时,1s 轮询刷新 plugins 列表但 permEditTarget 仍是旧 item → 弹窗仍可保存,
  // 把已卸载插件的 ghost 权限写回 _permissions.json,同 id 日后重装意外继承非当前意图的授权。
  // 插件从 live 列表消失即自动关闭弹窗(覆盖轮询);保存瞬间也 pluginStillExists 复检(覆盖
  // 本 effect 关闭前的同帧点击),同 KeybindingsTabContent R50。
  useEffect(() => {
    if (permEditTarget && !plugins.some((p) => p.id === permEditTarget.id)) {
      setPermEditTarget(null);
    }
  }, [permEditTarget, plugins]);

  // race(R103,R102 同族):卸载确认弹窗持有打开瞬间的 uninstallTarget 旧快照。弹窗打开期间该插件被
  // 另一窗口/操作卸载(1s 轮询刷新后从 plugins 消失),或卸载+重装同 id(version 变化=不同实例),
  // 迟到的确认会对当前新实例执行 mgr.uninstall(target.id) → 删掉用户从未确认的新插件。live 列表中
  // 同 id+同 version 的条目不再存在即自动关弹窗。用 id+version 作同一实例校验(PluginListItem 无稳定
  // 实例 token,重装通常改 version;同 version 重装不可区分,极罕见,按 id 语义仍合理)。
  // 注:不在 onConfirmUninstall 里再复检 —— React passive effect 在 commit 后、paint 前 flush,plugins
  // 一变本 effect 即先关弹窗,用户无从在「plugins 已变而弹窗仍开」的画面上点确认,故 effect 已充分。
  useEffect(() => {
    if (
      uninstallTarget &&
      !plugins.some(
        (p) =>
          p.id === uninstallTarget.id &&
          p.manifest.version === uninstallTarget.manifest.version,
      )
    ) {
      setUninstallTarget(null);
    }
  }, [uninstallTarget, plugins]);

  const onConfirmUninstall = async () => {
    if (!uninstallTarget || !mgr) return;
    const target = uninstallTarget;
    setUninstallTarget(null);
    try {
      await mgr.uninstall(target.id);
      // 卸载成功:把该 id 从 update-store.available 摘除。否则若该插件此前有可用更新,
      // IconSidebar 设置角标(=available.length)会持续把这个已不存在的插件计入「待更新」
      // 数,整个 session 不收敛 —— update-store 只在启动与 marketplace 更新成功对账时
      // refresh,不订阅插件列表变化,卸载本身不会重算 available。与 MarketplaceTab.onUpdate
      // 成功后的乐观 dismiss 对称(同「派生标记离开状态须清」族)。dismiss 对不在 available
      // 的 id 是 no-op,安全。
      useUpdateStore.getState().dismiss(target.id);
    } catch (err) {
      console.warn(`[plugins-tab] uninstall ${target.id} failed`, err);
      // i18n(I10,I1-I9 同族,catch 抛错路径):uninstall 抛回带 code 的 Error
      // (main RM_FAILED message 是中文「删除失败:…」/ NOT_SUPPORTED),只 errorMessage()
      // 会丢 code 且把中文/英文 raw 塞进本地化外壳 → 双向泄漏。有 code 时按 code 经 catalog
      // 本地化,无 code(如 "Plugin x not found")回退原文。
      const code = (err as { code?: unknown }).code;
      const message =
        typeof code === 'string'
          ? localizeErrorByCode(code, errorMessage(err))
          : errorMessage(err);
      setInstallMsg({
        text: t('plugins_tab.install.uninstall_fail', { message }),
        isError: true,
      });
    }
    refresh();
  };

  const onInstall = async () => {
    if (!gitUrl.trim()) return;
    // race(R8):同步单飞 —— 重入(同 tick 双击/Enter)在 installing state 生效前直接挡掉。
    if (installingRef.current) return;
    installingRef.current = true;
    setInstalling(true);
    setInstallMsg(null);
    try {
      const r = await coApi.plugins.installFromGit(gitUrl.trim());
      if (!r.ok) {
        // i18n(codex 复查 P1):installFromGit 各错误站点的 Error.message 是硬编码中文
        // (不支持的 git URL / manifest 缺字段 / main 入口非法 / 删除失败…),经 safeHandle
        // 原样传到 renderer。直接展示 r.message → en/ko 界面看到中文。改用稳定 r.code 经
        // catalog 翻译(errors.<CODE> 三语言已齐);未纳入 catalog 的 code 才回退原 message。
        const localized = tf(`errors.${r.code}`, r.message);
        setInstallMsg({
          text: t('plugins_tab.error.generic', {
            message: `[${r.code}] ${localized}`,
          }),
          isError: true,
        });
      } else {
        setInstallMsg({
          text: t('plugins_tab.install.success', {
            name: r.data.name,
            version: r.data.version,
          }),
          isError: false,
        });
        setPendingInstall(r.data);
        setGitUrl('');
      }
    } catch (err) {
      setInstallMsg({
        text: t('plugins_tab.error.generic', {
          message: errorMessage(err),
        }),
        isError: true,
      });
    } finally {
      installingRef.current = false;
      setInstalling(false);
    }
  };

  // a11y(A47,A46 同族):生命周期操作(reload/disable/enable/retry)失败此前只 console.warn,
  // 用户看似无响应。统一把失败经 installMsg live region(A42:role=alert)反馈,带 code 本地化。
  const reportActionError = (err: unknown) => {
    const code = (err as { code?: unknown }).code;
    const message =
      typeof code === 'string'
        ? localizeErrorByCode(code, errorMessage(err))
        : errorMessage(err);
    setInstallMsg({
      text: t('plugins_tab.error.generic', { message }),
      isError: true,
    });
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
            // a11y(A5 同族):placeholder 是 URL 示例(格式提示)非标签 → 用 section 标题作
            // aria-label,给屏幕阅读器「从 Git URL 安装」的可访问名。
            aria-label={t('plugins_tab.section.install_from_git')}
            placeholder="https://github.com/user/plugin.git"
            value={gitUrl}
            // 边界(E282):截断超长 git URL(防 paste 撑 React state + IPC structured-clone 放大)。
            onChange={(e) => setGitUrl(clampGitUrl(e.target.value))}
            disabled={installing}
            className="flex-1"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={onInstall}
            disabled={installing || !gitUrl.trim()}
            // a11y(A95,A94 同族):安装中标 aria-busy(Marketplace loading 修复的兄弟入口)。
            aria-busy={installing}
          >
            {installing
              ? t('plugins_tab.install.installing')
              : t('plugins_tab.install.install')}
          </Button>
        </div>
        {/* a11y(A95,A51 同族):安装 loading 瞬时态 → 视觉隐藏 role=status 镜像「安装中」
            (仅 installing 时输出;成功/失败结果由下方 installMsg live region 播报)。 */}
        <span style={SR_ONLY_STYLE} role="status">
          {installing ? t('plugins_tab.install.installing') : ''}
        </span>
        {installMsg && (
          // a11y(A42,A41 同族):异步安装/卸载结果须 live region 主动播报(焦点仍在按钮/对话框)。
          // 失败用 role=alert(assertive),成功用 role=status(polite)。
          <div
            className="mt-2 text-xs text-fg-muted"
            role={installMsg.isError ? 'alert' : 'status'}
          >
            {installMsg.text}
          </div>
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
                  // a11y(A68,A41 同族):插件运行时错误异步出现(激活失败等),焦点常在别处 →
                  // role=alert(失败=assertive)主动播报,否则 SR 用户不知插件状态变坏。
                  <div role="alert" className="mt-1 text-2xs text-error">
                    {/* i18n(I4):error 结构化 {code,message},按 code 经 catalog 渲染;
                        未收录 code(PERMISSION_DENIED/IMPORT_FAILED/EXCEPTION 等动态
                        message)保留旧 `code: message` 格式作 fallback。 */}
                    {tf(
                      `errors.${p.error.code}`,
                      `${p.error.code}: ${p.error.message}`,
                    )}
                  </div>
                )}
                {p.warning && (
                  // a11y(A68):部分授权等警告异步出现 → role=status(可覆盖警告=polite)。
                  <div role="status" className="mt-1 text-2xs text-warning">
                    {/* a11y(A84,A73 同族装饰符号):⚠ 是纯视觉装饰,严重度由 role/文本表达 →
                        aria-hidden,否则混进 live region 播报成"warning sign …"噪声。 */}
                    <span aria-hidden="true">⚠</span>{' '}
                    {t(p.warning.code, p.warning.params)}
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
                      reportActionError(err);
                    }
                    refresh();
                  }}
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
                    onClick={async () => {
                      try {
                        await mgr?.disable(p.id);
                      } catch (err) {
                        console.warn(`[plugins-tab] disable ${p.id} failed`, err);
                        reportActionError(err);
                      }
                      refresh();
                    }}
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
                    onClick={async () => {
                      try {
                        await mgr?.enable(p.id);
                      } catch (err) {
                        console.warn(`[plugins-tab] enable ${p.id} failed`, err);
                        reportActionError(err);
                      }
                      refresh();
                    }}
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
                    onClick={async () => {
                      try {
                        await mgr?.enable(p.id);
                      } catch (err) {
                        console.warn(`[plugins-tab] retry ${p.id} failed`, err);
                        reportActionError(err);
                      }
                      refresh();
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
          declared={permEditTarget?.manifest.permissions ?? []}
          store={permStore}
          onClose={() => setPermEditTarget(null)}
          pluginStillExists={() =>
            permEditTarget !== null &&
            plugins.some((p) => p.id === permEditTarget.id)
          }
        />
      )}
    </section>
  );
}
