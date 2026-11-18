import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { FS_PATH_MAX, MAX_SCOPE_PATH_DEPTH, pathDepthExceeds } from '../../shared/fs-limits';
import { fileIdOf, prefixesOf, type FileId } from '../lib/file-identity';
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
// - 冷却键带文件身份(scopeThrottleKeys):同一目录可以有 realpath 不归一的别的路径(macOS 数据卷
//   `/System/Volumes/Data/<绝对路径>`;Linux bind mount;Windows subst)。只按路径字符串记时,被拒后换别名再问即
//   避开单路径冷却。键 = 路径 + 它自身及各级上级的 (dev, ino);尚不存在的各级用「最近已存在上级的身份 + 余下段」的摘要。
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

// 冷却键 = `路径 \0 自身身份 \0 上级身份 …`(身份由深到浅;取不到的那一级略去)。不带身份的纯路径也是合法的键。
const KEY_SEP = '\0';

// 安全:算键的开销与键的大小都有上限。路径是插件给的:入口(validateScopesShape)已限 64 条 × 64 级,这里不依赖
// 入口再限一次 —— 此前逐级 stat 全量并发、缺失的各级逐级拼接「余下各段」(键长是层级数的平方),64 条 × 4081 级的
// 请求让主进程卡死 10s、RSS +2.8GB。
/** 带身份的键最多看这么多级(canonical 化可能比请求写法深:`~` 展开、符号链接);更深的路径只按字符串记。 */
export const SCOPE_KEY_MAX_LEVELS = 2 * MAX_SCOPE_PATH_DEPTH;
/** 一次调用里同时在途的 stat 数(同 canonicalizePathScopes 的 worker 池)。 */
export const SCOPE_KEY_STAT_CONCURRENCY = 16;
// 单个身份的最大长度:已存在的一级 `dev:ino`(两个 u64 十进制)41;缺失的一级 `~` + 32 位十六进制 = 33。
const ID_MAX_CHARS = 41;
/** 单个键的字符数上限(路径 + 每级一个身份);超出退回纯路径键。 */
export const SCOPE_KEY_MAX_CHARS = FS_PATH_MAX + (SCOPE_KEY_MAX_LEVELS + 1) * (ID_MAX_CHARS + 1);

/** 尚不存在的名字的比较形:大小写不敏感的平台(macOS / Windows 默认)折叠大小写与 Unicode 规范化形式。 */
const foldMissingName = (name: string): string =>
  process.platform === 'linux' ? name : name.normalize('NFC').toLowerCase();

/** 缺失的一级的伪身份:由上一级(已存在上级的 dev:ino,或上一级缺失层的伪身份)与本级名字(折叠后)链式摘要,定长。 */
const missingId = (parentId: string, name: string): string =>
  `~${createHash('sha256').update(parentId).update(KEY_SEP).update(foldMissingName(name)).digest('hex').slice(0, 32)}`;

/**
 * 把请求里各 scope 的 canonical 路径变成冷却键(顺序不变)。每条路径自身及各级上级逐级 stat:已存在的一级记
 * `dev:ino`;尚不存在的一级记「最近已存在上级的身份 + 其下各段名字(折叠后)」的链式摘要(每级定长,键长与层级数
 * 成线性)。stat 不了 → 那一级不带身份,仍按路径字符串比较(只会少命中身份这一层,字符串层不变)。
 * 有界:层级数超过 SCOPE_KEY_MAX_LEVELS(或超长)的路径不 stat、只给纯路径键;各路径共有的上级只 stat 一次,
 * stat 经 SCOPE_KEY_STAT_CONCURRENCY 个 worker 发出;单个键不超过 SCOPE_KEY_MAX_CHARS。`statOf` 仅测试注入。
 */
export async function scopeThrottleKeys(
  canonicalPaths: readonly string[],
  statOf: (p: string) => Promise<{ readonly dev: bigint; readonly ino: bigint }> = (p) => stat(p, { bigint: true }),
): Promise<string[]> {
  const chains = canonicalPaths.map((raw) => {
    const path = raw.replaceAll(KEY_SEP, '');
    // 含 NUL(不可能是真实路径)/ 相对路径 / 超长 / 层级过深:只按字符串
    const plain =
      path !== raw ||
      !isAbsolute(path) ||
      path.length > FS_PATH_MAX ||
      pathDepthExceeds(path, SCOPE_KEY_MAX_LEVELS);
    return { path, prefixes: plain ? null : prefixesOf(path) };
  });

  const ids = new Map<string, FileId | null>();
  for (const { prefixes } of chains) for (const p of prefixes ?? []) ids.set(p, null);
  const pending = [...ids.keys()];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const p = pending[next];
      next += 1;
      if (p === undefined) return;
      ids.set(p, await statOf(p).then(fileIdOf, () => null));
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCOPE_KEY_STAT_CONCURRENCY, pending.length) }, worker));

  return chains.map(({ path, prefixes }) => {
    if (prefixes === null) return path;
    const levelIds = prefixes.map((p) => ids.get(p) ?? null);
    const nearest = levelIds.findIndex((id) => id !== null);
    if (nearest === -1) return path;
    // 缺失的各级(nearest 之下):从最近的已存在上级往下逐级链式摘要。
    const identities = levelIds.filter((id, i): id is FileId => i >= nearest && id !== null);
    let parentId: string = levelIds[nearest]!;
    for (let i = nearest - 1; i >= 0; i -= 1) {
      parentId = missingId(parentId, basename(prefixes[i]!));
      identities.unshift(parentId);
    }
    const key = [path, ...identities].join(KEY_SEP);
    return key.length <= SCOPE_KEY_MAX_CHARS ? key : path;
  });
}

export class ScopeRequestThrottle extends PromptThrottle {
  constructor() {
    // 请求路径等于被拒路径、或是它的祖先(把被拒目录包进更大的范围)→ 命中。按路径字符串判一次,再按文件身份
    // 判一次:请求路径自身的身份出现在被拒路径「自身 + 各级上级」的身份里。
    super((requested, denied) => {
      const [requestedPath = '', requestedId] = requested.split(KEY_SEP);
      const [deniedPath = '', ...deniedIds] = denied.split(KEY_SEP);
      return (
        isSameOrInsidePath(requestedPath, deniedPath) ||
        (requestedId !== undefined && deniedIds.includes(requestedId))
      );
    });
  }

  /**
   * 是否可以为这次请求弹窗(canonicalPaths = 请求里各 scope 归一化后的路径,或 scopeThrottleKeys 给出的冷却键)。true → 已计入该插件的弹窗速率并
   * 标记为在途(调用方随后必须真的弹窗,且弹窗无论以何种方式收口都必须调 endPrompt);false(该插件已有未决弹窗 /
   * 在退避期 / 某条路径在拒绝冷却期内 / 弹窗超速)→ 调用方直接按 deny 收口。
   */
  tryPrompt(pluginId: string, canonicalPaths: readonly string[], now: number = Date.now()): boolean {
    return this.admit(pluginId, canonicalPaths, now).ok;
  }

  /**
   * 不看路径就能确定这次请求不会弹窗(该插件已有未决弹窗 / 在退避期 / 弹窗超速)。算冷却键要逐级 stat,调用方在
   * 算之前先问:被节流的请求直接 deny,不触发 stat。false 之后仍须调 tryPrompt。
   */
  blocked(pluginId: string, now: number = Date.now()): boolean {
    return this.blockedRegardlessOfKeys(pluginId, now);
  }
}
