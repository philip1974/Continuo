export const TAB_DRAG_MIME = 'application/x-continuo-terminal-tab';

export interface TabDragPayload {
  readonly version: 1;
  readonly windowId: number;
  readonly sourcePanelId: string;
  readonly sourceTabId: string;
  readonly sourceLeafId: string;
  readonly ptyId: string;
  readonly sessionId: string;
  readonly title: string;
}

export function encodeTabDragPayload(payload: TabDragPayload): string {
  return JSON.stringify(payload);
}

export function decodeTabDragPayload(
  dataTransfer: DataTransfer | null,
): TabDragPayload | null {
  if (!dataTransfer) return null;
  const raw = dataTransfer.getData(TAB_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TabDragPayload>;
    if (parsed.version !== 1) return null;
    if (
      typeof parsed.windowId !== 'number' ||
      typeof parsed.sourcePanelId !== 'string' ||
      typeof parsed.sourceTabId !== 'string' ||
      typeof parsed.sourceLeafId !== 'string' ||
      typeof parsed.ptyId !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.title !== 'string'
    ) {
      return null;
    }
    return parsed as TabDragPayload;
  } catch {
    return null;
  }
}
