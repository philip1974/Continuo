import { hostname as osHostname, release as osRelease } from 'node:os';
import type { WebPreferences } from 'electron';

interface BuildCommonWebPreferencesInput {
  readonly preload?: string;
  /** 本机 hostname(省略 → os.hostname())。 */
  readonly hostname?: string;
  /** 平台(省略 → process.platform)。 */
  readonly platform?: NodeJS.Platform;
  /** os.release()(省略 → 实际值);仅 win32 用于取 build 号。 */
  readonly osRelease?: string;
}

// OSC7:shell 集成(bash/fish)与 oh-my-zsh 等发 `file://<真实 hostname>$PWD`,renderer 的 OSC7
// parser 须接受本机 hostname;sandbox renderer 拿不到 os.hostname → 经 additionalArguments 注入。
export function buildContinuoHostnameArg(hostname: string): string {
  return `--continuo-hostname=${hostname}`;
}

// 终端:xterm 需知道 Windows build 号才能按 ConPTY 能力关 reflow(build < 21376 时 ConPTY 自行重绘,
// xterm 再 reflow 既白做 O(scrollback) 又与之冲突);sandbox renderer 拿不到 os.release → 同通道注入。
export function buildContinuoWindowsBuildArg(build: number): string {
  return `--continuo-windows-build=${build}`;
}

/** Windows os.release() 形如 `10.0.19045`,第三段即 build 号;取不到 → null。 */
export function parseWindowsBuildNumber(release: string): number | null {
  const build = release.split('.')[2];
  return build !== undefined && /^\d+$/.test(build) ? Number(build) : null;
}

export function buildCommonWebPreferences(
  input: BuildCommonWebPreferencesInput = {},
): WebPreferences {
  const additionalArguments = [buildContinuoHostnameArg(input.hostname ?? osHostname())];
  if ((input.platform ?? process.platform) === 'win32') {
    const build = parseWindowsBuildNumber(input.osRelease ?? osRelease());
    if (build !== null) additionalArguments.push(buildContinuoWindowsBuildArg(build));
  }

  const prefs: WebPreferences = {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    // issue #34:Chromium 在 macOS 上偶发误判窗口"不可见"触发 backgroundThrottling,
    // 暂停 paint 后永久不退出 → 进程健康但屏幕静止。Continuo 是 IDE 类应用,
    // 窗口永远应保持 paint;关掉节流。
    backgroundThrottling: false,
    additionalArguments,
  };

  if (input.preload !== undefined) {
    prefs.preload = input.preload;
  }

  return prefs;
}
