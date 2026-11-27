// fs:show-save-dialog:编辑器「另存为」的原生保存对话框(VSCode fileDialogService.pickFileToSave)。只返回用户选定的路径,
// 不写盘 —— 写入仍走 fs:write-file(原地写 / 符号链接写穿 / 插件打开路径的守卫都在那里,另存为不另开写入通道)。
// - 只接受主窗主 webContents 的调用(trustedSenderWindow:可信 frame + 发送方就是该窗口自己的主 webContents);popout 子窗的
//   界面由主窗 renderer 驱动,不经自己的 webContents 发 IPC。对话框挂在获焦的、属于该主窗的窗口上(popout 子窗里触发 →
//   挂在子窗上),否则挂主窗。renderer 不自报父窗口。
// - defaultPath:绝对路径原样作为对话框的默认位置;只有文件名(无标题文件从首行推断的名字、无工作区时)→ 用户主目录下的该名。
// - 选定的 Markdown 路径登记为本窗口打开过的文档(同 fs:read-file 读取成功后):另存到工作区外后,同目录图片照常显示。
// - 覆盖确认由系统对话框负责(macOS / Windows 自带;Linux 传 showOverwriteConfirmation)。
// BDD: src/__tests__/editor-save-as/
import path from 'node:path';
import { z } from 'zod';
import type { BrowserWindow, SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import { FS_PATH_MAX } from '../../../shared/fs-limits';
import { ERROR_CODES } from '../../../shared/error-codes';
import { codedError } from '../../../shared/error-message';

export const showSaveDialogInputSchema = z
  .object({ defaultPath: z.string().min(1).max(FS_PATH_MAX) })
  .strict();

export type ShowSaveDialogInput = z.infer<typeof showSaveDialogInputSchema>;

export interface SaveDialogDeps {
  /** 发送方主窗(不可信 / 不是主 webContents → null)。 */
  readonly senderWindow: () => BrowserWindow | null;
  /** 对话框挂在哪个窗口上(获焦的、属于 owner 的窗口;缺省 owner)。 */
  readonly parentFor: (owner: BrowserWindow) => BrowserWindow;
  readonly showSaveDialog: (parent: BrowserWindow, opts: SaveDialogOptions) => Promise<SaveDialogReturnValue>;
  readonly homeDir: () => string;
  readonly recordDocument: (windowId: number, filePath: string) => void;
}

/** 对话框的默认位置:绝对路径原样;只有文件名 → 主目录下(名字里的目录成分丢弃)。 */
export function resolveSaveDialogDefaultPath(defaultPath: string, homeDir: string): string {
  if (path.isAbsolute(defaultPath)) return defaultPath;
  return path.join(homeDir, path.basename(defaultPath));
}

export function makeShowSaveDialogHandler(
  deps: SaveDialogDeps,
): (input: ShowSaveDialogInput) => Promise<string | null> {
  return async (input) => {
    const owner = deps.senderWindow();
    if (!owner) throw codedError(ERROR_CODES.NO_WINDOW, 'save dialog: sender is not a main window');
    const r = await deps.showSaveDialog(deps.parentFor(owner), {
      defaultPath: resolveSaveDialogDefaultPath(input.defaultPath, deps.homeDir()),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    const picked = r.canceled ? undefined : r.filePath;
    if (picked === undefined || picked === '') return null;
    // 系统对话框给的总是绝对路径;防御:相对 / 超长 → 当作取消(不让 renderer 拿到写不进 IPC 的路径)
    if (!path.isAbsolute(picked) || picked.length > FS_PATH_MAX) return null;
    if (!owner.isDestroyed()) deps.recordDocument(owner.id, picked);
    return picked;
  };
}
