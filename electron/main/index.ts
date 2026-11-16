import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { isOwnRendererWindowUrl } from './window-open-policy';
import { LAYOUT_CHANNELS, WINDOW_ID_CHANNEL } from '../shared/persistence-channels';
import type {
  HandlerDetails,
  IpcMainEvent,
  MenuItemConstructorOptions,
  WindowOpenHandlerResponse,
} from 'electron';
import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc';
import { loadSettings } from './services/settings.service';
import { getMainT, type MainT } from './i18n';
import { setMenuRebuilder } from './ipc/i18n.ipc';
import {
  allocateWindowSeq,
  defaultExplorerV3,
  ensureWindowEntry,
  loadExplorer,
  migrateExplorerFileToV3,
  pruneLRUClosed,
} from './persistence';
import { EXPLORER_FILE_NAME } from '../shared/explorer-persistence-schema';
import { pickWindowsToRestore } from './services/window-restore.service';
import { pickStartupMode } from './services/startup-mode.service';
import {
  pickArgvFolders,
  isWithinStartupPathLimit,
  MAX_STARTUP_DIRS,
} from './services/cli-args.service';
import { extractProtocolUrl } from './protocol-argv';
import {
  routeProtocolUrl,
  drainOnProtocolReady,
} from './protocol-dispatch';
import {
  clearWindow,
  getActiveSeqs,
  setWindowSeq,
} from './services/window-seq.service';
import { withExplorerFileMutex } from './lib/file-mutex';
import { atomicWriteJson } from './lib/atomic-write';
import { makeWindowResourceCleanup } from './window-resource-cleanup';
import { makeQuitCleanupGuard } from './quit-cleanup-guard';
import { resolveUserDataPath } from './user-data-path';
import { PLUGINS_CHANNELS } from '../shared/plugins-channels';
import { ERROR_CODES } from '../shared/error-codes';
import {
  createMcpHost,
  setMcpRevokers,
  type McpCallCtx,
  type McpHost,
} from './services/mcp-host.service';
import {
  createStdioSocketServer,
  type StdioSocketServer,
} from './services/mcp-stdio-server.service';
import { makeTerminalMcpTools } from './services/mcp-terminal-host';
import type { CreateSessionPtyInput } from './services/mcp-tools-terminal';
import * as terminalSessions from './services/terminal-sessions.service';
import * as termService from './services/terminal.service';
import { makeCreateHandler, setMcpEnvProvider, setStopHookCanceller } from './ipc/terminal.ipc';
import {
  cancelAgentAuthByWindow,
  cancelAllAgentAuth,
  requestAgentAuth,
  setAgentAuthControllerTeardown,
  setMcpHostRef,
} from './services/agent-auth.service';
import { DebugService } from './services/debug.service';
import * as debugSessions from './services/debug-sessions.service';
import { makeDebugMcpTools } from './services/mcp-debug-host';
import { createContinuoMcpEnv } from './services/continuo-terminal-host-adapter';
import { buildClaudeAddCommand, setStdioConfig } from './services/mcp-stdio-config.service';
import {
  createAwaitStopHookTool,
  createHookFileBroker,
  inferRunner,
  installStopHookForSession,
} from './services/mcp-tools-hook-bridge';
import { startPluginMcpIpc } from './ipc/plugin-mcp.ipc';
import {
  defaultIsTrustedFrame,
  isTrustedRendererFileUrl,
  setTrustedRendererFile,
} from './safe-handle';
import {
  buildRendererQuery,
  stripSpikeQuery,
  spikeAllowed,
  installSpikeGate,
  parseDevRendererUrl,
} from './spike-gate';
import { buildCommonWebPreferences } from './continuo-meta-args';
import { isPopoutUrl } from './popout-url';
import {
  askDirtyClose,
  needsDirtyConfirm,
  parseDirtyState,
  parseFlushAck,
  type DirtyCloseChoice,
  type DirtyState,
} from './dirty-close-confirm';
import { releaseFsWatchersForWindow } from './ipc/fs.ipc';
import { cleanupAllShellExecs, isAllowedExternalUrl } from './services/shell.service';
import { cleanupAllShellStreams } from './services/plugin-shell-stream.service';
import { MAX_EXTERNAL_URL_LEN } from './../shared/url-limits';
import { cancelScopeRequestsForWebContents } from './ipc/plugin-fs.ipc';
import { registerDebugViewIpc } from './ipc/debug-view.ipc';
import { DEBUG_VIEW_CHANNELS } from '../shared/debug-view-channels';
import { codedError } from '../shared/error-message';

// 窗口级资源清理器(scope 授权 / fs watcher / agent 授权)。挂在覆盖全窗口的
// browser-window-created(见下),主窗与 dockview popout 子窗一视同仁 —— popout 不走
// createMainWindow,旧实现把三项清理只挂在 createMainWindow 漏了 popout 兄弟入口。
const releaseWindowResources = makeWindowResourceCleanup({
  cancelScopeRequests: cancelScopeRequestsForWebContents,
  releaseFsWatchers: releaseFsWatchersForWindow,
  cancelAgentAuth: cancelAgentAuthByWindow,
});

// autorun delay:Win shell prompt 慢,默认更长。
const AUTORUN_DELAY_MS = process.platform === 'win32' ? 600 : 200;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const PRELOAD = path.join(__dirname, '../preload/index.cjs');
const RENDERER_FILE = path.join(__dirname, '../renderer/index.html');

// dev 与 packaged Continuo.app 必须用不同 userData,否则:
// (a) requestSingleInstanceLock 互踩 → 后启动的 quit;
// (b) <userData>/mcp.sock 会被后者 unlink,冲掉前者正在监听的 socket;
// (c) explorer.json / LevelDB / Cookies 并发写报错。
// 必须在 requestSingleInstanceLock 与任何 getPath('userData') 之前调用。
const resolvedUserDataPath = resolveUserDataPath({
  appDataPath: app.getPath('appData'),
  e2eUserDataDir: app.commandLine.getSwitchValue('user-data-dir'),
  isDev,
  isE2E: process.env['CONTINUO_E2E'] === '1',
});
if (resolvedUserDataPath !== null) {
  app.setPath('userData', resolvedUserDataPath);
}

const LRU_MAX_CLOSED = Infinity;
// flush 结果:'ok' 已 ack / 'save-failed' renderer 报保存失败 / 'still-dirty' flush 后最终脏检查仍有未保存改动 /
// 'timeout' 超时兜底 / 'skipped' 无法 flush 直接放行。
type FlushOutcome = 'ok' | 'save-failed' | 'still-dirty' | 'timeout' | 'skipped';
// 本轮关闭的用户选择:'save' 确认框选「保存」/ 'discard' 选「不保存」/ 'none' 无脏计数未弹框。
type FlushMode = 'save' | 'discard' | 'none';
// 在途 flush 请求,按 requestId 记账(复审:此前按 windowId,单窗关闭与 Cmd+Q 交叉时两次请求互相覆盖,
// 旧请求的 ack 结算新请求 →「不保存」的 ack 被当「保存」成功,保存未完成就退出)。
const pendingFlushAcks = new Map<
  number,
  { readonly windowId: number; readonly done: (outcome: FlushOutcome) => void }
