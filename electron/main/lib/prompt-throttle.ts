// 安全:授权弹窗节流的通用实现(主进程内存,数量有上限)。被用户拒绝后没有冷却时,请求方可在拒绝后立刻再问,
// 弹窗关一个来一个,直到用户误点「允许」。使用方:
// - services/scope-request-throttle.ts(plugin-fs scope 请求:subject=插件,key=canonical 路径,祖先路径也算命中)
// - services/agent-auth.service.ts(agent 授权:subject=窗口×调用方类别,key=授权域)
//
// - 拒绝冷却:按**单个 key** 记。请求里任一 key 命中(covers)冷却中的被拒 key → 整个请求不弹窗;同一 key 连续
//   被拒指数退避。
// - subject 级退避:同一 subject 连续 PROMPT_SUBJECT_DENY_STREAK 次被拒(不论 key)→ 该 subject 的所有请求进入
//   退避,每多被拒一次翻倍、封顶;用户授予一次计数减 1(不清零、不解除已生效的退避)。
// - 超时冷却:弹窗无人应答直到超时 → 该 subject **所在超时组**的所有请求进入冷却,连续超时翻倍、封顶;用户对组内
//   任一弹窗作出决定后连续超时计数归零。不算拒绝(不升拒绝退避、不计连续被拒)。超时组由构造参数 timeoutGroupOf
//   给出,默认即 subject 自身;agent 授权按窗口分组(同窗口的窗口内 agent 与 external 共用,见 agent-auth.service)。
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

interface TimeoutState {
  /** 该超时组连续无人应答超时的次数(组内任一用户决定归零)与对应的冷却截止时刻。 */
  timeouts: number;
  lastTimeoutAt: number;
  timeoutUntil: number;
}

