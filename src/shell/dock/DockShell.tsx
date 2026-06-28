import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type SerializedDockview,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { PanelMount } from '@/shell/motion/PanelMount';
import { applyDefaultLayout } from './layout.default';
import { HeaderActions } from './HeaderActions';
import { EmptyState } from './EmptyState';
import { setDockApi } from './dock-api-ref';
import { focusTerminalPanel } from '@/panels/Terminal/terminal-focus-registry';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { stripTerminalPanelsFromLayout } from './strip-terminal-layout';
import { makeJsonSafe } from '../../../electron/shared/make-json-safe';
import { useDockReconciler } from './DockReconciler';
import { useDockLocaleSync } from './useDockLocaleSync';
import { wrapPanelClose, cancelPendingPanelClose } from './wrap-panel-close';
import { handleTerminalPanelRemoved } from './DockReconciler';
import { SharedTab } from '@/shell/motion/SharedTab';
import { useClosingStore } from '@/stores/closing.store';
import { useEditorStore } from '@/stores/editor.store';
import { debounce } from '@/lib/debounce';
import { flushExplorerPersistence } from '@/lib/persist/explorer-persist';
import { flushPendingAutoSave } from '@/panels/Editor/autosave-flush-registry';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { t as translate } from '@/i18n';
import '@/styles/dockview.css';

// 外提到 module 顶层常量:DockviewReact 的 components/tabComponents 引用稳定
// 才能避免 dockview 内部 effect 误判 props 变化。每次 render 新建对象会
// 触发 dockview 重订阅 createComponent。同 panelComponents 对照(useMemo)。
const tabComponents = { default: SharedTab };

interface FlushBridge {
  readonly layout?: {
    readonly onFlushRequest?: (
      cb: (payload?: { windowId: number }) => Promise<void>,
    ) => () => void;
    readonly sendFlushAck?: (windowId: number) => void;
  };
  readonly system?: {
    readonly windowId?: number;
  };
}

function getFlushBridge(): FlushBridge | undefined {
  return (window as Window & { electron?: FlushBridge }).electron;
}

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

/** 把 coApp.panels 注册的 PanelSpec 桥接成 Dockview 的 components map.
 *  每个 panel 自动包 PanelMount(进出场动画). */
function usePanelComponents(): Record<string, React.FC<IDockviewPanelProps>> {
  const snapshot = useRegistry(coApp.panels);
  return useMemo(() => {
    const map: Record<string, React.FC<IDockviewPanelProps>> = {};
    for (const spec of snapshot) {
      const type = spec.type;
      // race(R59,R55-R58 同族):wrapper 只捕获 type,渲染时从 **live** coApp.panels.get(type) 取
      // 当前 factory,而非闭包捕获快照里的 spec.factory。panel type 被插件 disable/reload
      // unregister 后、到 useRegistry 快照重渲前,dockview 仍会渲染本 component → 闭包捕获旧
      // factory 会实例化已移除插件代码(访问已释放资源)。live 查找:已移除则渲染空(panel 内容空,
      // 由 reconciler/关闭流程移除该 panel)。
      map[type] = (p) => {
        const live = coApp.panels.get(type);
        return (
          <PanelMount panelId={p.api.id}>
            {live ? (live.factory(p) as React.ReactNode) : null}
          </PanelMount>
        );
      };
    }
    return map;
  }, [snapshot]);
}

