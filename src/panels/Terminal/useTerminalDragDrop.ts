import { useCallback } from 'react';
import { coApi } from '@/lib/co-api';
import {
  joinWithTrailingSpace,
  quotePaths,
} from '@/lib/shell-quote';
import { useT } from '@/i18n';
import { notify } from '@/notifications/notify';
import { getShellFamily } from '@/stores/terminal.store';

export interface UseTerminalDragDropInput {
  readonly sessionId: string;
  readonly focus: () => void;
}

function hasFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files');
}

export function useTerminalDragDrop({
  sessionId,
  focus,
}: UseTerminalDragDropInput): {
  onDragOver: React.DragEventHandler<HTMLDivElement>;
  onDrop: React.DragEventHandler<HTMLDivElement>;
} {
  const t = useT();

  const onDragOver = useCallback<React.DragEventHandler<HTMLDivElement>>((e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback<React.DragEventHandler<HTMLDivElement>>(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);

      void (async () => {
        const paths: string[] = [];
        let webDragCount = 0;

        for (const file of files) {
          const path = await coApi.window.getPathForFile(file);
          if (path) {
            paths.push(path);
          } else {
            webDragCount += 1;
          }
        }

        const shellFamily = getShellFamily(sessionId);
        const { quoted, skipped } = quotePaths(paths, shellFamily);

        if (quoted.length === 0 && skipped.length === 0) {
          notify.warn(t('panels.terminal.drag_drop.no_os_path'));
          return;
        }

        const r = await coApi.terminal.write(
          sessionId,
          joinWithTrailingSpace(quoted),
        );
        if (!r.ok) {
          notify.warn(t('panels.terminal.drag_drop.write_failed'));
        } else {
          focus();
        }

        const skippedCount = skipped.length + webDragCount;
        if (skippedCount > 0) {
          notify.warn(
            t('panels.terminal.drag_drop.partial_skip', {
              count: skippedCount,
            }),
          );
        }
      })();
    },
    [focus, sessionId, t],
  );

  return { onDragOver, onDrop };
}
