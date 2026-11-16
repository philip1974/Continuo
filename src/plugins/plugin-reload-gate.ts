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
  /** 订阅 main 广播的「插件已卸载」(终审 P1:跨窗口卸载);与 uninstalled 成对提供。 */
  readonly onUninstalled?: (cb: (id: string) => void) => void;
  /** 本窗口撤销已卸载插件(PluginManager.handleUninstalled)。 */
  readonly uninstalled?: (id: string) => Promise<void>;
  /**
   * 卸载广播的同步部分(PluginManager.markUninstalled,终审 P1):广播一到**立即**调用,不受 init 缓冲影响 ——
   * init 的激活可能正挂在该插件的授权弹窗上,须先取消弹窗、阻止加载插件代码;uninstalled 仍按缓冲规则排队。
   */
  readonly markUninstalled?: (id: string) => void;
  /** 订阅 main 广播的「插件启用状态已变更」(终审 P1:跨窗口启停);与 enabledChanged 成对提供。 */
  readonly onEnabledChanged?: (cb: (id: string, enabled: boolean) => void) => void;
  /** 本窗口同步启用状态(PluginManager.handleEnabledChanged)。 */
  readonly enabledChanged?: (id: string, enabled: boolean) => Promise<void>;
  readonly onError?: (
    where: 'init' | 'reload' | 'uninstalled' | 'enabled-changed',
    err: unknown,
  ) => void;
}

export function wirePluginReloadGate(deps: PluginReloadGateDeps): void {
  const pending = new Set<string>();
  // init 完成前到达的卸载广播同样缓冲:init 可能已用卸载前的目录快照激活该插件,完成后再撤销。
  const pendingUninstalled = new Set<string>();
  // init 完成前到达的启停广播同样缓冲(同 id 以最后一次为准):init 读的 _enabled.json 快照可能早于该变更。
  const pendingEnabled = new Map<string, boolean>();
  let ready = false;

  const doReload = (id: string): void => {
    void deps.reload(id).catch((err) => deps.onError?.('reload', err));
  };

  const doUninstalled = (id: string): void => {
    void deps.uninstalled?.(id).catch((err) => deps.onError?.('uninstalled', err));
  };

  const doEnabledChanged = (id: string, enabled: boolean): void => {
    void deps
      .enabledChanged?.(id, enabled)
      .catch((err) => deps.onError?.('enabled-changed', err));
  };

  const flush = (): void => {
    ready = true;
    for (const id of pending) doReload(id);
    pending.clear();
    for (const id of pendingUninstalled) doUninstalled(id);
    pendingUninstalled.clear();
    for (const [id, enabled] of pendingEnabled) doEnabledChanged(id, enabled);
    pendingEnabled.clear();
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

  deps.onUninstalled?.((id) => {
    try {
      deps.markUninstalled?.(id);
    } catch (err) {
      deps.onError?.('uninstalled', err);
    }
    if (!ready) {
      pendingUninstalled.add(id);
      return;
    }
    doUninstalled(id);
  });

  deps.onEnabledChanged?.((id, enabled) => {
    if (!ready) {
      pendingEnabled.delete(id); // 重新插入 → 按最后到达顺序重放
      pendingEnabled.set(id, enabled);
      return;
    }
    doEnabledChanged(id, enabled);
  });
}
