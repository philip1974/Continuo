// 终端本地文件链接的路径解析(VSCode TerminalLinkResolver 同款:相对路径按终端 cwd 解析,stat 确认存在才算链接)。
// renderer 从终端输出里识别出候选路径,经 terminal:resolve_links 交给这里;只有**普通文件**(stat.isFile)才返回绝对路径 ——
// 目录 / FIFO / 设备文件(打开会阻塞或无意义)/ 不存在 → null。范围与编辑器打开文件一致(用户主动 ⌘ + 单击,不限工作区内)。
// BDD: src/__tests__/terminal-file-links/

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 单次解析的候选路径数上限(VSCode 每行最多解析 10 个链接)。 */
export const MAX_TERMINAL_LINK_CANDIDATES = 10;

/**
 * 每个候选 → 存在的普通文件的绝对路径,否则 null。`~/` 开头按 home 展开;绝对路径原样;相对路径依次按 bases
 *(终端 cwd、工作区根)解析,取第一个存在的。
 */
export async function resolveTerminalLinkPaths(
  candidates: readonly string[],
  bases: readonly string[],
  home: string,
): Promise<(string | null)[]> {
  return Promise.all(
    candidates.map(async (raw) => {
      for (const abs of absoluteCandidates(raw, bases, home)) {
        if (await isRegularFile(abs)) return abs;
      }
      return null;
    }),
  );
}

function absoluteCandidates(raw: string, bases: readonly string[], home: string): string[] {
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return [path.join(home, raw.slice(1))];
  if (path.isAbsolute(raw)) return [path.resolve(raw)];
  const out: string[] = [];
  for (const base of bases) {
    if (!path.isAbsolute(base)) continue;
    const abs = path.resolve(base, raw);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

async function isRegularFile(abs: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(abs)).isFile();
  } catch {
    return false;
  }
}
