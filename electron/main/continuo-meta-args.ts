import { hostname as osHostname } from 'node:os';
import type { WebPreferences } from 'electron';

interface BuildCommonWebPreferencesInput {
  readonly preload?: string;
  readonly isPackaged?: boolean;
  /** 本机 hostname(省略 → os.hostname())。 */
  readonly hostname?: string;
}

// topic 48: main-side pure helper for webPreferences.additionalArguments.
export function buildContinuoPackagedArg(isPackaged: boolean): string {
  return `--continuo-packaged=${isPackaged}`;
}

// OSC7:shell 集成(bash/fish)与 oh-my-zsh 等发 `file://<真实 hostname>$PWD`,renderer 的 OSC7
// parser 须接受本机 hostname;sandbox renderer 拿不到 os.hostname → 经 additionalArguments 注入。
export function buildContinuoHostnameArg(hostname: string): string {
  return `--continuo-hostname=${hostname}`;
}

export function buildCommonWebPreferences(
  input: BuildCommonWebPreferencesInput = {},
): WebPreferences {
  const prefs: WebPreferences = {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    // issue #34:Chromium 在 macOS 上偶发误判窗口"不可见"触发 backgroundThrottling,
    // 暂停 paint 后永久不退出 → 进程健康但屏幕静止。Continuo 是 IDE 类应用,
    // 窗口永远应保持 paint;关掉节流。
    backgroundThrottling: false,
    additionalArguments: [
      buildContinuoPackagedArg(input.isPackaged ?? false),
      buildContinuoHostnameArg(input.hostname ?? osHostname()),
    ],
  };

  if (input.preload !== undefined) {
    prefs.preload = input.preload;
  }

  return prefs;
}
