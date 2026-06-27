// 边界(E103,数据完整性):JSON.stringify 不是「可序列化」校验 —— 它**静默改写**非 JSON 值:
// NaN/Infinity → null,undefined/function/symbol 属性被丢弃(只对 BigInt/循环引用才抛)。插件
// saveData({ x: Infinity, y: undefined }) 会表面保存成功、renderer cache 留原值,但重启从磁盘读到
// x:null 且 y 消失 = 持久化数据静默损坏/前后不一致。此 helper 递归校验值确为 JSON 安全:number
// 必须 finite,拒绝 undefined/function/symbol/bigint,数组/对象递归。renderer 预检 + main 兜底共用,
// 拒绝后不写盘、不提交 cache。跨进程单一来源放 electron/shared(renderer 不可 import main)。

// 递归深度上限:防病态深层嵌套对象在递归校验时爆栈(JSON.stringify 自身迭代实现不会爆栈,
// 但本递归会;超限视为非法)。
const MAX_JSON_DEPTH = 256;

// 边界(E183):数组长度上限。此前数组分支用 `value.forEach`,forEach **跳过 sparse array 空洞** →
// `new Array(1e9)`(稀疏,length 1e9 但无实际元素)秒过校验,随后 JSON.stringify 在 renderer/main
// 生成 1e9 个 null 的超大 JSON,绕过「stringify 后按 16MiB cap」的保护(stringify 本身就是 OOM 点)。
// 改为先限 length、再索引循环并拒绝空洞(空洞会被 stringify 成 null = 校验通过但落盘变形)。
const MAX_JSON_ARRAY_LEN = 1_000_000;

// 边界(E285,E254 字符串值对偶):单个 string **值**长度上限。E254 只限对象 **key** 长度,字符串
// **值**(`{value: 'x'.repeat(1e9)}`)此前无任何上限 —— assertJsonValue string 分支直接 return,随后
// 调用方 JSON.stringify(value) 把这个超大字符串再物化一遍(~2× 内存),在「stringify 后按字节 cap」
// (MAX_PLUGIN_DATA_BYTES 16MiB / RESULT_BYTES_MAX 10MiB / SCHEMA_BYTES_MAX 64KiB)生效**之前**就已在
// renderer/main 制造巨大分配甚至 OOM(stringify 本身就是 OOM 点,字节 cap 来不及)。在递归遍历时即对
// 每个字符串值 fail-fast,挡在 stringify 之前。上限取 16MiB code unit = 最大调用方字节 cap
// (MAX_PLUGIN_DATA_BYTES):任一 UTF-16 code unit ≥ 1 UTF-8 字节,故 len > 16Mi ⇒ 字节 > 16MiB ⇒ 必被
// 任一调用方的字节 cap 拒,提前拒不会误伤任何字节 cap 会接受的合法字符串(仅作粗粒度 OOM 预闸,精确
// 字节上限仍由各调用方在其后施加)。导出供单测断言。
export const MAX_JSON_STRING_LEN = 16 * 1024 * 1024; // 16Mi code units(= 最大调用方字节 cap)
// 边界(E184,E183 对象对偶):plain object 自有属性数量上限。此前 object 分支无 key 数上限且
// getOwnPropertySymbols + getOwnPropertyNames + keys + entries **多次全量物化** key 数组 —— 百万 key
// 对象在 stringify 字节上限生效前就在 renderer/main 多次大数组分配/卡顿(E183 的数组 length cap 不覆盖
// 对象宽度)。改为一次 Reflect.ownKeys(覆盖 string+symbol)+ 立即 cap + 单次循环逐 key 校验。
// object key 数上限取 10 万(远超任何真实 plugin data / MCP schema 的对象宽度;每 key 携带字符串键 +
// 值开销,比数组元素更重,故比数组上限更紧;16MiB 字节上限再兜底)。导出供单测断言。
export const MAX_JSON_OBJECT_KEYS = 100_000;
// 边界(E254):单个对象 string key 长度上限。此前只限 key 数量,单个超长 key(如 "x".repeat(1e8))过校验,
// 推迟到 JSON.stringify 才按字节拒 → 先在 renderer/main 制造巨大分配;且错误 path `${path}.${k}` 拼超长
// key 放大错误串本身。超限直接抛(错误消息只含长度数字,不拼 key)。8192 远超任何真实属性名。导出供单测。
export const MAX_JSON_KEY_LEN = 8192;

/**
 * 递归断言 value 为 JSON 安全值,否则抛 Error。
 * JSON 安全 = null / 有限 number / string / boolean / (元素/属性递归安全的)数组/普通对象。
 */
