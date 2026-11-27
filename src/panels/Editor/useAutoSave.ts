// M-Editor Step E2:useAutoSave 薄壳 hook。
// 监听全局 activeTab 内容变化,enabled=true 时按 delayMs 防抖触发 saveFile;delayMs = null(onFocusChange / onWindowChange)
// 时不计时,在编辑器失焦 / 窗口失焦时保存。
//
// enabled / delayMs / saveOn 由 EditorPanel 按活动 tab 的生效模式决定(auto-save-config.resolveAutoSave:files.autoSave +
// Markdown 语言级覆盖;当初 ADR-015 只给 Markdown 自动保存,默认行为保持)。BDD: src/__tests__/files-auto-save/

import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { groupActiveTabIdOf, groupTabsOf, useEditorStore } from '@/stores/editor.store';
import { makeAutoSaveScheduler, type AutoSaveScheduler } from './auto-save';
import { findEditorFileTabById } from './editor-tab-lookup';
import {
  trackInFlightAutoSave,
} from './autosave-flush-registry';
import { claimAutoSave, releaseAutoSave, setAutoSaveFailed } from './autosave-failures';
import { isAutoSaveHeld, useAutoSaveHeld } from './autosave-hold';
import { flushEditorWriteBacks } from './editor-writeback-registry';
import {
  DEFAULT_AUTO_SAVE_SETTINGS,
  resolveAutoSave,
  savesOnWindowBlur,
  type AutoSaveSettings,
  type ResolvedAutoSave,
} from './auto-save-config';
import { observeOrphanedAutoSave } from './autosave-orphan-notice';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';
import { saveFailureNotifyKey, saveFailureReason } from '@/notifications/notify-open-failed';
import { failureOf } from '@/lib/failure-of';
import { basenameForChrome } from '@/lib/path-label';
import { EDITOR_DISK_CHANGED, type SaveFileOptions } from './editor-file-actions';
import { saveHotkeyLabel } from './editor-commands';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

export interface UseAutoSaveOptions {
  /** 活动 tab 是否自动保存(生效模式 ≠ off 且未暂停)。 */
  enabled: boolean;
  /** 防抖毫秒(files.autoSaveDelay / Markdown 的 autoSave.delayMs);null = 不计时,等失焦 / 切走 / 关窗时保存。 */
  delayMs: number | null;
  /** 只看该编辑器组的活动 tab(编辑器组面板各自一个;缺省 = 活动组的活动 tab)。 */
  groupId?: string;
  /**
   * delayMs = null 时活动 tab 的保存时机:focusChange = 焦点移出 rootRef(编辑器组面板)、切到同组别的 tab、窗口失焦
   *(VSCode onFocusChange);windowChange = 只在窗口失焦时(VSCode onWindowChange)。
   */
  saveOn?: 'focusChange' | 'windowChange' | null;
  /** 暂停(关闭脏 tab 的确认框开着等):窗口失焦也不保存本组任何 tab。 */
  paused?: boolean;
  /** 自动保存设置:窗口失焦时据此挑出组内该保存的后台脏 tab。缺省 = 默认设置。 */
  settings?: AutoSaveSettings;
  /** 编辑器组面板根元素(判断焦点是否移出)。 */
  rootRef?: RefObject<HTMLElement | null>;
  /** 编辑器组面板所在窗口(popout 搬移后变化;缺省 = 不监听窗口失焦)。 */
  hostWindow?: Window | null;
}

/**
 * 自动保存失败提示(带文件名;写保护 / 磁盘冲突附保存键出路)。与 ⌘S 的保存失败提示同一个 key:同一文件只留最新一条。
 * 去重(ok→失败跃迁才提示)由调用方负责。
 */
function notifyAutoSaveFailed(tabId: string, err: unknown): void {
  const { code, message } = failureOf(err);
  // 带文件名(同显式保存失败「保存失败 <name>:<原因>」):后台失败时用户需知道是哪个文件。
  const filePath = findEditorFileTabById(useEditorStore.getState().tabs, tabId)?.filePath ?? tabId;
  // 磁盘冲突的说明里写着保存键:填当前生效绑定(改绑后跟随)。
  const reason = saveFailureReason(
    { code, message },
    code === EDITOR_DISK_CHANGED ? { hotkey: saveHotkeyLabel() } : undefined,
  );
  notify.warn(
    t('common.label_detail', {
      label: `${t('editor.autosave_failed')} ${basenameForChrome(filePath)}`,
      // 写保护:自动保存不替用户去写保护,出路是按保存键走覆盖确认框(同磁盘冲突提示的写法)。
      detail:
        code === ERROR_CODES.FS_READONLY
          ? t('editor.autosave_readonly_detail', { reason, hotkey: saveHotkeyLabel() })
          : reason,
    }),
    { mirror: false, replaceKey: saveFailureNotifyKey(filePath) },
  );
}

