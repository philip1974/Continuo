function isEcmaTrimWhitespaceCode(code: number): boolean {
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

export function isBlankString(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (!isEcmaTrimWhitespaceCode(value.charCodeAt(i))) return false;
  }
  return true;
}

export function trimStringToMax(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  let start = 0;
  while (
    start < value.length &&
    isEcmaTrimWhitespaceCode(value.charCodeAt(start))
  ) {
    start += 1;
  }
  if (start >= value.length) return '';

  let end = value.length;
  while (end > start && isEcmaTrimWhitespaceCode(value.charCodeAt(end - 1))) {
    end -= 1;
  }

  return value.slice(start, Math.min(end, start + maxLength));
}
