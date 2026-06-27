import type { z } from 'zod';

// 边界(E185/E186/E187 单一来源):record 型外部输入(env / 权限表等)的**有界早停**校验。此前各处用
// `z.record(...).refine(r => Object.keys(r).length <= MAX)` —— z.record 先 O(N) 全量遍历校验所有条目、
// refine 又 Object.keys 全量物化一次,条目数上限在全量成本之后才生效 → 畸形巨 record 在 main schema
// 校验阶段就 O(N) 卡顿/分配,绕过 MAX 防放大意图。本工厂产出 superRefine 校验器:确认 plain object →
// for-in + hasOwnProperty 早停计数到 maxEntries+1 即拒,同轮校验 key 长度 + 每 value。复杂度
// O(min(N, maxEntries+1)),无 Object.keys/z.record 的额外全量物化。各 record 入口共用,防校验逻辑漂移。

export interface BoundedRecordLimits {
  readonly keyMax: number;
  readonly maxEntries: number;
  /** 每个 value 是否合法(env=string≤上限;权限表=PermissionRecordSchema.safeParse(v).success)。 */
  readonly valueOk: (val: unknown) => boolean;
  /** 错误消息中的 record 名(默认 'record')。 */
  readonly label?: string;
}

export function makeBoundedRecordValidator(
  limits: BoundedRecordLimits,
): (v: unknown, ctx: z.RefinementCtx) => void {
  const { keyMax, maxEntries, valueOk, label = 'record' } = limits;
  return (v, ctx) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      ctx.addIssue({ code: 'custom', message: `${label} 必须是对象` });
      return;
    }
    const obj = v as Record<string, unknown>;
    let count = 0;
    // 边界(E201,DEFER —— 经 user 定夺 2026-06-26):codex 提议用 Reflect.ownKeys/descriptor 拒 symbol key
    // 与 non-enumerable own property。**不采纳**,理由:
    //  (1) 不可达:本校验器全部 3 个消费者(shell.ipc / terminal-create / plugins.ipc)都是 IPC ingress 的
    //      zod schema,在 main 校验**经 structured clone 的对象** —— Electron structured clone 不复制 symbol
    //      key、不复制 non-enumerable own property,故这些属性在校验器运行前就已被剥离。
    //  (2) for...in(仅枚举 enumerable string own key)与所有真实消费者(JSON.stringify / structured clone /
    //      child_process spawn env)的枚举语义一致 —— 三者同样跳过 symbol/non-enumerable,无"校验↔使用"分歧。
    //  (3) codex remedy 抵触 E185 刻意设计:本工厂存在的全部意义是**早停**(达 maxEntries+1 即拒,O(min(N,
    //      maxEntries+1)),不 Object.keys/Reflect.ownKeys 全量物化)。捕获 non-enumerable string key 必须
    //      getOwnPropertyNames 全量物化,直接回退 E185 的防放大。
    // 与 assert-json-value(E140/E200)的区别:那里校验的是同进程内待 JSON.stringify 的活对象(可含 symbol/
    // 非枚举),故须用 Reflect.ownKeys 显式拒;这里是 post-IPC 已净化对象 + 早停契约,语义不同。
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      count += 1;
      if (count > maxEntries) {
        ctx.addIssue({
          code: 'custom',
          message: `${label} 条目超过上限 ${maxEntries}`,
        });
        return; // 早停:不继续遍历超大对象
      }
      if (key.length > keyMax) {
        ctx.addIssue({ code: 'custom', message: `${label} key 超长(> ${keyMax})` });
        return;
      }
      if (!valueOk(obj[key])) {
        ctx.addIssue({ code: 'custom', message: `${label} value 非法` });
        return;
      }
    }
  };
}

export interface EnvBoundedLimits {
  readonly keyMax: number;
  readonly valMax: number;
  readonly maxEntries: number;
}

/** env(string→string record)的有界早停校验,薄封装 makeBoundedRecordValidator。 */
export function makeEnvBoundedValidator(
  limits: EnvBoundedLimits,
): (v: unknown, ctx: z.RefinementCtx) => void {
  return makeBoundedRecordValidator({
    keyMax: limits.keyMax,
    maxEntries: limits.maxEntries,
    valueOk: (val) => typeof val === 'string' && val.length <= limits.valMax,
    label: 'env',
  });
}