// 窗口失焦批量保存的后台 tab 最近一次失败(按 tab id;成功即清除):连续失败只提示一次,同 scheduler 的 ok→失败去重。
const backgroundFailed = new Set<string>();

/**
 * 保存组内(除活动 tab,它走自己的 scheduler)生效模式满足 eligible 的脏 tab(VSCode saveAllDirtyAutoSaveables):窗口失焦 =
 * onFocusChange / onWindowChange 的;打开自动保存 = 生效模式不是 off 的。无标题(生效模式 off)/ 已删除 / 删除确认中的跳过。
 */
function saveBackgroundTabs(
  saveTab: (tabId: string, opts?: SaveFileOptions) => Promise<unknown>,
  groupId: string | undefined,
  activeId: string | null,
  settings: AutoSaveSettings,
  eligible: (r: ResolvedAutoSave) => boolean,
): void {
  const s = useEditorStore.getState();
  const tabs = groupId === undefined ? s.tabs : groupTabsOf(s, groupId);
  const targets = tabs.filter(
    (tab) =>
      tab.id !== activeId &&
      tab.dirty &&
      !tab.orphaned &&
      !isAutoSaveHeld(tab.filePath) &&
      eligible(resolveAutoSave(tab.filePath, settings)),
  );
  for (const tab of targets) {
    void saveTab(tab.id, { recreateMissing: false }).then(
      (r) => {
        const failure = (r as { ok?: unknown; code?: unknown } | null | undefined)?.ok === false ? r : null;
        // 已删除(读盘不存在 → saveFile 就地标记 orphaned):tab 显示「已删除」,不算自动保存失败(同 scheduler 路径)
        if (failure === null || (failure as { code?: unknown }).code === ERROR_CODES.FS_NOT_FOUND) {
          backgroundFailed.delete(tab.id);
          return;
        }
        if (backgroundFailed.has(tab.id)) return;
        backgroundFailed.add(tab.id);
        notifyAutoSaveFailed(tab.id, failure);
      },
      (err: unknown) => {
        console.warn('[auto-save] failed:', err);
        if (backgroundFailed.has(tab.id)) return;
        backgroundFailed.add(tab.id);
        notifyAutoSaveFailed(tab.id, err);
      },
    );
  }
}