/**
 * admit 的结果。不放行时给出原因与还需等待的时长(in-flight 无法预知 → 0):
 * - in-flight:该 subject 已有未决弹窗
 * - cooldown:某个 key 在拒绝冷却期内,或该 subject 在连续被拒退避期 / 超时冷却期内
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
  /** 超时组 → 超时冷却状态(数量上限同 subjects,超出丢最旧的)。 */
  private readonly timeoutGroups = new Map<string, TimeoutState>();

  /**
   * @param covers 请求的 key 是否命中某个被拒 key(默认相等)。scope 请求传「相等或是其祖先路径」。
   * @param timeoutGroupOf subject 所属的超时组(默认 subject 自身)。组内共用超时冷却与连续超时计数。
   */
  constructor(
    private readonly covers: (requested: string, denied: string) => boolean = (a, b) => a === b,
    private readonly timeoutGroupOf: (subject: string) => string = (subject) => subject,
  ) {}

  /** 该 subject 所在超时组的冷却截止时刻(无记录 → 0)。 */
  private timeoutUntil(subject: string): number {
    return this.timeoutGroups.get(this.timeoutGroupOf(subject))?.timeoutUntil ?? 0;
  }

  /**
   * 是否可以为这次请求弹窗。ok → 已计入该 subject 的弹窗速率并标记为在途(调用方随后必须真的弹窗,且弹窗无论以
   * 何种方式收口都必须调 endPrompt);否则调用方直接按 deny 收口。
   */
  admit(subject: string, keys: readonly string[], now: number = Date.now()): PromptAdmission {
    if (this.inFlight.has(subject)) return { ok: false, reason: 'in-flight', retryAfterMs: 0 };
    let until = this.timeoutUntil(subject);
    const state = this.subjects.get(subject);
    if (state) {
      until = Math.max(until, state.backoffUntil);
      for (const [deniedKey, denied] of state.denied) {
        if (now >= denied.until) {
          if (now - denied.deniedAt > PROMPT_DENY_FORGET_MS) state.denied.delete(deniedKey);
          continue;
        }
        if (keys.some((k) => this.covers(k, deniedKey))) until = Math.max(until, denied.until);
      }
    }
    if (now < until) return { ok: false, reason: 'cooldown', retryAfterMs: until - now };
    if (state) {
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

  /**
   * 不看 key 就能确定 admit 会拒绝:该 subject 已有未决弹窗 / 在连续被拒退避期或超时冷却期 / 弹窗超速。只读,
   * 不记账。给「算 key 本身有开销」的调用方(scope 请求的冷却键要逐级 stat)在算 key 之前先问一次 —— 被节流的
   * 请求不该再触发那份开销;false 之后仍须照常调 admit(key 级冷却只有它能判,且两者之间状态可能变化)。
   */
  blockedRegardlessOfKeys(subject: string): boolean {
    const now = Date.now();
    if (this.inFlight.has(subject)) return true;
    if (now < this.timeoutUntil(subject)) return true;
    const state = this.subjects.get(subject);
    if (!state) return false;
    if (now < state.backoffUntil) return true;
    let recent = 0;
    for (const t of state.prompts) if (now - t < PROMPT_RATE_WINDOW_MS) recent += 1;
    return recent >= PROMPT_RATE_MAX;
  }

  /**
   * 计入该 subject 的弹窗速率,但不占在途槽、不记任何决定:请求因目标暂时无法显示弹窗(窗口正在重新加载)被直接
   * 拒绝时用 —— 否则这段时间里的重试不受任何限制,目标恢复后积压的重试可以连弹。
   */
  noteAttempt(subject: string): void {
    const now = Date.now();
    const state = this.stateFor(subject);
    state.prompts = state.prompts
      .filter((t) => now - t < PROMPT_RATE_WINDOW_MS)
      .slice(-(PROMPT_RATE_MAX - 1));
    state.prompts.push(now);
  }

  /** admit 放行的弹窗已收口(用户决定 / 超时 / 窗口关闭 / 请求方消失 / 发送失败)→ 该 subject 可以再弹。 */
  endPrompt(subject: string): void {
    this.inFlight.delete(subject);
  }

  /**
   * 用户对弹窗的决定。deny → 请求里每个 key 进入冷却(连续被拒翻倍,封顶),subject 连续被拒计数 +1;
   * grant → 清除这些 key(仅这些)的拒绝记录,subject 连续被拒计数 -1。两者都把该 subject 所在超时组的连续超时
   * 计数归零(用户在场;已生效的超时冷却不解除)。
   */
  noteDecision(
    subject: string,
    keys: readonly string[],
    decision: 'grant' | 'deny',
    now: number = Date.now(),
  ): void {
    const group = this.timeoutGroups.get(this.timeoutGroupOf(subject));
    if (group) group.timeouts = 0;
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
   * 弹窗无人应答直到超时。用户不理会 ≠ 拒绝(不升拒绝退避、不计 subject 连续被拒),但可被用来持续占屏 →
   * 该 subject 所在超时组的**所有** subject、所有 key 进入冷却:首次 PROMPT_DENY_COOLDOWN_BASE_MS,连续超时(组内
   * 合并计数)翻倍,上限同拒绝冷却。不按 key 记:轮换 key(授权域)即可绕开;按组而非单个 subject 记:组内多个
   * subject 交替只发起不应答,各自的冷却期由另一个的弹窗填满。
   */
  noteTimeout(subject: string): void {
    const now = Date.now();
    const groupKey = this.timeoutGroupOf(subject);
    let state = this.timeoutGroups.get(groupKey);
    if (!state) {
      if (this.timeoutGroups.size >= MAX_TRACKED_SUBJECTS) {
        this.timeoutGroups.delete(this.timeoutGroups.keys().next().value as string);
      }
      state = { timeouts: 0, lastTimeoutAt: 0, timeoutUntil: 0 };
      this.timeoutGroups.set(groupKey, state);
    }
    // 「无超时」同样从冷却结束起算(理由同 noteDecision 的连续被拒计数)。
    if (now - Math.max(state.lastTimeoutAt, state.timeoutUntil) > PROMPT_DENY_FORGET_MS) state.timeouts = 0;
    state.timeouts += 1;
    state.lastTimeoutAt = now;
    state.timeoutUntil = Math.max(state.timeoutUntil, now + cooldownFor(state.timeouts));
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
      state = {
        denied: new Map(),
        prompts: [],
        streak: 0,
        lastDeniedAt: 0,
        backoffUntil: 0,
      };
      this.subjects.set(subject, state);
    }
    return state;
  }
}
