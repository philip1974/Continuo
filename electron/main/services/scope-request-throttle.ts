import { isSameOrInsidePath } from '../lib/path-inside';

// 安全:plugin-fs:request-scope 的弹窗节流。被用户拒绝后没有冷却时,有 fs 权限的插件可在拒绝回调里立刻再次
// requestScope,弹窗关一个来一个,直到用户误点「允许」(correlator.canAccept 只限同时未决数)。
// - 拒绝冷却:按**单条 canonical 路径**记(不看 mode、不看和谁一起请求)。请求里任一路径在冷却期内、或是某条冷却中
//   路径的祖先(扩大范围再问一次)→ 整个请求直接 deny 不弹窗;同一路径连续被拒指数退避。
//   曾按「整组 scope」计键:被拒后改成 [被拒路径, 任意新目录]、r 换 rw、换父目录即是新键,冷却形同虚设。
//   被拒路径的子目录是缩小范围,不拦(它自己被拒后同样进入冷却,并计入下面的插件级退避)。
// - 插件级退避:同一插件连续 SCOPE_PLUGIN_DENY_STREAK 次被拒(不论请求什么)→ 该插件所有 scope 请求进入退避,
//   每多被拒一次翻倍、封顶;用户授予一次计数减 1(不清零、不解除已生效的退避)。
// - 速率上限:同一插件单位时间内发出的弹窗数有上限(挡轮换不同目录的刷屏)。
// - 单飞:同一插件同时最多一个未决弹窗。上面三项只看**已落定**的决定:插件不等结果同步连发 N 次同一请求时还没有
//   任何拒绝记录,N 个弹窗全部排进队列,用户拒掉第一个后其余依次弹出。未决期间的新请求直接 deny(不排队、不计拒绝)。
// 只在主进程内存里,数量有上限;见 src/__tests__/plugin-fs-scope-request-throttle/。

/** 首次被拒后的冷却。 */
export const SCOPE_DENY_COOLDOWN_BASE_MS = 30_000;
/** 连续被拒的冷却上限。 */
export const SCOPE_DENY_COOLDOWN_MAX_MS = 5 * 60_000;
/** 距上次拒绝超过该时长 → 退避级别归零(记录丢弃)。 */
export const SCOPE_DENY_FORGET_MS = 10 * 60_000;
/** 同一插件连续被拒这么多次 → 插件级退避(首次 SCOPE_DENY_COOLDOWN_BASE_MS,之后每次被拒翻倍,同一上限)。 */
export const SCOPE_PLUGIN_DENY_STREAK = 3;
/** 每插件在 SCOPE_PROMPT_RATE_WINDOW_MS 内最多发出的弹窗数。 */
export const SCOPE_PROMPT_RATE_MAX = 10;
export const SCOPE_PROMPT_RATE_WINDOW_MS = 60_000;
/** 每插件记住的被拒路径数 / 记住的插件数上限(超出丢最旧的)。 */
const MAX_DENIED_PATHS_PER_PLUGIN = 64;
const MAX_TRACKED_PLUGINS = 256;

interface Denied {
  /** 连续被拒次数(决定冷却时长)。 */
  count: number;
  deniedAt: number;
  until: number;
}

interface PluginState {
  /** canonical path → 拒绝记录。 */
  readonly denied: Map<string, Denied>;
  /** 最近发出的弹窗时刻(升序,只保留窗口内的)。 */
  prompts: number[];
  /** 该插件连续被拒次数(任何请求;授予一次减 1)与对应的退避截止时刻。 */
  streak: number;
  lastDeniedAt: number;
  backoffUntil: number;
}

const cooldownFor = (level: number): number =>
  Math.min(SCOPE_DENY_COOLDOWN_BASE_MS * 2 ** (level - 1), SCOPE_DENY_COOLDOWN_MAX_MS);

export class ScopeRequestThrottle {
  private readonly plugins = new Map<string, PluginState>();
  /** 有未决弹窗的插件。独立于 plugins(不随其容量淘汰);大小受 correlator 的未决请求上限约束。 */
  private readonly inFlight = new Set<string>();

