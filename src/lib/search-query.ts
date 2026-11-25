// 搜索框 query 长度上限(Quick Open / Command Palette 等模糊搜索入口共用)。
//
// 边界(E279):query 不限长时,畸形粘贴超长字符串一次性进 fuzzyFilter —— 对最多数千候选做
// 小写化 + 模糊匹配 = O(results × queryLen) CPU + 大字符串分配,单次 paste 即可卡死 renderer。
// setQuery 处截断到合理上限(真实搜索 query 远短于此);各搜索入口复用同一常量,消漂移。

export const MAX_SEARCH_QUERY_LEN = 1024;

/** 截断 query 到 MAX_SEARCH_QUERY_LEN(超长 paste 防 O(results×queryLen) 放大)。 */
export function clampSearchQuery(q: string): string {
  return q.length > MAX_SEARCH_QUERY_LEN ? q.slice(0, MAX_SEARCH_QUERY_LEN) : q;
}

/**
 * 过滤用的规范化 query:截断上限 + 去首尾空白。各过滤入口(命令面板 / Quick Open / 设置搜索 / 快捷键设置 / 市场)
 * 共用 —— 此前只有一部分 trim,输入 " foo" 时命令面板照常命中、Quick Open(子序列匹配要求路径真有空格)几乎搜不到。
 * 终端搜索要字面匹配,不用它。
 */
export function normalizeSearchQuery(q: string): string {
  return clampSearchQuery(q).trim();
}

/**
 * 正则语法错误信息(合法为 null):查找框正则模式下提示「正则表达式无效」并把这条信息放进 title / 可访问描述
 * (VSCode 查找框弹出 `new RegExp` 的错误信息)。flags 照各查找引擎实际编译用的(如 CodeMirror 带 `u`)。
 */
export function regexSyntaxError(source: string, flags = ''): string | null {
  try {
    new RegExp(source, flags);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
