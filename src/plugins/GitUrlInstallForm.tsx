// 「从 Git URL 安装」输入行的单一实现(设置 → 插件、插件市场两处共用;此前各写一份,R8 单飞 / E282 截断 /
// A94-A95 aria-busy 与忙碌镜像等修复都在两处各补一次)。
//
// 只管输入、按钮与忙碌态;安装调用与结果消息(文案、live region、成功后的附加动作)留给调用方 ——
// 两处的文案不同,设置页的消息区还被卸载 / 生命周期操作共用。

import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, Input } from '@/design';
import { isImeComposing } from '@/design/ime';
import { useSingleFlight } from '@/lib/use-single-flight';
import { SR_ONLY_STYLE } from '@/lib/sr-only';
import { clampGitUrl } from '../../electron/shared/plugins-channels';

export interface GitUrlInstallFormProps {
  /** 输入框可访问名(placeholder 是 URL 示例而非标签)。 */
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly installLabel: string;
  readonly installingLabel: string;
  /** 用已 trim 的 URL 执行安装;返回 true 时清空输入(安装成功)。 */
  readonly install: (url: string) => Promise<boolean>;
}

export function GitUrlInstallForm({
  ariaLabel,
  placeholder,
  installLabel,
  installingLabel,
  install,
}: GitUrlInstallFormProps) {
  const [url, setUrl] = useState('');
  const trimmedUrl = useMemo(() => url.trim(), [url]);
  // race(R8):同步单飞闸门 —— disabled={busy} 是 render 后状态,同一 tick 内双击 / Enter 会两次进入
  // onInstall,启动两次 installFromGit(主进程双 clone,第二个常 EEXIST 把成功覆盖成失败)。
  const { busy, run } = useSingleFlight();

  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const onInstall = async (): Promise<void> => {
    if (!trimmedUrl) return;
    await run(async () => {
      if (await install(trimmedUrl)) setUrl('');
    });
    // 从按钮发起时,busy 期间按钮 disabled 会把焦点甩回 body(Chrome 里 activeElement 还可能停在已禁用的按钮上):
    // 结束后还给输入框;焦点已被用户移到本行之外则不抢。
    const input = inputRef.current;
    if (!input) return;
    const active = input.ownerDocument.activeElement;
    if (
      active === null ||
      active === input.ownerDocument.body ||
      (active !== input && rowRef.current?.contains(active))
    ) {
      input.focus();
    }
  };

  // Enter 提交(VSCode 输入框同款);IME 组合中的 Enter 是确认候选词,不算提交。
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || isImeComposing(e.nativeEvent)) return;
    e.preventDefault();
    void onInstall();
  };

  return (
    <>
      <div ref={rowRef} className="mt-3 flex items-center gap-2">
        <Input
          ref={inputRef}
          size="sm"
          aria-label={ariaLabel}
          placeholder={placeholder}
          // 地址里可能带访问令牌(https://<token>@host/…):屏幕录制模式不显示这里的按键(BDD: src/__tests__/screencast-mode/)
          data-screencast-sensitive=""
          value={url}
          // 边界(E282):截断超长 git URL(防 paste 撑 React state + IPC structured-clone 放大,main schema 才拒)。
          onChange={(e) => setUrl(clampGitUrl(e.target.value))}
          onKeyDown={onKeyDown}
          // 安装中 readOnly 而非 disabled:disabled 会让正在输入框里的焦点掉回 body。
          readOnly={busy}
          aria-busy={busy}
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void onInstall()}
          disabled={busy || !trimmedUrl}
          // a11y(A94/A95):安装中标 aria-busy。
          aria-busy={busy}
        >
          {busy ? installingLabel : installLabel}
        </Button>
      </div>
      {/* a11y(A94/A95,A51 同族):安装 loading 瞬时态,焦点在按钮时文字变化不一定被播报 → 视觉隐藏
          role=status 镜像「安装中」(仅 busy 时输出;结果由调用方的消息 live region 播报)。 */}
      <span style={SR_ONLY_STYLE} role="status">
        {busy ? installingLabel : ''}
      </span>
    </>
  );
}