>();
let nextFlushRequestId = 1;
const flushedOnQuit = new Set<number>();
// 关窗 flush 的 ack 等待上限。数据安全(codex 复查 P1):renderer 的 flush-ack 在 DockShell
// 依次 await layout/explorer/autosave 落盘后才发;此超时是**防挂死兜底**(renderer 崩溃/死循环
// 永不 ack 时仍能关窗),但旧值 1s 太短 —— 大 markdown autosave / 慢盘的合法 flush 可能 >1s,
// 超时先 fire → 在 renderer 写完前关窗 → 丢最后编辑。放宽到 10s:远超正常 flush(通常 <100ms),
// 给慢盘充足余量;真正挂死的 renderer 也只多等 9s 才关(罕见、可接受)。ack 一到立即 resolve,
// 不等满超时。webContents 已销毁则立即放行(见 requestWindowFlush)。
export const FLUSH_ACK_TIMEOUT_MS = 10_000;
// 退出清理(flush + PTY 强杀)只跑一次。原实现用 `wins.every(flushedOnQuit)` 兼当
// 守卫,但关掉最后一个窗口触发的 window-all-closed→quit 路径里 wins 已空,
// `[].every()` 恒 true → 提前 return 跳过 cleanupAll(),Linux/Windows 上长任务 PTY
// 孤儿化(window 'closed' 清理走 3s grace timer,进程退出不触发 SIGKILL)。改用独立
// 守卫:无论哪条 quit 路径,cleanupAll() 都在 app.quit() 前 await 一次。见第十三轮 P1-AI。
// 守卫区分 started/finished:清理在途时用户再次 quit 必须继续拦截,不能放行绕过 cleanupAll
// (codex 复审 F1,见 quit-cleanup-guard.ts)。
const quitGuard = makeQuitCleanupGuard();
const debugService = new DebugService();

debugService.setEventSink({
  emit(ownerWindowId, event) {
    const win = BrowserWindow.fromId(ownerWindowId);
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(DEBUG_VIEW_CHANNELS.EVENT, event);
    } catch (err) {
      console.error('[debug-view] event send failed', err);
    }
  },
});

registerDebugViewIpc(debugService);

ipcMain.on(WINDOW_ID_CHANNEL, (event: IpcMainEvent) => {
  // 与 layout:flush-ack / plugin-mcp INVOKE_REPLY 对齐:不受信 frame
  // (被注入的子 frame)拿不到窗口 id。合法 renderer 与 popout 子窗都走
  // file:// / 同源 dev URL → 受信。
  if (!defaultIsTrustedFrame(event.senderFrame)) {
    event.returnValue = 0;
    return;
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  event.returnValue = win?.id ?? 0;
});

ipcMain.on(
  LAYOUT_CHANNELS.FLUSH_ACK,
  (event: IpcMainEvent, windowId: unknown, result?: unknown) => {
    if (!defaultIsTrustedFrame(event.senderFrame)) return;
    if (typeof windowId !== 'number') return;
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!senderWin || senderWin.id !== windowId) return;
    const ack = parseFlushAck(result);
    let entry = ack.requestId === null ? undefined : pendingFlushAcks.get(ack.requestId);
    if (ack.requestId === null) {
      // 兼容不带 requestId 的旧回执:仅当该窗口恰有一个在途请求(无歧义)时接受。
      const mine = [...pendingFlushAcks.values()].filter((e) => e.windowId === windowId);
      if (mine.length === 1) entry = mine[0];
    }
    if (!entry || entry.windowId !== windowId) return;
    // 按回执携带的最终脏态记账(始终携带,含空集合;旧回执只有 remaining)。remaining:flush 后仍有未保存改动
    // (防抖内 autosave 失败 / flush 期间继续输入 / 确认期间别窗变脏),中止本次关闭后再次关闭会看到确认框;
    // 空集合:「保存」后已干净,退出前全局最终检查不再拿旧脏集合误中止(复审)。
    const finalState = ack.state ?? ack.remaining;
    if (finalState) recordDirtyState(senderWin, finalState);
    entry.done(ack.saveFailed ? 'save-failed' : ack.remaining ? 'still-dirty' : 'ok');
  },
);

// 各主窗关窗会丢的脏 tab 计数(renderer 在脏态变化时上报,见 dirty-close-confirm.ts)。
// 受信校验与 FLUSH_ACK 同款:不受信 frame / 解析失败的上报忽略;按 sender 所在窗口记账(不信任 payload 里的 id)。
const dirtyStates = new Map<number, DirtyState>();

