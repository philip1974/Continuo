// BDD: workspace-trust / 主进程信任服务:首次询问、持久化、父文件夹继承、realpath / 大小写 / NFD、单飞、请求信任、移除、读失败
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceTrustService,
  type TrustData,
  type TrustPromptAnswer,
  type TrustPromptRequest,
  type WorkspaceTrustDeps,
} from '../../../electron/main/services/workspace-trust.service';
import { WORKSPACE_TRUST_MAX_FOLDERS, type WorkspaceTrustState } from '../../../electron/shared/workspace-trust';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function setup(opts: {
  data?: TrustData | null;
  loadError?: boolean;
  answers?: TrustPromptAnswer[];
  realpath?: Record<string, string>;
  platform?: NodeJS.Platform;
  enabled?: boolean;
} = {}) {
  const answers = [...(opts.answers ?? [])];
  const prompts: TrustPromptRequest[] = [];
  const pushes: [number, WorkspaceTrustState][] = [];
  const saves: TrustData[] = [];
  const deps: WorkspaceTrustDeps = {
    enabled: opts.enabled ?? true,
    load: async () => {
      if (opts.loadError) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return opts.data ?? null;
    },
    save: async (d) => {
      saves.push(d);
    },
    realpath: async (p) => opts.realpath?.[p] ?? p,
    platform: opts.platform ?? 'darwin',
    prompt: vi.fn(async (req: TrustPromptRequest) => {
      prompts.push(req);
      return answers.length > 0 ? answers.shift()! : null;
    }),
    push: (id, s) => pushes.push([id, s]),
    warn: () => undefined,
  };
  const svc = createWorkspaceTrustService(deps);
  const last = (id: number): WorkspaceTrustState | undefined => pushes.filter(([w]) => w === id).at(-1)?.[1];
  return { svc, prompts, pushes, saves, last, deps };
}

const TRUST = { trust: true, parent: false } as const;
const TRUST_PARENT = { trust: true, parent: true } as const;
const NO = { trust: false, parent: false } as const;

