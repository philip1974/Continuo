// POSIX shell 单引号转义:把任意字符串变成恰好一个 shell 词。
//
// 安全:单引号内除 `'` 自身外没有任何特殊字符(`$(…)`、反引号、`"`、`\`、`}`、空白、换行都按字面),
// `'` 用「闭合 → 转义的单引号 → 重开」(`'\''`)表示。用于把宿主侧路径拼进会被 sh / bash / zsh 执行
// (或被用户粘贴进这些 shell)的命令字符串;不要改用双引号——双引号内 `$`、反引号、`\` 仍会展开。

export function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
