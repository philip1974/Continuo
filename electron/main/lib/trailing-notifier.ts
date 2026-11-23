// 尾随合并通知:首次 notify 起 delayMs 内的多次变更只触发一次 fn(不随后续变更推迟,最长 delayMs 必发)。
// 用于「集合批量变更 → 广播一次 changed」类通知(如 MCP tools/list_changed:插件激活时逐个注册
// N 个 tool,逐个广播会让每个客户端重拉 N 次 tools/list,总量 O(N²))。

export interface TrailingNotifier {
  notify(): void;
}

export function createTrailingNotifier(fn: () => void, delayMs: number): TrailingNotifier {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    notify() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
      // 不因待发通知阻止进程退出。
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
    },
  };
}