describe('workspace-trust 服务', () => {
  it('首次打开未信任文件夹:先推受限,弹一次对话框(带上级文件夹完整路径);信任 → 推受信任并持久化', async () => {
    const { svc, prompts, last, saves } = setup({ answers: [TRUST] });
    svc.setWindowRoot(1, '/work/proj');
    await flush();
    expect(prompts).toEqual([{ windowId: 1, root: '/work/proj', parent: '/work', persistBlocked: false }]);
    expect(last(1)).toEqual({ root: '/work/proj', trusted: true });
    expect(saves.at(-1)).toEqual({ trusted: ['/work/proj'], prompted: ['/work/proj'] });
    expect(await svc.isWindowTrusted(1, '/work/proj')).toBe(true);
  });

  it('不信任 → 受限、记为已询问;再次打开(别的窗口 / 重启后)不再询问', async () => {
    const a = setup({ answers: [NO] });
    a.svc.setWindowRoot(1, '/work/proj');
    await flush();
    expect(a.last(1)).toEqual({ root: '/work/proj', trusted: false });
    expect(await a.svc.isWindowTrusted(1, '/work/proj')).toBe(false);
    a.svc.setWindowRoot(2, '/work/proj');
    await flush();
    expect(a.prompts).toHaveLength(1);
    // 重启:用落盘数据新建服务
    const b = setup({ data: a.saves.at(-1)! });
    b.svc.setWindowRoot(1, '/work/proj');
    await flush();
    expect(b.prompts).toHaveLength(0);
    expect(b.last(1)).toEqual({ root: '/work/proj', trusted: false });
  });

  it('重启保留信任:已信任文件夹不再询问、直接受信任', async () => {
    const { svc, prompts, last } = setup({ data: { trusted: ['/work/proj'], prompted: ['/work/proj'] } });
    svc.setWindowRoot(1, '/work/proj');
    await flush();
    expect(prompts).toHaveLength(0);
    expect(last(1)).toEqual({ root: '/work/proj', trusted: true });
  });

  it('勾选「信任上级文件夹」→ 记上级;上级下的其它子文件夹不再询问,直接受信任', async () => {
    const { svc, prompts, last, saves } = setup({ answers: [TRUST_PARENT] });
    svc.setWindowRoot(1, '/work/a');
    await flush();
    expect(saves.at(-1)?.trusted).toEqual(['/work']);
    svc.setWindowRoot(1, '/work/b/deep');
    await flush();
    expect(prompts).toHaveLength(1);
    expect(last(1)).toEqual({ root: '/work/b/deep', trusted: true });
    // 上级之外不继承;前缀相同的兄弟目录不算子目录
    svc.setWindowRoot(1, '/workspace2');
    await flush();
    expect(prompts).toHaveLength(2);
  });

  it('经符号链接打开:上级取上报的原路径的上级(同 VSCode,不取链接目标的上级),写入前 realpath;规范化后的上级不覆盖当前文件夹 → 当前文件夹一并记入', async () => {
    const { svc, prompts, last, saves } = setup({
      answers: [TRUST_PARENT],
      realpath: { '/links/proj': '/real/x/proj', '/links': '/vol/links' },
    });
    svc.setWindowRoot(1, '/links/proj');
    await flush();
    expect(prompts[0]).toMatchObject({ root: '/links/proj', parent: '/links' });
    expect(saves.at(-1)?.trusted).toEqual(['/vol/links', '/real/x/proj']);
    expect(saves.at(-1)?.trusted).not.toContain('/real/x');
    expect(last(1)).toEqual({ root: '/links/proj', trusted: true });
    // 上级本身(经链接规范化)下的其它文件夹继承信任
    svc.setWindowRoot(2, '/vol/links/other');
    await flush();
    expect(last(2)?.trusted).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it('文件系统根没有上级:不提供「信任上级文件夹」', async () => {
    const { svc, prompts } = setup({ answers: [NO] });
    svc.setWindowRoot(1, '/');
    await flush();
    expect(prompts[0]?.parent).toBeNull();
  });

  it('比较按 realpath:经符号链接打开已信任目录 = 受信任;macOS 上大小写 / NFD 变体同样匹配', async () => {
    const nfc = '/Users/u/café';
    const nfd = nfc.normalize('NFD');
    const { svc, prompts, last } = setup({
      data: { trusted: ['/real/proj', nfc], prompted: [] },
      realpath: { '/link/proj': '/real/proj' },
    });
    svc.setWindowRoot(1, '/link/proj');
    svc.setWindowRoot(2, '/REAL/Proj/sub');
    svc.setWindowRoot(3, nfd);
    await flush();
    expect(last(1)?.trusted).toBe(true);
    expect(last(2)?.trusted).toBe(true);
    expect(last(3)?.trusted).toBe(true);
    expect(prompts).toHaveLength(0);
  });

  it('Linux 区分大小写:大小写不同的路径不继承信任', async () => {
    const { svc, last } = setup({ platform: 'linux', data: { trusted: ['/real/proj'], prompted: ['/REAL/PROJ'] } });
    svc.setWindowRoot(1, '/REAL/PROJ');
    await flush();
    expect(last(1)?.trusted).toBe(false);
  });

  it('同一文件夹在多个窗口同时打开:只弹一个对话框,结果推给所有窗口', async () => {
    let release!: (a: TrustPromptAnswer) => void;
    const { svc, deps, last } = setup();
    (deps.prompt as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<TrustPromptAnswer>((r) => (release = r)),
    );
    svc.setWindowRoot(1, '/work/proj');
    svc.setWindowRoot(2, '/work/proj');
    await flush();
    expect(deps.prompt).toHaveBeenCalledTimes(1);
    release(TRUST);
    await flush();
    expect(last(1)?.trusted).toBe(true);
    expect(last(2)?.trusted).toBe(true);
  });

  it('对话框未能弹出 / 抛错:保持受限,不记为已询问(下次打开再问)', async () => {
    const { svc, deps, last, saves } = setup();
    (deps.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no window'));
    svc.setWindowRoot(1, '/work/proj');
    await flush();
    expect(last(1)?.trusted).toBe(false);
    expect(saves).toHaveLength(0);
    svc.setWindowRoot(1, '/work/proj');
    await flush();
    expect(deps.prompt).toHaveBeenCalledTimes(2);
  });

  it('requestTrust(管理里的「信任」):已拒绝过也再弹对话框,由对话框结果决定', async () => {
    const { svc, prompts, last } = setup({ answers: [NO, NO, TRUST] });
    svc.setWindowRoot(1, '/work/proj');
    await flush();
    expect(await svc.requestTrust(1)).toBe(false);
    expect(last(1)?.trusted).toBe(false);
    expect(await svc.requestTrust(1)).toBe(true);
    expect(prompts).toHaveLength(3);
    expect(last(1)?.trusted).toBe(true);
    // 已受信任时不再弹
    expect(await svc.requestTrust(1)).toBe(true);
    expect(prompts).toHaveLength(3);
  });

  it('getInfo / removeFolder:直接受信任可「不信任」;经上级受信任时不能单独不信任(显示加粗条目);移除即时推受限', async () => {
    const { svc, last } = setup({ data: { trusted: ['/work', '/work/proj'], prompted: ['/work/proj'] } });
    svc.setWindowRoot(1, '/work/proj');
    await flush();
    let info = await svc.getInfo(1);
    expect(info).toMatchObject({ root: '/work/proj', trusted: true, canUntrust: false });
    expect([...info.trustedBy].sort()).toEqual(['/work', '/work/proj']);
    await svc.removeFolder('/work');
    info = await svc.getInfo(1);
    expect(info).toMatchObject({ trusted: true, trustedBy: ['/work/proj'], canUntrust: true, folders: ['/work/proj'] });
    await svc.removeFolder('/work/proj');
    expect(last(1)).toEqual({ root: '/work/proj', trusted: false });
    expect((await svc.getInfo(1)).folders).toEqual([]);
  });

  it('读持久化失败(非「不存在」):什么都不信任,且本次启动不写盘(不覆盖原文件);对话框与管理界面都标明「本次修改不会保存」', async () => {
    const { svc, last, saves, prompts } = setup({ loadError: true, answers: [TRUST] });
    svc.setWindowRoot(1, '/work/proj');
    await flush();
    expect(prompts[0]?.persistBlocked).toBe(true);
    expect(last(1)?.trusted).toBe(true); // 内存里生效
    expect(saves).toHaveLength(0);
    expect(await svc.getInfo(1)).toMatchObject({ persistBlocked: true });
    expect(await setup().svc.getInfo(1)).toMatchObject({ persistBlocked: false });
  });

  it('isWindowTrusted:根与登记不符 / 未登记 → false;关窗后 → false', async () => {
    const { svc } = setup({ data: { trusted: ['/work'], prompted: [] } });
    expect(await svc.isWindowTrusted(1, '/work/proj')).toBe(false);
    svc.setWindowRoot(1, '/work/proj');
    expect(await svc.isWindowTrusted(1, '/other')).toBe(false);
    expect(await svc.isWindowTrusted(1, '/work/proj')).toBe(true);
    svc.clearWindow(1);
    expect(await svc.isWindowTrusted(1, '/work/proj')).toBe(false);
  });

  it('关闭文件夹(root=null):推「未打开文件夹」', async () => {
    const { svc, last } = setup();
    svc.setWindowRoot(1, null);
    expect(last(1)).toEqual({ root: null, trusted: true });
  });

  it('enabled=false(E2E 默认):一切受信任、不询问', async () => {
    const { svc, prompts, last } = setup({ enabled: false });
    svc.setWindowRoot(1, '/work/proj');
    await flush();
    expect(prompts).toHaveLength(0);
    expect(last(1)?.trusted).toBe(true);
    expect(await svc.isWindowTrusted(1, '/work/proj')).toBe(true);
  });

  it('条目数有上限:超出丢最早的', async () => {
    const many = Array.from({ length: WORKSPACE_TRUST_MAX_FOLDERS }, (_, i) => `/f/${i}`);
    const { svc, saves } = setup({ data: { trusted: many, prompted: [] }, answers: [TRUST] });
    svc.setWindowRoot(1, '/new/proj');
    await flush();
    const saved = saves.at(-1)!.trusted;
    expect(saved).toHaveLength(WORKSPACE_TRUST_MAX_FOLDERS);
    expect(saved.at(-1)).toBe('/new/proj');
    expect(saved[0]).toBe('/f/1');
  });
});
