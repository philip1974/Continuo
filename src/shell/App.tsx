import { useCallback, useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { ThemeProvider } from '@/theme';
import { useThemeBinding } from '@/theme/binding';
import { DockShell } from './dock/DockShell';
import { TerminalSessionsSync } from './dock/TerminalSessionsSync';
import { Splash } from './decor/Splash';
import { ExplorerSidebar } from './ExplorerSidebar';
import { IconSidebar } from './IconSidebar';
import { PopoutHost } from './PopoutHost';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { CommandPalette } from '@/plugins/command-palette/CommandPalette';
import { useCommandPaletteHotkey } from '@/plugins/command-palette/useCommandPaletteHotkey';
import { useCommandHotkeys } from '@/plugins/command-palette/useCommandHotkeys';
import { QuickOpenModal } from '@/plugins/quick-open/QuickOpenModal';
import { useQuickOpenHotkey } from '@/plugins/quick-open/useQuickOpenHotkey';
import { PermissionPrompt } from '@/plugins/permissions/PermissionPrompt';
import { AgentAuthPrompt } from './AgentAuthPrompt';
import { coApp } from '@/plugins/co-app';
import { coApi } from '@/lib/co-api';
import { isPopoutWindow } from '@/lib/popout-mode';
import { pickDroppedDirectory } from '@/lib/window-drop';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { NotifyIpcBridge } from '@/notifications/NotifyIpcBridge';
import { ToastViewport } from '@/notifications/ToastViewport';
import { breadcrumb, probeCssLoaded } from '@/lib/diagnostics/breadcrumb';
import { SplashWatchdog } from './decor/SplashWatchdog';

const SPLASH_MIN_MS = 600;

function MainApp() {
  const [layoutReady, setLayoutReady] = useState(false);
  const [splashElapsed, setSplashElapsed] = useState(false);

  // issue #33:App mount + layoutReady 翻 true 各落一条 breadcrumb。
  useEffect(() => {
    breadcrumb({
      event: 'app_mounted',
      workspaceRoot: useWorkspaceStore.getState().root,
      sidebarOpen: useLayoutUiStore.getState().sidebarOpen,
    });
  }, []);
  useEffect(() => {
    if (layoutReady) breadcrumb({ event: 'layout_ready' });
  }, [layoutReady]);

  useEffect(() => {
    const t = setTimeout(() => setSplashElapsed(true), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, []);

  // 全局 ⌘P / Ctrl+P 触发 Quick Open(文件搜索,VSCode 同款)
  useQuickOpenHotkey();
  // 全局 ⌘⇧P / Ctrl+Shift+P 触发命令面板(让位给 Quick Open)
  useCommandPaletteHotkey();
  // 全局 commands 注册的 hotkey 监听 + 派发(M-Plugin v1.6 补漏)
  useCommandHotkeys(coApp.commands);

  // workspace.root 变化 → 通知 main 维护 windowId→root 映射,供 MCP agent
  // terminal_create_session 路径 cwd 回退使用。
  const workspaceRoot = useWorkspaceStore((s) => s.root);
  useEffect(() => {
    coApi.window.notifyRoot(workspaceRoot ?? null).then((res) => {
      if (!res.ok) {
        console.warn('[App] notifyRoot rejected', res.code, workspaceRoot);
      }
    });
  }, [workspaceRoot]);

  // 拖文件夹到当前窗口 → 换 workspace(VSCode 同款,issue #23 衍生 UX)。
  // 文件 drop 暂不处理 — 让 dockview 子区域(editor)自己处理(它有自己的逻辑)。
  // dragover 必 preventDefault,否则浏览器拒绝触发 drop。
  const setRoot = useWorkspaceStore((s) => s.setRoot);
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      // 只对 file drop 类型 prevent — 不影响 internal drag(dockview tab 拖动等)
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      const dt = e.dataTransfer;
      void (async () => {
        const path = await pickDroppedDirectory(
          { files: Array.from(dt.files) },
          (file) => coApi.window.getPathForFile(file),
          async (p) => {
            const r = await coApi.fs.listDir(p);
            return r.ok;
          },
        );
        if (path) setRoot(path);
      })();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [setRoot]);

  const onLayoutReady = useCallback(() => setLayoutReady(true), []);
  const showSplash = !(layoutReady && splashElapsed);

  return (
    <>
      <TerminalSessionsSync />
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
      <CommandPalette commands={coApp.commands} />
      <QuickOpenModal />
      <PermissionPrompt />
      <AgentAuthPrompt />
      {showSplash && <Splash />}
      <SplashWatchdog
        layoutReady={layoutReady}
        forceEnter={() => setLayoutReady(true)}
        snapshot={() => ({
          layoutReady,
          workspaceRoot: useWorkspaceStore.getState().root,
          sidebarOpen: useLayoutUiStore.getState().sidebarOpen,
          hasCoApi:
            typeof (globalThis as { window?: { __lmApi?: unknown } }).window
              ?.__lmApi !== 'undefined',
          cssLoaded: probeCssLoaded(),
        })}
      />
    </>
  );
}

// 必须在 ThemeProvider 内才能 useTheme;独立组件持有 useThemeBinding
function ThemeBinder() {
  useThemeBinding();
  return null;
}

export function App() {
  return (
    <ThemeProvider>
      <ThemeBinder />
      <NotificationsProvider>
        <NotifyIpcBridge />
        <ToastViewport />
        <MotionConfig reducedMotion="user">
          {isPopoutWindow() ? <PopoutHost /> : <MainApp />}
        </MotionConfig>
      </NotificationsProvider>
    </ThemeProvider>
  );
}
