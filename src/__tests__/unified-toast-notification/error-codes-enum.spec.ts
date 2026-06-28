// topic-15 unified-toast-notification: shared ERROR_CODES enum and migration static guards. BDD 先行,源实现 Op3-Op11 落地后才会通过。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  FS_ERROR_CODES,
} from '../../../electron/shared/error-codes';
import { mapNodeErrnoCode } from '../../../electron/main/ipc/fs/path-utils';

const ROOT = path.resolve(__dirname, '../../..');

const MAIN_TARGETS = [
  'electron/main/index.ts',
  'electron/main/ipc.ts',
  'electron/main/ipc/terminal.ipc.ts',
  'electron/main/ipc/window.ipc.ts',
  'electron/main/services/plugins.service.ts',
  'electron/main/services/mcp-host.service.ts',
  'electron/main/services/mcp-tools-terminal.ts',
  'electron/main/services/terminal-sessions.service.ts',
] as const;

const FS_TARGETS = [
  'electron/main/ipc/fs/path-utils.ts',
  'electron/main/ipc/fs/read-file.ts',
  'electron/main/ipc/fs/list-dir.ts',
  'electron/main/ipc/fs/create.ts',
  'electron/main/ipc/fs/rename.ts',
  'electron/main/ipc/fs/remove.ts',
  'electron/main/ipc/fs/move-copy.ts',
] as const;

const RENDERER_TARGETS = [
  'src/shell/dock/HeaderActions.tsx',
  'src/core-plugins/TerminalPlugin.ts',
] as const;

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('unified-toast-notification: ERROR_CODES enum', () => {
  it('T9 exposes exactly 45 unique business error code keys', () => {
    expect(Object.keys(ERROR_CODES).sort()).toEqual(
      Array.from(new Set(Object.keys(ERROR_CODES))).sort(),
    );
    // race(R4):+TERMINAL_WRITE_FAILED(34→35),write 真实失败上抛供 renderer 感知。
    // race(R31):+TERMINAL_CREATE_CANCELLED(35→36),create 期间被取消 → kill 孤儿 PTY 并以此收场。
    // 边界(E18):+FS_FILE_TOO_LARGE(36→37),readFile 超 64MiB 拦截。
    // 边界(E30):+FS_DIR_TOO_LARGE(37→38),plugin-fs list-dir 条目数超硬上限拦截。
    // 边界(E230):+TOO_MANY_STREAMS(38→39),流式 shell active 子进程超全局/per-sender 并发上限拦截。
    // 边界(E235):+TOO_MANY_TERMINALS(39→40),终端会话(真实 PTY)超全局/每窗口数量上限拦截。
    // topic-50:+5 DEBUG_* 业务错误码(40→45),agent MCP debug 工具错误稳定本地化。
    expect(Object.keys(ERROR_CODES)).toHaveLength(46);
    expect(ERROR_CODES.TERMINAL_CWD_UNRESOLVED).toBe(
      'TERMINAL_CWD_UNRESOLVED',
    );
    expect(ERROR_CODES.FS_EEXIST).toBe('FS_EEXIST');
  });

  it('T9b removes raw main code literals and fsError("FS_*") literals from migration targets', () => {
    const hits: string[] = [];
    for (const rel of MAIN_TARGETS) {
      const body = read(rel);
      const matches = body.match(/code:\s*['"][A-Z][A-Z0-9_]*['"]/g) ?? [];
      hits.push(...matches.map((m) => `${rel}: ${m}`));
    }
    for (const rel of FS_TARGETS) {
      const body = read(rel);
      const matches = body.match(/fsError\(\s*['"]FS_[A-Z0-9_]*['"]/g) ?? [];
      hits.push(...matches.map((m) => `${rel}: ${m}`));
    }
    expect(hits).toEqual([]);
  });

  it("T9b removes renderer .code === 'X' business-code comparisons", () => {
    const hits: string[] = [];
    for (const rel of RENDERER_TARGETS) {
      const body = read(rel);
      const matches =
        body.match(/\.code\s*===\s*['"][A-Z][A-Z0-9_]*['"]/g) ?? [];
      hits.push(...matches.map((m) => `${rel}: ${m}`));
    }
    expect(hits).toEqual([]);
  });

  it('T-FS-IO maps unknown node errno values to FS_ERROR_CODES.FS_IO', () => {
    expect(mapNodeErrnoCode({ code: 'EWHATEVER' })).toBe(
      FS_ERROR_CODES.FS_IO,
    );
  });
});