ipcMain.on(LAYOUT_CHANNELS.DIRTY_STATE, (event: IpcMainEvent, raw: unknown) => {
  if (!defaultIsTrustedFrame(event.senderFrame)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = parseDirtyState(raw);
  if (!win || !state) return;
  recordDirtyState(win, state);
});

function recordDirtyState(win: BrowserWindow, state: DirtyState): void {
  // 只有 pendingAutoSave(依赖关窗 flush 落盘的 .md)也要记:flush 超时时据此中止关闭(终审 P1)。
  if (state.dirty > 0 || state.pendingAutoSave) dirtyStates.set(win.id, state);
  else dirtyStates.delete(win.id);
  // macOS:关闭按钮显示「有未保存改动」圆点(其它平台无此 API)。
  if (process.platform === 'darwin') win.setDocumentEdited(state.dirty > 0);
}

/**
 * 有脏 tab 的窗口弹确认框(挂在该窗口上);无脏 tab → null(不弹框)。state:确认框告知用户的脏 tab
 * (「保存」时 renderer 只放过其中的 untitled id;退出前全局最终检查据此判断是否超出用户已接受的范围)。
 */
function confirmDirtyClose(
  win: BrowserWindow,
): { readonly state: DirtyState; readonly choice: Promise<DirtyCloseChoice> } | null {
  const state = dirtyStates.get(win.id);
  if (!needsDirtyConfirm(state)) return null;
  return {
    state,
    choice: askDirtyClose(state, getMainT(), (opts) => dialog.showMessageBox(win, opts)),
  };
}

/**
 * 退出前全局最终检查(复审):多窗 Cmd+Q 时 A 已 flush+ACK、等待别窗保存 / 确认期间,用户仍可在 A 里继续编辑,
 * A 不会再被 renderer 最终检查覆盖。用 main 持续接收的脏态上报判断是否超出本轮用户已接受的范围(按 id 身份,
 * 当前脏 id 须是已接受集合的子集;复审:只比数量会被同数量替换绕过):
 * 未弹框 → 不接受任何脏;「保存」→ 只接受确认框告知的 untitled;「不保存」→ 接受确认时的脏 tab。
 * pendingAutoSave(未计入 dirty 的活动 .md)同样按身份检查(见函数内)。
 */
function exceedsAccepted(
  current: DirtyState | undefined,
  mode: FlushMode,
  accepted?: DirtyState,
  flushedPending?: readonly string[],
): boolean {
  if (current === undefined) return false;
  const ok = new Set(
    mode === 'save' ? accepted?.untitledIds : mode === 'discard' ? accepted?.ids : undefined,
  );
  if (current.ids.some((id) => !ok.has(id))) return true;
  // 终审 P1:ACK 之后在活动 .md 输入,防抖触发前该 tab 只进 pendingAutoSave(dirty 仍 0),本轮 flush 已结束、
  // 不会再落盘 → 同样超出接受范围。放过:已接受集合内的 id(「不保存」确认的脏 .md 改归 pendingAutoSave)与
  // flush 请求前已上报的 id(已随本轮 flush 落盘;仅不带 state 的旧回执会让其残留在记账里)。
  const flushed = new Set(flushedPending);
  return (current.pendingAutoSave ?? []).some((id) => !ok.has(id) && !flushed.has(id));
}

/**
 * 本轮 flush 后是否必须中止关闭 / 退出(否则丢改动):
 * - 「保存」:未确认成功(renderer 报失败 / 仍有未保存改动 / 超时无回执 / 请求被跳过)。skipped(renderer
 *   未就绪 / send 抛错)意味着保存根本没执行(复审:此前当成功关闭)。
 * - 未弹框:renderer 最终脏检查报告仍有未保存改动(统一规则,见 DockShell onFlushRequest);或超时无回执且该窗口
 *   最近上报的 pendingAutoSave 非空(终审 P1:未计入确认的活动 .md 靠 flush 落盘,读盘挂起的网络卷上 flush 超时
 *   放行会丢编辑)。pendingAutoSave 为空时超时照常放行 —— renderer 卡死 / 崩溃永不回执时窗口仍能关。
 * - 「不保存」:用户已明确放弃框里列出的文件;只有未列入框的待 autosave .md 仍脏(remaining)/ flush 超时才中止。
 */
function shouldAbortClose(mode: FlushMode, outcome: FlushOutcome, windowId: number): boolean {
  if (mode === 'save') return outcome !== 'ok';
  // 「不保存」只针对确认框列出的文件;待 autosave 的 .md 不在列表里(用户未被告知会丢),其 flush 超时同样
  // 中止。代价:renderer 卡死且恰有待落盘 .md 时窗口关不掉(可强制退出),数据安全优先。
  const pendingAutoSaveTimedOut =
    outcome === 'timeout' && dirtyStates.get(windowId)?.pendingAutoSave !== undefined;
  // 待 autosave 的 .md flush 后仍脏(首次保存失败)→ renderer 回执 remaining(终审 P1),同样中止。
  if (mode === 'discard') return outcome === 'still-dirty' || pendingAutoSaveTimedOut;
  if (outcome === 'still-dirty') return true;
  return pendingAutoSaveTimedOut;
}

// 复审(d):每窗关闭流程代际。单窗关闭流程启动时取号;before-quit 接管窗口时再递增 → 旧流程(如在途的
// 「不保存」关闭)完成时发现已被取代,不再 `flushed = true; win.close()`(否则在退出的「保存」完成前销毁窗口)。
const closeFlowGen = new Map<number, number>();
// 在途单窗关闭流程的复位函数(显示窗口 + 释放关窗守卫)。before-quit 接管时取走,退出中止时立即调用 ——
// 否则被接管窗口仍隐藏、守卫仍在途,要等旧 ACK / 10s 超时才恢复(复审)。
const closeFlowReleases = new Map<number, () => void>();

function bumpCloseFlowGen(windowId: number): number {
  const gen = (closeFlowGen.get(windowId) ?? 0) + 1;
  closeFlowGen.set(windowId, gen);
  return gen;
}

// renderer 已订阅 flush 请求的窗口(DockShell 挂载后经 preload 上报)。没上报过 = 启动中 / 加载失败:
// 此时 renderer 没有任何可落盘的状态,也没人会回 ack,requestWindowFlush 直接放行,不发请求、不等超时。
const flushReadyWindowIds = new Set<number>();

ipcMain.on(LAYOUT_CHANNELS.FLUSH_READY, (event: IpcMainEvent) => {
  if (!defaultIsTrustedFrame(event.senderFrame)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) flushReadyWindowIds.add(win.id);
});

/**
 * mode='save':renderer 先保存所有有路径的脏 tab 再 flush(用户在脏文件确认框选了「保存」)。
 * mode='discard':请求带 discard:true(用户已选「不保存」),renderer 只检查确认时未列入框的待 autosave .md
 * (随请求带 pendingAutoSave)是否仍脏。
 */
function requestWindowFlush(
  win: BrowserWindow,
  mode: FlushMode = 'none',
  accepted?: DirtyState,
): Promise<FlushOutcome> {
  return new Promise((resolve) => {
    const requestId = nextFlushRequestId++;
    let doneCalled = false;
    let timer: NodeJS.Timeout | null = null;
    const done = (outcome: FlushOutcome) => {
      if (doneCalled) return;
      doneCalled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingFlushAcks.delete(requestId);
      resolve(outcome);
    };
    pendingFlushAcks.set(requestId, { windowId: win.id, done });
    // webContents 已销毁 / renderer 还没就绪 → 无法 flush/ack,立即放行(不空等满超时)。
    if (win.webContents.isDestroyed() || !flushReadyWindowIds.has(win.id)) {
      done('skipped');
      return;
    }
    timer = setTimeout(() => done('timeout'), FLUSH_ACK_TIMEOUT_MS);
    try {
      // requestId:renderer 回执原样带回,只结算对应请求。
      // untitledIds:「保存」时确认框告知会丢弃的 untitled id,renderer 只放过这些 id。
      const untitledIds = accepted?.untitledIds ?? [];
      const flag =
        mode === 'save'
          ? { save: true, ...(untitledIds.length > 0 ? { untitledIds: [...untitledIds] } : {}) }
          : mode === 'discard'
            ? {
                discard: true,
                // 确认时未列入框的待 autosave .md:renderer flush 后仍脏(保存失败)→ 回执 remaining,中止关闭。
                ...(accepted?.pendingAutoSave ? { pendingAutoSave: [...accepted.pendingAutoSave] } : {}),
              }
            : {};
      win.webContents.send(LAYOUT_CHANNELS.FLUSH_REQUEST, { windowId: win.id, ...flag, requestId });
    } catch {
      done('skipped');
    }
  });
}

function wireWindowCloseFlush(win: BrowserWindow): void {
  const windowId = win.id; // closed 之后窗口已销毁,提前取 id
  win.on('closed', () => {
    flushReadyWindowIds.delete(windowId);
    dirtyStates.delete(windowId);
    closeFlowGen.delete(windowId);
    closeFlowReleases.delete(windowId);
  });
  let flushed = flushedOnQuit.has(win.id);
  // race(R45):flush 在途守卫。requestWindowFlush 是异步(等 renderer ack / 10s 超时),其间
  // `flushed` 仍为 false;若不挡住,快速重复关窗 / 系统关窗 / app.quit 触发的第二个 close 会再次
  // requestWindowFlush,用同 win.id 覆盖 pendingFlushAcks → renderer 的 ack 只 resolve 最新请求,
  // 旧 promise 干等满超时才放行,且 flush 完成后可能重复 win.close()。
  let flushing = false;
  win.on('close', (event) => {
    // flushedOnQuit 也要查:`before-quit` 路径可能已经 flush 过本窗并写入
    // flushedOnQuit,但本闭包的局部 `flushed` 不会被它更新 —— 只看局部量会让
    // app.quit() 触发 close 时对同一窗口重复 flush(多一次 IPC 往返 + preventDefault
    // 二次阻塞退出)。
    if (flushed || flushedOnQuit.has(win.id)) return;
    event.preventDefault();
    // race(R45):已有 flush 在途 → 只阻止本次关闭,不再发第二个 flush(避免覆盖 pending ack)。
    // 脏文件确认框打开期间同样置 flushing,重复关闭不叠第二个确认框。
    if (flushing) return;
    flushing = true;
    const gen = bumpCloseFlowGen(windowId);
    const release = (): void => {
      flushing = false;
      if (!win.isDestroyed()) win.show();
    };
    closeFlowReleases.set(windowId, release);
    const finish = (): void => {
      if (closeFlowReleases.get(windowId) === release) closeFlowReleases.delete(windowId);
    };
    // 复审(d):本流程已被 before-quit 接管 → 无副作用返回,不置 flushed、不 close(退出继续则由退出关窗;
    // 退出中止则退出流程已调用 release 显示窗口并释放守卫 —— 此处再复位会破坏用户之后发起的新关闭流程)。
    const superseded = (): boolean => closeFlowGen.get(windowId) !== gen;
    const flushAndClose = async (mode: FlushMode, accepted?: DirtyState) => {
      // UX:数据安全 flush 仍在后台完成,但关闭按钮点击后先隐藏窗口,
      // 避免用户看到 10s 兜底窗口内的"无反应"状态。
      try {
        if (!win.isDestroyed()) win.hide();
      } catch {
        // close 竞态下 hide 失败不影响 flush / close 兜底。
      }
      const outcome = await requestWindowFlush(win, mode, accepted);
      if (superseded()) return;
      finish();
      if (shouldAbortClose(mode, outcome, windowId)) {
        // 保存失败 / 未确认 / 仍有未保存改动 → 中止关闭,窗口重新显示(保存失败 renderer 已 toast)。
        release();
        return;
      }
      flushed = true;
      flushedOnQuit.add(win.id);
      win.close();
    };
    const confirm = confirmDirtyClose(win);
    // 无脏 tab:与之前完全一致(同步 hide + 发 flush,不弹框)。
    if (!confirm) {
      void flushAndClose('none');
      return;
    }
    void (async () => {
      const choice = await confirm.choice;
      if (win.isDestroyed() || superseded()) return;
      if (choice === 'cancel') {
        finish();
        flushing = false;
        return;
      }
      await flushAndClose(choice === 'save' ? 'save' : 'discard', confirm.state);
    })();
  });
}

// dockview popout 走 window.open(url),url 默认是当前 renderer URL。
// 同源 → allow + 注入我们的 preload + 安全 webPreferences。
// 外站 → 转交系统浏览器,deny 弹窗。
function windowOpenHandler({ url }: HandlerDetails): WindowOpenHandlerResponse {
  // 边界(E190,E179/E152 同族外链长度):window.open url 的类型/长度前置闸,先于 new URL 解析与
  // shell.openExternal。否则超长 url 让主进程先做大字符串 URL 解析,并可能把巨大 URL 交给系统协议
  // 处理器(绕过 shell.openExternal IPC 的 2048 上限与 Markdown 外链上限)。对齐共享 MAX_EXTERNAL_URL_LEN。
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    url.length > MAX_EXTERNAL_URL_LEN
  ) {
    return { action: 'deny' };
  }
  // 安全 S1:只允许指向本应用自己的 renderer 入口(dev server 同源 / 受信的 renderer 文件,精确 pathname)。
  // 判定与主窗加载方式一致,见 window-open-policy。dev URL 经 parseDevRendererUrl(限长 + total,E304)。
  const allow = isOwnRendererWindowUrl(
    url,
    isDev ? parseDevRendererUrl(process.env['ELECTRON_RENDERER_URL']) : null,
    isTrustedRendererFileUrl,
  );

  if (allow) {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 800,
        height: 600,
        backgroundColor: '#020617',
        // 子窗口用系统默认标题栏:
        //   - 给用户一个明确的可拖区域(主窗口 hiddenInset 把 Continuo 文字
        //     做成可拖,popout 子窗里没有这条,需要原生 titlebar)
        //   - 避免 dockview tab bar 撞 macOS 红绿灯按钮
        webPreferences: buildCommonWebPreferences({
          preload: PRELOAD,
          isPackaged: app.isPackaged,
        }),
      },
    };
  }
  // deny 分支会把任意 URL 交给系统打开 —— `target="_blank"` 锚点点击都走这里
  // (含 marketplace 不受信的 authorUrl / 评论 url)。必须复用 shell.service 的
  // scheme 白名单,否则 `smb://`、自定义协议等非 http(s) URL 会绕过白名单经 OS
  // 协议处理器打开,成为投放面。非白名单 scheme 直接静默 deny。
  if (isAllowedExternalUrl(url)) {
    shell.openExternal(url);
  }
  return { action: 'deny' };
}

