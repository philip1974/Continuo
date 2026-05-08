// M-Editor Step E2:auto-save 调度器(纯函数,可测)。
// 与 fs-watch-helpers 同模式 — React hook 是薄壳。
//
// 决策:Markdown 2s 防抖自动保存,代码必须 Cmd+S(决策 #3,doc/09 ADR-015)。
// enabled 由 caller 决定(EditorPanel 根据当前 tab 类型),scheduler 不知道。

export interface AutoSaveScheduler {
  /** 排队一次保存,delay 内多次调用合并;失败 swallow + console.warn,不影响下次. */
  schedule: () => void;
  /** 清掉 pending. */
  cancel: () => void;
}

export function makeAutoSaveScheduler(
  saveFile: () => Promise<unknown>,
  delayMs: number,
): AutoSaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        Promise.resolve()
          .then(() => saveFile())
          .catch((err) => {
             
            console.warn('[auto-save] failed:', err);
          });
      }, delayMs);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
