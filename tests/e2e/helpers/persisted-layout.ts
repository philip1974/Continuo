// 读 explorer.json 各窗口段持久化的 dock 布局(layout:write 写入;atomicWriteJson 带缩进写盘,
// 故按解析后的结构断言,不要对原文做子串匹配)。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 返回各窗口段 layout 中全部 panel 的 contentComponent(文件不存在 / 尚无 layout → [])。 */
export function persistedPanelComponents(userDataDir: string): string[] {
  const file = path.join(userDataDir, 'explorer.json');
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return []; // 写盘中途读到半截:按尚无布局处理,由调用方轮询
  }
  const windows = (parsed as { windows?: unknown }).windows;
  if (!Array.isArray(windows)) return [];
  const out: string[] = [];
  for (const w of windows) {
    const panels = (w as { layout?: { panels?: Record<string, { contentComponent?: unknown }> } }).layout?.panels;
    if (!panels || typeof panels !== 'object') continue;
    for (const p of Object.values(panels)) {
      if (typeof p?.contentComponent === 'string') out.push(p.contentComponent);
    }
  }
  return out;
}
