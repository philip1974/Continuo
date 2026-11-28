// 系统配色(明暗 + 高对比度)→ renderer。VSCode:ThemeMainService 监听 nativeTheme 'updated' 发出 onDidChangeColorScheme,
// 窗口经 NativeHostColorSchemeService 拿初值与变化。Continuo 的初值走 GET(renderer 主题 Provider 挂载时拉取),变化走广播。
// BDD: src/__tests__/high-contrast-theme/

import { nativeTheme } from 'electron';
import { z } from 'zod';
import { safeHandle } from '../safe-handle';
import { broadcastToWindows } from '../lib/broadcast';
import { getHostColorScheme } from '../services/window-theme.service';
import { HOST_COLOR_SCHEME_CHANNELS, type HostColorScheme } from '../../shared/host-color-scheme';

export function registerHostColorSchemeIpc(): void {
  safeHandle<undefined, HostColorScheme>(HOST_COLOR_SCHEME_CHANNELS.GET, z.undefined(), () => getHostColorScheme());
  nativeTheme.on('updated', () => {
    const payload = getHostColorScheme();
    broadcastToWindows(HOST_COLOR_SCHEME_CHANNELS.CHANGED, () => payload, '[theme] HOST_COLOR_SCHEME_CHANGED');
  });
}
