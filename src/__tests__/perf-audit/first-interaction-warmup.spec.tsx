// @vitest-environment jsdom
// perf:首次交互预热提前到意图最早可知点。
// ① Explorer 文件行 pointerdown 即预热编辑引擎 chunk(此前要等 click → openFileByPath 才开始拉
//    ~650KB CodeEditor / ~729KB Milkdown);共享 loader 去重、失败不缓存,从不打开文件的会话不受影响。
// ② 终端意图预热同时加载捆绑字体 MesloLGS NF(仅终端使用,此前首个 term.open 才开始加载/解码,
//    xterm 6 不在字体加载完后重测 → 首个终端按回退字体测量 cell)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadEditorPanelModule: vi.fn(() => Promise.resolve({})),
  loadCodeEditorModule: vi.fn(() => Promise.resolve({})),
  loadMilkdownEditorModule: vi.fn(() => Promise.resolve({})),
  preloadCodeEditorEngine: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../panels/Editor/editor-engine-loaders', () => h);
vi.mock('@/panels/Terminal/TerminalPanelView', () => ({}));

import { warmEditorEngineFor } from '../../panels/Editor/editor-file-actions';
import { preloadTerminalPanelChunk } from '../../lib/terminal-chunk-warmup';

const src = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf8');

afterEach(() => {
  for (const fn of Object.values(h)) fn.mockClear();
});

describe('首次交互预热', () => {
  it('warmEditorEngineFor 已导出:代码文件预热 Editor 面板 + CodeEditor', () => {
    warmEditorEngineFor('/w/a.ts');
    expect(h.loadEditorPanelModule).toHaveBeenCalledTimes(1);
    expect(h.loadCodeEditorModule).toHaveBeenCalledTimes(1);
    expect(h.loadMilkdownEditorModule).not.toHaveBeenCalled();
  });

  it('Explorer 文件行 pointerdown 时(非目录、非重命名)触发 onFileIntent,FolderTree 接 warmEditorEngineFor', () => {
    const row = src('panels/Explorer/FileRow.tsx');
    expect(row).toMatch(/onPointerDown=\{\(e\) => \{[\s\S]*?if \(!isDir && !isRenaming\) onFileIntent\?\.\(data\.path\)/);
    expect(src('panels/Explorer/FolderTree.tsx')).toMatch(/onFileIntent=\{warmEditorEngineFor\}/);
  });

  it('终端意图预热同时加载 MesloLGS NF 字体;document.fonts 缺失不抛', () => {
    const load = vi.fn(() => Promise.resolve([]));
    Object.defineProperty(document, 'fonts', { value: { load }, configurable: true });
    preloadTerminalPanelChunk();
    expect(load).toHaveBeenCalledWith(expect.stringContaining('"MesloLGS NF"'));
    Object.defineProperty(document, 'fonts', { value: undefined, configurable: true });
    expect(() => preloadTerminalPanelChunk()).not.toThrow();
  });
});
