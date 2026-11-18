// M-Editor Step E2:useAutoSave 薄壳 hook。
// 监听全局 activeTab 内容变化,enabled=true 时按 delayMs 防抖触发 saveFile。
//
// 决策(ADR-015):Markdown 自动保存,代码必须显式 Cmd+S。
// enabled 由 EditorPanel 根据当前 tab 文件类型决定(.md/.markdown → true)。

import { useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '@/stores/editor.store';
import { makeAutoSaveScheduler, type AutoSaveScheduler } from './auto-save';
import { isMarkdownPath } from './editor-path-utils';
import { findEditorFileTabById } from './editor-tab-lookup';
import {
  registerAutoSaveFlush,
  trackInFlightAutoSave,
} from './autosave-flush-registry';
import { claimAutoSave, releaseAutoSave, setAutoSaveFailed } from './autosave-failures';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { errorCodeOf } from '../../../electron/shared/error-message';

const DEFAULT_DELAY_MS = 2000;

export interface UseAutoSaveOptions {
  enabled: boolean;
  /** 默认 2000ms(决策 #3). */
  delayMs?: number;
}

export function useAutoSave(
  saveTab: (tabId: string) => Promise<unknown>,
  opts: UseAutoSaveOptions,
): void {
  const { enabled, delayMs = DEFAULT_DELAY_MS } = opts;
  // 只订阅活跃 tab 的调度相关字段(打磨 R47):id/filePath/dirty/content 变化才重排
  // schedule。用 useShallow 返回扁平 primitive 对象,逐字段 Object.is 比较 ——
  // markSaved 推进 originalContent、reloadFromDisk 改 reloadEpoch 等不在此集合的字段
  // 变化不再触发 hook 重渲/effect 重跑。content 只作 string ref(不用 JSON 签名,
  // 避免序列化大文档正文)。
  const active = useEditorStore(
    useShallow((s) => {
      const found =
        s.activeTabId === null ? null : findEditorFileTabById(s.tabs, s.activeTabId);
      return {
        id: found?.id ?? null,
        filePath: found?.filePath ?? null,
        dirty: found?.dirty ?? false,
        content: found?.content,
      };
    }),
  );
  const tabId = active.id;
  // 关窗 / 切 tab flush 用:schedule effect 最近一次看到的内容与 enabled(都属于该 effect 当时的 tab)。
  // 关窗握手先同步回写编辑器里尚未上抛的输入(editor-writeback-registry)再 flush,中间没有 React 重渲;
  // 切 tab 时编辑器卸载回写(被删子树的 passive destroy)也先于本 hook 的 cleanup —— 两种情况下 schedule
  // effect 都来不及排队,原本干净的 tab 的这段内容不在 scheduler 里。flush 前发现 store 内容 ≠ effect
  // 看过的 → 先补排队。enabled 取 effect 看过的值而非本次渲染的:切 tab 的 cleanup 运行时渲染已属于新 tab。
  const seenContentRef = useRef<string | undefined>(undefined);
  const seenEnabledRef = useRef(false);

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
        return saveTab(tabId).then(
          (r) => {
            setAutoSaveFailed(created, (r as { ok?: unknown } | null | undefined)?.ok === false);
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
      // 同走 localizeErrorByCode(按 code 本地化,未收录回退原 message)。
      (err) => {
        const message = (err as { message?: unknown } | null | undefined)?.message;
        notify.warn(
          `${t('editor.autosave_failed')}: ${localizeErrorByCode(
            errorCodeOf(err),
            typeof message === 'string' ? message : String(err),
          )}`,
          { mirror: false },
        );
      },
    );
    return created;
  }, [saveTab, tabId, delayMs]);

  // 内容/脏态变化 → 防抖排队。注意:这里**不**在 cleanup 取消,否则每次按键
  // (activeTab 变)都会取消再排队,且切 tab 会丢掉 pending。切走该 tab 的落盘交给
  // 下面按 scheduler 身份(=tabId)触发的 flush effect。
  useEffect(() => {
    seenContentRef.current = active.content;
    seenEnabledRef.current = enabled;
    if (!scheduler) return;
    // 运行中关掉 autosave 设置 → 取消已排队的保存(禁用应阻止已排队写入)。
    // 这是针对当前 tab 的 scheduler;切 tab 的落盘仍由 flush effect 处理。
    if (!enabled) {
      scheduler.cancel();
      // 暂停 / 禁用期间没有 pending,关窗 flush 不会落盘 → 关窗脏文件计数不得豁免本 tab
      // (典型:关闭脏 .md 的「放弃修改?」确认框开着时暂停 autosave)。恢复后 schedule 即清除。
      setAutoSaveFailed(scheduler, true);
      return;
    }
    if (active.id === null || !active.filePath) return;
    // 已不脏(Cmd+S 保存成功 / 撤销回原样)→ 取消防抖窗口里已排的保存,到点不再空写一遍。
    if (!active.dirty) {
      scheduler.cancel();
      return;
    }
    scheduler.schedule();
    // 有 pending:关窗 flush 会落盘,清除失败态(失败后继续编辑 / 显式保存后再编辑)。
    setAutoSaveFailed(scheduler, false);
  }, [enabled, active, scheduler]);

  // 切走该 tab(scheduler 身份随 tabId 变)或组件卸载 → flush pending,
  // 把还卡在防抖窗口里的编辑落盘,避免连续输入后立即切 tab 丢失整段内容。
  // 同时把当前 scheduler 的 flush 句柄注册进 registry,供关窗/退出的 flush 握手
  // (DockShell onFlushRequest)在 ack 前同步落盘 pending autosave(P1-AE)。
  useEffect(() => {
    if (!scheduler || tabId === null) {
      registerAutoSaveFlush(null);
      return;
    }
    // 同步回写产生、schedule effect 尚未看到的编辑 → 先补排队(flush 时已不脏仍由 save 闭包跳过写盘)。
    const scheduleUnseenWriteBack = (): void => {
      const tab = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
      if (
        seenEnabledRef.current &&
        tab?.filePath &&
        tab.dirty &&
        tab.content !== seenContentRef.current
      ) {
        scheduler.schedule();
      }
    };
    registerAutoSaveFlush(() => {
      scheduleUnseenWriteBack();
      return scheduler.flush();
    });
    // 本 scheduler 成为活动 tab 的 autosave 持有者(关窗计数据此豁免其脏 .md,见 autosave-failures.ts)。
    claimAutoSave(tabId, scheduler);
    // claim 重置失败态;本 tab 当前 autosave 暂停 / 禁用(schedule effect 已先于 claim 运行、其标记被丢弃)→ 补标。
    if (!seenEnabledRef.current) setAutoSaveFailed(scheduler, true);
    return () => {
      registerAutoSaveFlush(null);
      releaseAutoSave(scheduler);
      // 切走该 tab:fire-and-forget 触发落盘,但登记进在途集合 —— 紧接着关窗时
      // flush 握手会 await 它,否则旧 tab 这次写盘 IPC 仍在飞就被退出截断(P1-AE 的
      // 兄弟缺口,codex 复审 F2)。编辑器卸载回写先于此 cleanup 把旧 tab 写脏 → 先补排队再 flush。
      scheduleUnseenWriteBack();
      trackInFlightAutoSave(scheduler.flush());
    };
  }, [scheduler, tabId]);
}

/**
 * 根据 filePath 判断是否启用自动保存.
 * 决策 #3:.md / .markdown 自动保存;其它(代码 / 任意)显式 Cmd+S。
 */
export function isAutoSaveEnabled(filePath: string | null): boolean {
  // 可维护性 M13:markdown 扩展名判定共用 editor-path-utils.isMarkdownPath。
  if (!filePath) return false;
  return isMarkdownPath(filePath);
}
