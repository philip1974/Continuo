import { useCallback, useEffect, useState } from 'react';
import { LazyMotion, MotionConfig } from 'motion/react';
import { ThemeProvider } from '@/theme';
import { WindowBackgroundSync } from '@/theme/WindowBackgroundSync';
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
import { useExternalFileSync } from '@/panels/Editor/useExternalFileSync';
import { useExternalSyncRootWatch } from '@/panels/Editor/useExternalSyncRootWatch';
import { QuickOpenModal } from '@/plugins/quick-open/QuickOpenModal';
import { OpenRecentModal } from '@/plugins/open-recent/OpenRecentModal';
import { useQuickOpenHotkey } from '@/plugins/quick-open/useQuickOpenHotkey';
import { PermissionPrompt } from '@/plugins/permissions/PermissionPrompt';
import { PluginFailureNotifier } from '@/plugins/PluginFailureNotifier';
import { AgentAuthPrompt } from './AgentAuthPrompt';
import { coApp } from '@/plugins/co-app';
import { coApi } from '@/lib/co-api';
import { isPopoutWindow } from '@/lib/popout-mode';
import {
  resolveDroppedWorkspace,
  captureDropCandidates,
  hasFiles,
  MAX_DROP_FILES,
} from '@/lib/window-drop';
import { workspaceRootSelectionGuard } from '@/lib/workspace-root-guard';
import {
  useWorkspaceStore,
  waitForWorkspaceRootRestored,
} from '@/stores/workspace.store';
import { notifyRootWhenHydrated } from './notify-root-when-hydrated';
import { useMenuCommands } from './menu-commands';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { ToastViewport } from '@/notifications/ToastViewport';
import { LanguageFromSettings } from '@/plugins/settings/LanguageFromSettings';
import { RestoreWindowsFromSettings } from '@/plugins/settings/RestoreWindowsFromSettings';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { switchToCheckedRoot } from '@/panels/Explorer/open-recent-root';

