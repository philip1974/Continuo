// 终端重命名框(VSCode 终端 tab 右键「重命名…」/ workbench.action.terminal.rename):预填当前标题,回车确定、Esc 取消;
// 非空 → 固定为用户标题(之后不再被 OSC 标题 / 进程名覆盖),留空 → 清除,回到自动标题。BDD: src/__tests__/terminal-title/
import { useId, useState, type FormEvent } from 'react';
import { Button, Input, Modal } from '@/design';
import { useT } from '@/i18n';
import { coApi } from '@/lib/co-api';
import { notifyIfFailed } from '@/notifications/notify-thrown-error';
import { getIndexedTerminalSessionById, useTerminalStore } from '@/stores/terminal.store';
import { terminalBaseTitle, terminalTitleInputOf } from '@/shell/dock/terminal-panel-id';
import { LABEL_MAX } from '../../../electron/shared/terminal-create';

export function TerminalRenameDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  // 打开时取一次:预填当前显示的基础名(不含 agent /「已退出」后缀)。
  const [initial] = useState(() => {
    const session = getIndexedTerminalSessionById(useTerminalStore.getState().sessions, sessionId);
    return { title: session ? terminalBaseTitle(terminalTitleInputOf(session)) : '', pinned: session?.userTitle !== undefined };
  });
  const [value, setValue] = useState(initial.title);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const title = value.trim();
    // 原样确定自动标题 = 没有改名:不把当前的自动名(随语言 / 程序变化)固定下来。
    if (!initial.pinned && title === initial.title.trim()) {
      onClose();
      return;
    }
    notifyIfFailed(coApi.terminal.rename(sessionId, title));
    onClose();
  };

  return (
    <Modal visible onClose={onClose} aria-labelledby={titleId} aria-describedby={hintId}>
      <form onSubmit={submit}>
        <h2 id={titleId} className="mb-3 text-sm font-medium text-fg">
          {t('panels.terminal.rename_dialog.title')}
        </h2>
        <Input
          data-autofocus
          size="sm"
          className="w-full"
          value={value}
          maxLength={LABEL_MAX}
          aria-labelledby={titleId}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
        />
        <p id={hintId} className="mb-5 mt-2 text-xs leading-relaxed text-fg-muted">
          {t('panels.terminal.rename_dialog.hint')}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t('panels.terminal.rename_dialog.cancel')}
          </Button>
          <Button type="submit" variant="primary" size="sm">
            {t('panels.terminal.rename_dialog.confirm')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
