// 工作区信任(对齐 VSCode WorkspaceTrustManagementService + workspace.contribution 的启动询问)。纯逻辑,依赖注入,可单测;
// Electron 接线(原生对话框、userData 文件、推送)在 ipc/workspace-trust.ipc。
//
// - 信任按文件夹持久化在主进程侧 userData(不进工作区):`trusted` = 已信任文件夹(VSCode uriTrustInfo 只存 trusted 项),
//   `prompted` = 已询问过的文件夹(VSCode startupPrompt 默认 once:每个工作区只在首次打开时问一次,STARTUP_PROMPT_SHOWN_KEY)。
// - 比较前 realpath(符号链接 / `..` 指向同一目录算同一个;失败用原值);macOS / Windows 再按 NFC + 小写比较(默认文件系统
//   大小写不敏感、APFS 不区分 NFC / NFD,同 foldPathForCompare),Linux 原样。
// - 继承:某个已信任条目等于当前文件夹或是其上级 → 受信任(VSCode doGetUriTrustInfo 的 isEqualOrParent)。
// - 询问:未信任、且没问过 → 弹一次(同一文件夹同时只弹一个,多窗口共用);「信任」可勾选「信任上级文件夹」(加上级条目)。
//   上级 = 上报的原路径 root 的上级(VSCode setParentFolderTrust 取工作区 URI 的 dirname,不解析符号链接:经链接打开时
//   信任的是对话框里看到的那个上级),写入前再 realpath 规范化;规范化后的上级不覆盖当前文件夹(链接指向别处)→ 当前文件夹
//   也一并记入,保证「信任」之后本窗口确实受信任。
//   对话框结果只来自 deps.prompt(main 原生对话框),renderer 没有直接置信任的入口。
// - 读盘失败(IO)→ 本次启动不写盘;对话框与管理界面提示「本次修改不会保存」(persistBlocked)。
// - enabled=false(只在 E2E 默认,见 workspace-trust.ipc):一切视为受信任、不询问。
// BDD: src/__tests__/workspace-trust/

import path from 'node:path';
import { isSameOrInsidePath } from '../lib/path-inside';
import {
  WORKSPACE_TRUST_MAX_FOLDERS,
  type WorkspaceTrustInfo,
  type WorkspaceTrustState,
} from '../../shared/workspace-trust';

export interface TrustPromptRequest {
  readonly windowId: number;
  /** 窗口上报的根(对话框里显示)。 */
  readonly root: string;
  /** root 的上级文件夹完整路径(可勾选「信任上级文件夹」;不解析符号链接);根目录没有上级 → null。 */
  readonly parent: string | null;
  /** 本次运行信任的修改存不下来(读盘失败):对话框写明。 */
  readonly persistBlocked: boolean;
}

/** 用户的决定;null = 对话框没能弹出 / 没有结果(不记为已询问,保持受限)。 */
export type TrustPromptAnswer = { readonly trust: boolean; readonly parent: boolean } | null;

export interface TrustData {
  readonly trusted: readonly string[];
  readonly prompted: readonly string[];
}

export interface WorkspaceTrustDeps {
  readonly enabled: boolean;
  /** 读持久化:null = 不存在(首次);抛错 = 读失败(本次启动不再写盘,防覆盖原文件)。 */
  readonly load: () => Promise<TrustData | null>;
  readonly save: (data: TrustData) => Promise<void>;
  readonly realpath: (p: string) => Promise<string>;
  readonly platform: NodeJS.Platform;
  readonly prompt: (req: TrustPromptRequest) => Promise<TrustPromptAnswer>;
  readonly push: (windowId: number, state: WorkspaceTrustState) => void;
  readonly warn?: (message: string, err?: unknown) => void;
}

export interface WorkspaceTrustService {
  /** 窗口工作区根变化(window:notify-root):求信任状态、推送,未信任且没问过 → 询问。 */
  setWindowRoot(windowId: number, root: string | null): void;
  clearWindow(windowId: number): void;
  /** 窗口当前根(须等于 expectedRoot)是否受信任;状态未求出时等它求出。根不符 / 未登记 → false。 */
  isWindowTrusted(windowId: number, expectedRoot: string): Promise<boolean>;
  getInfo(windowId: number): Promise<WorkspaceTrustInfo>;
  /** 为窗口当前文件夹弹信任对话框(已受信任则不弹);返回之后是否受信任。 */
  requestTrust(windowId: number): Promise<boolean>;
  /** 从已信任列表移除一项(按同一路径语义匹配)。 */
  removeFolder(folder: string): Promise<void>;
}

interface WindowEntry {
  readonly root: string;
  readonly canonical: Promise<string>;
}

