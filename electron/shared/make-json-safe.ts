// 把值清洗成 JSON 安全的深拷贝。用于「尽力而为」的 UI 状态持久化(dockview 布局)。
//
// 背景:dockview `api.toJSON()` 在某些瞬时状态(拖拽中 / 零面积 group / 布局未就绪)会产出
// 非有限 `size` 等值。写端的 assertJsonValue(E119)是为**插件数据**设计的硬守卫 —— 一旦发现
// 非 JSON-safe 值就整份**拒写**(BAD_INPUT),导致布局**永远无法落盘**(explorer.json 冻结)。
// 对布局这种「丢个别字段可接受、dockview 恢复时会按窗口尺寸重算 size」的 UI 状态,正确做法是
// 写盘前把非 JSON-safe 值**剔除**,让其余布局正常持久化,而非整份拒绝。
//
// 语义(与 assertJsonValue 的「JSON 安全」定义对齐,且与 JSON.stringify 的丢弃行为一致):
//   - 保留 null / boolean / 有限 number / string
//   - 非有限 number(NaN/±Infinity)、undefined / function / symbol / bigint、非普通对象:
//       · 对象属性 → 删除该键(JSON.stringify 对 undefined 键同此)
//       · 数组元素 → 置 null(保持索引不变,JSON.stringify 对 NaN/undefined 数组元素同此)
//   - 数组 / 普通对象递归处理
//
// ⚠️ 仅用于「个别字段可接受静默丢失」的 UI 状态持久化。**不可**用于插件数据等不容静默丢失的
// 场景 —— 那些仍由 assertJsonValue 硬拒(数据安全优先)。返回被丢弃字段的 path 列表供诊断日志。

const MAX_DEPTH = 256;
const hasOwn = Object.prototype.hasOwnProperty;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function isJsonSafeScalar(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'boolean' || t === 'string') return true;
  if (t === 'number') return Number.isFinite(v);
  return false;
}

/**
 * 返回 input 的 JSON 安全深拷贝 + 被丢弃字段的 path 列表(供诊断)。
 * 见文件头语义说明。纯函数,无副作用。
 */
export function makeJsonSafe(input: unknown): {
  value: unknown;
  dropped: string[];
} {
  const dropped: string[] = [];

  const walk = (
    value: unknown,
    path: string,
    depth: number,
  ): { keep: boolean; value: unknown } => {
    if (depth > MAX_DEPTH) {
      dropped.push(path);
      return { keep: false, value: undefined };
    }
    if (isJsonSafeScalar(value)) return { keep: true, value };
    if (Array.isArray(value)) {
      const out = new Array<unknown>(value.length);
      for (let i = 0; i < value.length; i += 1) {
        const el = value[i];
        const r = walk(el, `${path}[${i}]`, depth + 1);
        out[i] = r.keep ? r.value : null; // 不安全元素 / 洞 → null(保索引,同 JSON.stringify)
      }
      return { keep: true, value: out };
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const k in value) {
        if (!hasOwn.call(value, k)) continue;
        const r = walk(value[k], `${path}.${k}`, depth + 1);
        if (r.keep) out[k] = r.value; // 不安全 → 删键(path 已记录于递归内)
      }
      return { keep: true, value: out };
    }
    // 非有限 number / undefined / function / symbol / bigint / 非普通对象 → 丢弃
    dropped.push(path);
    return { keep: false, value: undefined };
  };

  const root = walk(input, '$', 0);
  return { value: root.keep ? root.value : null, dropped };
}
