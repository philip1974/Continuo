import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanel,
  type SerializedDockview,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { usePanelComponents } from './panel-components';
import { coApp } from '@/plugins/co-app';
import { applyDefaultLayout, resetDockLayout } from './layout.default';
import { HeaderActions } from './HeaderActions';
import { EmptyState } from './EmptyState';
import { markDockLayoutRestored, setDockApi } from './dock-api-ref';
import { focusTerminalPanel } from '@/panels/Terminal/terminal-panel-handles';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { stripTerminalPanelsFromLayout } from './strip-terminal-layout';
import { popoutPositionsRelativeToWindow } from './popout-restore-position';
import { trackPopoutRestore, whenPopoutRestoreSettled } from './popout-restore-settle';
import { makeJsonSafe } from '../../../electron/shared/make-json-safe';
import { useDockReconciler } from './DockReconciler';
import { useDockLocaleSync } from './useDockLocaleSync';
import { wrapPanelClose, activateDockPanel, addPanelKeepingActive } from './wrap-panel-close';
import { trackEditorGroups } from './editor-groups-dock-sync';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';
import { handleTerminalPanelRemoved, removeTerminalSessionWithFeedback } from './DockReconciler';
import { TerminalKillConfirmHost, cancelTerminalCloseGuard, terminalCloseGuard } from './terminal-close-confirm';
import { SharedTab } from '@/shell/motion/SharedTab';
import { useClosingStore } from '@/stores/closing.store';
import { useEditorStore } from '@/stores/editor.store';
import { debounce } from '@/lib/debounce';
import { flushExplorerPersistence } from '@/lib/persist/explorer-persist';
import { flushPendingAutoSave } from '@/panels/Editor/autosave-flush-registry';
import { flushEditorWriteBacks } from '@/panels/Editor/editor-writeback-registry';
import { saveHotkeyLabel } from '@/panels/Editor/editor-commands';
import {
  getAutoSaveFailureVersion,
  subscribeAutoSaveFailures,
} from '@/panels/Editor/autosave-failures';
import { useEditorFile } from '@/panels/Editor/useEditorFile';
import { useSettingValue } from '@/plugins/settings/values-store';
import {
  AUTO_SAVE_MARKDOWN_ENABLED,
} from '@/plugins/settings/core-setting-specs';
import {
  countDirtyForClose,
  remainingAfterDiscard,
  remainingAfterFlush,
  saveDirtyTabsForClose,
  saveForCloseFailureMessage,
} from './dirty-close';
import { coApi } from '@/lib/co-api';
import { readDockLayout } from './layout-prefetch';
import { trackPopoutDocuments } from './popout-documents';
import { trackPopoutWindowTitles } from './popout-window-titles';
import { isMainWindowDockEmpty, mainWindowAddPosition, trackGroupMru } from './group-mru';
import { trackDropFocus } from './panel-focus';
import { trackActiveTabReveal } from './reveal-active-tab';
import { notify } from '@/notifications/notify';
import { t as translate } from '@/i18n';
import '@/styles/dockview.css';

// 外提到 module 顶层常量:DockviewReact 的 components/tabComponents 引用稳定
// 才能避免 dockview 内部 effect 误判 props 变化。每次 render 新建对象会
// 触发 dockview 重订阅 createComponent。同 panelComponents 对照(useMemo)。
const tabComponents = { default: SharedTab };

// 边界(E217,E215 同族):dock layout 的 panel 数量上限。layout:read 有 2MiB 字节上限(E215),但畸形
// layout 仍可在其内塞大量短 panel key。正常 layout panel 数 = 编辑器 tab + 终端 + 资源管理器等,远低于此。
const MAX_LAYOUT_PANELS = 256;

export function sanitizePersistedDockLayout(
  json: unknown,
): SerializedDockview | null {
  if (!json || typeof json !== 'object') return null;
  const layout = json as SerializedDockview & {
    panels?: Record<string, { contentComponent?: string }>;
  };
  // 既无 grid 也无 panels = 空布局(写端对「仅含终端」布局写的 {version:1})→ 无可恢复布局,静默走默认;
  // 交给 fromJSON 只会抛错并误报「恢复失败」。
  if (!('grid' in layout) && !('panels' in layout)) return null;
  const panels = layout.panels;
  if (!panels || typeof panels !== 'object') return layout;
  // 边界(E217,E197/E199 有界迭代族):单次 for...in 边数边扫,不先 Object.keys 把畸形 layout 的所有
  // panel key 全量物化。panel 数超 MAX_LAYOUT_PANELS → 丢弃 layout(返 null,走默认布局)。
  let count = 0;
  for (const panelId in panels) {
    if (!Object.prototype.hasOwnProperty.call(panels, panelId)) continue;
    count += 1;
    if (count > MAX_LAYOUT_PANELS) return null;
  }
  // 既有契约:终端不从持久化 layout 恢复(终端由 DockReconciler 依 live session 重建)。旧实现发现
  // 终端 panel 即整体弃用(返 null)→ 连带丢弃 editor 等非终端布局,且被上层当作「恢复失败」误报红
  // toast。改为只剥离终端 panel + 修补 grid 树,让非终端布局存活;无非终端残留 → null(静默走默认)。
  return stripTerminalPanelsFromLayout(layout);
}