function MainApp() {
  // 性能:Splash 只遮住布局恢复期,布局就绪即移除(此前另有 600ms 最短展示,布局 80ms 就绪也要
  // 再白等 ~500ms 才可交互)。
  // onLayoutReady 由 DockShell 在「布局恢复 + 终端首个快照已 reconcile」后报(事件式屏障,带安全上限)。
  const [layoutReady, setLayoutReady] = useState(false);

  // 全局 ⌘P / Ctrl+P 触发 Quick Open(文件搜索,VSCode 同款)
  useQuickOpenHotkey();
  // 全局 ⌘⇧P / Ctrl+Shift+P 触发命令面板(让位给 Quick Open)
  useCommandPaletteHotkey();
  // 全局 commands 注册的 hotkey 监听 + 派发(M-Plugin v1.6 补漏)
  useCommandHotkeys(coApp.commands);
  // 应用菜单项即命令(文件 → 打开文件夹… ⌘O):main 请求本窗执行
  useMenuCommands(coApp.commands);
  // 外部文件同步挂在常驻 MainApp(每窗口一次),不放在懒加载的 EditorPanel:打开文件到 Editor chunk
  // 挂载之间的外部修改否则会因订阅尚不存在而永久漏掉。hook 只依赖 editor store + coApi.fs。
  useExternalFileSync();
  // 同步所需的 workspace root watcher 不绑在可见文件树上(侧栏启动即关闭时文件树不挂载、不装 watcher)。
  useExternalSyncRootWatch();

  // workspace.root 变化 → 通知 main 维护 windowId→root 映射,供 MCP agent
  // terminal_create_session 路径 cwd 回退使用。
  // race(R46):initExplorerPersistence 是 fire-and-forget,首帧 root=null(hydrate 未完成)。若
  // 立即 notifyRoot(null) 写进 main 的 window→root map,hydrate 前 MCP/agent 建终端(未显式传 cwd)
  // 会从空 map 回退成无 workspaceRoot 的全局终端 / 错误 cwd。门控:等 root 恢复
  //(waitForWorkspaceRootRestored;只需 root,不等编辑器 tab 恢复读盘)再推,且 await 后读**最新** root
  //(getState)而非首帧捕获值。恢复后该 Promise 立即 resolve,正常 root 变更无延迟。renderer 自身新建
  // 终端用同一门控(createUserTerminal)。
  const workspaceRoot = useWorkspaceStore((s) => s.root);
  useEffect(() => {
    let cancelled = false;
    void notifyRootWhenHydrated({
      waitHydrated: waitForWorkspaceRootRestored,
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
      // 边界(E118,E114 残留 + E116 同款):同步有界捕获 dt.files(最多 MAX_DROP_FILES 个,
      // 即 pickDroppedDirectory 的探测上限),不在调用点全量 Array.from 物化超大 FileList;
      // 且同步捕获避免进入 async 后 DataTransfer.files 失效。
      // 性能:webkitGetAsEntry 已能判定时只探测目录(纯文件拖入零 listDir IPC),否则回退全量探测。
      const { files: droppedFiles, hadDirectory } = captureDropCandidates(dt, MAX_DROP_FILES);
      const isLatest = workspaceRootSelectionGuard.begin(); // race(R18→R27):标记本次 root 选择为最新(全窗口共享守卫)
      void (async () => {
        try {
          const result = await resolveDroppedWorkspace(
            { files: droppedFiles },
            hadDirectory,
            (file) => coApi.window.getPathForFile(file),
            // perf:目录探测只看 ok → withStats:false,main 不逐项 lstat。
            (p) => coApi.fs.listDir(p, { withStats: false }),
          );
          // 期间有更新的 drop 发起 → 本次为过期请求,丢弃(不 setRoot 不反馈),由最新 drop 负责。
          if (!isLatest()) return;
          if (result.kind === 'open') {
            // 已在别的窗口打开 → 聚焦那个窗口、本窗口不变;否则切换并把焦点交给新文件树(焦点在侧栏 / 已丢失时;同最近打开)。
            await switchToCheckedRoot(result.path, isLatest, setRoot);
          }
          else if (result.kind === 'error') {
            notifyFailure(result);
          }
        } catch (err) {
          if (!isLatest()) return;
          notifyThrownError(err);
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
  const showSplash = !layoutReady;

  return (
    <>
      <TerminalSessionsSync />
      <RestoreWindowsFromSettings />
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
      <OpenRecentModal />
      <PermissionPrompt />
      <AgentAuthPrompt />
      {/* 插件激活 / 渲染失败主动 error 通知(BDD: plugin-failure-notify) */}
      <PluginFailureNotifier />
      {showSplash && <Splash />}
    </>
  );
}

// 首屏包体积:组件统一用轻量 m.*,完整特性集 domMax(动画 / 手势 / 拖拽 / layout,~115KB)异步加载,
// 不进 main-app 静态图。layoutId(SharedTab 标题 / 指示条飞行)需要 layout 特性,故用 domMax 而非
// domAnimation。strict:残留 motion.* 会在渲染时直接报错。特性加载完成前 m.* 按 initial 渲染,
// 动画晚一帧开始。模块求值即开始加载(不等首次 commit 后 LazyMotion 的 effect),与首屏渲染并行。
const motionFeatures = import('./motion-features').then((mod) => mod.domMax);
const loadMotionFeatures = () => motionFeatures;

export function App() {
  return (
    <ThemeProvider>
      <WindowBackgroundSync />
      <LanguageFromSettings />
      <NotificationsProvider>
        <ToastViewport />
        <LazyMotion features={loadMotionFeatures} strict>
          <MotionConfig reducedMotion="user">
            {isPopoutWindow() ? <PopoutHost /> : <MainApp />}
          </MotionConfig>
        </LazyMotion>
      </NotificationsProvider>
    </ThemeProvider>
  );
}
