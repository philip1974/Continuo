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
  trackInFlightAutoSave,
} from './autosave-flush-registry';
import { claimAutoSave, releaseAutoSave, setAutoSaveFailed } from './autosave-failures';
import { useAutoSaveHeld } from './autosave-hold';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { failureOf } from '@/lib/failure-of';
import { EDITOR_DISK_CHANGED, type SaveFileOptions } from './editor-file-actions';
import { saveHotkeyLabel } from './editor-commands';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

export interface UseAutoSaveOptions {
  enabled: boolean;
  /** 防抖毫秒(默认值在 autoSave.delayMs 设置项上). */
  delayMs: number;
}

export function useAutoSave(
  saveTab: (tabId: string, opts?: SaveFileOptions) => Promise<unknown>,
  opts: UseAutoSaveOptions,
): void {
  const { delayMs } = opts;
  // 只订阅活跃 tab 的调度相关字段(打磨 R47):id/filePath/dirty/content 变化才重排
  // schedule。用 useShallow 返回扁平 primitive 对象,逐字段 Object.is 比较 ——
  // markSaved 推进 originalContent、reloadFromDisk 改 reloadEpoch 等不在此集合的字段
  // 变化不再触发 hook 重渲/effect 重跑。content 只作 string ref(不用 JSON 签名,
  // 避免序列化大文档正文)。
  const active = useEditorStore(
    useShallow((s) => {
      const found =
        findEditorFileTabById(s.tabs, s.activeTabId);
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
      // 同走 localizeErrorByCode(按 code 本地化,未收录回退原 message)。
      (err) => {
        const { code, message } = failureOf(err);
        notify.warn(
          t('common.label_detail', {
            label: t('editor.autosave_failed'),
            // 磁盘冲突的说明里写着保存键:填当前生效绑定(改绑后跟随)。
            detail: localizeErrorByCode(
              code,
              message,
              code === EDITOR_DISK_CHANGED ? { hotkey: saveHotkeyLabel() } : undefined,
            ),
          }),
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
  }, [enabled, active, scheduler]);

  // 切走该 tab(scheduler 身份随 tabId 变)或组件卸载 → flush pending,
  // 把还卡在防抖窗口里的编辑落盘,避免连续输入后立即切 tab 丢失整段内容。
  // 同时以 claimAutoSave 登记为活动持有者(带 flush 句柄),供关窗/退出的 flush 握手
  // (DockShell onFlushRequest)在 ack 前同步落盘 pending autosave(P1-AE)。
  useEffect(() => {
    if (!scheduler || tabId === null) return;
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
      // 切走该 tab:fire-and-forget 触发落盘,但登记进在途集合 —— 紧接着关窗时
      // flush 握手会 await 它,否则旧 tab 这次写盘 IPC 仍在飞就被退出截断(P1-AE 的
      // 兄弟缺口,复审 F2)。编辑器卸载回写先于此 cleanup 把旧 tab 写脏 → 先补排队再 flush。
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
