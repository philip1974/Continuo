// 安全:授权弹窗节流的通用实现(主进程内存,数量有上限)。被用户拒绝后没有冷却时,请求方可在拒绝后立刻再问,
// 弹窗关一个来一个,直到用户误点「允许」。使用方:
// - services/scope-request-throttle.ts(plugin-fs scope 请求:subject=插件,key=canonical 路径,祖先路径也算命中)
// - services/agent-auth.service.ts(agent 授权:subject=窗口×调用方类别,key=授权域)
//
// - 拒绝冷却:按**单个 key** 记。请求里任一 key 命中(covers)冷却中的被拒 key → 整个请求不弹窗;同一 key 连续
//   被拒指数退避。
// - subject 级退避:同一 subject 连续 PROMPT_SUBJECT_DENY_STREAK 次被拒(不论 key)→ 该 subject 的所有请求进入
//   退避,每多被拒一次翻倍、封顶;用户授予一次计数减 1(不清零、不解除已生效的退避)。
// - 速率上限:同一 subject 单位时间内发出的弹窗数有上限(挡轮换不同 key 的刷屏)。
// - 单飞:同一 subject 同时最多一个未决弹窗。上面三项只看**已落定**的决定:不等结果同步连发 N 次时还没有任何
//   拒绝记录。未决期间的新请求直接拒(不排队、不计拒绝)。

/** 首次被拒后的冷却。 */
export const PROMPT_DENY_COOLDOWN_BASE_MS = 30_000;
/** 连续被拒的冷却上限。 */
export const PROMPT_DENY_COOLDOWN_MAX_MS = 5 * 60_000;
/** 距上次拒绝超过该时长 → 退避级别归零(记录丢弃)。 */
export const PROMPT_DENY_FORGET_MS = 10 * 60_000;
/** 同一 subject 连续被拒这么多次 → subject 级退避(首次 PROMPT_DENY_COOLDOWN_BASE_MS,之后每次被拒翻倍,同一上限)。 */
export const PROMPT_SUBJECT_DENY_STREAK = 3;
/** 每 subject 在 PROMPT_RATE_WINDOW_MS 内最多发出的弹窗数。 */
export const PROMPT_RATE_MAX = 10;
export const PROMPT_RATE_WINDOW_MS = 60_000;
/** 每 subject 记住的被拒 key 数 / 记住的 subject 数上限(超出丢最旧的)。 */
const MAX_DENIED_KEYS_PER_SUBJECT = 64;
const MAX_TRACKED_SUBJECTS = 256;

interface Denied {
  /** 连续被拒次数(决定冷却时长)。 */
  count: number;
  deniedAt: number;
  until: number;
}

interface SubjectState {
  /** key → 拒绝记录。 */
  readonly denied: Map<string, Denied>;
  /** 最近发出的弹窗时刻(升序,只保留窗口内的)。 */
  prompts: number[];
  /** 该 subject 连续被拒次数(任何请求;授予一次减 1)与对应的退避截止时刻。 */
  streak: number;
  lastDeniedAt: number;
  backoffUntil: number;
}

/**
 * admit 的结果。不放行时给出原因与还需等待的时长(in-flight 无法预知 → 0):
 * - in-flight:该 subject 已有未决弹窗
 * - cooldown:某个 key 在拒绝冷却期内,或该 subject 在连续被拒退避期内
 * - rate:弹窗超速
 */
export type PromptAdmission =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'in-flight' | 'cooldown' | 'rate';
      readonly retryAfterMs: number;
    };

const cooldownFor = (level: number): number =>
  Math.min(PROMPT_DENY_COOLDOWN_BASE_MS * 2 ** (level - 1), PROMPT_DENY_COOLDOWN_MAX_MS);

export class PromptThrottle {
  private readonly subjects = new Map<string, SubjectState>();
  /** 有未决弹窗的 subject。独立于 subjects(不随其容量淘汰);大小受调用方的未决请求上限约束。 */
  private readonly inFlight = new Set<string>();

  /**
   * @param covers 请求的 key 是否命中某个被拒 key(默认相等)。scope 请求传「相等或是其祖先路径」。
   */
  constructor(
    private readonly covers: (requested: string, denied: string) => boolean = (a, b) => a === b,
  ) {}

