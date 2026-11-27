/// <reference types="electron-vite/node" />
// TS / JS 语言服务(转到定义)的 IPC 接线:ts-language:request 走 safeHandle 管线(frame 信任 + zod);发送方须是一个窗口,
// 根取自该窗口的工作区(renderer 不传根,只能查自己窗口打开的文件夹之内的文件)。语言服务进程是 Electron utilityProcess
//(入口 ts-language/ts-language-server 经 electron-vite `?modulePath` 打成独立 chunk),堆上限同 VSCode
// typescript.tsserver.maxTsServerMemory 默认值。webContents 离开(关闭 / 重载 / 崩溃)→ 结束其语言服务进程。
// 逻辑在 services/ts-language.service(可单测),这里只接真实 Electron。
// BDD: src/__tests__/editor-go-to-definition/

import { utilityProcess } from 'electron';
import { z } from 'zod';
import tsServerPath from '../ts-language/ts-language-server?modulePath';
import { safeHandleWithCtx, senderWindowOrThrow } from '../safe-handle';
import { ERROR_CODES } from '../../shared/error-codes';
import { FS_PATH_MAX } from '../../shared/fs-limits';
import {
  TS_CLIENT_ID_MAX,
  TS_DOC_TEXT_MAX,
  TS_DOCS_MAX,
  TS_LANGUAGE_CHANNELS,
  TS_SERVER_MAX_MEMORY_MB,
} from '../../shared/ts-language';
import { getWorkspaceRoot } from '../services/window-workspace-roots.service';
import { makeWcGoneHook } from '../lib/wc-gone-hook';
import { createTsLanguageService, type TsServerChild } from '../services/ts-language.service';

const tsPath = () => z.string().min(1).max(FS_PATH_MAX);
const position = () => z.number().int().min(1).max(10_000_000);

export const tsRequestInputSchema = z
  .object({
    clientId: z.string().min(1).max(TS_CLIENT_ID_MAX),
    docs: z
      .array(
        z
          .object({
            path: tsPath(),
            version: z.number().int().min(0),
            text: z.string().max(TS_DOC_TEXT_MAX).optional(),
          })
          .strict(),
      )
      .max(TS_DOCS_MAX),
    op: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('warmup'), path: tsPath() }).strict(),
      z
        .object({
          kind: z.literal('definition'),
          slot: z.enum(['hover', 'command']),
          path: tsPath(),
          line: position(),
          column: position(),
        })
        .strict(),
    ]),
  })
  .strict();

function spawnTsServer(): TsServerChild {
  const proc = utilityProcess.fork(tsServerPath, [], {
    serviceName: 'Continuo TypeScript Language Service',
    execArgv: [`--max-old-space-size=${TS_SERVER_MAX_MEMORY_MB}`],
    stdio: 'ignore',
  });
  return {
    postMessage: (msg) => proc.postMessage(msg),
    onMessage: (cb) => void proc.on('message', cb),
    onExit: (cb) => void proc.on('exit', cb),
    kill: () => void proc.kill(),
  };
}

export function registerTsLanguageIpc(): void {
  const service = createTsLanguageService({ spawn: spawnTsServer });
  const attachGoneHook = makeWcGoneHook((wcId) => service.dispose(wcId));
  safeHandleWithCtx(TS_LANGUAGE_CHANNELS.REQUEST, tsRequestInputSchema, (input, { event }) => {
    const win = senderWindowOrThrow(event, ERROR_CODES.NO_WINDOW);
    attachGoneHook(event.sender);
    return service.request(event.sender, getWorkspaceRoot(win.id), input);
  });
}
