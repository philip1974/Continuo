// 工作区信任的 Electron 接线(逻辑在 services/workspace-trust.service,可单测):
// - 持久化:<userData>/workspace-trust.json(主进程侧用户数据,不进工作区;E2E 的 --user-data-dir 下同样如此)。
// - 询问:main 原生对话框(dialog.showMessageBox,挂在发起窗口上;VSCode 的启动信任对话框同样是工作台对话框、macOS 默认原生
//   样式)。结果只来自用户在原生对话框里的点击:renderer / 插件 / agent 没有任何置信任的 IPC,REQUEST_TRUST 只能「请 main 问用户」。
// - E2E 默认(只在 CONTINUO_E2E=1 下生效):信任关闭(一切视为受信任、不弹对话框),现有打开文件夹的 e2e 不被对话框打断;
//   信任专项 e2e 另设 CONTINUO_E2E_WORKSPACE_TRUST=1 打开真实行为。非 E2E 模式恒为开启,没有关闭开关。
// BDD: src/__tests__/workspace-trust/

import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { z } from 'zod';
import { safeHandle, safeHandleWithWindow } from '../safe-handle';
import { atomicWriteJson } from '../lib/atomic-write';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { quarantineCorruptFile } from '../lib/corrupt-snapshot';
import { trySend } from '../lib/try-send';
import { getMainT } from '../i18n';
import { ERROR_CODES } from '../../shared/error-codes';
import { ROOT_MAX } from '../../shared/window-create-schema';
import { WORKSPACE_TRUST_CHANNELS, WORKSPACE_TRUST_MAX_FOLDERS } from '../../shared/workspace-trust';
import {
  createWorkspaceTrustService,
  type TrustData,
  type TrustPromptAnswer,
  type TrustPromptRequest,
  type WorkspaceTrustService,
} from '../services/workspace-trust.service';

export const WORKSPACE_TRUST_FILE_NAME = 'workspace-trust.json';
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const FolderList = z.array(z.string().min(1).max(ROOT_MAX)).max(WORKSPACE_TRUST_MAX_FOLDERS);
const TrustFileSchema = z.object({ version: z.literal(1), trusted: FolderList, prompted: FolderList });

/** E2E 默认:CONTINUO_E2E=1 且未显式要求真实行为 → 信任关闭。其余情况恒开启。 */
export function workspaceTrustEnabled(env: NodeJS.ProcessEnv): boolean {
  return !(env['CONTINUO_E2E'] === '1' && env['CONTINUO_E2E_WORKSPACE_TRUST'] !== '1');
}

async function loadTrustFile(file: string): Promise<TrustData | null> {
  let text: string;
  try {
    const r = await readFileCappedFd(file, MAX_FILE_BYTES);
    if (r.tooLarge) {
      await quarantineCorruptFile(file);
      return null;
    }
    text = r.text as string;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = TrustFileSchema.safeParse(json);
  if (!parsed.success) {
    // 损坏:隔离留证后从空表开始(什么都不信任 = fail-closed)
    await quarantineCorruptFile(file);
    return null;
  }
  return parsed.data;
}

/** 原生信任对话框(文案照 VSCode workspace.contribution 的启动询问)。 */
export async function showTrustPrompt(req: TrustPromptRequest): Promise<TrustPromptAnswer> {
  const t = getMainT();
  const options: MessageBoxOptions = {
    type: 'info',
    message: t('workspace_trust.prompt.message'),
    detail: [
      t('workspace_trust.prompt.detail', { product: 'Continuo' }),
      t('workspace_trust.prompt.learn_more'),
      req.root,
    ].join('\n\n'),
    buttons: [t('workspace_trust.prompt.trust'), t('workspace_trust.prompt.dont_trust')],
    defaultId: 0,
    // Esc / 关闭 = 不信任(受限模式浏览)
    cancelId: 1,
    noLink: true,
    ...(req.parentName !== null
      ? { checkboxLabel: t('workspace_trust.prompt.trust_parent', { name: req.parentName }), checkboxChecked: false }
      : {}),
  };
  const win = BrowserWindow.fromId(req.windowId);
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return { trust: r.response === 0, parent: r.response === 0 && r.checkboxChecked };
}

let service: WorkspaceTrustService | null = null;

/** 已注册的信任服务;未注册(单测里只注册了别的 IPC)→ null,调用方按「不受信任」处理。 */
export function getWorkspaceTrust(): WorkspaceTrustService | null {
  return service;
}

const RemoveFolderInput = z.object({ path: z.string().min(1).max(ROOT_MAX) });

export function registerWorkspaceTrustIpc(): void {
  const file = path.join(app.getPath('userData'), WORKSPACE_TRUST_FILE_NAME);
  const svc = createWorkspaceTrustService({
    enabled: workspaceTrustEnabled(process.env),
    load: () => loadTrustFile(file),
    save: (data) => atomicWriteJson(file, { version: 1, trusted: data.trusted, prompted: data.prompted }),
    realpath: (p) => fs.realpath(p),
    platform: process.platform,
    prompt: showTrustPrompt,
    push: (windowId, state) => {
      const win = BrowserWindow.fromId(windowId);
      trySend(win?.webContents, WORKSPACE_TRUST_CHANNELS.CHANGED, state);
    },
  });
  service = svc;
  const NoInput = z.undefined();
  safeHandleWithWindow(WORKSPACE_TRUST_CHANNELS.GET_INFO, NoInput, (_input, win) => svc.getInfo(win.id), ERROR_CODES.NO_WINDOW);
  safeHandleWithWindow(
    WORKSPACE_TRUST_CHANNELS.REQUEST_TRUST,
    NoInput,
    (_input, win) => svc.requestTrust(win.id),
    ERROR_CODES.NO_WINDOW,
  );
  safeHandle(WORKSPACE_TRUST_CHANNELS.REMOVE_FOLDER, RemoveFolderInput, (input) => svc.removeFolder(input.path));
}
