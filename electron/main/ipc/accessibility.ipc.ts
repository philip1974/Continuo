// 系统读屏检测 → renderer(VSCode code/electron-main/app.ts:app.on('accessibility-support-changed') → sendToAll;
// 窗口初值 app.isAccessibilitySupportEnabled())。Continuo 的初值走 GET_SUPPORT(renderer 首次需要时拉取),变化走广播。
// BDD: src/__tests__/terminal-screen-reader/

import { app } from 'electron';
import { z } from 'zod';
import { safeHandle } from '../safe-handle';
import { broadcastToWindows } from '../lib/broadcast';
import {
  ACCESSIBILITY_CHANNELS,
  type AccessibilitySupportChangedPayload,
} from '../../shared/accessibility-channels';

export function registerAccessibilityIpc(): void {
  safeHandle<undefined, boolean>(ACCESSIBILITY_CHANNELS.GET_SUPPORT, z.undefined(), () =>
    app.isAccessibilitySupportEnabled(),
  );
  app.on('accessibility-support-changed', (_event, enabled: boolean) => {
    const payload: AccessibilitySupportChangedPayload = { enabled };
    broadcastToWindows(ACCESSIBILITY_CHANNELS.SUPPORT_CHANGED, () => payload, '[accessibility] SUPPORT_CHANGED');
  });
}