function DockReconcilerMount({
  api,
  restoreStartedAt,
  onHydrated,
}: {
  api: DockviewApi;
  restoreStartedAt: number;
  onHydrated: () => void;
}): null {
  useDockReconciler(api, restoreStartedAt, onHydrated);
  useDockLocaleSync(api);
  return null;
}

// 可维护性 M10:dock layout 写盘单一来源(toJSON → {version:1,...} payload → layout.write
// → r.ok 失败 warn)。自动持久化(onDidLayoutChange debounce)与关窗 flush 共用,避免
// payload 结构 / 版本号 / 错误处理在两处漂移。warnPrefix 区分日志来源;调用方各自决定是否
// 再包 try/catch(flush 路径需捕获 toJSON/write 异常,debounce 路径沿用原行为不捕获)。
// a11y(A132):布局保存失败的 notify 限流 —— 自动保存(debounce)可能连续失败,避免 toast 轰炸,
// 同类失败 5s 内只播报一次。
let lastLayoutSaveNotifyAt = 0;
const LAYOUT_SAVE_NOTIFY_MIN_INTERVAL_MS = 5000;
let lastSuccessfulLayoutPayload: string | null = null;
// 每个 dock api 的布局版本(每次变更 +1)与「已落盘」的版本;二者相等 = 干净,可跳过快照重建。
// 用版本号而非布尔标记:写盘 await 期间若又发生变更,版本已前进,写成功后只把**写盘前**的版本记为
// 已落盘 —— 期间的变更仍是脏的,后续 debounce / 关窗 flush 会再写(布尔标记会把它一并标干净而丢失)。
// 关闭守卫:终端有子进程时先确认(VSCode confirmOnKill),× / 中键 / Delete / ⌘W 等所有 api.close 入口共用。
function wrapPanelCloseGuarded(panel: IDockviewPanel): void {
  wrapPanelClose(panel, terminalCloseGuard, cancelTerminalCloseGuard);
}

const layoutVersions = new WeakMap<DockviewApi, number>();
const savedLayoutVersions = new WeakMap<DockviewApi, number>();
function notifyLayoutSaveFailedRateLimited(): void {
  const now = Date.now();
  if (now - lastLayoutSaveNotifyAt < LAYOUT_SAVE_NOTIFY_MIN_INTERVAL_MS) return;
  lastLayoutSaveNotifyAt = now;
  notify.error(translate('errors.dock.layout_save_failed'));
}

async function writeDockLayoutSnapshot(
  api: DockviewApi,
  warnPrefix: string,
  // a11y(A132):自动保存路径传 true → 失败(!ok/reject)限流 notify(用户/SR 知布局未持久化,
  // 重启会丢);关窗 flush 路径传 false(默认)→ 沿用「可见日志 + 抛出由调用方 try/catch」语义。
  notifyOnFail = false,
): Promise<void> {
  // popout 恢复在途时 toJSON 漏掉在途的 popout 组与其面板 → 先等落定(见 popout-restore-settle)。
  await whenPopoutRestoreSettled(api);
  const version = layoutVersions.get(api) ?? 0;
  if (savedLayoutVersions.get(api) === version) return;
  try {
    // 写盘前剥离终端 panel(彻底修复:持久化 layout 不再携带终端的 sessionId 等陈旧/敏感
    // 数据;读端 sanitize 仍是兜底防线,处理历史 explorer.json 与竞态)。仅含终端(无非终端
    // panel)→ strip 返 null,此时写无 grid 的空布局(payload = {version:1}),终端绝不进持久化;
    // 读端 sanitize 对无 grid 布局返 null → 静默走默认布局(与此前读端剥离后的恢复行为一致)。
    const raw = api.toJSON();
    const cleaned = (stripTerminalPanelsFromLayout(raw) ?? {}) as unknown;
    // dockview toJSON 在某些瞬时状态会产出非有限 size 等非 JSON-safe 值,写端 assertJsonValue(E119)
    // 会整份拒写(BAD_INPUT)→ 布局永远无法落盘。写盘前清洗成 JSON-safe(剔除非有限数/undefined,
    // 语义同 JSON.stringify),让其余布局正常持久化;dockview 恢复时按窗口尺寸重算 size。
    const { value: snapshot, dropped } = makeJsonSafe(cleaned);
    if (dropped.length > 0) {
      console.warn(`${warnPrefix} 丢弃非 JSON-safe 值(布局仍持久化)`, dropped);
    }
    const payload = {
      version: 1 as const,
      ...(snapshot as object),
    };
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === lastSuccessfulLayoutPayload) {
      savedLayoutVersions.set(api, version);
      return;
    }

    const r = await coApi.layout.write(payload);
    if (!r.ok) {
      console.warn(`${warnPrefix} failed`, r.code, r.message);
      if (notifyOnFail) notifyLayoutSaveFailedRateLimited();
      return;
    }
    lastSuccessfulLayoutPayload = serializedPayload;
    savedLayoutVersions.set(api, version);
  } catch (err) {
    console.warn(`${warnPrefix} rejected`, err);
    if (notifyOnFail) notifyLayoutSaveFailedRateLimited();
    else throw err; // 保留 flush 路径抛出语义(调用方自有 try/catch)
  }
}

