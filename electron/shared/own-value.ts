/**
 * 按**自有属性**查普通对象字典;键不是自有属性 → undefined。
 *
 * 字典是 `{}` 字面量 / JSON.parse 结果 / 展开拷贝时,`dict[key]` 会沿原型链命中 Object.prototype 成员:
 * 插件可控的键(命令 id、titleKey、插件 id、设置 id、快捷键主键名)为 `constructor` / `toString` /
 * `hasOwnProperty` / `__proto__` 等时得到函数或对象,下游按 string / record 用 → 渲染期 TypeError 整窗白屏。
 * 凡以外部可控键查字典的位置都走这里(renderer + main 共用)。
 */
export function ownValue<V>(
  dict: Readonly<Record<string, V>>,
  key: string,
): V | undefined {
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

/**
 * 写入自有数据属性。`dict[key] = v` 在 key 为 `__proto__` 时触发 Object.prototype 的 setter:改写 dict 原型
 *(v 为对象)或静默丢弃(v 为原始值),键本身不落入 dict。JSON.parse / JSON.stringify 都把 `__proto__` 当普通
 * 自有键,逐键拷贝 JSON 数据时用这里保持同一语义。
 */
export function setOwnValue<V>(dict: Record<string, V>, key: string, value: V): void {
  if (key === '__proto__') {
    Object.defineProperty(dict, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    dict[key] = value;
  }
}