export function useAutoSave(
  saveTab: (tabId: string, opts?: SaveFileOptions) => Promise<unknown>,
  opts: UseAutoSaveOptions,
): void {
  const { delayMs, groupId, rootRef, hostWindow } = opts;
  const saveOn = opts.saveOn ?? null;
  const paused = opts.paused === true;
  const settings = opts.settings ?? DEFAULT_AUTO_SAVE_SETTINGS;
  // 只订阅活跃 tab 的调度相关字段(打磨 R47):id/filePath/dirty/content 变化才重排
  // schedule。用 useShallow 返回扁平 primitive 对象,逐字段 Object.is 比较 ——
  // markSaved 推进 originalContent、reloadFromDisk 改 reloadEpoch 等不在此集合的字段
  // 变化不再触发 hook 重渲/effect 重跑。content 只作 string ref(不用 JSON 签名,
  // 避免序列化大文档正文)。
  const active = useEditorStore(
    useShallow((s) => {
      const found = findEditorFileTabById(
        s.tabs,
        groupId === undefined ? s.activeTabId : groupActiveTabIdOf(s, groupId),
      );
      return {
        id: found?.id ?? null,
        filePath: found?.filePath ?? null,
        dirty: found?.dirty ?? false,
        orphaned: found?.orphaned ?? false,
        content: found?.content,
      };
    }),
  );
  const tabId = active.id;
  // Explorer 删除确认 / 移到废纸篓在途期间暂停该文件的自动保存(见 autosave-hold.ts),同 !enabled。
  const held = useAutoSaveHeld(active.filePath);
  const enabled = opts.enabled && !held;
  // 关窗 / 切 tab flush 用:schedule effect 最近一次看到的内容与 enabled(都属于该 effect 当时的 tab)。
  // 关窗握手先同步回写编辑器里尚未上抛的输入(editor-writeback-registry)再 flush,中间没有 React 重渲;
  // 切 tab 时编辑器卸载回写(被删子树的 passive destroy)也先于本 hook 的 cleanup —— 两种情况下 schedule
  // effect 都来不及排队,原本干净的 tab 的这段内容不在 scheduler 里。flush 前发现 store 内容 ≠ effect
  // 看过的 → 先补排队。enabled 取 effect 看过的值而非本次渲染的:切 tab 的 cleanup 运行时渲染已属于新 tab。
  const seenContentRef = useRef<string | undefined>(undefined);
  const seenEnabledRef = useRef(false);
  // 同上:effect 看过的保存时机(切走时按旧 tab 的模式决定是否 flush —— onWindowChange 切 tab 不保存)。
  const seenSaveOnRef = useRef<'focusChange' | 'windowChange' | null>(null);

  // 每个 tab 一个 scheduler(身份含 tabId)。保存绑定到调度时捕获的 tabId,
  // 而非"当前 active tab" —— 切走后 active 已变,绑定 active 会保存错的 tab。
  const scheduler = useMemo(() => {
    if (tabId === null) return null;
    const created: AutoSaveScheduler = makeAutoSaveScheduler(
      // 记录本 scheduler 最近一次 autosave 是否失败(resolve {ok:false} 或 reject),关窗计数据此不再豁免
      // 失败态的活动 tab(见 autosave-failures.ts)。按 scheduler 实例记录:换实例后旧实例的迟到结果被丢弃。
      () => {
        // 执行时读 store:排队后 tab 已被显式保存(Cmd+S / 关窗「保存」)而不再脏 → 无需再读盘比较 + 原子写,
        // 也不会因其间的外部修改对干净 tab 误报「自动保存失败」。覆盖计时器到点、切 tab flush、关窗 flush 三条路径。
        // tab 已关闭(找不到,典型:防抖窗口内确认「放弃修改」后切走 flush)→ 没有可保存的内容,
        // 不是保存失败,不交给 saveTab(否则 TAB_NOT_FOUND 误报「自动保存失败」)。
        const tab = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
        if (!tab || !tab.dirty) {
          setAutoSaveFailed(created, false);
          return Promise.resolve({ ok: true });
        }
        // 文件已删除(orphaned):不自动写回(VSCode 同款,只有手动保存重建);仍脏未落盘 → 关窗计数不豁免。
        if (tab.orphaned) {
          setAutoSaveFailed(created, true);
          return Promise.resolve({ ok: true });
        }
        // 不重建已删除的文件:外部删除后 orphaned 还在确认途中(防抖 + stat + 延迟复查)时自动保存可能先到点,
        // 读盘不存在 → saveFile 不写回并就地标记 orphaned。与上面 orphaned 分支同口径:未落盘(关窗计数不豁免),
        // 不弹「自动保存失败」(tab 已显示「已删除」)。
        return saveTab(tabId, { recreateMissing: false }).then(
          (r) => {
            const failed = (r as { ok?: unknown } | null | undefined)?.ok === false;
            setAutoSaveFailed(created, failed);
            if (failed && (r as { code?: unknown }).code === ERROR_CODES.FS_NOT_FOUND) return { ok: true };
            return r;
          },
          (err: unknown) => {
            setAutoSaveFailed(created, true);
            throw err;
          },
        );
      },
      delayMs,
      // 自动保存失败时弹一次 warn toast(去重在 scheduler 内,连续失败不刷屏)。
      // 数据不丢(dirty 保持),仅补反馈 —— 否则后台静默失败用户无从知晓为何脏点不消。
      // scheduler 已 console.warn,故 mirror:false 防双写。见第二十一轮 P1-AZ。
      // 打磨 P2-BK:err 可能是 resolve 的 {ok:false,code,message} 失败结果 → 与 Cmd+S 失败
      // 同走 saveFailureReason(按 code 本地化,未收录回退原 message)。
      (err) => notifyAutoSaveFailed(tabId, err),
    );
    return created;
  }, [saveTab, tabId, delayMs]);

  // 内容/脏态变化 → 防抖排队。注意:这里**不**在 cleanup 取消,否则每次按键
  // (activeTab 变)都会取消再排队,且切 tab 会丢掉 pending。切走该 tab 的落盘交给
  // 下面按 scheduler 身份(=tabId)触发的 flush effect。
  useEffect(() => {
    seenContentRef.current = active.content;
    seenEnabledRef.current = enabled;
    seenSaveOnRef.current = saveOn;
    if (!scheduler) return;
    // 运行中关掉 autosave 设置 → 取消已排队的保存(禁用应阻止已排队写入)。
    // 这是针对当前 tab 的 scheduler;切 tab 的落盘仍由 flush effect 处理。
    // 文件已删除(orphaned)同禁用:取消已排队的保存,删除后不被自动写回。
    if (!enabled || active.orphaned) {
      scheduler.cancel();
      // 暂停 / 禁用期间没有 pending,关窗 flush 不会落盘 → 关窗脏文件计数不得豁免本 tab
      // (典型:关闭脏 .md 的「放弃修改?」确认框开着时暂停 autosave)。恢复后 schedule 即清除。
      setAutoSaveFailed(scheduler, true);
      return;
    }
    if (!active.filePath) return;
    // 已不脏(Cmd+S 保存成功 / 撤销回原样)→ 取消防抖窗口里已排的保存,到点不再空写一遍。
    if (!active.dirty) {
      scheduler.cancel();
      return;
    }
    scheduler.schedule();
    // 有 pending:关窗 flush 会落盘,清除失败态(失败后继续编辑 / 显式保存后再编辑)。
    setAutoSaveFailed(scheduler, false);
  }, [enabled, active, scheduler, saveOn]);

  // 文件已删除(orphaned)且有未保存修改:自动保存不会写回 → 提示一次(不刷屏,见 autosave-orphan-notice.ts),
  // 否则继续输入时磁盘静默不更新。只看自动保存设置本身(opts.enabled),不受删除确认期间的暂停(held)影响。
  const autoSaveOn = opts.enabled;
  const { orphaned: activeOrphaned, dirty: activeDirty, filePath: activeFilePath } = active;
  useEffect(() => {
    if (tabId === null || !autoSaveOn) return;
    observeOrphanedAutoSave(tabId, activeOrphaned, activeDirty, () => {
      notify.warn(
        t('editor.autosave_paused_deleted', {
          name: basenameForChrome(activeFilePath ?? tabId),
          hotkey: saveHotkeyLabel(),
        }),
      );
    });
  }, [tabId, autoSaveOn, activeOrphaned, activeDirty, activeFilePath]);

  // 切走该 tab(scheduler 身份随 tabId 变)或组件卸载 → flush pending,
  // 把还卡在防抖窗口里的编辑落盘,避免连续输入后立即切 tab 丢失整段内容。
  // 同时以 claimAutoSave 登记为活动持有者(带 flush 句柄),供关窗/退出的 flush 握手
  // (DockShell onFlushRequest)在 ack 前同步落盘 pending autosave(P1-AE)。
  useEffect(() => {
    if (!scheduler || tabId === null) return;
    const scheduleUnseenWriteBack = (): void => scheduleUnseen(scheduler, tabId, seenEnabledRef, seenContentRef);
    // 本 scheduler 成为活动 tab 的 autosave 持有者(关窗计数据此豁免其脏 .md、关窗 flush 握手调它的落盘句柄,
    // 见 autosave-failures.ts)。
    claimAutoSave(tabId, scheduler, () => {
      scheduleUnseenWriteBack();
      return scheduler.flush();
    });
    // claim 重置失败态;本 tab 当前 autosave 暂停 / 禁用(schedule effect 已先于 claim 运行、其标记被丢弃)→ 补标。
    if (!seenEnabledRef.current) setAutoSaveFailed(scheduler, true);
    return () => {
      releaseAutoSave(scheduler);
      // onWindowChange:切 tab 不保存(VSCode 只在窗口失焦时保存),被切走的脏 tab 由窗口失焦的批量保存落盘。
      if (seenSaveOnRef.current === 'windowChange') {
        scheduler.cancel();
        return;
      }
      // 切走该 tab:fire-and-forget 触发落盘,但登记进在途集合 —— 紧接着关窗时
      // flush 握手会 await 它,否则旧 tab 这次写盘 IPC 仍在飞就被退出截断(P1-AE 的
      // 兄弟缺口,复审 F2)。编辑器卸载回写先于此 cleanup 把旧 tab 写脏 → 先补排队再 flush。
      scheduleUnseenWriteBack();
      trackInFlightAutoSave(scheduler.flush());
    };
  }, [scheduler, tabId]);

  // 立即保存活动 tab 的待保存改动(失焦 / 打开自动保存触发):先同步回写编辑视图尚未上抛的输入(Milkdown 上抛有 200ms 起的防抖),
  // 回写产生的编辑补排队后 flush。失焦只对 onFocusChange / onWindowChange(saveOn ≠ null)由调用处判断。
  const flushActiveRef = useRef<(() => void) | null>(null);
  flushActiveRef.current =
    scheduler && tabId !== null && enabled
      ? () => {
          flushEditorWriteBacks([tabId]);
          scheduleUnseen(scheduler, tabId, seenEnabledRef, seenContentRef);
          trackInFlightAutoSave(scheduler.flush());
        }
      : null;

  // onFocusChange:焦点移出编辑器组面板(到终端 / 资源管理器 / 别的组 / 命令面板,或窗口失焦时 relatedTarget 为空)→ 保存。
  // 面板内移动(编辑区 ↔ tab 行 / 查找框)不算失焦。监听挂在面板根元素上,popout 搬移 DOM 后仍有效。
  useEffect(() => {
    const root = rootRef?.current;
    if (!root || saveOn !== 'focusChange') return;
    const onFocusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget;
      if (next instanceof Node && root.contains(next)) return;
      flushActiveRef.current?.();
    };
    root.addEventListener('focusout', onFocusOut);
    return () => root.removeEventListener('focusout', onFocusOut);
  }, [rootRef, saveOn]);

  // 窗口失焦(onFocusChange / onWindowChange 都保存,VSCode WINDOW_CHANGE):活动 tab 经 scheduler flush,组内其余符合条件的
  // 脏 tab 直接保存。按编辑器所在窗口判断(popout 子窗里的编辑器看子窗)。
  const blurStateRef = useRef({ saveTab, groupId, tabId, settings, paused, saveOn });
  blurStateRef.current = { saveTab, groupId, tabId, settings, paused, saveOn };
  const watchWindow = hostWindow ?? null;
  useEffect(() => {
    if (!watchWindow) return;
    const onBlur = (): void => {
      const st = blurStateRef.current;
      if (st.paused) return;
      if (st.saveOn !== null) flushActiveRef.current?.();
      saveBackgroundTabs(st.saveTab, st.groupId, st.tabId, st.settings, savesOnWindowBlur);
    };
    watchWindow.addEventListener('blur', onBlur);
    return () => watchWindow.removeEventListener('blur', onBlur);
  }, [watchWindow]);

  // 打开自动保存(VSCode editorAutoSave.onDidChangeAutoSaveConfiguration):自动保存设置变化后 files.autoSave 不是 off → 立即保存本组
  // 全部符合条件的脏 tab(活动 tab 经 scheduler flush;此 effect 在 schedule effect 之后,新模式下的排队已就绪),不等延迟 / 失焦。
  // 挂载不算变化;设置跨窗同步,各窗口的编辑器组各自保存自己的 tab。暂停期间(关闭确认框开着)不保存。
  const seenSettingsRef = useRef(settings);
  useEffect(() => {
    const prev = seenSettingsRef.current;
    seenSettingsRef.current = settings;
    if (sameAutoSaveSettings(prev, settings) || settings.mode === 'off') return;
    const st = blurStateRef.current;
    if (st.paused) return;
    flushActiveRef.current?.();
    saveBackgroundTabs(st.saveTab, st.groupId, st.tabId, st.settings, (r) => r.mode !== 'off');
  }, [settings]);
}