  /**
   * 是否可以为这次请求弹窗。ok → 已计入该 subject 的弹窗速率并标记为在途(调用方随后必须真的弹窗,且弹窗无论以
   * 何种方式收口都必须调 endPrompt);否则调用方直接按 deny 收口。
   */
  admit(subject: string, keys: readonly string[], now: number = Date.now()): PromptAdmission {
    if (this.inFlight.has(subject)) return { ok: false, reason: 'in-flight', retryAfterMs: 0 };
    const state = this.subjects.get(subject);
    if (state) {
      let until = state.backoffUntil;
      for (const [deniedKey, denied] of state.denied) {
        if (now >= denied.until) {
          if (now - denied.deniedAt > PROMPT_DENY_FORGET_MS) state.denied.delete(deniedKey);
          continue;
        }
        if (keys.some((k) => this.covers(k, deniedKey))) until = Math.max(until, denied.until);
      }
      if (now < until) return { ok: false, reason: 'cooldown', retryAfterMs: until - now };
      state.prompts = state.prompts.filter((t) => now - t < PROMPT_RATE_WINDOW_MS);
      if (state.prompts.length >= PROMPT_RATE_MAX) {
        const oldest = state.prompts[0] ?? now;
        return { ok: false, reason: 'rate', retryAfterMs: oldest + PROMPT_RATE_WINDOW_MS - now };
      }
    }
    this.stateFor(subject).prompts.push(now);
    this.inFlight.add(subject);
    return { ok: true };
  }

  /** admit 放行的弹窗已收口(用户决定 / 超时 / 窗口关闭 / 请求方消失 / 发送失败)→ 该 subject 可以再弹。 */
  endPrompt(subject: string): void {
    this.inFlight.delete(subject);
  }

  /**
   * 用户对弹窗的决定。deny → 请求里每个 key 进入冷却(连续被拒翻倍,封顶),subject 连续被拒计数 +1;
   * grant → 清除这些 key(仅这些)的拒绝记录,subject 连续被拒计数 -1。
   */
  noteDecision(
    subject: string,
    keys: readonly string[],
    decision: 'grant' | 'deny',
    now: number = Date.now(),
  ): void {
    const state = this.stateFor(subject);
    if (decision === 'grant') {
      for (const key of keys) state.denied.delete(key);
      // 只减 1、不清零,也不解除已生效的退避:清零的话「拒、拒、(请求一个无害的小范围骗到)允、拒、拒、允…」
      // 计数永远到不了 PROMPT_SUBJECT_DENY_STREAK,subject 级退避形同虚设。
      state.streak = Math.max(0, state.streak - 1);
      return;
    }
    for (const key of new Set(keys)) {
      const count = (state.denied.get(key)?.count ?? 0) + 1;
      this.setDenied(state, key, { count, deniedAt: now, until: now + cooldownFor(count) });
    }
    // 「无拒绝」从退避结束起算:退避期内本来就弹不了窗,不能算作安静。否则退避到上限(5 分钟)后再等 5 分钟
    // 计数即清零,又能从头连弹 PROMPT_SUBJECT_DENY_STREAK 次。
    if (now - Math.max(state.lastDeniedAt, state.backoffUntil) > PROMPT_DENY_FORGET_MS) state.streak = 0;
    state.streak += 1;
    state.lastDeniedAt = now;
    if (state.streak >= PROMPT_SUBJECT_DENY_STREAK) {
      state.backoffUntil = now + cooldownFor(state.streak - PROMPT_SUBJECT_DENY_STREAK + 1);
    }
  }

  /**
   * 弹窗无人应答直到超时。用户不理会 ≠ 拒绝(不升退避级别、不计 subject 连续被拒),但可被用来持续占屏 →
   * 这些 key 进入一次基础冷却(不缩短已有的更长冷却)。
   */
  noteTimeout(subject: string, keys: readonly string[], now: number = Date.now()): void {
    const state = this.stateFor(subject);
    const until = now + PROMPT_DENY_COOLDOWN_BASE_MS;
    for (const key of new Set(keys)) {
      const prev = state.denied.get(key);
      this.setDenied(
        state,
        key,
        prev ? { ...prev, until: Math.max(prev.until, until) } : { count: 0, deniedAt: now, until },
      );
    }
  }

  private setDenied(state: SubjectState, key: string, denied: Denied): void {
    state.denied.delete(key); // 重新插入 → Map 迭代序即最近被拒序,超限时丢最旧的
    state.denied.set(key, denied);
    if (state.denied.size > MAX_DENIED_KEYS_PER_SUBJECT) {
      state.denied.delete(state.denied.keys().next().value as string);
    }
  }

  private stateFor(subject: string): SubjectState {
    let state = this.subjects.get(subject);
    if (!state) {
      if (this.subjects.size >= MAX_TRACKED_SUBJECTS) {
        this.subjects.delete(this.subjects.keys().next().value as string);
      }
      state = { denied: new Map(), prompts: [], streak: 0, lastDeniedAt: 0, backoffUntil: 0 };
      this.subjects.set(subject, state);
    }
    return state;
  }
}
