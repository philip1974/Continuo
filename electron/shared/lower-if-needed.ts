// 「按需小写」跨进程单一来源(重构:此前 renderer 9 处 + main 2 处逐字复制同一函数)。
//
// 热路径(搜索过滤 / hotkey 归一化 / 路径大小写折叠)上绝大多数输入已是小写 ASCII;先扫一遍,
// 只有出现 ASCII 大写(A-Z)或非 ASCII(可能有大小写映射)字符才调 `toLowerCase()`,否则原样
// 返回同一字符串引用(零分配)。结果与 `value.toLowerCase()` 恒等。
export function lowerIfNeeded(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 65 && code <= 90) || code > 127) {
      return value.toLowerCase();
    }
  }
  return value;
}
