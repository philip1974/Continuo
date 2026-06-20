import type { WebPreferences } from 'electron';

interface BuildCommonWebPreferencesInput {
  readonly preload?: string;
  readonly isPackaged?: boolean;
}

// topic 48: main-side pure helper for webPreferences.additionalArguments.
export function buildContinuoPackagedArg(isPackaged: boolean): string {
  return `--continuo-packaged=${isPackaged}`;
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
    ],
  };

  if (input.preload !== undefined) {
    prefs.preload = input.preload;
  }

  return prefs;
}