/**
 * Splash 就绪屏障的安全上限:布局已恢复而终端首个 sessions 快照迟迟不到(IPC 卡住 / 同步源未启用)时,
 * 最多再等这么久就报 ready,不永久遮挡界面。正常路径由事件解除,不等此上限。
 */
export const DOCK_TERMINAL_READY_TIMEOUT_MS = 3000;

export function DockShell({ onLayoutReady }: { onLayoutReady?: () => void }) {
  const apiRef = useRef<DockviewApi | null>(null);
  // race(R22):保存 onReady 里注册的 dockview onDid* disposables + debounce 持久化函数,在
  // DockShell 卸载 / onReady 重入(HMR/StrictMode/dockview 重建)时统一 dispose + cancel。
  // 否则旧 listener 与旧 debounce(闭包持旧 event.api)仍会触发,对已卸载组件 setEmpty、重复
  // handleTerminalPanelRemoved,或用旧 api.toJSON() 迟到写回 layout 覆盖新实例布局。
  const dockDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const layoutPersistRef = useRef<{ cancel: () => void } | null>(null);
  const disposeDockListeners = useCallback(() => {
    for (const d of dockDisposablesRef.current) {
      try {
        d.dispose();
      } catch {
        /* ignore dispose errors */
      }
    }
    dockDisposablesRef.current = [];
    layoutPersistRef.current?.cancel();
    layoutPersistRef.current = null;
  }, []);
  // restoreStartedAt:本 api 布局恢复开始时刻。Reconciler 首次 hydrate 只抑制此前已存在的 session 的兜底聚焦,
  // 恢复期间新建的 user terminal(Cmd+T)照常聚焦。
  const [reconcilerTarget, setReconcilerTarget] = useState<{
    api: DockviewApi;
    restoreStartedAt: number;
  } | null>(null);
  // apiReady 是 state(不是 ref):驱动下面 editor 自动激活 useEffect 的依赖,
  // 修复"hydrate 在 onReady 之前完成 → activeTabId 变化触发 effect 时
  // apiRef.current 仍 null → 错过添加 panel"的时序竞态。
  const [apiReady, setApiReady] = useState(false);
  // 布局(fromJSON / 默认布局)已恢复。会 addPanel 的 editor 自动激活依赖它而非 apiReady:恢复前加的面板
  // 会被 fromJSON 的 clear() 删掉且不再补建。关窗 flush 握手仍依赖 apiReady(时序不变)。
  const [layoutRestored, setLayoutRestored] = useState(false);
  // 当前 api 的 Reconciler 已按终端首个权威快照完成 reconcile(或已达安全上限)。与 layoutRestored 一起
  // 构成 onLayoutReady(App 移除 Splash)的事件式屏障:仅布局恢复就移除 Splash 时,迟到的终端快照会让
  // 面板在用户已可操作后跳入。
  const [terminalsReady, setTerminalsReady] = useState(false);
  const onTerminalsHydrated = useCallback(() => setTerminalsReady(true), []);
  // 主窗 dock 空态:null = 不空;'closed' = 面板全关;'elsewhere' = 面板都在 popout 子窗里。
  const [empty, setEmptyKind] = useState<null | 'closed' | 'elsewhere'>(null);
  const setEmpty = useCallback((api: DockviewApi) => {
    setEmptyKind(isMainWindowDockEmpty(api) ? (api.panels.length > 0 ? 'elsewhere' : 'closed') : null);
  }, []);
  const panelComponents = usePanelComponents();
  const { saveTab } = useEditorFile();

  const onReady = useCallback(
    async (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      const restoreStartedAt = Date.now();
      // race:Reconciler 的 api 推迟到布局恢复(fromJSON / 默认布局)完成后才设置(见下方)。
      // 若此处即挂载,await layout.read() 期间 Reconciler 建出的终端 panel 会被随后的 fromJSON
      //(dockview 内部先 clear())清掉,而 Reconciler 视为已同步不再补加 → 终端从 UI 消失。
      setApiReady(true);
      setLayoutRestored(false);
      setTerminalsReady(false);
      // 暴露给 IconSidebar 等 Dockview 之外的组件;布局恢复前 openOrFocusPanel 排队(见 dock-api-ref)。
      setDockApi(event.api, { layoutPending: true });
      // a11y(A131,A130 同族):layout.read() reject 此前会中断整个 onReady(连默认布局都不应用)。
      // try/catch 兜底;read 失败(reject/!ok)或 fromJSON 失败 → notify.error(用户/SR 知布局被
      // 重置而非静默);首次无持久布局(ok+null data)不算失败,默认布局静默应用。
      let persisted: unknown = null;
      let restoreFailed = false;
      try {
        // 性能:首次 onReady 取用 init() 开头的预取结果;之后的 onReady(重建 / StrictMode)重新读取。
        const readResult = await readDockLayout();
        if (readResult.ok) {
          persisted = readResult.data;
        } else {
          restoreFailed = true;
          console.warn('[dock] layout:read failed', readResult.code, readResult.message);
        }
      } catch (err) {
        restoreFailed = true;
        console.warn('[dock] layout:read rejected', err);
      }

      // race(R30):onReady 是 async,await layout.read() 期间可能发生 dockview 重建 / StrictMode /
      // onReady 重入(新 onReady 把 apiRef.current 指向新 api)或组件卸载(unmount cleanup 置 null)。
      // 此时本次回调已过期,继续执行会:对 stale event.api 跑 fromJSON/applyDefaultLayout、
      // setDockApi/setEmpty 覆盖新实例、disposeDockListeners() 清掉新实例的 listener 再把
      // debounce/flush listener 绑到旧 api(布局保存/关闭 flush 指向旧 dock、panel 事件丢失)、
      // 以及卸载后 setState。apiRef.current 在每次 onReady 入口同步赋值、卸载时置 null →
      // 用它判定本次是否仍是最新 api;过期则提前返回,跳过后续所有副作用。
      if (apiRef.current !== event.api) return;

      let restored = false;
      let popoutRestoreTracking: { dispose: () => void } | null = null;
      // sanitize 会剥离终端 panel(既有契约,非失败)并修补 grid 树。返回 null = 无可恢复的
      // 非终端布局(无持久化/畸形/超限)→ 静默走默认布局,不算失败、不报错。只有真正的 fromJSON 抛错
      // (布局结构损坏)才置 restoreFailed → 弹 toast。
      const sanitized = sanitizePersistedDockLayout(persisted);
      if (sanitized) {
        try {
          // popout 位置:dockview 存的是屏幕坐标、恢复时又加主窗原点 → 先换算成相对主窗原点(否则每次重启往右下漂)。
          event.api.fromJSON(popoutPositionsRelativeToWindow(sanitized, window.screenX, window.screenY));
          // popout 组之后才异步开窗挂上;落定前的布局快照不完整,写盘须等(见 popout-restore-settle)。
          popoutRestoreTracking = trackPopoutRestore(
            event.api,
            Array.isArray(sanitized.popoutGroups) ? sanitized.popoutGroups.length : 0,
          );
          restored = true;
        } catch (err) {
          restoreFailed = true;
          console.warn('[dock] fromJSON 失败,落回默认布局', err);
        }
      }
      if (!restored) applyDefaultLayout(event.api);
      // 布局已定型 → 挂载 Reconciler:新 api 视作空 dock,按 live sessions 全量建终端 panel(R26)。
      setReconcilerTarget({ api: event.api, restoreStartedAt });
      // 放行恢复前排队的 openOrFocusPanel + editor 自动激活。
      markDockLayoutRestored(event.api);
      setLayoutRestored(true);
      if (restoreFailed) {
        notify.error(translate('errors.dock.layout_restore_failed'));
      }

      // Explorer 已迁出 Dockview → 固定左 sidebar(VSCode 风)。
      // 旧版持久化 layout(explorer.json 窗口段)可能仍含 'explorer' panel(已无对应 component),清理掉。
      const orphanExplorer = event.api.getPanel('explorer');
      if (orphanExplorer) {
        try {
          orphanExplorer.api.close();
        } catch {
          /* ignore */
        }
      }
      // 单例面板类型(editor / settings / 插件面板,见 PanelSpec.multiInstance)只允许固定 id(= type)那一个:旧版「⋯」
      // 菜单曾多开出 `editor-1` / `settings-1`,恢复后两个 EditorPanel 各自自动保存互相覆盖、⌘, 关不掉多出的设置面板。
      // 关闭非固定 id 的实例(内容来自共享 store,不丢数据;editor 缺失时下方按固定 id 补建)。
      closeDuplicateSingletonPanels(event.api, coApp.panels);

      setEmpty(event.api);

      // race(R22):onReady 重入(dockview 重建)先清旧 listener/debounce,再注册新的。
      disposeDockListeners();

      const persist = debounce(
        // a11y(A132):自动保存路径 notifyOnFail=true(失败限流 notify,用户知布局未落盘)。
        () => writeDockLayoutSnapshot(event.api, '[dock] layout:write', true),
        300,
      );
      layoutPersistRef.current = persist;

      // race(R22):保存各 onDid* 返回的 disposable,卸载/重建时统一 dispose。
      dockDisposablesRef.current.push(
        ...(popoutRestoreTracking ? [popoutRestoreTracking] : []),
        event.api.onDidLayoutChange(() => {
          layoutVersions.set(event.api, (layoutVersions.get(event.api) ?? 0) + 1);
          persist();
          setEmpty(event.api);
        }),
        // 防 closing-store 残留:panel 真被 removed 后从 set 摘掉,
        // 避免后续同 id panel 一上来就走 EXIT 动画。
        // terminal panel:同时走 handleTerminalPanelRemoved 反向通知 main
        // remove session(suppress flag + move-vs-real-close 区分由 helper 管)。
        event.api.onDidRemovePanel((panel) => {
          useClosingStore.getState().unmark(panel.id);
          void handleTerminalPanelRemoved({
            panel,
            api: event.api,
            removeSession: removeTerminalSessionWithFeedback,
          });
        }),
        // 拦截所有 panel 的 api.close,统一走"标记 closing → 220ms 延迟 → 真 close"。
        // 包括 group 整体关闭、第三方调用方等间接路径,只要走 api.close 都能拿到动画。
        event.api.onDidAddPanel(wrapPanelCloseGuarded),
        // topic-22: exit-maximize 后把 focus 拉回 xterm。
        // setActive() 不会触发 onDidActiveChange(panel 在 exit 前已是 active),
        // 所以必须显式调 focusTerminalPanel。用 event.group.activePanel
        // (design review v1 P1-3) 不重读全局 activePanel,避免 exit 期间被改写。
        event.api.onDidMaximizedGroupChange((evt) => {
          if (evt.isMaximized) return;
          const panel = evt.group.activePanel;
          if (!panel) return;
          if (panel.view.contentComponent !== TERMINAL_PANEL_TYPE) return;
          focusTerminalPanel(panel.id);
        }),
        // popout 子窗文档集合 → ToastViewport 把 toast 也渲染进子窗(弹出面板的 notify.* 进主窗 provider)。
        trackPopoutDocuments(event.api),
        // popout 子窗原生标题 = 子窗自己的活动文件 / 面板(dockview 只在开窗时抄一次主窗标题)。
        trackPopoutWindowTitles(event.api),
        // 关掉活动组 / popout 子窗后激活最近使用的组、收回的面板获焦(VSCode),而非 dockview 默认的最早的组。
        trackGroupMru(event.api),
        // 拖放 dock tab(分栏 / 叠放)后被拖的面板获焦(VSCode);dockview 只激活不移 DOM 焦点。
        trackDropFocus(event.api),
        // 每个组的活动 tab 总在 tab 条可见区内(VSCode),不被挤进「⌄N」溢出菜单看不到。
        trackActiveTabReveal(event.api),
        // 编辑器组 ↔ editor 面板:组关闭 → 关面板;面板被关 → 移除组;激活面板 → 活动编辑器组(BDD: editor-groups)。
        trackEditorGroups(event.api),
      );
      event.api.panels.forEach(wrapPanelCloseGuarded);
    },
    [disposeDockListeners, setEmpty],
  );

  useEffect(() => {
    if (layoutRestored && terminalsReady) onLayoutReady?.();
  }, [layoutRestored, terminalsReady, onLayoutReady]);

  useEffect(() => {
    if (!layoutRestored || terminalsReady) return;
    const timer = setTimeout(() => setTerminalsReady(true), DOCK_TERMINAL_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [layoutRestored, terminalsReady]);

  // 空状态「恢复默认布局」与命令「视图:重置布局」同一实现(BDD: src/__tests__/dock-reset-layout/)。
  const restore = useCallback(() => {
    if (apiRef.current) resetDockLayout(apiRef.current);
  }, []);

  // unmount 时 reset 单例,防 stale 引用;并 dispose onReady 注册的 dockview listeners +
  // cancel layout debounce(race R22:防卸载后旧 listener/迟到写盘对新实例生效)。
  useEffect(
    () => () => {
      setDockApi(null);
      // race(R30):置 null 失效任何仍 parked 在 await 的 onReady —— 其 resume 后
      // `apiRef.current !== event.api` 成立,跳过 fromJSON/register/setState 等卸载后副作用。
      apiRef.current = null;
      disposeDockListeners();
    },
    [disposeDockListeners],
  );

  useEffect(() => {
    if (!apiReady) return;
    if (!apiRef.current) return;
    // 关窗 flush 握手:main 发 layout:flush-request → 本回调落盘三路数据 → sendFlushAck → main 才真正
    // 关窗。必须经 coApi(preload 只暴露 __lmApi;此前读了一个不存在的全局 bridge,整条握手是死的:
    // flush 从不执行,main 每次关窗干等 ack 超时)。
    const off = coApi.layout.onFlushRequest?.(async (payload) => {
      // 先把编辑器里尚未进 store 的输入(Milkdown 自适应延迟上抛窗口内,见 MilkdownEditor emitDelayMs)同步回写,
      // 下面的「保存」与 autosave flush 才落盘到最新内容。
      flushEditorWriteBacks();
      // 用户在 main 的脏文件确认框选了「保存」→ 先保存所有有路径的脏 tab(代码文件不 autosave,
      // ADR-015),任一失败 → toast + 回执 saveFailed,main 中止关窗 / 退出并重新显示窗口。
      let saveFailed = false;
      if (payload?.save) {
        const result = await saveDirtyTabsForClose(
          useEditorStore.getState().tabs,
          saveTab,
          () => useEditorStore.getState().tabs,
        );
        if (result.failed > 0) {
          saveFailed = true;
          // 列出失败文件;磁盘冲突 / 写保护单独说明(关窗流程不弹覆盖框,引导用户按保存键解决或选「不保存」;
          // 保存键填当前生效绑定)。
          notify.error(saveForCloseFailureMessage(result, saveHotkeyLabel()));
        }
      }
      // race(R42):在 flush **执行时**读取 apiRef.current,而非 effect 注册时闭包捕获。effect 仅
      // 依赖 apiReady、只注册一次;若 onReady 重入/重建(HMR/StrictMode/dockview rebuild)把
      // apiRef.current 换成新 api,旧闭包会用 stale api 写盘 → 关窗落盘旧 dock 布局,覆盖/丢失当前
      // 窗口的 panel 增删/移动。apiRef.current 由 onReady 同步更新、卸载置 null(R30 同款基准)。
      const api = apiRef.current;
      const layoutFlush = (async () => {
        if (!api) return;
        try {
          await writeDockLayoutSnapshot(api, '[dockview] flush save');
        } catch (err) {
          console.warn('[dockview] flush save failed', err);
        }
      })();
      // 除 dockview layout 外,explorer/editor 段(workspace 切换、打开的 tab、
      // 树展开)走的是独立的 300ms debounce 链,关窗前必须一并同步落盘,
      // 否则 ack 返回但这些改动随未触发的 timer 丢失。见审计 #4。
      const explorerFlush = (async () => {
        try {
          await flushExplorerPersistence();
        } catch (err) {
          console.warn('[dockview] explorer flush failed', err);
        }
      })();
      // pending 的 markdown autosave 内容卡在 useAutoSave 的 2s 防抖 timer 里,
      // 只在 React unmount cleanup 才 flush,而 win.close() 销毁 renderer 时
      // React cleanup 不保证执行 → 编辑 md 后 2s 内关窗会丢最后一段。关窗前
      // 在 ack 之前同步落盘(P1-AE)。
      const autosaveFlush = (async () => {
        try {
          await flushPendingAutoSave();
        } catch (err) {
          console.warn('[dockview] autosave flush failed', err);
        }
      })();
      // 三条 flush 数据域独立;layout/explorer 如最终共享 explorer.json,main 侧 file mutex
      // 仍负责串行化磁盘合并。renderer 这里并行启动,减少关闭按钮等待首个慢任务串住后续落盘。
      await Promise.all([layoutFlush, explorerFlush, autosaveFlush]);
      // 统一规则:全部 flush 完成后、ACK 前最终脏检查。本轮未选「不保存」且仍有未保存改动(防抖内 autosave
      // 失败 / flush 期间继续输入 / 确认期间变脏)→ 回执 remaining,main 中止关闭 / 退出并按此记账。
      const tabs = useEditorStore.getState().tabs;
      // 「不保存」:框里列出的文件照常丢弃,但确认时未列入框的待 autosave .md(pendingAutoSave)仍脏 → remaining。
      const pendingAutoSave = payload?.discard ? payload.pendingAutoSave : undefined;
      const remaining = payload?.discard
        ? remainingAfterDiscard(
            tabs,
            Array.isArray(pendingAutoSave)
              ? pendingAutoSave.filter((id): id is string => typeof id === 'string')
              : [],
          )
        : remainingAfterFlush(tabs);
      // 回执始终携带 flush 后的最终脏态(含空集合),main 以其记账(复审:「保存」后 tab 变干净,但干净状态
      // 此前要等之后的 effect 上报,main 可能先用旧脏集合做退出前全局最终检查而误中止退出)。
      // autosave 已 flush 过,仍脏的 .md 也计入(同 remainingAfterFlush)。
      const state = countDirtyForClose(tabs, false);
      // main 已按回执记账:同步去重基准,之后脏态变化与之不同即重新上报。
      lastDirtyReportRef.current = JSON.stringify(state);
      const windowId = payload?.windowId ?? coApi.system.windowId;
      // requestId 原样带回:main 只接受与在途请求匹配的回执(关窗与 Cmd+Q 交叉时不串号)。
      const requestId = payload?.requestId;
      coApi.layout.sendFlushAck?.(windowId, {
        ...(payload?.save ? { saveFailed } : {}),
        state,
        ...(remaining ? { remaining } : {}),
        ...(typeof requestId === 'number' ? { requestId } : {}),
      });
    });
    return () => {
      off?.();
    };
  }, [apiReady, saveTab]);

  // 关窗脏文件确认:脏态变化(chromeVersion 覆盖 dirty 翻转 / tab 增删改名)时向 main 上报
  // 关窗会丢的脏 tab 计数与 id,main 关窗 / 退出前据此弹「保存 / 不保存 / 取消」。计数与 id 不变不重发;
  // 初值 0/0 = main 的默认(未上报),挂载时无脏 tab 不发。
  const editorChromeVersion = useEditorStore((s) => s.chromeVersion);
  // 活动 tab 的 autosave 持有者 / 失败态变化(失败或非活动的脏 .md 需计入确认)也要重新上报。
  const autoSaveFailureVersion = useSyncExternalStore(
    subscribeAutoSaveFailures,
    getAutoSaveFailureVersion,
  );
  const mdAutoSaveEnabled = useSettingValue(AUTO_SAVE_MARKDOWN_ENABLED.id, AUTO_SAVE_MARKDOWN_ENABLED.default);
  const lastDirtyReportRef = useRef(JSON.stringify(countDirtyForClose([], false)));
  useEffect(() => {
    const state = countDirtyForClose(useEditorStore.getState().tabs, mdAutoSaveEnabled);
    const key = JSON.stringify(state);
    if (key === lastDirtyReportRef.current) return;
    lastDirtyReportRef.current = key;
    coApi.layout.reportDirtyState?.(state);
  }, [editorChromeVersion, mdAutoSaveEnabled, autoSaveFailureVersion]);

  // Editor 自动激活:Explorer 单击文件 → editor.store activeTabId / editorFocusPulse 变
  // → 自动 setActive 'editor' panel(VSCode 行为)。
  // 若 panel 不存在(用户拖关了 / 启动时 layout 没含),自动 addPanel 加回。
  // hydrate 恢复 session(可能晚于布局恢复)以 requestFocus:false 打开,不递增 pulse → 只确保面板存在,不激活。
  //
  // deps 必含 layoutRestored(而非 apiReady):让布局恢复完成晚于 activeTabId hydrate 的场景也能补建;
  // 恢复前 addPanel 的 editor 会被 fromJSON 的 clear() 删掉。
  // deps 必含 editorFocusPulse:同 id 重新点击(activeTabId 不变)也要触发,
  // 否则用户切到 terminal 后再点资源管理器同一文档,terminal 不会让位。见 #22。
  const editorActiveTabId = useEditorStore((s) => s.activeTabId);
  const editorFocusPulse = useEditorStore((s) => s.editorFocusPulse);
  // 激活 / 补建的是**活动编辑器组**的面板(组 id = 面板 id;BDD: src/__tests__/editor-groups/)。
  const editorGroupId = useEditorStore((s) => s.activeGroupId);
  // 已处理到的 editorFocusPulse 基线:布局恢复完成时取当时的 pulse,此后每消费一次用户意图(setActive editor)
  // 就推进到当前 pulse。恢复后首次运行的 activeTabId 来自持久化 hydrate,不是用户意图:只确保 editor 面板存在,
  // 不 setActive(否则覆盖 fromJSON 恢复的活动面板 / 恢复期间排队打开的面板);pulse 自上次处理以来有变化
  //(用户打开 / 切换文件)才激活。不推进的话:用户在 hydrate 前开过文件(pulse 0→1)又切回别的面板,随后
  // hydrate 以 requestFocus:false 改 activeTabId 时 1 !== 0 会被再次判成意图、抢走活动面板。
  // layoutRestored 回落(onReady 重入)时重置。
  const handledFocusPulseRef = useRef<number | null>(null);
  useEffect(() => {
    if (!layoutRestored) {
      handledFocusPulseRef.current = null;
      return;
    }
    handledFocusPulseRef.current ??= editorFocusPulse;
    if (!editorActiveTabId) return;
    const api = apiRef.current;
    if (!api) return;
    const userIntent = editorFocusPulse !== handledFocusPulseRef.current;
    let editorPanel = api.getPanel(editorGroupId);
    if (!editorPanel) {
      // 活动组在 popout 子窗时补建在主窗(VSCode:从主窗打开文件落在主窗),不落进用户看不到的子窗。
      const position = mainWindowAddPosition(api);
      const options = {
        id: editorGroupId,
        component: 'editor',
        title: 'Editor',
        params: { titleKey: 'panels.editor.title' },
        ...(position ? { position } : {}),
      };
      // 非用户意图 → 不抢激活(同 Reconciler 不抢焦点的做法)。
      if (!userIntent) {
        addPanelKeepingActive(api, options);
        return;
      }
      editorPanel = api.addPanel(options);
    } else if (!userIntent) {
      return;
    }
    // 已有面板可能正处于关闭 EXIT 动画窗口内(用户刚关 editor 面板随即又点开文件):activateDockPanel 撤销排定的
    // 真 close,否则刚打开的文件随面板一起消失。
    activateDockPanel(editorPanel);
    handledFocusPulseRef.current = editorFocusPulse;
  }, [editorActiveTabId, editorFocusPulse, layoutRestored, editorGroupId]);

  return (
    // isolate:把 dockview 内部的大 z-index(sash 99、浮动组 997+、拖放落点 9999)收进 dock 自身的层叠上下文,
    // 不与 body 下的 toast / 模态 / 菜单同层比较(BDD:src/__tests__/dock-stacking-context)。
    // data-workbench-part:F6 / ⇧F6 区域切换的「dock」区域(src/shell/focus-parts.ts)。
    <div className="relative isolate h-full w-full" data-workbench-part="dock">
      {reconcilerTarget && (
        <DockReconcilerMount
          api={reconcilerTarget.api}
          restoreStartedAt={reconcilerTarget.restoreStartedAt}
          onHydrated={onTerminalsHydrated}
        />
      )}
      <DockviewReact
        components={panelComponents}
        tabComponents={tabComponents}
        defaultTabComponent={SharedTab}
        rightHeaderActionsComponent={HeaderActions}
        onReady={onReady}
        className="dockview-theme-abyss h-full w-full"
      />
      {empty !== null && <EmptyState onRestore={restore} elsewhere={empty === 'elsewhere'} />}
      <TerminalKillConfirmHost />
    </div>
  );
}

/** 关闭单例类型(未声明 multiInstance)中 id 不等于 type 的面板实例。 */
export function closeDuplicateSingletonPanels(
  api: Pick<DockviewApi, 'panels'>,
  panels: { get(type: string): { readonly multiInstance?: boolean } | undefined },
): void {
  for (const panel of [...api.panels]) {
    const type = panel.view?.contentComponent;
    if (typeof type !== 'string' || panel.id === type) continue;
    // 编辑器组面板(editor:2 …)是多编辑器组的合法实例,不是旧版多开的重复编辑器(BDD: editor-groups)
    if (type === 'editor' && isEditorGroupId(panel.id)) continue;
    const spec = panels.get(type);
    if (!spec || spec.multiInstance === true) continue;
    try {
      panel.api.close();
    } catch {
      /* ignore */
    }
  }
}

