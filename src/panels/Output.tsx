import { useLayoutEffect, useRef, useState } from 'react';
import { Button, EmptyState, IconButton, MenuItem } from '@/design';
import { useT } from '@/i18n';
import { DropdownMenu } from '@/lib/dropdown-menu';
import { ChevronDownIcon, ClearAllIcon, LockIcon } from '@/lib/ui-icons';
import {
  clearOutputChannel,
  setActiveOutputChannel,
  setOutputAutoScroll,
  useActiveOutputChannelId,
  useOutputAutoScroll,
  useOutputChannelSnapshot,
  useOutputChannels,
} from '@/plugins/output/output-channels';

const CHEVRON = <ChevronDownIcon size={12} />;
const CLEAR_ICON = <ClearAllIcon size={14} />;
const LOCKED_ICON = <LockIcon size={14} locked />;
const UNLOCKED_ICON = <LockIcon size={14} locked={false} />;
/** 离底部不超过这么多像素算「在底部」(智能滚动:滚回底部即恢复自动滚动)。 */
const BOTTOM_SLACK_PX = 4;

/**
 * 输出面板(BDD: src/__tests__/plugin-output-channel/)。对齐 VSCode 输出视图(src/vs/workbench/contrib/output/browser/
 * outputView.ts、output.contribution.ts):标题栏的通道下拉切换通道,「清除输出」,「自动滚动」开关(锁);内容变化时
 * 未锁定则滚到最后一行,手动向上滚即锁定、滚回底部即解锁(output.smartScroll)。没有任何通道时只显示空状态。
 */
export function Output() {
  const t = useT();
  const channels = useOutputChannels();
  const activeId = useActiveOutputChannelId();
  const active = channels.find((c) => c.id === activeId) ?? channels[0] ?? null;
  const snapshot = useOutputChannelSnapshot(active?.id ?? null);
  const autoScroll = useOutputAutoScroll();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 本组件自己触发的滚动(不当作用户滚动去锁定)。 */
  const programmatic = useRef(false);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !autoScroll) return;
    programmatic.current = true;
    body.scrollTop = body.scrollHeight;
  }, [snapshot.version, autoScroll, active?.id]);

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    if (programmatic.current) {
      programmatic.current = false;
      return;
    }
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= BOTTOM_SLACK_PX;
    setOutputAutoScroll(atBottom);
  };

  if (active === null) {
    return (
      // 没有任何控件:根是打开 / 显示输出后的焦点落点(只经脚本聚焦,不进 Tab 顺序;BDD: open-panel-focus)。
      <div tabIndex={-1} data-panel-focus-root="" className="flex h-full w-full overflow-auto outline-none">
        <EmptyState>{t('panels.output.empty')}</EmptyState>
      </div>
    );
  }

  const channelLabel = t('panels.output.channel');
  const autoScrollLabel = t(autoScroll ? 'panels.output.auto_scroll_off' : 'panels.output.auto_scroll_on');
  return (
    <div tabIndex={-1} data-panel-focus-root="" className="flex h-full w-full flex-col outline-none">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`${channelLabel}: ${active.name}`}
          title={channelLabel}
          data-output-channel-picker=""
          onClick={() => setMenuOpen((v) => !v)}
          className="min-w-0 max-w-[60%] !gap-1"
        >
          <span className="truncate">{active.name}</span>
          <span aria-hidden="true" className="shrink-0 text-fg-muted">
            {CHEVRON}
          </span>
        </Button>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} triggerRef={triggerRef}>
          {({ closeAndRestore }) =>
            channels.map((c) => (
              <MenuItem
                key={c.id}
                checked={c.id === active.id}
                checkKind="radio"
                title={c.ownerId ?? undefined}
                onClick={() => {
                  closeAndRestore();
                  setActiveOutputChannel(c.id);
                }}
              >
                {c.name}
              </MenuItem>
            ))
          }
        </DropdownMenu>
        <div className="flex-1" />
        <IconButton
          size="xs"
          title={t('panels.output.clear')}
          aria-label={t('panels.output.clear')}
          onClick={() => clearOutputChannel(active.id)}
        >
          {CLEAR_ICON}
        </IconButton>
        <IconButton
          size="xs"
          title={autoScrollLabel}
          aria-label={autoScrollLabel}
          aria-pressed={!autoScroll}
          onClick={() => setOutputAutoScroll(!autoScroll)}
        >
          {autoScroll ? UNLOCKED_ICON : LOCKED_ICON}
        </IconButton>
      </div>
      <div
        ref={bodyRef}
        onScroll={onScroll}
        role="document"
        aria-label={active.name}
        data-output-channel={active.id}
        className="min-h-0 flex-1 overflow-auto"
      >
        <pre className="m-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-fg">{snapshot.text}</pre>
      </div>
    </div>
  );
}
