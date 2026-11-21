// ECMAScript 空白码点判定的跨进程单一来源(重构:此前 renderer blank-string / text-stats /
// CommandRegistry 与 main mcp-stdio-server / mcp-tools-hook-bridge 各持一份同集合副本)。
//
// 集合 = JS 正则 `\s` = String.prototype.trim 剥离的码点(WhiteSpace + LineTerminator):
// \t \n \v \f \r 空格、U+00A0、U+1680、U+2000-200A、U+2028、U+2029、U+202F、U+205F、U+3000、U+FEFF。
// 走 charCodeAt 逐码元判定,避免 trim()/正则在热路径分配子串。

export function isEcmaWhitespaceCode(code: number): boolean {
  if (code <= 0x20) {
    return (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0b ||
      code === 0x0c ||
      code === 0x0d ||
      code === 0x20
    );
  }
  if (code >= 0x2000 && code <= 0x200a) return true;
  return (
    code === 0x00a0 ||
    code === 0x1680 ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** 等价 `value.trim() === ''`,零分配。 */
export function isBlankString(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (!isEcmaWhitespaceCode(value.charCodeAt(i))) return false;
  }
  return true;
}

/** 等价 `value.trim().slice(0, maxLength)`,不物化完整 trim 结果。 */
export function trimStringToMax(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  let start = 0;
  while (
    start < value.length &&
    isEcmaWhitespaceCode(value.charCodeAt(start))
  ) {
    start += 1;
  }
  if (start >= value.length) return '';

  let end = value.length;
  while (end > start && isEcmaWhitespaceCode(value.charCodeAt(end - 1))) {
    end -= 1;
  }

  return value.slice(start, Math.min(end, start + maxLength));
}
