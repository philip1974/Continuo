import { isSameOrInsidePath } from '../lib/path-inside';
import {
  PROMPT_DENY_COOLDOWN_BASE_MS,
  PROMPT_DENY_COOLDOWN_MAX_MS,
  PROMPT_DENY_FORGET_MS,
  PROMPT_RATE_MAX,
  PROMPT_RATE_WINDOW_MS,
  PROMPT_SUBJECT_DENY_STREAK,
  PromptThrottle,
} from '../lib/prompt-throttle';

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
// 机制本身在 lib/prompt-throttle.ts(与 agent 授权弹窗共用);这里只定「路径命中」的含义与 scope 侧的命名。

/** 首次被拒后的冷却。 */
export const SCOPE_DENY_COOLDOWN_BASE_MS = PROMPT_DENY_COOLDOWN_BASE_MS;
/** 连续被拒的冷却上限。 */
export const SCOPE_DENY_COOLDOWN_MAX_MS = PROMPT_DENY_COOLDOWN_MAX_MS;
/** 距上次拒绝超过该时长 → 退避级别归零(记录丢弃)。 */
export const SCOPE_DENY_FORGET_MS = PROMPT_DENY_FORGET_MS;
/** 同一插件连续被拒这么多次 → 插件级退避(首次 SCOPE_DENY_COOLDOWN_BASE_MS,之后每次被拒翻倍,同一上限)。 */
export const SCOPE_PLUGIN_DENY_STREAK = PROMPT_SUBJECT_DENY_STREAK;
/** 每插件在 SCOPE_PROMPT_RATE_WINDOW_MS 内最多发出的弹窗数。 */
export const SCOPE_PROMPT_RATE_MAX = PROMPT_RATE_MAX;
export const SCOPE_PROMPT_RATE_WINDOW_MS = PROMPT_RATE_WINDOW_MS;

export class ScopeRequestThrottle extends PromptThrottle {
  constructor() {
    // 请求路径等于被拒路径、或是它的祖先(把被拒目录包进更大的范围)→ 命中。
    super((requested, denied) => isSameOrInsidePath(requested, denied));
  }

  /**
   * 是否可以为这次请求弹窗(canonicalPaths = 请求里各 scope 归一化后的路径)。true → 已计入该插件的弹窗速率并
   * 标记为在途(调用方随后必须真的弹窗,且弹窗无论以何种方式收口都必须调 endPrompt);false(该插件已有未决弹窗 /
   * 在退避期 / 某条路径在拒绝冷却期内 / 弹窗超速)→ 调用方直接按 deny 收口。
   */
  tryPrompt(pluginId: string, canonicalPaths: readonly string[], now: number = Date.now()): boolean {
    return this.admit(pluginId, canonicalPaths, now).ok;
  }
}
