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
