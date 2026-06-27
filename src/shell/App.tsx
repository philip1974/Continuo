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
import {
  resolveDroppedWorkspace,
  captureBoundedFiles,
  hasDirectoryInFirstItems,
  hasFiles,
  MAX_DROP_FILES,
} from '@/lib/window-drop';
import { workspaceRootSelectionGuard } from '@/lib/workspace-root-guard';
import { notify } from '@/notifications/notify';
import { localizeErrorByCode } from '@/lib/localize-error';
import {
  useWorkspaceStore,
  waitForWorkspaceHydrated,
} from '@/stores/workspace.store';
import { notifyRootWhenHydrated } from './notify-root-when-hydrated';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { NotifyIpcBridge } from '@/notifications/NotifyIpcBridge';
import { ToastViewport } from '@/notifications/ToastViewport';
import { LanguageFromSettings } from '@/plugins/settings/LanguageFromSettings';

const SPLASH_MIN_MS = 600;

function MainApp() {
  const [layoutReady, setLayoutReady] = useState(false);
  const [splashElapsed, setSplashElapsed] = useState(false);

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
  // race(R46):initExplorerPersistence 是 fire-and-forget,首帧 root=null(hydrate 未完成)。若
  // 立即 notifyRoot(null) 写进 main 的 window→root map,hydrate 前 MCP/agent 建终端(未显式传 cwd)
  // 会从空 map 回退成无 workspaceRoot 的全局终端 / 错误 cwd。门控:等 waitForWorkspaceHydrated()
  // 再推,且 await 后读**最新** root(getState)而非首帧捕获值。hydrate 后该 Promise 立即 resolve,
  // 正常 root 变更无延迟。renderer 自身新建终端早已用同一门控(createUserTerminal)。
  const workspaceRoot = useWorkspaceStore((s) => s.root);
  useEffect(() => {
    let cancelled = false;
    void notifyRootWhenHydrated({
      waitHydrated: waitForWorkspaceHydrated,
      getRoot: () => useWorkspaceStore.getState().root,
      notifyRoot: (root) => coApi.window.notifyRoot(root),
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  // 拖文件夹到当前窗口 → 换 workspace(VSCode 同款,issue #23 衍生 UX)。
  // 文件 drop 暂不处理 — 让 dockview 子区域(editor)自己处理(它有自己的逻辑)。
  // dragover 必 preventDefault,否则浏览器拒绝触发 drop。
  const setRoot = useWorkspaceStore((s) => s.setRoot);
  // race(R18→R27):workspace 文件夹 drop 的异步解析「最新者胜」守卫 —— 连续拖入 A 后 B,若 B 先
  // resolve setRoot(B),随后 A 的旧 promise resolve 不得再 setRoot(A)(乱序覆盖,打开错误目录,
  // 后续 explorer/layout/editor 持久化基于错误 root)。R27 改用全窗口共享的
  // workspaceRootSelectionGuard:drop 与「打开最近」/ EmptyWorkspace 打开 / ExplorerHeader 切换
  // 互相失效(此前各入口守卫分裂,drop 在途时点 recent 切换后 drop 迟到仍会覆盖)。
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      // 只对 file drop 类型 prevent — 不影响 internal drag(dockview tab 拖动等)。
      // 边界(E224):用共享 hasFiles(早停索引遍历 + 类型守卫),不裸 types.includes('Files')。
      if (hasFiles(e.dataTransfer)) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return; // 边界(E224):共享 hasFiles 早停遍历
      e.preventDefault();
      const dt = e.dataTransfer;
      if (dt === null) return; // 原生 DragEvent.dataTransfer 可空;hasFiles 已隐含非空,显式收窄

      // a11y(A149,A141 同族):同步判断 drop 是否含目录(webkitGetAsEntry 必须在事件回调同步读,
      // 进入 async 后 items 失效)。拖文件夹却打不开(listDir !ok/reject)与「只拖文件(暂不处理)
      // 静默跳过」此前无法区分 → 拖文件夹失败无 toast/live region 反馈。仅在「确实拖了目录」时报。
      // 边界(E114,E176 有界化):仅检查前 MAX_DROP_FILES 个 item,与 pickDroppedDirectory 的探测
      // 上限对齐,防超大拖放在同步 hadDirectory 探测处放大。E176:改用 hasDirectoryInFirstItems 按索引
      // 有界循环,不再 `Array.from(dt.items).slice(...)` 全量物化 DataTransferItemList(与 captureBoundedFiles 同款)。
      const hadDirectory = hasDirectoryInFirstItems(dt.items, MAX_DROP_FILES);
      // 边界(E118,E114 残留 + E116 同款):同步有界捕获 dt.files(最多 MAX_DROP_FILES 个,
      // 即 pickDroppedDirectory 的探测上限),不在调用点全量 Array.from 物化超大 FileList;
      // 且同步捕获避免进入 async 后 DataTransfer.files 失效。
      const droppedFiles = captureBoundedFiles(dt.files, MAX_DROP_FILES);
      const isLatest = workspaceRootSelectionGuard.begin(); // race(R18→R27):标记本次 root 选择为最新(全窗口共享守卫)
      void (async () => {
        try {
          const result = await resolveDroppedWorkspace(
            { files: droppedFiles },
            hadDirectory,
            (file) => coApi.window.getPathForFile(file),
            (p) => coApi.fs.listDir(p),
          );
          // 期间有更新的 drop 发起 → 本次为过期请求,丢弃(不 setRoot 不反馈),由最新 drop 负责。
          if (!isLatest()) return;
          if (result.kind === 'open') setRoot(result.path);
          else if (result.kind === 'error') {
            notify.error(localizeErrorByCode(result.code, result.message), {
              code: result.code,
            });
          }
        } catch (err) {
          if (!isLatest()) return;
          const code = (err as { code?: string })?.code ?? 'EXCEPTION';
          notify.error(localizeErrorByCode(code, (err as Error)?.message ?? code), {
            code,
          });
        }
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
      <LanguageFromSettings />
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
