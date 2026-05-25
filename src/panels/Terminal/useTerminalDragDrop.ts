import { useEffect, useRef, type RefObject } from 'react';
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

function hasFiles(dataTransfer: DataTransfer | null): dataTransfer is DataTransfer {
  return dataTransfer !== null && Array.from(dataTransfer.types).includes('Files');
}

function pointInRect(
  x: number,
  y: number,
  rect: DOMRect | DOMRectReadOnly,
): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    x >= rect.left &&
    x < rect.right &&
    y >= rect.top &&
    y < rect.bottom
  );
}

export function useTerminalDragDrop({
  sessionId,
  focus,
}: UseTerminalDragDropInput): {
  ref: RefObject<HTMLDivElement>;
} {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current === null) return;
    const ownerDoc = ref.current.ownerDocument || document;

    const isTerminalFileDrag = (e: DragEvent): e is DragEvent & {
      dataTransfer: DataTransfer;
    } => {
      if (!hasFiles(e.dataTransfer)) return false;
      const dropZone = ref.current;
      if (dropZone === null) return false;
      return pointInRect(e.clientX, e.clientY, dropZone.getBoundingClientRect());
    };

    const onDragEnter = (e: DragEvent) => {
      if (!isTerminalFileDrag(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer.dropEffect = 'copy';
    };

    const onDragOver = (e: DragEvent) => {
      if (!isTerminalFileDrag(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer.dropEffect = 'copy';
    };

    const onDrop = (e: DragEvent) => {
      if (!isTerminalFileDrag(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const dataTransfer = e.dataTransfer;
      const files = Array.from(dataTransfer.files);

      if (import.meta.env.DEV) {
        console.debug('[terminal-drag-drop] capture drop', {
          sessionId,
          files: files.length,
          types: Array.from(dataTransfer.types),
        });
      }

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
    };

    ownerDoc.addEventListener('dragenter', onDragEnter, true);
    ownerDoc.addEventListener('dragover', onDragOver, true);
    ownerDoc.addEventListener('drop', onDrop, true);
    return () => {
      ownerDoc.removeEventListener('dragenter', onDragEnter, true);
      ownerDoc.removeEventListener('dragover', onDragOver, true);
      ownerDoc.removeEventListener('drop', onDrop, true);
    };
  }, [focus, sessionId, t]);

  return { ref: ref as RefObject<HTMLDivElement> };
}
