// 终端拖放文件路径的 shell 引用:在 @continuo-terminal/shell-quote 之上补 Continuo 侧的注入防护。
// (兄弟仓库包不在本仓库修改,这里只做前置处理/包装,其余规则——控制字符拒绝、cmd 不可表示字符——
// 一律委托给 quoteForShell。)
//
// 安全(Q1,fish):posix 族的 `'…'` + `'\''` 拼接对 bash/zsh 正确,但 fish 单引号内 `\'` 与 `\\`
// 仍是转义(fish 文档 "Quotes")。文件名 `a\'; touch pwned #` 被引成 `'…a\'\''; touch pwned #'`,
// fish 把 `\'` 读成字面 `'` 后在下一个 `'` 处闭合 → 回车执行 `touch pwned`。族信息按 PTY 启动 shell
// 判定,用户在 zsh 里再起 fish 时也识别不到,所以不另立 fish 族,而是让 posix 输出对 bash/zsh/fish
// 同时成立:含 `\` 的路径把 `\` 与 `'` 都放到引号外用反斜杠转义(`\\`、`\'`),引号内只剩普通字符。
// 引号段之间从不相邻,不产生 `''`(zsh RC_QUOTES 下 `''` 在引号内表示字面 `'`)。
import { quoteForShell, type ShellFamily } from '@continuo-terminal/shell-quote';

/** 引号内只放普通字符,`\` 与 `'` 放在引号外反斜杠转义:bash/zsh/fish 解析结果一致。 */
function quotePosixPortable(path: string): string {
  return path.replace(/[^\\']+|[\\']/g, (seg) =>
    seg === '\\' || seg === "'" ? `\\${seg}` : `'${seg}'`,
  );
}

function quoteOne(
  path: string,
  family: ShellFamily,
): { ok: true; quoted: string } | { ok: false; reason: string } {
  const r = quoteForShell(path, family);
  if (!r.ok) return r;
  if (family === 'posix' && path.includes('\\')) {
    return { ok: true, quoted: quotePosixPortable(path) };
  }
  return r;
}

/** 与 shell-quote 的 quotePaths 同形:逐项引用,失败项进 skipped。 */
export function quoteDropPaths(
  paths: readonly string[],
  family: ShellFamily,
): { quoted: string[]; skipped: Array<{ path: string; reason: string }> } {
  const quoted: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const path of paths) {
    const r = quoteOne(path, family);
    if (r.ok) quoted.push(r.quoted);
    else skipped.push({ path, reason: r.reason });
  }
  return { quoted, skipped };
}
