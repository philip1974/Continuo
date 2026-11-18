import { isSameOrInsidePath } from '../lib/path-inside';

// 安全:plugin-fs:request-scope 的弹窗节流。被用户拒绝后没有冷却时,有 fs 权限的插件可在拒绝回调里立刻再次
// requestScope,弹窗关一个来一个,直到用户误点「允许」(correlator.canAccept 只限同时未决数)。
// - 拒绝冷却:按**单条 canonical 路径**记(不看 mode、不看和谁一起请求)。请求里任一路径在冷却期内、或是某条冷却中
//   路径的祖先(扩大范围再问一次)→ 整个请求直接 deny 不弹窗;同一路径连续被拒指数退避。
//   曾按「整组 scope」计键:被拒后改成 [被拒路径, 任意新目录]、r 换 rw、换父目录即是新键,冷却形同虚设。
//   被拒路径的子目录是缩小范围,不拦(它自己被拒后同样进入冷却,并计入下面的插件级退避)。
// - 插件级退避:同一插件连续 SCOPE_PLUGIN_DENY_STREAK 次被拒(不论请求什么)→ 该插件所有 scope 请求进入退避,
//   每多被拒一次翻倍、封顶;用户授予一次即清零。
// - 速率上限:同一插件单位时间内发出的弹窗数有上限(挡轮换不同目录的刷屏)。
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
  /** 该插件连续被拒次数(任何请求;授予一次清零)与对应的退避截止时刻。 */
  streak: number;
  lastDeniedAt: number;
  backoffUntil: number;
}

const cooldownFor = (level: number): number =>
  Math.min(SCOPE_DENY_COOLDOWN_BASE_MS * 2 ** (level - 1), SCOPE_DENY_COOLDOWN_MAX_MS);

export class ScopeRequestThrottle {
  private readonly plugins = new Map<string, PluginState>();

  /**
   * 是否可以为这次请求弹窗(canonicalPaths = 请求里各 scope 归一化后的路径)。true → 已计入该插件的弹窗速率
   * (调用方随后必须真的弹窗);false(插件在退避期 / 某条路径在拒绝冷却期内 / 弹窗超速)→ 调用方直接按 deny 收口。
   */
  tryPrompt(pluginId: string, canonicalPaths: readonly string[], now: number = Date.now()): boolean {
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
    return true;
  }

  /**
   * 用户对弹窗的决定。deny → 请求里每条路径进入冷却(连续被拒翻倍,封顶),插件连续被拒计数 +1;
   * grant → 清除这些路径的拒绝记录与插件的连续被拒计数。
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
      state.streak = 0;
      state.backoffUntil = 0;
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
    if (now - state.lastDeniedAt > SCOPE_DENY_FORGET_MS) state.streak = 0;
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