interface CreateMainWindowOpts {
  /** issue #23 Phase 1:新窗口直接打开此 workspace,通过 query string 注入. */
  readonly workspace?: string;
  /**
   * issue #23 Phase 2B:windowSeq 标识此窗口在 explorer.json windows[] 中的段。
   * 主窗(冷启动时第一个)硬编码 0;新窗由 IPC handler 从磁盘 nextWindowSeq 算。
   */
  readonly windowSeq: number;
  /**
   * Issue #45:`true` ⇒ this window opens the user-supplied workspace fresh
   * (dock open-file, CLI argv, open-folder-in-new-window IPC). Renderer
   * discards persisted per-window UI / editor for this windowSeq and uses
   * `opts.workspace` as the root. `false` / omitted ⇒ restore from
   * explorer.json segment (workspace query, if any, is fallback only).
   * Forgetting to set this for a true "open new folder" callsite means
   * the user gets the old workspace restored instead — verify against the
   * BDD scenarios at src/__tests__/cold-start-drag-folder/.
   */
  readonly fresh?: boolean;
}

// race(R40/R41):co:// 深链 FIFO 缓冲队列。无就绪窗口期间到达的深链全部入队;每个窗口
// 上报协议监听就绪(PROTOCOL_READY)后都尝试排空,确保「应用无窗口时收到的深链」由下一个创建的
// 窗口消费,而非只挂在 bootstrap 窗口上(声明在 createMainWindow 之前,供其闭包引用)。
const pendingProtocolUrls: string[] = [];
// 已上报协议监听就绪(PROTOCOL_READY)的窗口 webContents。did-finish-load 不算就绪:renderer 要等
// 动态 import main-app + locale IPC 之后才挂 onProtocolUrl 监听。主 frame 重新导航(reload)后作废。
const protocolReadyContents = new WeakSet<object>();

ipcMain.on(PLUGINS_CHANNELS.PROTOCOL_READY, (event: IpcMainEvent) => {
  if (!defaultIsTrustedFrame(event.senderFrame)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win.webContents !== event.sender) return;
  protocolReadyContents.add(win.webContents);
  drainOnProtocolReady(win, PLUGINS_CHANNELS.PROTOCOL_URL, pendingProtocolUrls);
});

export function createMainWindow(opts: CreateMainWindowOpts) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // `hiddenInset` 是 macOS 专属语义(隐藏标题栏但保留内嵌红绿灯按钮);Windows/Linux
    // 上它是未定义行为,可能导致 chrome 显示异常 → 非 darwin 用 'default' 原生标题栏。
    // (Windows/Linux 的自定义 chrome + 窗口控件 overlay 精修留作 follow-up。跨平台审计 P2)
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#020617',
    webPreferences: buildCommonWebPreferences({
      preload: PRELOAD,
      isPackaged: app.isPackaged,
    }),
  });

  const seq = opts.windowSeq;
  setWindowSeq(win.id, seq);
  wireWindowCloseFlush(win);

  win.on('closed', () => {
    clearWindow(win.id);
    // 窗口级资源清理(scope / fs watcher / agent 授权)已移到覆盖全窗口的
    // browser-window-created → releaseWindowResources,主窗与 popout 统一处理。
    // 此处只保留主窗专属的 explorer.json 段落持久化(popout 无 windowSeq 段)。
    const explorerFile = path.join(app.getPath('userData'), EXPLORER_FILE_NAME);
    void withExplorerFileMutex(async () => {
      const payload = (await loadExplorer(explorerFile)) ?? defaultExplorerV3();
      const entry = ensureWindowEntry(payload, seq);
      entry.lastClosedAt = Date.now();
      pruneLRUClosed(payload, LRU_MAX_CLOSED, getActiveSeqs());
      await atomicWriteJson(explorerFile, payload);
    });
  });

  win.webContents.setWindowOpenHandler(windowOpenHandler);

  // 多窗口:opts.workspace + opts.windowSeq 走 query string,renderer
  // parseInitialWorkspace / parseInitialWindowSeq 接收。dev loadURL 与 prod
  // loadFile 都加 query;loadFile 第二参支持 query 字段。
  // [topic 45 spike gate 二道防线]: buildRendererQuery 收集所有 query input;
  // stripSpikeQuery 在 spikeAllowed 拒绝时剥离 spike key (future-proof, P1.3)。
  const baseQuery = buildRendererQuery({
    windowSeq: String(seq),
    workspace: opts.workspace,
    fresh: opts.fresh,
    // opts.spike 当前 callsite 未注入,但 buildRendererQuery 支持 forward;
    // future-proof, 防 packaged spike key 直接绕过第一道 will-navigate gate
  });

  const targetUrl =
    isDev && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : `file://${RENDERER_FILE}`;
  const gateResult = spikeAllowed({
    url: targetUrl,
    argv: process.argv,
    packaged: app.isPackaged,
  });
  const queryParts = stripSpikeQuery(baseQuery, gateResult.allowed);

  // 边界(E299):dev env URL 解析失败(缺失/畸形,开发误配)→ parseDevRendererUrl 返 null,回退 loadFile,
  // 不让 new URL 同步抛崩溃 createMainWindow(应用启动无窗口)。
  const devUrl = isDev ? parseDevRendererUrl(process.env['ELECTRON_RENDERER_URL']) : null;
  if (devUrl) {
    for (const key in queryParts) {
      if (!Object.prototype.hasOwnProperty.call(queryParts, key)) continue;
      devUrl.searchParams.set(key, queryParts[key]!);
    }
    win.loadURL(devUrl.toString());
  } else {
    win.loadFile(RENDERER_FILE, { query: queryParts });
  }

  // race(R41):每个新窗口上报协议监听就绪(PROTOCOL_READY)后都排空协议队列 —— 无就绪窗口期入队的
  // co:// 由「下一个就绪的任意窗口」消费。reload 后旧文档的监听随之失效 → 就绪作废,等新文档重新上报。
  win.webContents.on('did-navigate', () => protocolReadyContents.delete(win.webContents));

  return win;
}

