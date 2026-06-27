// race(R16):插件 PluginManager.init() 是异步扫描+激活,但 main-app 启动时立即订阅
// plugins.onChanged → reload。init 仍在扫描(某插件尚未 entries.set())时若该插件文件变化,
// reload(id) 因「Plugin not found」被丢弃,随后 init 用旧快照激活 → 漏掉启动窗口期的一次变更
// (插件以旧代码/manifest 运行直到下次改动或手动 reload)。
//
// 本 gate:init 完成前到达的 onChanged 只记入 pending(去重),init 完成(成功或失败)后逐个
// reload;之后的 onChanged 直接 reload。把启动时序与变更订阅解耦成可单测的纯逻辑。

export interface PluginReloadGateDeps {
  readonly init: () => Promise<void>;
  readonly reload: (id: string) => Promise<void>;
  /** 订阅 main 推送的插件文件变化;同步注册(必须先于任何 init 工作完成)。 */
  readonly onChanged: (cb: (id: string) => void) => void;
  readonly onError?: (where: 'init' | 'reload', err: unknown) => void;
}

export function wirePluginReloadGate(deps: PluginReloadGateDeps): void {
  const pending = new Set<string>();
  let ready = false;

  const doReload = (id: string): void => {
    void deps.reload(id).catch((err) => deps.onError?.('reload', err));
  };

  const flush = (): void => {
    ready = true;
    for (const id of pending) doReload(id);
    pending.clear();
  };

  // init 失败也要 flush + 标 ready:否则缓冲的变更永远不重放、后续变更永久被 buffer。
  void deps.init().then(flush, (err) => {
    deps.onError?.('init', err);
    flush();
  });

  // 同步注册订阅:init() 已发起但其异步扫描尚未推进,此处先就位捕获窗口期变更。
  deps.onChanged((id) => {
    if (!ready) {
      pending.add(id);
      return;
    }
    doReload(id);
  });
}
