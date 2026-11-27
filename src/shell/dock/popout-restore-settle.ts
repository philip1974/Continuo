// popout 恢复在途时不写残缺布局。dockview 6 fromJSON 把 popout 组放进 setTimeout(逐个间隔 100ms)再 addPopoutGroup,
// 后者等子窗 load 后才把组挂进 _popoutGroups;在此之前该组既不在 grid 也不在 popoutGroups,toJSON 直接漏掉它与其面板。
// 这段时间里写盘(⌘Q / 关窗 flush、自动保存)会把「没有 popout」的布局落盘 → 下次启动 popout 与面板永久丢失。
// dockview 的 popoutRestorationPromise 在 addPopoutGroup「被调用」时就 resolve(不等开窗完成),不能用 → 自己按
// 「popout 位置的组数」轮询判定落定;开窗失败(onDidOpenPopoutWindowFail,dockview 已收回主窗)计入落定;限时兜底。
// BDD: src/__tests__/window-state-restore/popout-restore-settle.spec.ts

/** 轮询间隔:dockview 挂上 popout 时不保证发事件(组已是活动组时无任何事件)。只在恢复在途期间轮询。 */
export const POPOUT_RESTORE_POLL_MS = 50;
/** 落定上限:子窗迟迟 load 不完 / 静默失败时不无限期挡住写盘;须远小于 main 关窗 flush 回执上限(10s)。 */
export const POPOUT_RESTORE_SETTLE_MAX_MS = 5000;

/** DockviewApi 用到的最小面(结构化,便于单测)。 */
interface TrackedApi {
  readonly groups: ReadonlyArray<{ readonly api: { readonly location: { readonly type: string } } }>;
  onDidOpenPopoutWindowFail: (listener: () => void) => { dispose: () => void };
}

const settling = new WeakMap<object, Promise<void>>();
const settledListeners = new Set<(api: object) => void>();

/** 订阅 popout 恢复落定(挂上时 dockview 不保证发事件,依赖 popout 位置的派生状态须在此重算)。返回退订。 */
export function onPopoutRestoreSettled(listener: (api: object) => void): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}

/** fromJSON 之后调用:该 api 正在恢复 expected 个 popout。返回的 disposable 立即结束等待(卸载 / 重建)。 */
export function trackPopoutRestore(
  api: TrackedApi,
  expected: number,
): { dispose: () => void } {
  if (expected <= 0) {
    settling.delete(api);
    return { dispose: () => undefined };
  }
  let failed = 0;
  let done = false;
  let finish = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    const fail = api.onDidOpenPopoutWindowFail(() => {
      failed += 1;
    });
    const poll = setInterval(() => {
      let attached = expected;
      try {
        attached = api.groups.filter((g) => g.api.location.type === 'popout').length;
      } catch {
        // api 已销毁 → 视为落定
      }
      if (attached + failed >= expected) finish();
    }, POPOUT_RESTORE_POLL_MS);
    const timeout = setTimeout(() => finish(), POPOUT_RESTORE_SETTLE_MAX_MS);
    finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timeout);
      fail.dispose();
      if (settling.get(api) === promise) settling.delete(api);
      resolve();
      for (const listener of settledListeners) listener(api);
    };
  });
  settling.set(api, promise);
  return { dispose: () => finish() };
}

/** 该 api 的 popout 恢复是否在途(恢复失败的组会被 dockview 收回主窗网格,网格最小宽随之变化)。 */
export function isPopoutRestoreSettling(api: object): boolean {
  return settling.has(api);
}

/** 布局快照写盘前等待:该 api 的 popout 恢复落定(未登记 → 立即)。 */
export function whenPopoutRestoreSettled(api: object): Promise<void> {
  return settling.get(api) ?? Promise.resolve();
}