// 给所有新创建的 webContents(包括 dockview popout 的子窗口)装上 windowOpenHandler。
// 这样从 popout 再 popout 也走我们的同一套安全策略。
app.on('web-contents-created', (_evt, contents) => {
  contents.setWindowOpenHandler(windowOpenHandler);
  installSpikeGate(contents, app.isPackaged); // [topic 45 spike gate 第一道] will-navigate + will-frame-navigate
});

// ─────────────────────────────────────────────────────
// Application menu(issue #23 衍生 UX:可见入口)
// macOS 标准 template + File 项加 New Window / Open Folder in New Window…
// 跨平台:Linux/Windows menu 同款 File 项。
// ─────────────────────────────────────────────────────

/** 路径是已存在的目录(不存在 / 无权限 / 非目录 → false)。argv / open-file / 冷启动目录判定共用。 */
function isDirectorySync(p: string): boolean {
  try {
    return nodeFs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 开一个新主窗:分配新的 windowSeq;给了 workspace 则以它为 root 且 fresh(用户显式打开,不沿用该
 * seq 的历史持久化段),不给则是空白新窗。菜单 / Dock 菜单 / argv / open-file / 冷启动多目录共用。
 */
async function openWorkspaceWindow(workspace?: string): Promise<void> {
  const explorerFile = path.join(app.getPath('userData'), EXPLORER_FILE_NAME);
  const windowSeq = await allocateWindowSeq(explorerFile);
  if (workspace === undefined) createMainWindow({ windowSeq });
  else createMainWindow({ windowSeq, workspace, fresh: true });
}

async function openFolderInNewWindow(): Promise<void> {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled || r.filePaths.length === 0) return;
  await openWorkspaceWindow(r.filePaths[0]!);
}

async function newWindow(): Promise<void> {
  await openWorkspaceWindow();
}

function buildAppMenu(t: MainT): Menu {
  const isMac = process.platform === 'darwin';
  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: t('menu.file.new_window'),
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => {
        void newWindow();
      },
    },
    {
      label: t('menu.file.open_folder_in_new_window'),
      click: () => {
        void openFolderInNewWindow();
      },
    },
    { type: 'separator' },
    isMac ? { role: 'close' } : { role: 'quit' },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { label: t('menu.file.label'), submenu: fileSubmenu },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  return Menu.buildFromTemplate(template);
}

/** macOS dock 右键菜单(locale 依赖)。启动 + setLocale 后都要(重)建,否则切语言
 * 后 dock 菜单标签永久停留旧语言。Linux/Windows 无 dock 跳过。 */
function setDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const t = getMainT();
  app.dock.setMenu(
    Menu.buildFromTemplate([
      {
        label: t('menu.file.new_window'),
        click: () => {
          void newWindow();
        },
      },
      {
        label: t('menu.file.open_folder_in_new_window'),
        click: () => {
          void openFolderInNewWindow();
        },
      },
    ]),
  );
}

/** 由 i18n.ipc setMenuRebuilder 注册；setLocale 后被调，整体重建 application menu + dock menu。 */
function rebuildAppMenu(): void {
  if (process.env['CONTINUO_E2E'] === '1') return;
  Menu.setApplicationMenu(buildAppMenu(getMainT()));
  setDockMenu();
}

function isReloadKey(key: string): boolean {
  return key === 'r' || key === 'R' || key === 'F5';
}

// popout 子窗口禁止刷新。
// 原因:dockview 用 portal 把 panel 注到子窗 body,reload 清空 portal 目标
// 但 main 端 dockview state 还在 → 子窗黑屏。
// did-start-navigation 是 "did" 事件不能 preventDefault,改成在键盘事件层吞掉
// Cmd+R / Ctrl+R / F5,并去掉 popout 的菜单(避免菜单里的 Reload)。
app.on('browser-window-created', (_evt, win) => {
  // 窗口级资源清理:主窗 / 新窗 / dockview popout 子窗一视同仁(popout 不走
  // createMainWindow,镜像 terminal.ipc 的 windowClosedCleanup 覆盖全窗口挂法)。
  // webContents id ≠ BrowserWindow id 且 'closed' 后 webContents 已销毁不可读 →
  // 在创建期(此刻 webContents 存活)先捕获 wcId。
  const wcId = win.webContents.id;
  win.once('closed', () => {
    void debugService.killByOwner(win.id, 'window-closed').catch((err) => {
      console.warn('[debug] killByOwner failed during window close', err);
    });
    releaseWindowResources(win.id, wcId);
  });

  win.webContents.once('did-finish-load', () => {
    if (!isPopoutUrl(win.webContents.getURL())) return;
    win.setMenu(null);
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const reload = isReloadKey(input.key);
      if ((reload && (input.meta || input.control)) || input.key === 'F5') {
        event.preventDefault();
      }
    });
  });
});

// M-Plugin v4.4:co:// 协议处理(原 co://,v0.2 改名 Continuo)
// macOS:open-url(用户点 co://...);Windows / Linux:single-instance argv

const PROTOCOL = 'co';

function dispatchProtocolUrl(url: string): void {
  // race(R39):只投给已就绪(renderer 经 preload 上报 PROTOCOL_READY、onProtocolUrl 已挂)的窗口;
  // 无就绪窗口时入队,由之后第一个上报就绪的窗口排空。见 routeProtocolUrl。
  routeProtocolUrl(url, {
    windows: BrowserWindow.getAllWindows(),
    channel: PLUGINS_CHANNELS.PROTOCOL_URL,
    pending: pendingProtocolUrls,
    isReady: (w) => protocolReadyContents.has(w.webContents),
  });
}

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]!),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // co:// 深链(大小写无关,见 extractProtocolUrl)
    const url = extractProtocolUrl(argv, PROTOCOL);
    if (url) dispatchProtocolUrl(url);
    // Windows/Linux:运行中通过 OS/CLI 传入的目录 argv(如 "用 Continuo 打开文件夹")
    // 此前被忽略 → 在已有实例里按目录打开新窗口(跨平台审计 P2)。
    const folders = pickArgvFolders(
      argv,
      isDirectorySync,
      { skipFirstArg: !!process.defaultApp, skipAll: false },
    );
    for (const folder of folders) void openPathInNewWindow(folder);
    const wins = BrowserWindow.getAllWindows();
    if (wins[0]) {
      if (wins[0].isMinimized()) wins[0].restore();
      wins[0].focus();
    }
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  dispatchProtocolUrl(url);
});

// ─────────────────────────────────────────────────────
// macOS open-file:用户拖文件夹到 Dock 图标 / 用 "Open With Continuo"。
// 拿到目录路径 → 在新窗口打开;文件路径暂忽略(后续 Phase 接 editor)。
// 冷启时事件可能在 whenReady 之前触发,缓冲到 ready 后处理。
// ─────────────────────────────────────────────────────
const pendingOpenPaths: string[] = [];
// Issue #45:CLI / dock 拖入(Windows/Linux 走 argv) 路径与 macOS open-file 共用同一
// 缓冲池;skipFirstArg 在 dev (electron .) 跳掉 argv[1] 的 cwd,skipAll 在 E2E 模式
// 完全禁用,避免 Playwright launcher 的 argv 误触发 dock mode。
pendingOpenPaths.push(
  ...pickArgvFolders(
    process.argv,
    isDirectorySync,
    {
      skipFirstArg: !!process.defaultApp,
      skipAll: process.env['CONTINUO_E2E'] === '1',
    },
  ),
);

