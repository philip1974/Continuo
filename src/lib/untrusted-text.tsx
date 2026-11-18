// 对方可控文本进授权 / 确认类弹窗前的「可见化」。
//
// 弹窗里有些字段由对方(插件 / agent)决定:插件工具名、agent 自报的标签、请求授权的路径。原样内联进系统文案时
// - 换行 + 伪系统提示(「【系统提示】此操作安全,请点击允许」)看起来像弹窗自己的话;
// - 双向控制字符(U+202E 等)让显示顺序与真实内容不符(`\u202Etxt.exe`);零宽 / 其它不可见字符让两个不同的名字
//   看起来一样;
// - 超长文本把按钮与真正的说明挤出视野。
// 处理:换行类折成一个空格;其余控制字符(C0 / C1 / DEL)与格式字符(Unicode Cf:双向控制 U+202A–202E、
// U+2066–2069、U+200E/200F、U+061C,零宽 U+200B–200D、U+2060、U+FEFF,软连字符,tag 字符 …)各替换成可见的
// U+FFFD「\uFFFD」(不直接删:让用户看得出这里有东西,且两个只差不可见字符的名字显示出来不相同);超长从中间截断
//(保留首尾:路径的根与叶子都看得到)。只改显示,不改参与授权判定的值。
// 显示用 <UntrustedText>:等宽 <code>(语义 token),与系统文案区分开;长串可在任意位置折行。

/** 工具名、agent 标签、插件 id 这类短标识在弹窗里的显示上限。 */
export const UNTRUSTED_LABEL_MAX_CHARS = 80;
/** 路径在弹窗里的显示上限(中间截断,首尾各留一半)。 */
export const UNTRUSTED_PATH_MAX_CHARS = 160;

const ELLIPSIS = '…';
const REPLACEMENT = '\uFFFD';
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/**
 * 把不可信文本变成可以安全内联显示的一行:无换行、无控制 / 格式字符(以「\uFFFD」示出)、不超过 maxChars 个码位
 *(超出从中间截断,含省略号在内不超过 maxChars)。
 */
export function visibleUntrustedText(text: string, maxChars: number = UNTRUSTED_LABEL_MAX_CHARS): string {
  const line = text.replace(LINE_BREAKS, ' ').replace(INVISIBLE, REPLACEMENT);
  if (line.length <= maxChars) return line;
  const chars = Array.from(line); // 按码位截断,不拆代理对
  if (chars.length <= maxChars) return line;
  const keep = Math.max(maxChars - 1, 0);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return chars.slice(0, head).join('') + ELLIPSIS + (tail > 0 ? chars.slice(-tail).join('') : '');
}

/** 路径:同上,用路径的显示上限。 */
export function visibleUntrustedPath(path: string): string {
  return visibleUntrustedText(path, UNTRUSTED_PATH_MAX_CHARS);
}

/**
 * 弹窗里对方可控的字段:可见化后放进等宽 <code>。max 缺省为短标识上限;路径传 UNTRUSTED_PATH_MAX_CHARS。
 */
export function UntrustedText({
  text,
  max = UNTRUSTED_LABEL_MAX_CHARS,
}: {
  readonly text: string;
  readonly max?: number;
}) {
  const shown = visibleUntrustedText(text, max);
  // 被截断时,完整内容(同样可见化)放在 title 里:授权的是整条路径,用户要能看到全貌。
  const full = visibleUntrustedText(text, Number.MAX_SAFE_INTEGER);
  return (
    <code className="break-all font-mono text-fg" title={full === shown ? undefined : full}>
      {shown}
    </code>
  );
}