function DockReconcilerMount({ api }: { api: DockviewApi }): null {
  useDockReconciler(api);
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
const cleanLayoutApis = new WeakSet<DockviewApi>();
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
  if (cleanLayoutApis.has(api)) return;
  try {
    // 写盘前剥离终端 panel(彻底修复:持久化 layout 不再携带终端的 sessionId/cwd 等陈旧/敏感
    // 数据;读端 sanitize 仍是兜底防线,处理历史 explorer.json 与竞态)。仅含终端(无非终端
    // panel)→ strip 返 null,此时回落原始快照,由读端再行剥离为默认。
    const raw = api.toJSON();
    const cleaned = (stripTerminalPanelsFromLayout(raw) ?? raw) as unknown;
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
      cleanLayoutApis.add(api);
      return;
    }

    const r = await coApi.layout.write(payload);
    if (!r.ok) {
      console.warn(`${warnPrefix} failed`, r.code, r.message);
      if (notifyOnFail) notifyLayoutSaveFailedRateLimited();
      return;
    }
    lastSuccessfulLayoutPayload = serializedPayload;
    cleanLayoutApis.add(api);
  } catch (err) {
    console.warn(`${warnPrefix} rejected`, err);
    if (notifyOnFail) notifyLayoutSaveFailedRateLimited();
    else throw err; // 保留 flush 路径抛出语义(调用方自有 try/catch)
  }
}