// 边界(E59,E58 运行期 sibling):macOS open-file 在 app ready 后直接走本入口,绕过冷启动
// pendingOpenPaths/pickStartupMode 的数量/长度上限。畸形/自动化 open-file 事件可在运行中连续送入
// 大量目录或超长路径 → 对每个先同步 statSync + 批量 allocateWindowSeq/createMainWindow,主进程
// 同步 I/O 卡顿 + 批量开窗。复用启动路径长度守卫(超长不 statSync)+ 运行期并发开窗上限。
let openInFlight = 0;
async function openPathInNewWindow(absPath: string): Promise<void> {
  // 超长/非法路径先跳过,绝不对其 statSync。
  if (!isWithinStartupPathLimit(absPath)) {
    console.warn('[open-file] dropping invalid/oversize path');
    return;
  }
  // 运行期并发开窗上限:挡 open-file 事件洪水批量开窗(冷启动有 pickStartupMode 上限,运行期靠此)。
  if (openInFlight >= MAX_STARTUP_DIRS) {
    console.warn(
      `[open-file] too many concurrent opens (>= ${MAX_STARTUP_DIRS}), dropping`,
    );
    return;
  }
  openInFlight += 1;
  try {
    if (!isDirectorySync(absPath)) return; // 路径不存在 / 无权限 / 非目录 → 跳过
    await openWorkspaceWindow(absPath);
  } finally {
    openInFlight -= 1;
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (!app.isReady()) {
    pendingOpenPaths.push(filePath);
    return;
  }
  void openPathInNewWindow(filePath);
});

// Agent Terminal MCP host(P1):启动 HTTP server,把 token / url 通过 env
// 注入到所有 PTY → 用户在 terminal 跑 claude / codex 时反连本机 host。
// P4+ C 方案:同时启 stdio server(unix socket),Claude Code 走 stdio 配置一次永久使用。
let mcpHost: McpHost | null = null;
let mcpStdio: StdioSocketServer | null = null;
// Stop hook broker 的停止函数(MCP host 启动成功后赋值),由 before-quit 不可逆清理阶段调用。
let stopHookBroker: (() => Promise<void>) | null = null;

// MCP tool 共享的 PTY create 入口:复用 IPC 端的 makeCreateHandler 工厂,
// 包一层 lazy mainWindow 查询(tool 调用时窗口必在,但 host 启动时还没创建)。
const ptyCreateHandler = makeCreateHandler();
const getSessionOwner = (id: string): number | null =>
  terminalSessions.get(id)?.ownerWindowId ?? null;

async function createSessionForAgent(
  input: CreateSessionPtyInput,
  ctx: McpCallCtx,
): Promise<{ id: string }> {
  const win = BrowserWindow.fromId(ctx.ownerWindowId);
  if (!win || win.isDestroyed()) {
    throw codedError(ERROR_CODES.TERMINAL_NO_WINDOW, 'no window for terminal create');
  }
  // 安全 S3:把新会话归属到发起 create 的 MCP 调用方(ctx.callerSubject)。后续
  // read/send/kill 仅该调用方(同一 token / 同一 stdio 连接)可操作该会话。
  const r = await ptyCreateHandler(
    input,
    win,
    typeof ctx.callerSubject === 'string'
      ? { controllerToken: ctx.callerSubject }
      : undefined,
  );
  // P3 autorun:spawn 后 delay 200ms(Win 600)等 shell prompt 出现,然后键入命令。
  // 不严格保证 prompt 已就绪 — 平台差异大,简单 timer 是最务实的近似。
  // race(R111 同族):ptyCreateHandler 是异步边界,期间调用方已断开 → 不再键入 autorun 命令。
  if (input.autorun && !ctx.signal?.aborted) {
    const cmd = input.autorun;
    setTimeout(() => {
      if (termService.has(r.id)) {
        // autorun 是尽力而为(prompt 就绪近似),写入结果无 UI 反馈通道 → fire-and-forget。
        // write 现返 Promise(R4),内部已 catch 不 reject,void 显式忽略避免 floating-promise。
        void termService.write(r.id, `${cmd}\n`);
      }
    }, AUTORUN_DELAY_MS);
  }
  return r;
}

async function startMcpHost(): Promise<void> {
  let brokerStarted = false;
  const hookEventsDir = path.join(app.getPath('userData'), 'hook-events');
  const broker = createHookFileBroker(hookEventsDir);
  try {
    await nodeFs.promises.mkdir(hookEventsDir, { recursive: true });
    try {
      await broker.start();
      brokerStarted = true;
      // 窗口关闭时取消该窗口仍在 block 的 await_stop_hook 等待者(审计 #3)。
      setStopHookCanceller((windowId) => {
        try {
          broker.cancelByWindow(windowId);
        } catch {
          // ignore — 关闭路径尽力而为
        }
      });
    } catch (err) {
      console.warn(
        '[hook-bridge] broker.start failed, await_stop_hook will be unavailable:',
        err,
      );
    }
    const installStopHook = async (
      cwd: string | undefined,
      agentLabel: string,
    ) => {
      const resolvedCwd = cwd ?? '';
      const runner = inferRunner({ id: '', cwd: resolvedCwd, agentLabel });
      return installStopHookForSession(resolvedCwd, runner, hookEventsDir);
    };
    const initialTools = [
      ...makeTerminalMcpTools({
        sessionStore: terminalSessions,
        service: termService,
        getSessionOwner,
        getSessionController: (id) => terminalSessions.getController(id),
        ensureAuthorized: (ownerWindowId?: number, method?: string) =>
          requestAgentAuth({
            method: method ?? 'terminal.create_session',
            ...(ownerWindowId !== undefined ? { ownerWindowId } : {}),
          }),
        createSession: createSessionForAgent,
        installStopHook,
        // 安全:await_stop_hook 与 read_output 同走 auth + per-session capability 门控
        //(会返回 transcript_path / last_assistant_message,不得被同窗口他方消费)。
        awaitStopHookTool: brokerStarted
          ? createAwaitStopHookTool({
              broker,
              getSessionMeta: (sessionId, ctx) => {
                const session = terminalSessions.get(sessionId);
                if (!session || session.ownerWindowId !== ctx.ownerWindowId) {
                  return null;
                }
                return session;
              },
            })
          : undefined,
      }),
      ...makeDebugMcpTools({
        service: debugService,
        getSessionOwner: (id) => debugSessions.get(id)?.ownerWindowId ?? null,
        getSessionController: (id) =>
          debugSessions.get(id)?.controllerToken ?? null,
        ensureAuthorized: (ownerWindowId: number, method?: string) =>
          requestAgentAuth({
            method: method ?? 'debug.*',
            ownerWindowId,
          }),
      }),
    ];
    mcpHost = await createMcpHost({
      initialTools,
    });
    setMcpEnvProvider((windowId: number) => {
      if (!mcpHost) return { env: {} as Record<string, string>, mcpToken: '' };
      return createContinuoMcpEnv({
        windowId,
        url: mcpHost.url,
        issueToken: (id) => mcpHost!.issueWindowToken(id),
      });
    });
    // 给 agent-auth service 注入 host 引用,撤销时 rotate token。
    setMcpHostRef(mcpHost);
    setMcpRevokers({
      byWindow: (windowId) => mcpHost!.revokeWindowTokens(windowId),
      // byToken 只用于终端专属 token(终端退出 / 创建回滚):token 失效后其经 HTTP MCP 创建的 debug
      // 会话再无人能 disconnect → 同步回收(与 stdio 断连路径一致),否则名额被占满、adapter 常驻。
      byToken: (token) => {
        mcpHost!.revokeToken(token);
        void debugService.killByController(token, 'terminal-exit').catch((err) => {
          console.warn('[debug] killByController failed on terminal token revoke', err);
        });
      },
    });
    setAgentAuthControllerTeardown({
      // 含在途 launch 的调用方:会话尚未登记,只列已登记会话的话撤销时漏掉它们(见 DebugService.listControllerTokens)。
      listControllerTokens: () => debugService.listControllerTokens(),
      killByController: (controllerToken, reason) => {
        void debugService.killByController(controllerToken, reason).catch((err) => {
          console.warn('[debug] killByController failed during revoke', err);
        });
      },
    });
    // 只在主 before-quit 的不可逆清理阶段停止(见 stopHookBroker):此前另挂一次性的退出监听,
    // 在退出一开始就停,用户取消退出后 broker 不会重启,await_stop_hook 直到重启应用都不可用。
    if (brokerStarted) {
      stopHookBroker = async () => {
        try {
          await broker.stop();
        } catch {
          // ignore shutdown races
        }
      };
    }
	 
    console.log(`[mcp-host] listening on ${mcpHost.url}`);
  } catch (err) {
    if (brokerStarted) {
      try {
        await broker.stop();
      } catch {
        // ignore cleanup races
      }
    }
	 
    console.warn(
      '[mcp-host] failed to start, agent terminal MCP unavailable',
      err,
    );
  }
}