function sameAutoSaveSettings(a: AutoSaveSettings, b: AutoSaveSettings): boolean {
  return a.mode === b.mode && a.delayMs === b.delayMs && a.markdown === b.markdown && a.markdownDelayMs === b.markdownDelayMs;
}

/** 同步回写产生、schedule effect 尚未看到的编辑 → 先补排队(flush 时已不脏仍由 save 闭包跳过写盘)。 */
function scheduleUnseen(
  scheduler: AutoSaveScheduler,
  tabId: string,
  seenEnabledRef: { readonly current: boolean },
  seenContentRef: { readonly current: string | undefined },
): void {
  const tab = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
  if (seenEnabledRef.current && tab?.filePath && tab.dirty && tab.content !== seenContentRef.current) {
    scheduler.schedule();
  }
}

/**
 * filePath 是否自动保存(生效模式 ≠ off,见 auto-save-config.resolveAutoSave)。缺省设置 = 默认:.md / .markdown 自动保存,
 * 其它显式保存;无标题文件从不自动保存。
 */
export function isAutoSaveEnabled(
  filePath: string | null,
  settings: AutoSaveSettings = DEFAULT_AUTO_SAVE_SETTINGS,
): boolean {
  return resolveAutoSave(filePath, settings).mode !== 'off';
}
