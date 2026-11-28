// 文件名 / 路径里双向控制、零宽等不可见字符的可见化(纯函数,无 DOM / node 依赖):main 的原生对话框(工作区信任)与
// renderer(src/lib/untrusted-text.tsx 再导出)共用同一份规则。
// BDD: src/__tests__/file-name-invisible-chars/

/** 文件名里要可见化的字符:控制字符(含换行 / Tab)、双向控制、零宽空格 / 连接符 / BOM。ZWNJ / ZWJ(U+200C / 200D)不算:
 * emoji 组合与波斯文 / 印地文等正常文字要用。全是 BMP 单码元。 */
const FILE_NAME_INVISIBLE = /[\p{Cc}؜​‎‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

/**
 * 资源管理器 / tab / Quick Open / 搜索结果 / 确认框里的文件名:上述字符各换成「�」(`‮txt.exe` 不再显示成 `exe.txt`,
 * 只差一个零宽字符的两个名字显示出来也不同)。**逐码元等长替换**:匹配高亮的下标照旧对得上;只改显示,不改实际路径与匹配。
 */
export function revealInvisibleChars(text: string): string {
  return text.replace(FILE_NAME_INVISIBLE, '�');
}
