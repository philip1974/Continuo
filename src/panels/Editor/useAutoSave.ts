// M-Editor Step E2:useAutoSave 薄壳 hook。
// 监听全局 activeTab 内容变化,enabled=true 时按 delayMs 防抖触发 saveFile。
//
// 决策(ADR-015):Markdown 自动保存,代码必须显式 Cmd+S。
// enabled 由 EditorPanel 根据当前 tab 文件类型决定(.md/.markdown → true)。

import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '@/stores/editor.store';
import { makeAutoSaveScheduler } from './auto-save';
import {
  registerAutoSaveFlush,
  trackInFlightAutoSave,
} from './autosave-flush-registry';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';

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
      const found = s.tabs.find((t) => t.id === s.activeTabId);
      return {
        id: found?.id ?? null,
        filePath: found?.filePath ?? null,
        dirty: found?.dirty ?? false,
        content: found?.content,
      };
    }),
  );
  const tabId = active.id;

  // 每个 tab 一个 scheduler(身份含 tabId)。保存绑定到调度时捕获的 tabId,
  // 而非"当前 active tab" —— 切走后 active 已变,绑定 active 会保存错的 tab。
  const scheduler = useMemo(
    () =>
      tabId !== null
        ? makeAutoSaveScheduler(
            () => saveTab(tabId),
            delayMs,
            // 自动保存失败时弹一次 warn toast(去重在 scheduler 内,连续失败不刷屏)。
            // 数据不丢(dirty 保持),仅补反馈 —— 否则后台静默失败用户无从知晓为何脏点不消。
            // scheduler 已 console.warn,故 mirror:false 防双写。见第二十一轮 P1-AZ。
            (err) =>
              notify.warn(
                `${t('editor.autosave_failed')}: ${err instanceof Error ? err.message : String(err)}`,
                { mirror: false },
              ),
          )
        : null,
    [saveTab, tabId, delayMs],
  );

  // 内容/脏态变化 → 防抖排队。注意:这里**不**在 cleanup 取消,否则每次按键
  // (activeTab 变)都会取消再排队,且切 tab 会丢掉 pending。切走该 tab 的落盘交给
  // 下面按 scheduler 身份(=tabId)触发的 flush effect。
  useEffect(() => {
    if (!scheduler) return;
    // 运行中关掉 autosave 设置 → 取消已排队的保存(禁用应阻止已排队写入)。
    // 这是针对当前 tab 的 scheduler;切 tab 的落盘仍由 flush effect 处理。
    if (!enabled) {
      scheduler.cancel();
      return;
    }
    if (active.id === null || !active.filePath || !active.dirty) return;
    scheduler.schedule();
  }, [enabled, active, scheduler]);

  // 切走该 tab(scheduler 身份随 tabId 变)或组件卸载 → flush pending,
  // 把还卡在防抖窗口里的编辑落盘,避免连续输入后立即切 tab 丢失整段内容。
  // 同时把当前 scheduler 的 flush 句柄注册进 registry,供关窗/退出的 flush 握手
  // (DockShell onFlushRequest)在 ack 前同步落盘 pending autosave(P1-AE)。
  useEffect(() => {
    if (!scheduler) {
      registerAutoSaveFlush(null);
      return;
    }
    registerAutoSaveFlush(() => scheduler.flush());
    return () => {
      registerAutoSaveFlush(null);
      // 切走该 tab:fire-and-forget 触发落盘,但登记进在途集合 —— 紧接着关窗时
      // flush 握手会 await 它,否则旧 tab 这次写盘 IPC 仍在飞就被退出截断(P1-AE 的
      // 兄弟缺口,codex 复审 F2)。
      trackInFlightAutoSave(scheduler.flush());
    };
  }, [scheduler]);
}

/**
 * 根据 filePath 判断是否启用自动保存.
 * 决策 #3:.md / .markdown 自动保存;其它(代码 / 任意)显式 Cmd+S。
 */
export function isAutoSaveEnabled(filePath: string | null): boolean {
  if (!filePath) return false;
  return /\.(md|markdown)$/i.test(filePath);
}
