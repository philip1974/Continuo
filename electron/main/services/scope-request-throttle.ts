import type { PathScope } from '../../shared/plugin-fs-contract';

// 安全:plugin-fs:request-scope 的弹窗节流。被用户拒绝后没有冷却时,有 fs 权限的插件可在拒绝回调里立刻再次
// requestScope,弹窗关一个来一个,直到用户误点「允许」(correlator.canAccept 只限同时未决数)。
// - 拒绝冷却:同一插件对同一组 scope(归一化后)被拒 → 冷却期内直接 deny 不弹窗;连续被拒指数退避。
// - 速率上限:同一插件单位时间内发出的弹窗数有上限(挡轮换不同目录的刷屏)。
// 只在主进程内存里,数量有上限;见 src/__tests__/plugin-fs-scope-request-throttle/。

/** 首次被拒后的冷却。 */
export const SCOPE_DENY_COOLDOWN_BASE_MS = 30_000;
/** 连续被拒的冷却上限。 */
export const SCOPE_DENY_COOLDOWN_MAX_MS = 5 * 60_000;
/** 距上次拒绝超过该时长 → 退避级别归零(记录丢弃)。 */
export const SCOPE_DENY_FORGET_MS = 10 * 60_000;
/** 每插件在 SCOPE_PROMPT_RATE_WINDOW_MS 内最多发出的弹窗数。 */
export const SCOPE_PROMPT_RATE_MAX = 10;
export const SCOPE_PROMPT_RATE_WINDOW_MS = 60_000;
/** 每插件记住的被拒 scope 组数 / 记住的插件数上限(超出丢最旧的)。 */
const MAX_DENIED_KEYS_PER_PLUGIN = 64;
const MAX_TRACKED_PLUGINS = 256;

interface Denied {
  /** 连续被拒次数(决定冷却时长)。 */
  count: number;
  deniedAt: number;
  until: number;
}

interface PluginState {
  readonly denied: Map<string, Denied>;
  /** 最近发出的弹窗时刻(升序,只保留窗口内的)。 */
  prompts: number[];
}

/** 一组 scope 的稳定标识:归一化后的 mode + path,排序去重(与请求里的顺序无关)。 */
export function scopeRequestKey(canonicalScopes: readonly PathScope[]): string {
  return [...new Set(canonicalScopes.map((s) => `${s.mode}\0${s.path}`))].sort().join('\n');
}

export class ScopeRequestThrottle {
  private readonly plugins = new Map<string, PluginState>();

  /**
   * 是否可以为这次请求弹窗。true → 已计入该插件的弹窗速率(调用方随后必须真的弹窗);
   * false(该组 scope 在拒绝冷却期内 / 插件弹窗超速)→ 调用方直接按 deny 收口。
   */
  tryPrompt(pluginId: string, key: string, now: number = Date.now()): boolean {
    const state = this.plugins.get(pluginId);
    if (state) {
      const denied = state.denied.get(key);
      if (denied) {
        if (now < denied.until) return false;
        if (now - denied.deniedAt > SCOPE_DENY_FORGET_MS) state.denied.delete(key);
      }
      state.prompts = state.prompts.filter((t) => now - t < SCOPE_PROMPT_RATE_WINDOW_MS);
      if (state.prompts.length >= SCOPE_PROMPT_RATE_MAX) return false;
    }
    this.stateFor(pluginId).prompts.push(now);
    return true;
  }

  /** 用户对弹窗的决定:deny → 进入冷却(连续被拒翻倍,封顶);grant → 清除该组的拒绝记录。 */
  noteDecision(pluginId: string, key: string, decision: 'grant' | 'deny', now: number = Date.now()): void {
    const state = this.stateFor(pluginId);
    const count = decision === 'deny' ? (state.denied.get(key)?.count ?? 0) + 1 : 0;
    state.denied.delete(key); // 重新插入 → Map 迭代序即最近被拒序,超限时丢最旧的
    if (decision === 'grant') return;
    const cooldown = Math.min(SCOPE_DENY_COOLDOWN_BASE_MS * 2 ** (count - 1), SCOPE_DENY_COOLDOWN_MAX_MS);
    state.denied.set(key, { count, deniedAt: now, until: now + cooldown });
    if (state.denied.size > MAX_DENIED_KEYS_PER_PLUGIN) {
      state.denied.delete(state.denied.keys().next().value as string);
    }
  }

  private stateFor(pluginId: string): PluginState {
    let state = this.plugins.get(pluginId);
    if (!state) {
      if (this.plugins.size >= MAX_TRACKED_PLUGINS) {
        this.plugins.delete(this.plugins.keys().next().value as string);
      }
      state = { denied: new Map(), prompts: [] };
      this.plugins.set(pluginId, state);
    }
    return state;
  }
}