export function DockShell({ onLayoutReady }: { onLayoutReady?: () => void }) {
  const apiRef = useRef<DockviewApi | null>(null);
  // race(R22):保存 onReady 里注册的 dockview onDid* disposables + debounce 持久化函数,在
  // DockShell 卸载 / onReady 重入(HMR/StrictMode/dockview 重建)时统一 dispose + cancel。
  // 否则旧 listener 与旧 debounce(闭包持旧 event.api)仍会触发,对已卸载组件 setEmpty、重复
  // handleTerminalPanelRemoved,或用旧 api.toJSON() 迟到写回 layout 覆盖新实例布局。
  const dockDisposablesRef = useRef<
    Array<{ dispose: () => void } | undefined>
  >([]);
  const layoutPersistRef = useRef<{ cancel: () => void } | null>(null);
  const disposeDockListeners = useCallback(() => {
    for (const d of dockDisposablesRef.current) {
      if (typeof d?.dispose !== 'function') continue;
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
  const [dockApi, setReconcilerApi] = useState<DockviewApi | null>(null);
  // apiReady 是 state(不是 ref):驱动下面 editor 自动激活 useEffect 的依赖,
  // 修复"hydrate 在 onReady 之前完成 → activeTabId 变化触发 effect 时
  // apiRef.current 仍 null → 错过添加 panel"的时序竞态。
  const [apiReady, setApiReady] = useState(false);
  const [empty, setEmpty] = useState(false);
  const panelComponents = usePanelComponents();

  const onReady = useCallback(
    async (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setReconcilerApi(event.api);
      setApiReady(true);
      setDockApi(event.api); // 暴露给 IconSidebar 等 Dockview 之外的组件
      // a11y(A131,A130 同族):layout.read() reject 此前会中断整个 onReady(连默认布局都不应用)。
      // try/catch 兜底;read 失败(reject/!ok)或 fromJSON 失败 → notify.error(用户/SR 知布局被
      // 重置而非静默);首次无持久布局(ok+null data)不算失败,默认布局静默应用。
      let persisted: unknown = null;
      let restoreFailed = false;
      try {
        const readResult = await coApi.layout.read();
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
      if (persisted && typeof persisted === 'object') {
        // sanitize 会剥离终端 panel(既有契约,非失败)并修补 grid 树。返回 null = 无可恢复的
        // 非终端布局(或畸形/超限)→ 静默走默认布局,不算失败、不报错。只有真正的 fromJSON 抛错
        // (布局结构损坏)才置 restoreFailed → 弹 toast。
        const sanitized = sanitizePersistedDockLayout(persisted);
        if (sanitized) {
          try {
            event.api.fromJSON(sanitized);
            restored = true;
          } catch (err) {
            restoreFailed = true;
            console.warn('[dock] fromJSON 失败,落回默认布局', err);
          }
        }
      }
      if (!restored) applyDefaultLayout(event.api);
      if (restoreFailed) {
        notify.error(translate('errors.dock.layout_restore_failed'));
      }

      // Explorer 已迁出 Dockview → 固定左 sidebar(VSCode 风)。
      // 旧 layout.json 可能仍含 'explorer' panel(已无对应 component),清理掉。
      const orphanExplorer = event.api.getPanel('explorer');
      if (orphanExplorer) {
        try {
          orphanExplorer.api.close();
        } catch {
          /* ignore */
        }
      }

      setEmpty(event.api.totalPanels === 0);
      onLayoutReady?.();

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
        event.api.onDidLayoutChange(() => {
          cleanLayoutApis.delete(event.api);
          persist();
          setEmpty(event.api.totalPanels === 0);
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
            removeSession: (sid) => coApi.terminal.remove(sid).then(() => undefined),
          });
        }),
        // 拦截所有 panel 的 api.close,统一走"标记 closing → 220ms 延迟 → 真 close"。
        // 包括 group 整体关闭、第三方调用方等间接路径,只要走 api.close 都能拿到动画。
        event.api.onDidAddPanel(wrapPanelClose),
        // topic-22: exit-maximize 后把 focus 拉回 xterm。
        // setActive() 不会触发 onDidActiveChange(panel 在 exit 前已是 active),
        // 所以必须显式调 focusTerminalPanel。用 event.group.activePanel
        // (codex red-team v1 P1-3) 不重读全局 activePanel,避免 exit 期间被改写。
        event.api.onDidMaximizedGroupChange((evt) => {
          if (evt.isMaximized) return;
          const panel = evt.group.activePanel;
          if (!panel) return;
          if (panel.view.contentComponent !== TERMINAL_PANEL_TYPE) return;
          focusTerminalPanel(panel.id);
        }),
      );
      event.api.panels.forEach(wrapPanelClose);
    },
    [onLayoutReady, disposeDockListeners],
  );

  const restore = useCallback(() => {
    if (apiRef.current) applyDefaultLayout(apiRef.current);
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
    const bridge = getFlushBridge();
    const off = bridge?.layout?.onFlushRequest?.(async (payload) => {
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
      const latest = getFlushBridge();
      latest?.layout?.sendFlushAck?.(
        payload?.windowId ?? latest.system?.windowId ?? 0,
      );
    });
    return () => {
      off?.();
    };
  }, [apiReady]);

  // Editor 自动激活:Explorer 单击文件 / hydrate 恢复 session → editor.store
  // activeTabId 变 → 自动 setActive 'editor' panel(VSCode 行为)。
  // 若 panel 不存在(用户拖关了 / 启动时 layout 没含),自动 addPanel 加回。
  //
  // deps 必含 apiReady:让 onReady 完成晚于 activeTabId hydrate 的场景也能补建。
  // deps 必含 editorFocusPulse:同 id 重新点击(activeTabId 不变)也要触发,
  // 否则用户切到 terminal 后再点资源管理器同一文档,terminal 不会让位。见 #22。
  const editorActiveTabId = useEditorStore((s) => s.activeTabId);
  const editorFocusPulse = useEditorStore((s) => s.editorFocusPulse);
  useEffect(() => {
    if (!editorActiveTabId) return;
    if (!apiReady) return;
    const api = apiRef.current;
    if (!api) return;
    let editorPanel = api.getPanel('editor');
    if (!editorPanel) {
      editorPanel = api.addPanel({
        id: 'editor',
        component: 'editor',
        title: 'Editor',
        params: { titleKey: 'panels.editor.title' },
      });
    } else {
      // panel 仍存在但可能正处于关闭 EXIT 动画窗口内(用户刚关 editor 面板随即
      // 又点开文件)。撤销它排定中的真 close + 清 closing 标记,否则刚激活的
      // 面板会在 EXIT_DURATION_MS 后随排定的 close 一起消失(刚打开的文件没了)。
      cancelPendingPanelClose('editor');
    }
    editorPanel.api.setActive();
  }, [editorActiveTabId, editorFocusPulse, apiReady]);

  return (
    <div className="relative h-full w-full">
      {dockApi && <DockReconcilerMount api={dockApi} />}
      <DockviewReact
        components={panelComponents}
        tabComponents={tabComponents}
        defaultTabComponent={SharedTab}
        rightHeaderActionsComponent={HeaderActions}
        onReady={onReady}
        className="dockview-theme-abyss h-full w-full"
      />
      {empty && <EmptyState onRestore={restore} />}
    </div>
  );
}