export function assertJsonValue(value: unknown, path = '$', depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(`json nesting too deep at ${path}`);
  }
  if (value === null) return;
  const t = typeof value;
  if (t === 'boolean') return;
  if (t === 'string') {
    // 边界(E285):字符串值长度 fail-fast(错误消息只含长度,不拼字符串本身,避免错误串放大)。
    if ((value as string).length > MAX_JSON_STRING_LEN) {
      throw new Error(
        `string too long (${(value as string).length} > ${MAX_JSON_STRING_LEN}) at ${path}`,
      );
    }
    return;
  }
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`non-finite number at ${path}`);
    }
    return;
  }
  if (
    t === 'undefined' ||
    t === 'function' ||
    t === 'symbol' ||
    t === 'bigint'
  ) {
    throw new Error(`non-JSON value (${t}) at ${path}`);
  }
  if (Array.isArray(value)) {
    // 边界(E183):先限 length(挡稀疏巨数组在 stringify 处 OOM),再**索引循环**(非 forEach)逐位
    // 校验并拒绝空洞(`!(i in value)` = sparse hole → stringify 成 null,落盘变形;forEach 会跳过漏检)。
    if (value.length > MAX_JSON_ARRAY_LEN) {
      throw new Error(
        `array too large (${value.length} > ${MAX_JSON_ARRAY_LEN}) at ${path}`,
      );
    }
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new Error(`sparse array hole at ${path}[${i}]`);
      }
      assertJsonValue(value[i], `${path}[${i}]`, depth + 1);
    }
    return;
  }
  if (t === 'object') {
    // 边界(E136,E103 同族):JSON.stringify 对**非 plain object** 静默改写 —— Date / 带 toJSON 的对象
    // → 字符串,Map/Set/class instance → {}(enumerable own props,丢方法/内部状态)。只递归校验
    // 普通对象(proto === Object.prototype 或 null,即 {} / Object.create(null)),否则「校验通过」
    // 但持久化/返回的是变形数据,调用方以为存的是原值。
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`non-plain object at ${path}`);
    }
    // 边界(E140,E136 深化 / E184 物化收口):plain object 仍可能携带 JSON.stringify 不忠实序列化的
    // 成员 —— (1)symbol key:`{[Symbol()]:x}` stringify 静默丢;(2)非枚举自有属性:stringify 跳过 →
    // 「校验通过」但不会被持久化(也涵盖非枚举的自带 toJSON)。要求 own keys 全为枚举字符串键、无 symbol。
    // E184:一次 Reflect.ownKeys(覆盖 string+symbol)→ 立即 key 数量 cap → 单次循环逐 key 判 symbol/
    // 枚举性并递归值,替代 getOwnPropertySymbols+getOwnPropertyNames+keys+entries 的多次全量物化。
    const obj = value as Record<string, unknown>;
    // 边界(E221,DEFER —— 经 user 定夺 2026-06-26):codex 提议改 for...in 边计数避免 Reflect.ownKeys
    // 全量物化超宽对象 key 数组。**不采纳**,理由:
    //  (1) 不可行:本分支靠 Reflect.ownKeys **看到** symbol key(下方 typeof k === 'symbol' 拒)+ 非枚举
    //      自有属性(下方 !desc.enumerable 拒)来满足 E140/E200 的"拒不忠实序列化成员"契约;for...in **只
    //      枚举 enumerable string key**,看不到 symbol/非枚举 —— JS 无 lazy 枚举它们的方式(getOwnPropertyNames
    //      /getOwnPropertySymbols/Reflect.ownKeys 都全量物化)。改 for...in 会让 symbol/非枚举键静默通过 → 破
    //      E140/E200,且这些是**可达**契约(同进程活对象,插件 saveData / MCP jsonSchema 可传 symbol/非枚举,
    //      不同于 E201 的 post-IPC 已剥离不可达)。
    //  (2) E184 已把此前 getOwnPropertySymbols+getOwnPropertyNames+keys+entries 的多次物化收口为**单次**
    //      Reflect.ownKeys;超 MAX_JSON_OBJECT_KEYS 时该 key 数组立即抛弃(转瞬即逝,非常驻)。
    //  (3) 混合(for...in 预数 + Reflect.ownKeys)只挡"超宽 enumerable key"的常见情形,exotic 的百万非枚举/
    //      symbol(defineProperty 构造)仍走 Reflect.ownKeys 物化,且对每个合法对象双遍历 —— 收益小、代价常驻。
    // 检测 symbol/非枚举(E140/E200 契约)与"零物化"在 JS 中不可兼得;保留单次 Reflect.ownKeys。
    const ownKeys = Reflect.ownKeys(obj);
    if (ownKeys.length > MAX_JSON_OBJECT_KEYS) {
      throw new Error(
        `object too many keys (${ownKeys.length} > ${MAX_JSON_OBJECT_KEYS}) at ${path}`,
      );
    }
    for (const k of ownKeys) {
      if (typeof k === 'symbol') {
        throw new Error(`symbol key in object at ${path}`);
      }
      // 边界(E254):单个 string key 长度上限。错误消息只含长度(不拼 key 本身,避免错误串放大);
      // 此 throw 在递归前,故下方 `${path}.${k}` 的 k 必 ≤ MAX_JSON_KEY_LEN(path 拼接有界)。
      if (k.length > MAX_JSON_KEY_LEN) {
        throw new Error(
          `object key too long (${k.length} > ${MAX_JSON_KEY_LEN}) at ${path}`,
        );
      }
      const desc = Object.getOwnPropertyDescriptor(obj, k);
      if (!desc || !desc.enumerable) {
        throw new Error(`non-enumerable own property in object at ${path}`);
      }
      // 边界(E200,E103/E136 数据完整性族):必须是 data property —— 拒 getter/setter。否则校验读
      // obj[k] 会调 getter 一次,调用方 JSON.stringify(value) 再调一次,getter 可两次返回不同值(校验
      // 看到小 JSON-safe 值,序列化落超大/非 JSON-safe/不同内容)→ 校验↔落盘不一致(TOCTOU)。
      // accessor 描述符无 `value` 字段;data 描述符有。递归校验 desc.value(只求值一次),不读 obj[k]。
      if (!('value' in desc)) {
        throw new Error(`accessor (getter/setter) property in object at ${path}`);
      }
      assertJsonValue(desc.value, `${path}.${k}`, depth + 1);
    }
    return;
  }
  throw new Error(`non-JSON value at ${path}`);
}