/**
 * stdio CLI proxy 路径:
 *  - packaged app:`<resourcesPath>/continuo-mcp-stdio.mjs`(electron-builder
 *    extraResources 拷过去)
 *  - dev:`scripts/continuo-mcp-stdio.mjs`(项目根)
 */
function resolveStdioCliPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'continuo-mcp-stdio.mjs');
  }
  // dev:从 main 的 __dirname(out/main/)往上找项目根
  return path.resolve(__dirname, '..', '..', 'scripts', 'continuo-mcp-stdio.mjs');
}

/**
 * stdio socket / named pipe 路径(跨平台):
 *  - macOS / Linux:`<userData>/mcp.sock`(unix socket,文件系统)
 *  - Windows:`\\.\pipe\continuo-mcp`(named pipe,不在文件系统;
 *    单实例 lock 已防双实例,无需 pid 后缀)
 *
 * CLI proxy(scripts/continuo-mcp-stdio.mjs)有同款默认值算法,两边对齐。
 */
function resolveStdioSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\continuo-mcp';
  }
  return path.join(app.getPath('userData'), 'mcp.sock');
}

async function startMcpStdioServer(): Promise<void> {
  if (!mcpHost) {
     
    console.warn('[mcp-stdio] http host not started, skipping stdio');
    return;
  }
  const socketPath = resolveStdioSocketPath();
  try {
    mcpStdio = await createStdioSocketServer({
      socketPath,
      tools: mcpHost.tools,
      serverInfo: mcpHost.serverInfo,
      resolveWindowId: (token) => mcpHost!.resolveWindowId(token),
      // stdio 连接断开 → 其 subject 永久失效:回收它创建的 debug 会话(否则无人能 disconnect,
      // 名额被占满、adapter 常驻)。终端会话对用户可见、可手动关,不在此回收。HTTP subject 是窗口级
      // token,随窗口关闭 / 撤销回收(killByOwner / revokeAndKillAgentSessions),不按连接回收。
      onCallerClosed: (subject) => {
        void debugService.killByController(subject, 'caller-disconnected').catch((err) => {
          console.warn('[debug] killByController failed on stdio close', err);
        });
      },
    });
    const cliPath = resolveStdioCliPath();
    const claudeAddCommand = buildClaudeAddCommand(cliPath);
     
    console.log(`[mcp-stdio] listening on ${mcpStdio.socketPath}`);
    // 打印推荐的 claude mcp add 命令,用户复制即可一次配置永久使用
     
    console.log(
      '[mcp-stdio] one-shot config (Claude Code):\n' +
        `  ${claudeAddCommand}`,
    );
    // 缓存配置给状态栏"复制 MCP 配置"按钮用
    setStdioConfig({
      available: true,
      cliPath,
      socketPath: mcpStdio.socketPath,
      claudeAddCommand,
    });
  } catch (err) {
     
    console.warn(
      '[mcp-stdio] failed to start, stdio MCP transport unavailable',
      err,
    );
  }
}

