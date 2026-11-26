// 只读图片视图(对齐 VSCode media-preview imagePreview.previewEditor)。BDD: src/__tests__/editor-image-preview/
// 居中显示,初始「适应」:大于编辑区按比例缩小(小图不放大);图片背后衬棋盘格(透明像素可辨,语义 token 色,亮暗主题都给值);
// 右下角显示「宽x高 · 大小 · 比例」(VSCode 在状态栏)。数据经主进程 fs:read-image 读为 data URL(不放开 file:)。
// 缩放(同 VSCode imagePreview):单击放大 / ⌥单击缩小一档(ZOOM_LEVELS),⌘ / ⌃ 滚轮与触控板捏合连续缩放(以指针为中心),
// 键盘 + / - 按档、0 / ⌘0 回适应;放大超过 100% 像素化显示,容器滚动。
// 外部修改由 EditorPanel 按 reloadEpoch 换 key 重挂,重新读取。
// 比例与滚动位置按 tab 存进 editor-view-state-cache(VSCode webview state 保存 scale 与偏移):切 tab 重挂后恢复,
// 并随会话快照跨重启恢复。BDD: src/__tests__/editor-state-restart/
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { coApi } from '@/lib/co-api';
import { useT } from '@/i18n';
import { basename } from '@/lib/path-cross';
import { failureOf, type Failure } from '@/lib/failure-of';
import { localizeErrorByCode } from '@/lib/localize-error';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { IMAGE_MAX_SCALE, IMAGE_MIN_SCALE, MAX_IMAGE_PREVIEW_BYTES } from '../../../electron/shared/image-preview';
import { registerEditorFocus } from './editor-focus-registry';
import { useEditorGroupId } from './editor-group-context';
import { imageViewStateOf, saveImageViewState } from './editor-view-state-cache';
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

// VSCode imagePreview 的缩放档位与上下限(media/imagePreview.js:zoomLevels / MIN_SCALE / MAX_SCALE / SCALE_PINCH_FACTOR)。
const ZOOM_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 5, 7, 10, 15, 20] as const;
const MIN_SCALE = IMAGE_MIN_SCALE;
const MAX_SCALE = IMAGE_MAX_SCALE;
const SCALE_PINCH_FACTOR = 0.075;

/** 'fit' = 适应编辑区;数字 = 相对原始尺寸的比例。 */
type Scale = 'fit' | number;

const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** 下一档(严格大于当前比例的最小档位;已到顶则封顶)。 */
function zoomInFrom(scale: number): number {
  return ZOOM_LEVELS.find((level) => level > scale + 1e-6) ?? MAX_SCALE;
}

/** 上一档(严格小于当前比例的最大档位;已到底则封底)。 */
function zoomOutFrom(scale: number): number {
  return [...ZOOM_LEVELS].reverse().find((level) => level < scale - 1e-6) ?? MIN_SCALE;
}

