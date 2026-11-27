// M-Editor Step E2:auto-save 调度器(纯函数,可测)。
// 与 fs-watch-helpers 同模式 — React hook 是薄壳。
//
// 当初(决策 #3,ADR-015)只有 Markdown 2s 防抖自动保存、代码必须 Cmd+S;现在按 files.autoSave / Markdown 覆盖逐文件决定
// (auto-save-config.ts,BDD: src/__tests__/files-auto-save/),默认行为不变。enabled / delay 由 caller 决定,scheduler 不知道。

export interface AutoSaveScheduler {
  /**
   * 排队一次保存,delay 内多次调用合并(delayMs = null:只记下待保存,等 flush —— onFocusChange / onWindowChange);
   * 失败 console.warn + 经 onError 通知一次(去重),不影响下次。数据不丢(markSaved 仅写盘成功才清 dirty),onError 仅补反馈。
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
  /** 防抖毫秒;null = 不计时,只在 flush(失焦 / 切走 / 关窗)时保存。 */
  delayMs: number | null,
  /**
   * 保存失败时的可选通知钩子。**去重**:仅在 ok→fail 跃迁时触发一次,连续失败不重复
   * (防 2s 防抖反复失败刷屏);一次成功后重置,下次再失败会再通知。
   */
  onError?: (err: unknown) => void,
): AutoSaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // delayMs = null 时的「有待保存」标记(相当于一个永不到点的 timer)。
  let pending = false;
  let lastFailed = false;
  // 当前在途的保存 promise。timer 自然 fire 后 `timer=null` 但写盘可能仍未完成;
  // 不记录它的话,关窗 flush() 在 timer 已清空时会走 no-op、在落盘 IPC 完成前就 ack
  // 退出 → 丢最后一次编辑(数据安全复查 P1)。记录后 flush() 在无 timer 时也
  // await 它,把「定时器已触发但还没写完」的保存纳入关窗握手。
  let inFlight: Promise<void> | null = null;

  const runSave = (): Promise<void> => {
    const p = Promise.resolve()
      .then(() => saveFile())
      .then((r) => {
        // 打磨 P2-BK:普通磁盘错误(EACCES/ENOSPC)是 resolve 的 {ok:false} 而非 reject,
        // 必须同样走失败路径(抛出结果本身,onError 可按其 code 本地化)。
        if ((r as { ok?: unknown } | null | undefined)?.ok === false) throw r;
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
    inFlight = p;
    void p.finally(() => {
      if (inFlight === p) inFlight = null;
    });
    return p;
  };

  return {
    schedule() {
      if (timer) clearTimeout(timer);
      if (delayMs === null) {
        timer = null;
        pending = true;
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        runSave();
      }, delayMs);
    },
    cancel() {
      pending = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    flush() {
      if (timer || pending) {
        if (timer) clearTimeout(timer);
        timer = null;
        pending = false;
        return runSave();
      }
      // timer 已 fire 但保存可能仍在途 → 等它落盘,避免关窗 ack 早于写盘。
      if (inFlight) return inFlight;
      return Promise.resolve();
    },
  };
}