app.whenReady().then(async () => {
  // 安全 S1:在建任何窗口 / IPC 之前注册真实 renderer 入口,让 defaultIsTrustedFrame
  // 与 windowOpenHandler 只信这个 file URL,拒绝任意 file:// 弹窗/frame 受信。放在
  // whenReady(而非模块顶层)以免被仅 import index 的单测污染全局注册态。
  setTrustedRendererFile(RENDERER_FILE);

  const userData = app.getPath('userData');
  const explorerFile = path.join(userData, EXPLORER_FILE_NAME);
  const legacyLayoutFile = path.join(userData, 'layout.json');
  await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

  // topic 16 i18n: 必须先 hydrate settings.json，buildAppMenu 才能拿到正确 locale 的 label
  await loadSettings();

  // E2E 跑 Playwright 时,Electron 默认菜单的 CmdOrCtrl+P 绑定 Print 会先吞
  // ⌘P,导致 Quick Open 收不到 keydown。e2e 显式禁用菜单(只影响测试模式)。
  if (process.env['CONTINUO_E2E'] === '1') {
    Menu.setApplicationMenu(null);
  } else {
    Menu.setApplicationMenu(buildAppMenu(getMainT()));
    // macOS dock 右键菜单(快捷入口)。抽成 setDockMenu 复用,locale 切换时一并重建。
    setDockMenu();
  }

  registerIpc({ createMainWindow });
  // topic 16: 把 rebuildAppMenu 注入 i18n.ipc，setLocale 时菜单整体重建
  setMenuRebuilder(rebuildAppMenu);
  // 在 createMainWindow 之前启 host,确保 renderer autoSpawn 的第一个 PTY
  // env 已含 MCP url / token。
  await startMcpHost();
  await startMcpStdioServer();
  // Plugin → MCP bridge 接线(host 已就绪,renderer 通过 IPC 注册的 tool 走它)。
  // tools/list_changed 通知同时推 HTTP SSE + stdio 客户端,Codex/Claude Code 收到自动重拉.
  if (mcpHost) startPluginMcpIpc(mcpHost, mcpStdio ?? undefined);
  // 冷启动开窗模式决策(issue #30):有 dock 缓冲目录 → dock 模式,
  // 第一个目录作主窗 workspace,其余各开新窗,**不**恢复历史;
  // 否则 → restore 模式,主窗用持久化 workspace,异步恢复历史 windows[]。
  const startup = pickStartupMode(pendingOpenPaths.splice(0), isDirectorySync);

  // 主窗由 createMainWindow 创建(有副作用:开窗 + 挂就绪作废监听);冷启动协议 URL 经
  // dispatchProtocolUrl 走统一队列消费(R69),不再需要持有主窗引用直发。
  if (startup.mode === 'dock') {
    // 第一个 dir 作主窗 workspace,覆盖持久化的 windows[0].workspace.root
    createMainWindow({
      windowSeq: 0,
      workspace: startup.dirs[0]!,
      fresh: true,
    });
    if (startup.dirs.length > 1) {
      void (async () => {
        for (let i = 1; i < startup.dirs.length; i += 1) {
          await openWorkspaceWindow(startup.dirs[i]!);
        }
      })();
    }
  } else {
    // 正常启动:主窗 windowSeq=0(workspace 由 renderer 从 explorer.json 段恢复)
    createMainWindow({ windowSeq: 0 });
    // Phase 2C(issue #23):上次会话的非主窗(windowSeq>0)逐个恢复
    void (async () => {
      try {
        const data = await loadExplorer(explorerFile);
        if (!data) return;
        for (const entry of pickWindowsToRestore(data, isDirectorySync)) {
          createMainWindow({
            windowSeq: entry.windowSeq,
            workspace: entry.workspace,
          });
        }
      } catch (err) {
        console.warn('[window-restore] 启动恢复失败,只开主窗', err);
      }
    })();
  }

  // 冷启 + open-url 顺序处理:可能在 mainwindow 未就绪前已收 url。race(R41):协议队列 drain 统一
  // 由 PROTOCOL_READY 处理器负责(任一窗口上报就绪即排空),此处不单独挂 drain。

  if (!process.defaultApp) {
    const url = extractProtocolUrl(process.argv, PROTOCOL);
    // race(R69):此前在 did-finish-load 回调里直发 win.webContents.send,绕过统一 routeProtocolUrl
    // 的 FIFO 队列 + R63 的「send 成功才出队 / 失败保留队首」韧性逻辑。两个漏洞:(1)主窗在 load
    // 前关闭 → did-finish-load 永不触发 → 冷启动深链永久丢失;(2)load 后、send 前窗口销毁 → send
    // 抛 "Object has been destroyed" → 深链丢失 + 在事件回调里成未捕获异常。改为交统一协议路由:
    // dispatchProtocolUrl 入 pendingProtocolUrls 后,由窗口上报 PROTOCOL_READY 时的 drain 韧性消费
    // (send 失败保留队首,留给下个窗口)。
    if (url) dispatchProtocolUrl(url);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow({ windowSeq: 0 });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  const action = quitGuard.onBeforeQuit();
  // 清理已完成 → 内部 app.quit() 的重入,放行退出。
  if (action === 'allow') return;
  // 清理在途、用户/外部再次 quit → 继续拦截,等在途 cleanupAll 跑完由内部 quit 放行。
  if (action === 'block') {
    event.preventDefault();
    return;
  }
  // action === 'run':首次 quit,跑清理。
  event.preventDefault();
  const targets: BrowserWindow[] = [];
  // 本轮接管的在途单窗关闭流程的复位函数;退出中止时立即调用(显示窗口 + 释放关窗守卫)。
  const takenOver: Array<() => void> = [];
  // 已回答确认框(保存 / 不保存)而被隐藏的窗口;退出中止时恢复显示。
  const answered: BrowserWindow[] = [];
  const abortQuit = (show: readonly BrowserWindow[]): void => {
    for (const release of takenOver) release();
    for (const w of [...answered, ...show]) if (!w.isDestroyed()) w.show();
    quitGuard.cancel(); // 复位:下次 Cmd+Q 重新确认,不卡在「在途」
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || flushedOnQuit.has(w.id)) continue;
    // popout 窗口跑的是 PopoutHost,不挂 DockShell,没有 flush 监听 → 永不 ack;对它发请求只会让退出
    // 干等满 FLUSH_ACK_TIMEOUT_MS。只 flush 主窗(wireWindowCloseFlush 也只挂在 createMainWindow)。
    // webContents 已销毁(关窗中间态)时 getURL() 会抛 —— 此处已 preventDefault,抛出会让 quitGuard
    // 永远停在「清理在途」、应用无法退出。已销毁的交给 requestWindowFlush 的立即放行分支。
    if (!w.webContents.isDestroyed() && isPopoutUrl(w.webContents.getURL())) continue;
    targets.push(w);
    // 复审(d):退出接管该窗口 —— 其在途的单窗关闭流程完成时不再 close(由退出统一处理)。
    bumpCloseFlowGen(w.id);
    const release = closeFlowReleases.get(w.id);
    if (release) {
      closeFlowReleases.delete(w.id);
      takenOver.push(release);
    }
  }
  // 脏文件确认:逐窗(一次一个框)问「保存 / 不保存 / 取消」,任一取消 → 中止整个退出。
  // 无脏窗口时不进任何 await,flush 与之前一样同步发出。
  const modes = new Map<number, FlushMode>();
  const accepted = new Map<number, DirtyState>();
  for (const w of targets) {
    const confirm = confirmDirtyClose(w);
    if (!confirm) continue;
    const choice = await confirm.choice;
    if (choice === 'cancel') {
      abortQuit([]);
      return;
    }
    modes.set(w.id, choice === 'save' ? 'save' : 'discard');
    accepted.set(w.id, confirm.state);
    // 终审 P1(冻结):回答后立即隐藏该窗口直到退出完成 —— 否则别窗确认框打开期间用户回到本窗继续编辑同一已脏
    // 文件,脏 id 身份不变,全局最终检查视为已接受 → 新增内容静默丢失。退出中止时 abortQuit 恢复显示。
    answered.push(w);
    try {
      if (!w.isDestroyed()) w.hide();
    } catch {
      // 关窗竞态下 hide 失败不阻断退出确认。
    }
  }
  // flush 请求前各窗已上报的 pendingAutoSave(随本轮 flush 落盘;全局最终检查不当作 ACK 之后的新输入)。
  const flushedPending = new Map<number, readonly string[] | undefined>();
  for (const w of targets) flushedPending.set(w.id, dirtyStates.get(w.id)?.pendingAutoSave);
  const outcomes = await Promise.all(
    targets.map((w) => requestWindowFlush(w, modes.get(w.id) ?? 'none', accepted.get(w.id))),
  );
  // 任一窗口需中止(「保存」未确认成功 / 最终脏检查仍有未保存改动,如 B 确认期间 A 变脏)→ 中止退出并显示
  // 该窗口。此时不记 flushedOnQuit:退出没发生,之后关这些窗口仍要走确认 + flush。
  const failed = targets.filter((w, i) =>
    shouldAbortClose(modes.get(w.id) ?? 'none', outcomes[i] ?? 'timeout', w.id),
  );
  if (failed.length > 0) {
    abortQuit(failed);
    return;
  }
  // 全局最终检查:必须在破坏性清理(cleanupAll 杀 PTY)之前。超出本轮已接受范围的窗口 → 中止退出。
  const changed = targets.filter(
    (w) =>
      !w.isDestroyed() &&
      exceedsAccepted(
        dirtyStates.get(w.id),
        modes.get(w.id) ?? 'none',
        accepted.get(w.id),
        flushedPending.get(w.id),
      ),
  );
  if (changed.length > 0) {
    abortQuit(changed);
    return;
  }
  for (const w of targets) flushedOnQuit.add(w.id);
  // 退出屏障(复审):已入 flushedOnQuit,之后的编辑不会再被 flush / 确认;不可逆清理(debug teardown 可能数秒)
  // 期间窗口仍可编辑 → 改动丢失,用户关窗也绕过确认。进入清理前隐藏全部窗口(popout 一并)。
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.hide();
    } catch {
      // 关窗竞态下 hide 失败不阻断退出清理。
    }
  }
  // force-kill 所有 PTY,防 agent 长任务子进程被孤儿化/zombie。无论是否有窗口要 flush
  // 都必须跑(关最后一个窗口触发的 quit 路径 wins 已空,旧 every() 守卫会跳过它)。
  // 在 app.quit() 前 await:window 'closed' 清理走 3s grace timer,进程退出不触发 SIGKILL。
  // 窗口已隐藏、无人应答授权弹窗:同步拒绝所有未决 agent 授权,挂在授权上的 MCP 工具调用随即结算,
  // 不把下面的 mcpHost close 拖到 5min 授权超时(close 自身也会断开现存连接并设上限)。
  cancelAllAgentAuth();
  // 插件 shell 子进程(一次性 exec / 流式)是 detached 进程组,不随 IDE 退出终止;立即强杀整树并等待。
  await Promise.allSettled([
    termService.cleanupAll(),
    debugService.cleanupAll('before-quit'),
    cleanupAllShellExecs(),
    cleanupAllShellStreams(),
  ]);
  // race(R83):此前 mcpHost/mcpStdio close 是 void fire-and-forget,随后立即 markFinished() +
  // app.quit() → 进程可能在 HTTP/SSE server 关闭、unix socket server close + mcp.sock unlink
  // 完成前退出:SSE/keepalive/socket 清理与退出竞态,mcp.sock 残留到下次启动兜底清理,退出/测试
  // 路径也无法可靠等待资源释放。纳入与 cleanupAll 同一段 awaited 清理,等齐再退出。allSettled:
  // 单个 close 失败/reject 不阻断另一个,也不阻断退出。
  await Promise.allSettled([mcpHost?.close(), mcpStdio?.close(), stopHookBroker?.()]);
  quitGuard.markFinished();
  app.quit();
});
