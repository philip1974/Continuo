import { useCallback, useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { ThemeProvider } from '@/theme';
import { DockShell } from './dock/DockShell';
import { Splash } from './decor/Splash';
import { ExplorerSidebar } from './ExplorerSidebar';
import { IconSidebar } from './IconSidebar';
import { PopoutHost } from './PopoutHost';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { CommandPalette } from '@/plugins/command-palette/CommandPalette';
import { useCommandPaletteHotkey } from '@/plugins/command-palette/useCommandPaletteHotkey';
import { useCommandHotkeys } from '@/plugins/command-palette/useCommandHotkeys';
import { SettingsModal } from '@/plugins/settings/SettingsModal';
import { PermissionPrompt } from '@/plugins/permissions/PermissionPrompt';
import { lmApp } from '@/plugins/lm-app';
import { isPopoutWindow } from '@/lib/popout-mode';

const SPLASH_MIN_MS = 600;

function MainApp() {
  const [layoutReady, setLayoutReady] = useState(false);
  const [splashElapsed, setSplashElapsed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSplashElapsed(true), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, []);

  // 全局 ⌘P / Ctrl+P 触发命令面板
  useCommandPaletteHotkey();
  // 全局 commands 注册的 hotkey 监听 + 派发(M-Plugin v1.6 补漏)
  useCommandHotkeys(lmApp.commands);

  const onLayoutReady = useCallback(() => setLayoutReady(true), []);
  const showSplash = !(layoutReady && splashElapsed);

  return (
    <>
      <div className="flex h-dvh w-dvw flex-col bg-canvas text-fg">
        <TitleBar />
        <main className="flex min-h-0 flex-1">
          <IconSidebar />
          <ExplorerSidebar />
          <div className="min-w-0 flex-1">
            <DockShell onLayoutReady={onLayoutReady} />
          </div>
        </main>
        <StatusBar />
      </div>
      <CommandPalette commands={lmApp.commands} />
      <SettingsModal settingTabs={lmApp.settingTabs} />
      <PermissionPrompt />
      {showSplash && <Splash />}
    </>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <MotionConfig reducedMotion="user">
        {isPopoutWindow() ? <PopoutHost /> : <MainApp />}
      </MotionConfig>
    </ThemeProvider>
  );
}
