// 读持久化的会话(explorer.json + 旁挂 explorer-ext.json 合并后的样子,与 main loadExplorer 同一合并逻辑):
// explorer.json 只写 0.2.15 认识的字段,新增字段(windowState / openWindowSeqs / workspaceSnapshots / 编辑器组 / 编码 …)在旁挂文件。
// BDD: src/__tests__/explorer-downgrade-compat/
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  explorerExtFilePath,
  hashExplorerText,
  mergeExplorerExt,
  parseExplorerExt,
} from '../../../electron/main/explorer-downgrade-compat';

/** 合并后的 JSON;explorer.json 不存在 / 写盘中途读到半截时抛(调用方在 poll 里 catch)。 */
export function readPersistedExplorer(userDataDir: string): unknown {
  const file = path.join(userDataDir, 'explorer.json');
  const raw = readFileSync(file, 'utf8');
  const base: unknown = JSON.parse(raw);
  let extText: string;
  try {
    extText = readFileSync(explorerExtFilePath(file), 'utf8');
  } catch {
    return base;
  }
  const ext = parseExplorerExt(extText);
  return ext ? mergeExplorerExt(base, ext, ext.legacyHash === hashExplorerText(raw)) : base;
}
