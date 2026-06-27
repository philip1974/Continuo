// race:单调代际「最新者胜」守卫。用于「同一异步操作可被更新的调用取代,过期结果不得落地」
// 的场景(如连续拖入两个 workspace 文件夹:后发起的若先 resolve,先发起的旧结果不得覆盖)。
//
// 用法:
//   const guard = createLatestGuard();
//   // 每次发起:
//   const isLatest = guard.begin();
//   const r = await something();
//   if (!isLatest()) return; // 期间已有更新的调用 → 本次过期,丢弃
//   apply(r);

export interface LatestGuard {
  /** 标记一次新调用为最新,返回「本次是否仍是最新」的查询函数。 */
  begin: () => () => boolean;
}

export function createLatestGuard(): LatestGuard {
  let seq = 0;
  return {
    begin() {
      const mine = ++seq;
      return () => mine === seq;
    },
  };
}