  /**
   * 是否可以为这次请求弹窗(canonicalPaths = 请求里各 scope 归一化后的路径)。true → 已计入该插件的弹窗速率并
   * 标记为在途(调用方随后必须真的弹窗,且弹窗无论以何种方式收口都必须调 endPrompt);false(该插件已有未决弹窗 /
   * 在退避期 / 某条路径在拒绝冷却期内 / 弹窗超速)→ 调用方直接按 deny 收口。
   */
  tryPrompt(pluginId: string, canonicalPaths: readonly string[], now: number = Date.now()): boolean {
    if (this.inFlight.has(pluginId)) return false;
    const state = this.plugins.get(pluginId);
    if (state) {
      if (now < state.backoffUntil) return false;
      for (const [deniedPath, denied] of state.denied) {
        if (now >= denied.until) {
          if (now - denied.deniedAt > SCOPE_DENY_FORGET_MS) state.denied.delete(deniedPath);
          continue;
        }
        // 请求路径等于被拒路径、或是它的祖先(把被拒目录包进更大的范围)→ 拒。
        if (canonicalPaths.some((p) => isSameOrInsidePath(p, deniedPath))) return false;
      }
      state.prompts = state.prompts.filter((t) => now - t < SCOPE_PROMPT_RATE_WINDOW_MS);
      if (state.prompts.length >= SCOPE_PROMPT_RATE_MAX) return false;
    }
    this.stateFor(pluginId).prompts.push(now);
    this.inFlight.add(pluginId);
    return true;
  }

  /** tryPrompt 放行的弹窗已收口(用户决定 / 超时 / 窗口关闭 / 插件卸载 / 发送失败)→ 该插件可以再弹。 */
  endPrompt(pluginId: string): void {
    this.inFlight.delete(pluginId);
  }

  /**
   * 用户对弹窗的决定。deny → 请求里每条路径进入冷却(连续被拒翻倍,封顶),插件连续被拒计数 +1;
   * grant → 清除这些路径(仅这些)的拒绝记录,插件连续被拒计数 -1。
   */
  noteDecision(
    pluginId: string,
    canonicalPaths: readonly string[],
    decision: 'grant' | 'deny',
    now: number = Date.now(),
  ): void {
    const state = this.stateFor(pluginId);
    if (decision === 'grant') {
      for (const path of canonicalPaths) state.denied.delete(path);
      // 只减 1、不清零,也不解除已生效的退避:清零的话「拒、拒、(请求一个无害小目录骗到)允、拒、拒、允…」
      // 计数永远到不了 SCOPE_PLUGIN_DENY_STREAK,插件级退避形同虚设。
      state.streak = Math.max(0, state.streak - 1);
      return;
    }
    for (const path of new Set(canonicalPaths)) {
      const count = (state.denied.get(path)?.count ?? 0) + 1;
      state.denied.delete(path); // 重新插入 → Map 迭代序即最近被拒序,超限时丢最旧的
      state.denied.set(path, { count, deniedAt: now, until: now + cooldownFor(count) });
      if (state.denied.size > MAX_DENIED_PATHS_PER_PLUGIN) {
        state.denied.delete(state.denied.keys().next().value as string);
      }
    }
    // 「无拒绝」从退避结束起算:退避期内插件本来就弹不了窗,不能算作安静。否则退避到上限(5 分钟)后再等 5 分钟
    // 计数即清零,又能从头连弹 SCOPE_PLUGIN_DENY_STREAK 次。
    if (now - Math.max(state.lastDeniedAt, state.backoffUntil) > SCOPE_DENY_FORGET_MS) state.streak = 0;
    state.streak += 1;
    state.lastDeniedAt = now;
    if (state.streak >= SCOPE_PLUGIN_DENY_STREAK) {
      state.backoffUntil = now + cooldownFor(state.streak - SCOPE_PLUGIN_DENY_STREAK + 1);
    }
  }

  private stateFor(pluginId: string): PluginState {
    let state = this.plugins.get(pluginId);
    if (!state) {
      if (this.plugins.size >= MAX_TRACKED_PLUGINS) {
        this.plugins.delete(this.plugins.keys().next().value as string);
      }
      state = { denied: new Map(), prompts: [], streak: 0, lastDeniedAt: 0, backoffUntil: 0 };
      this.plugins.set(pluginId, state);
    }
    return state;
  }
}
