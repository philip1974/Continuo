// M-Editor Step E2:auto-save 调度器(纯函数,可测)。
// 与 fs-watch-helpers 同模式 — React hook 是薄壳。
//
// 决策:Markdown 2s 防抖自动保存,代码必须 Cmd+S(决策 #3,doc/09 ADR-015)。
// enabled 由 caller 决定(EditorPanel 根据当前 tab 类型),scheduler 不知道。

export interface AutoSaveScheduler {
  /**
   * 排队一次保存,delay 内多次调用合并;失败 console.warn + 经 onError 通知一次(去重),
   * 不影响下次。数据不丢(markSaved 仅写盘成功才清 dirty),onError 仅补反馈。
   */
  schedule: () => void;
  /** 清掉 pending. */
  cancel: () => void;
  /**
   * 立即执行 pending 的保存(若有),清掉 timer。无 pending 则 no-op。
   * 用于"切走/卸载该 tab"或关窗/退出时把还卡在防抖窗口里的编辑落盘,避免静默丢失。
   * 返回可 await 的 Promise:关窗 flush 握手需在 ack 前等保存真正落盘(失败 swallow)。
   */
  flush: () => Promise<void>;
}

export function makeAutoSaveScheduler(
  saveFile: () => Promise<unknown>,
  delayMs: number,
  /**
   * 保存失败时的可选通知钩子。**去重**:仅在 ok→fail 跃迁时触发一次,连续失败不重复
   * (防 2s 防抖反复失败刷屏);一次成功后重置,下次再失败会再通知。
   */
  onError?: (err: unknown) => void,
): AutoSaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFailed = false;

  const runSave = (): Promise<void> =>
    Promise.resolve()
      .then(() => saveFile())
      .then(() => {
        lastFailed = false;
        return undefined;
      })
      .catch((err) => {
        console.warn('[auto-save] failed:', err);
        if (!lastFailed) {
          lastFailed = true;
          onError?.(err);
        }
      });

  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        runSave();
      }, delayMs);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        return runSave();
      }
      return Promise.resolve();
    },
  };
}