/** 缩放锚点:指针(客户区坐标)下的图片点在缩放后保持不动;无指针(键盘)取视图中心。 */
interface ZoomAnchor {
  readonly clientX: number;
  readonly clientY: number;
  /** 锚点在图片上的相对位置(0–1)。 */
  readonly fx: number;
  readonly fy: number;
}

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
  const groupId = useEditorGroupId();
  useEffect(() => registerEditorFocus(tabId, () => rootRef.current?.focus(), groupId), [tabId, groupId]);

  const imgRef = useRef<HTMLImageElement>(null);
  // 挂载时取回该 tab 上次的比例与滚动位置(滚动在图片尺寸就绪后恢复一次)
  const [initialView] = useState(() => imageViewStateOf(tabId, groupId));
  const [scale, setScale] = useState<Scale>(initialView?.scale ?? 'fit');
  const scaleRef = useRef<Scale>(scale);
  scaleRef.current = scale;
  const pendingScrollRef = useRef(initialView);
  const anchorRef = useRef<ZoomAnchor | null>(null);
  // 按住 ⌥ 时光标换缩小镜(VSCode 同:按键状态挂在 window 上,焦点不在视图里也跟随)
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setAltHeld(e.altKey);
    const reset = () => setAltHeld(false);
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('blur', reset);
    };
  }, []);

  /** 换到新比例;'fit' 之外先按适应时的实际显示比例起算(VSCode firstZoom)。point = 指针客户区坐标(缺省取视图中心)。 */
  const zoomTo = (next: (current: number) => Scale, point?: { readonly clientX: number; readonly clientY: number }) => {
    const img = imgRef.current;
    const root = rootRef.current;
    if (!img || !root || !img.naturalWidth) return;
    const current = scaleRef.current === 'fit' ? img.clientWidth / img.naturalWidth : scaleRef.current;
    const target = next(current);
    const rect = img.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    const clientX = point?.clientX ?? view.left + view.width / 2;
    const clientY = point?.clientY ?? view.top + view.height / 2;
    const ratio = (v: number, start: number, size: number) => (size > 0 ? Math.min(1, Math.max(0, (v - start) / size)) : 0.5);
    anchorRef.current = { clientX, clientY, fx: ratio(clientX, rect.left, rect.width), fy: ratio(clientY, rect.top, rect.height) };
    scaleRef.current = target;
    setScale(target);
  };

  // 缩放后把锚点对应的图片点滚回原客户区位置(以指针 / 视图中心为中心缩放)
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const img = imgRef.current;
    const root = rootRef.current;
    if (!anchor || !img || !root) return;
    const rect = img.getBoundingClientRect();
    root.scrollLeft += rect.left + anchor.fx * rect.width - anchor.clientX;
    root.scrollTop += rect.top + anchor.fy * rect.height - anchor.clientY;
  }, [scale]);

  // 图片尺寸就绪(放大后的布局已定)→ 恢复上次的滚动位置一次
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const root = rootRef.current;
    if (!pending || !dims || !root) return;
    pendingScrollRef.current = undefined;
    root.scrollLeft = pending.scrollLeft;
    root.scrollTop = pending.scrollTop;
  }, [dims]);

  // 比例 / 滚动变化时记下(滚动恢复前不记,免得初始 0 覆盖待恢复的位置)
  const saveView = () => {
    const root = rootRef.current;
    if (!root || pendingScrollRef.current) return;
    saveImageViewState(tabId, { scale: scaleRef.current, scrollLeft: root.scrollLeft, scrollTop: root.scrollTop }, groupId);
  };
  // 挂载时的比例不必再记(未缩放过的图片不留状态)
  const scaleSavedRef = useRef(scale);
  useEffect(() => {
    if (scaleSavedRef.current === scale) return;
    scaleSavedRef.current = scale;
    saveView();
  }, [scale]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘ / ⌃ 滚轮与触控板捏合(Chromium 以 ctrlKey wheel 上报)缩放;React 的 wheel 监听是 passive,拦不住页面缩放 / 滚动,
  // 故原生挂(passive: false)。不带修饰键的滚轮照常滚动。
  const loaded = state.kind === 'ok';
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !loaded) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 : -1;
      zoomTo((current) => clampScale(current * (1 - delta * SCALE_PINCH_FACTOR)), e);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [loaded]);

  // 单击视图(VSCode 挂在整个容器上,点图片外的空白处同样缩放)。焦点不在视图里时第一下点击只激活(聚焦)不缩放 ——
  // VSCode imagePreview:mousedown 时 consumeClick = !isActive,随后的 click 被吞掉。mousedown 时焦点尚未移入视图。
  const consumeClickRef = useRef(false);
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!loaded || e.button !== 0) return;
    consumeClickRef.current = !rootRef.current?.contains(rootRef.current.ownerDocument.activeElement);
  };
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!loaded || e.button !== 0) return;
    if (consumeClickRef.current) {
      consumeClickRef.current = false;
      return;
    }
    zoomTo(e.altKey ? zoomOutFrom : zoomInFrom, e);
  };

  // 键盘(焦点在视图上):+ / = 放大、- 缩小(按档),0 / ⌘0(Ctrl+0)回适应。带其它修饰键的组合交给全局快捷键。
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!loaded || e.altKey) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === '0') {
      e.preventDefault();
      zoomTo(() => 'fit');
    } else if (mod) {
      return;
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomTo(zoomInFrom);
    } else if (e.key === '-') {
      e.preventDefault();
      zoomTo(zoomOutFrom);
    }
  };

  const fit = scale === 'fit';
  const zoomText = fit ? t('editor.image.zoom_fit') : `${Math.round(scale * 100)}%`;
  const imageStyle: CSSProperties =
    fit || !dims
      ? CHECKERBOARD
      : {
          ...CHECKERBOARD,
          width: `${dims.w * scale}px`,
          height: `${dims.h * scale}px`,
          // 放大超过原始尺寸:按像素显示(看清单个像素),不做平滑插值
          ...(scale > 1 ? { imageRendering: 'pixelated' } : null),
        };

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
        // 居中用 m-auto(非 justify/items-center):放大超出视图时左 / 上侧也能滚到
        className="flex h-full w-full overflow-auto p-4 outline-none focus-visible:outline-solid focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus-ring"
        style={loaded ? { cursor: altHeld ? 'zoom-out' : 'zoom-in' } : undefined}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        onClick={onClick}
        onScroll={saveView}
      >
        {state.kind === 'ok' ? (
          <img
            ref={imgRef}
            src={state.url}
            alt=""
            draggable={false}
            style={imageStyle}
            className={fit ? 'm-auto max-h-full max-w-full object-contain' : 'm-auto max-w-none shrink-0'}
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
          {` · ${zoomText}`}
        </div>
      )}
    </div>
  );
}
