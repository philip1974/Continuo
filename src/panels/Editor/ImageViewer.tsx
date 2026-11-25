// 只读图片视图(对齐 VSCode media-preview imagePreview.previewEditor)。BDD: src/__tests__/editor-image-preview/
// 居中显示,大于编辑区按比例缩小适应(小图不放大);图片背后衬棋盘格(透明像素可辨,语义 token 色,亮暗主题都给值);
// 右下角显示「宽x高 · 大小」(VSCode 在状态栏)。数据经主进程 fs:read-image 读为 data URL(不放开 file:)。
// 外部修改由 EditorPanel 按 reloadEpoch 换 key 重挂,重新读取。
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { coApi } from '@/lib/co-api';
import { useT } from '@/i18n';
import { basename } from '@/lib/path-cross';
import { failureOf, type Failure } from '@/lib/failure-of';
import { localizeErrorByCode } from '@/lib/localize-error';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { MAX_IMAGE_PREVIEW_BYTES } from '../../../electron/shared/image-preview';
import { registerEditorFocus } from './editor-focus-registry';
import { formatBinarySize } from './editor-image';

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly url: string; readonly size: number }
  | { readonly kind: 'error'; readonly failure: Failure }
  | { readonly kind: 'decode-error' };

// 棋盘格:两种相邻 surface token,8px 格(VSCode 同尺寸)。
const CHECKERBOARD: CSSProperties = {
  backgroundImage:
    'repeating-conic-gradient(var(--color-panel-soft) 0% 25%, var(--color-hover) 0% 50%)',
  backgroundSize: '16px 16px',
};

const MAX_LABEL = `${MAX_IMAGE_PREVIEW_BYTES / (1024 * 1024)}MB`;

export interface ImageViewerProps {
  readonly tabId: string;
  readonly filePath: string;
}

export function ImageViewer({ tabId, filePath }: ImageViewerProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dims, setDims] = useState<{ readonly w: number; readonly h: number } | null>(null);

  useEffect(() => {
    let live = true;
    coApi.fs.readImage(filePath).then(
      (r) => {
        if (!live) return;
        setState(r.ok ? { kind: 'ok', url: r.data.dataUrl, size: r.data.size } : { kind: 'error', failure: r });
      },
      (err: unknown) => {
        if (live) setState({ kind: 'error', failure: failureOf(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [filePath]);

  // 打开 / 关闭其它 tab 后的焦点落点(同 CodeEditor / Milkdown 登记聚焦句柄)
  useEffect(() => registerEditorFocus(tabId, () => rootRef.current?.focus()), [tabId]);

  let message: string | null = null;
  if (state.kind === 'error') {
    message =
      state.failure.code === ERROR_CODES.FS_FILE_TOO_LARGE
        ? t('editor.image.too_large', { max: MAX_LABEL })
        : t('editor.image.load_failed', { reason: localizeErrorByCode(state.failure.code, state.failure.message) });
  } else if (state.kind === 'decode-error') {
    message = t('editor.image.decode_failed');
  } else if (state.kind === 'loading') {
    message = t('common.loading');
  }

  return (
    <div className="relative h-full w-full bg-canvas">
      <div
        ref={rootRef}
        // 编辑区焦点落点(F6 / 点 tab / 打开后):panel-focus 按 data-editor-focus-target 优先聚焦
        tabIndex={0}
        data-editor-focus-target=""
        data-image-viewer=""
        role={state.kind === 'ok' ? 'img' : 'group'}
        aria-label={t('editor.image.aria', { name: basename(filePath) })}
        className="flex h-full w-full items-center justify-center overflow-auto p-4 outline-none focus-visible:outline-solid focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus-ring"
      >
        {state.kind === 'ok' ? (
          <img
            src={state.url}
            alt=""
            draggable={false}
            style={CHECKERBOARD}
            className="max-h-full max-w-full object-contain"
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setState({ kind: 'decode-error' })}
          />
        ) : (
          <p className="text-sm text-fg-muted">{message}</p>
        )}
      </div>
      {state.kind === 'ok' && (
        <div className="pointer-events-none absolute bottom-2 right-3 rounded bg-panel px-2 py-0.5 text-xs text-fg-muted">
          {dims ? `${dims.w}x${dims.h} · ` : ''}
          {formatBinarySize(state.size)}
        </div>
      )}
    </div>
  );
}
