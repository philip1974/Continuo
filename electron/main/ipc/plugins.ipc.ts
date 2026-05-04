// 插件 IPC(M-Plugin v4.1,主进程端)。
// 扫 userData/plugins/<id>/,读 manifest + main.js + styles.css 通过 IPC 给 renderer。

import { app } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import { PLUGINS_CHANNELS } from '../../shared/plugins-channels';
import {
  listPluginDirs,
  readEnabledIds,
  writeEnabledIds,
} from '../services/plugins.service';

const NoInput = z.undefined();
const WriteEnabledInput = z
  .object({ ids: z.array(z.string()) })
  .strict();

export function registerPluginsIpc(): void {
  const userData = app.getPath('userData');
  const pluginsDir = path.join(userData, 'plugins');
  const trusted = defaultIsTrustedFrame;

  safeHandle(
    PLUGINS_CHANNELS.LIST_DIRS,
    NoInput,
    () => listPluginDirs(pluginsDir),
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.READ_ENABLED,
    NoInput,
    () => readEnabledIds(pluginsDir),
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.WRITE_ENABLED,
    WriteEnabledInput,
    async ({ ids }) => {
      await writeEnabledIds(pluginsDir, ids);
    },
    trusted,
  );
}
