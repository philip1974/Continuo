// 去掉文本里的 ANSI 转义序列(CSI `ESC [ … final`、OSC `ESC ] … BEL / ESC \`、其余两字节 `ESC x`)。调试控制台与
// debug.read_output 显示纯文本(被调试程序经 outputCapture:'std' 写到 stdout 的颜色码等不再显示成乱码)。

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.includes('\u001b') || text.includes('\u009b') ? text.replace(ANSI_PATTERN, '') : text;
}
