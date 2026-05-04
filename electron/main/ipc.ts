import { app } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import { LayoutSchema, loadLayout, saveLayout } from './persistence';
import { defaultIsTrustedFrame, safeHandle } from './safe-handle';
import { registerFsIpc } from './ipc/fs.ipc';

// layout:read 入参为空(renderer ipcRenderer.invoke 不传第二参 → undefined)
const NoInput = z.undefined();

// popout:open 入参占位 schema,M5 真实现时再扩展 bounds 等字段
const PopoutOpenInput = z
  .object({ panelId: z.string().min(1) })
  .passthrough();

export function registerIpc() {
  const layoutFile = path.join(app.getPath('userData'), 'layout.json');
  const trusted = defaultIsTrustedFrame;

  safeHandle('layout:read', NoInput, () => loadLayout(layoutFile), trusted);

  safeHandle(
    'layout:write',
    LayoutSchema,
    async (json) => {
      // saveLayout 内部还会 LayoutSchema.parse 一次,双重保险,可接受
      await saveLayout(layoutFile, json);
    },
    trusted,
  );

  // M5 真做 popout 时实现;占位时统一抛业务码,renderer 拿到 IpcFail 即可。
  safeHandle(
    'popout:open',
    PopoutOpenInput,
    () => {
      throw Object.assign(new Error('popout:open not implemented yet (M5)'), {
        code: 'POPOUT_NOT_IMPLEMENTED',
      });
    },
    trusted,
  );

  // 资源管理器 fs.* 9 通道(Step 2)
  registerFsIpc();
}
