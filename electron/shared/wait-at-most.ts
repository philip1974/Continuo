// 「最多等 N ms 就放行」的有界等待(关闭 / 清理路径共用;此前 kill-with-grace、mcp-host、debug.service、
// dap-client、renderer 插件 onunload 各写一份 setTimeout + Promise.race + clearTimeout)。无 node 依赖,main / renderer 共用。

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等 `p` 完成或 `ms` 到期,先到者为准:p 完成 → 'done',到期 → 'timeout'(不 reject)。p 在到期前 reject
 * 则原样 reject。无论哪种结局都清掉计时器。`unref` 让计时器不挂住进程退出。
 */
export async function waitAtMost(
  p: Promise<unknown>,
  ms: number,
  opts: { readonly unref?: boolean } = {},
): Promise<'done' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    if (opts.unref) timer.unref?.();
  });
  try {
    return await Promise.race([p.then(() => 'done' as const), capped]);
  } finally {
    clearTimeout(timer);
  }
}
