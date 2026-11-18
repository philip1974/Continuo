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
//
// 安全(Q2,PowerShell):PowerShell tokenizer 把 U+2018–U+201B(‘ ’ ‚ ‛)与 ASCII `'` 一样当单引号
// 定界符,shell-quote 只双写 ASCII `'`,文件名 `a’;calc;’.txt` 会被 `’` 提前闭合 → 回车执行 calc。
// 单引号串内「两个连续单引号类字符」= 一个字面量(取第一个),故每个智能单引号原样双写即可保留原字符。
//
// 安全(Q3,Windows 嵌套 shell):族同样按 PTY 启动 shell 判定,PowerShell 终端里进了 cmd(或反之)时识别不到。
// PowerShell 的 `'…'` 在 cmd 中不是引号(`'…x&calc&.txt'` 的 & 直接分隔命令);cmd 的 `"…"` 在 PowerShell 中
// 是可展开串(`"…$(calc).txt"` 被求值,U+201C–U+201E 智能双引号可闭合)。故 Windows 两族的输出须在两者下
// 都不执行命令,与 posix 族「bash/zsh/fish 通用写法」同思路:
//   - 双引号 `"…"`:cmd 双引号内 & | < > ^ ( ) 是字面量,只有 " 切换引号态、% 展开(引号内也展开)、
//     ! 在延迟展开下展开(SS64 cmd "Escape Characters");PowerShell 双引号类串内只有 $(变量/子表达式)、
//     `(转义)与 " U+201C–U+201E(定界)特殊,其余含 ' ‘ ’ 皆字面(about_Quoting_Rules)。故不含
//     " % ! $ ` U+201C–U+201E 的路径用 `"…"` 在两者下都是同一字面参数。
//   - PowerShell 族另保留既有 `'…'`:路径不含 cmd 元字符(& | < > ^)与 " 时,cmd 把它当普通文本,
//     最多值带上引号,不会执行;PowerShell 中单引号串纯字面,$ ` 智能双引号都能保留。! 在 cmd 中只有
//     /V:ON 时于解析之后展开,改变值不造成执行,故此形态允许 !。cmd 的 %X% 在解析**之前**展开;交互模式下
//     未定义变量原样保留,只有已定义变量展开。攻击者只控制文件名与(不可信仓库的)目录名,能影响值的只有由
//     当前目录派生的动态变量 %CD% / %__CD__% / %=<盘符>:% / %CMDCMDLINE%(含 :~n,m 子串 / :a=b 替换后缀)——
//     目录 `x&calc&y` + 文件 `%CD%.txt`,PowerShell 里进 cmd 后拖入 → 展开出 & 即执行。故仅这些变量引用拒绝
//     此形态(再落到双引号形态,含 % 一律拒绝);其它 %(a%20b.pdf、a%20b%20c.pdf、%E4%B8%AD.txt 这类常见下载名)
//     仍允许。残余:用户自设环境变量的值若含 & 等元字符,`%该变量%` 理论上仍可注入,但值不受攻击者控制。
//   - cmd 族不能用 `'…'`(cmd 中值会带上引号);两种形态都不安全的路径一律拒绝(cmd_unrepresentable)。
import { quoteForShell, type ShellFamily } from '@continuo-terminal/shell-quote';

/** 引号内只放普通字符,`\` 与 `'` 放在引号外反斜杠转义:bash/zsh/fish 解析结果一致。 */
function quotePosixPortable(path: string): string {
  return path.replace(/[^\\']+|[\\']/g, (seg) =>
    seg === '\\' || seg === "'" ? `\\${seg}` : `'${seg}'`,
  );
}

/** PowerShell 视作单引号的全部字符:ASCII ' + U+2018–U+201B。 */
const POWERSHELL_SINGLE_QUOTES = /['\u2018-\u201b]/g;

/** cmd 与 PowerShell 双引号内都只当字面量的路径:不含 " % ! $ ` 与 U+201C–U+201E。 */
const WIN_DQ_UNSAFE = /["%!$`\u201c-\u201e]/;
/** PowerShell `'…'` 在 cmd 中仍不执行命令:不含 cmd 元字符与引号切换(% 见文件头 Q3 说明)。 */
const CMD_ACTIVE = /[&|<>^"]/;
/**
 * 由当前目录派生的 cmd 动态变量引用(忽略大小写,可带 `:~n,m` / `:a=b` 后缀):解析前展开,值可能来自
 * 不可信目录名(见文件头 Q3)。其它变量攻击者控制不了值,不在此列。
 */
const CMD_CWD_VAR = /%(?:CD|__CD__|=[A-Za-z]:|CMDCMDLINE)(?::[^%]*)?%/i;

function quoteOne(
  path: string,
  family: ShellFamily,
): { ok: true; quoted: string } | { ok: false; reason: string } {
  const r = quoteForShell(path, family);
  if (!r.ok) return r;
  if (family === 'posix' && path.includes('\\')) {
    return { ok: true, quoted: quotePosixPortable(path) };
  }
  if (family === 'powershell' && !CMD_ACTIVE.test(path) && !CMD_CWD_VAR.test(path)) {
    return { ok: true, quoted: `'${path.replace(POWERSHELL_SINGLE_QUOTES, '$&$&')}'` };
  }
  if (family === 'powershell' || family === 'cmd') {
    if (WIN_DQ_UNSAFE.test(path)) return { ok: false, reason: 'cmd_unrepresentable' };
    return { ok: true, quoted: `"${path}"` };
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