export function createWorkspaceTrustService(deps: WorkspaceTrustDeps): WorkspaceTrustService {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  const fold = (s: string): string => (deps.platform === 'linux' ? s : s.normalize('NFC').toLowerCase());
  const covers = (base: string, target: string): boolean => isSameOrInsidePath(fold(base), fold(target), deps.platform);
  const same = (a: string, b: string): boolean => covers(a, b) && covers(b, a);
  const warn = deps.warn ?? ((message: string, err?: unknown) => console.warn(message, err));

  let trusted: string[] = [];
  let prompted: string[] = [];
  let persistDisabled = false;
  const ready = (async () => {
    try {
      const data = await deps.load();
      if (data) {
        trusted = [...data.trusted];
        prompted = [...data.prompted];
      }
    } catch (err) {
      // 读失败(权限 / IO):当作什么都没信任(fail-closed),且本次启动不写盘(否则会用空表覆盖原文件)
      persistDisabled = true;
      warn('[workspace-trust] load failed; trust changes will not be saved this session', err);
    }
  })();

  let saveChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    saveChain = saveChain
      .then(async () => {
        if (persistDisabled) return;
        await deps.save({ trusted: [...trusted], prompted: [...prompted] });
      })
      .catch((err: unknown) => warn('[workspace-trust] save failed', err));
    return saveChain;
  };

  const windows = new Map<number, WindowEntry>();
  const prompts = new Map<string, Promise<void>>();

  const canonical = async (root: string): Promise<string> => {
    await ready;
    try {
      return await deps.realpath(root);
    } catch {
      return root;
    }
  };
  const trustedBy = (c: string): string[] => trusted.filter((t) => covers(t, c));
  const isTrusted = (c: string): boolean => !deps.enabled || trustedBy(c).length > 0;
  const pushBounded = (list: string[], item: string): void => {
    if (list.some((x) => same(x, item))) return;
    list.push(item);
    if (list.length > WORKSPACE_TRUST_MAX_FOLDERS) list.splice(0, list.length - WORKSPACE_TRUST_MAX_FOLDERS);
  };

  const pushWindow = async (windowId: number, entry: WindowEntry): Promise<void> => {
    const c = await entry.canonical;
    if (windows.get(windowId) !== entry) return;
    deps.push(windowId, { root: entry.root, trusted: isTrusted(c) });
  };
  const pushAll = async (): Promise<void> => {
    await Promise.all([...windows].map(([id, entry]) => pushWindow(id, entry)));
  };

  /** 弹信任对话框(同一文件夹单飞)并记录结果。 */
  const runPrompt = (windowId: number, root: string, c: string): Promise<void> => {
    const key = fold(c);
    const pending = prompts.get(key);
    if (pending) return pending;
    const parent = p.dirname(root);
    const hasParent = !same(parent, root);
    const run = (async () => {
      let answer: TrustPromptAnswer;
      try {
        answer = await deps.prompt({ windowId, root, parent: hasParent ? parent : null, persistBlocked: persistDisabled });
      } catch (err) {
        warn('[workspace-trust] prompt failed', err);
        answer = null;
      }
      if (answer === null) return;
      pushBounded(prompted, c);
      if (answer.trust && answer.parent && hasParent) {
        const parentCanonical = await canonical(parent);
        pushBounded(trusted, parentCanonical);
        if (!covers(parentCanonical, c)) pushBounded(trusted, c);
      } else if (answer.trust) {
        pushBounded(trusted, c);
      }
      await persist();
      await pushAll();
    })().finally(() => prompts.delete(key));
    prompts.set(key, run);
    return run;
  };

  const entryFor = (windowId: number): WindowEntry | undefined => windows.get(windowId);

  return {
    setWindowRoot(windowId, root) {
      if (root === null) {
        windows.delete(windowId);
        deps.push(windowId, { root: null, trusted: true });
        return;
      }
      const entry: WindowEntry = { root, canonical: canonical(root) };
      windows.set(windowId, entry);
      void (async () => {
        const c = await entry.canonical;
        if (windows.get(windowId) !== entry) return;
        const ok = isTrusted(c);
        deps.push(windowId, { root, trusted: ok });
        if (!ok && !prompted.some((x) => same(x, c))) await runPrompt(windowId, root, c);
      })();
    },
    clearWindow(windowId) {
      windows.delete(windowId);
    },
    async isWindowTrusted(windowId, expectedRoot) {
      const entry = entryFor(windowId);
      if (!entry || entry.root !== expectedRoot) return false;
      const c = await entry.canonical;
      return windows.get(windowId) === entry && isTrusted(c);
    },
    async getInfo(windowId) {
      await ready;
      const entry = entryFor(windowId);
      const folders = [...trusted];
      const persistBlocked = persistDisabled;
      if (!entry) return { root: null, trusted: true, trustedBy: [], canUntrust: false, folders, persistBlocked };
      const c = await entry.canonical;
      const by = trustedBy(c);
      return {
        root: entry.root,
        trusted: isTrusted(c),
        trustedBy: by,
        canUntrust: deps.enabled && by.length === 1 && same(by[0]!, c),
        folders,
        persistBlocked,
      };
    },
    async requestTrust(windowId) {
      const entry = entryFor(windowId);
      if (!entry) return true;
      const c = await entry.canonical;
      if (!isTrusted(c)) await runPrompt(windowId, entry.root, c);
      return isTrusted(c);
    },
    async removeFolder(folder) {
      await ready;
      const before = trusted.length;
      trusted = trusted.filter((t) => !same(t, folder));
      if (trusted.length === before) return;
      await persist();
      await pushAll();
    },
  };
}
