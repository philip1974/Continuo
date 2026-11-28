// 屏幕录制模式的浮层(懒加载:模式打开后才加载本 chunk)。主窗与每个 popout 子窗都在捕获阶段监听 keydown / 鼠标:
// - 按键浮层画在最近一次按键所在的窗口底部(VSCode:标记挂在 activeContainer,随获焦窗口移动),距底 screencastMode.verticalOffset%、
//   字号 screencastMode.fontSize;最后一次按键 keyboardOverlayTimeout 毫秒后淡出(减弱动效时直接消失,见 screencast.css);
// - 鼠标按下处画圆圈,按住移动跟随,松开消失(画在按下所在的窗口)。
// 浮层只是给观众看的视觉提示:aria-hidden、不接收指针事件。键位用 design KeyCap(快捷键页同款),颜色全走语义 token。
// 对照 VSCode src/vs/workbench/browser/actions/developerActions.ts ToggleScreencastModeAction(状态与按键逻辑见 screencast-store /
// screencast-keys,样式见 screencast.css)。
// BDD: src/__tests__/screencast-mode/

import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KeyCap } from '@/design';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import { useSettingValue } from '@/plugins/settings/values-store';
import {
  SCREENCAST_FONT_SIZE,
  SCREENCAST_KEYBOARD_OVERLAY_TIMEOUT,
  SCREENCAST_VERTICAL_OFFSET,
} from '@/plugins/settings/core-setting-specs';
import { getPopoutDocuments, subscribePopoutDocuments } from '@/shell/dock/popout-documents';
import { recordScreencastPress, setScreencastMouse, useScreencastStore } from './screencast-store';
import { describeScreencastKey } from './screencast-keys';
import './screencast.css';

/** 鼠标指示圆圈直径(VSCode screencastMode.mouseIndicatorSize 默认 20)。 */
const MOUSE_INDICATOR_SIZE = 20;

/** 事件所在窗口的文档(目标是元素 → 其文档;是文档 / 窗口本身 → 该文档)。 */
function eventDocument(e: Event): Document {
  const target = e.target as (Node & { document?: Document }) | null;
  if (!target) return document;
  if (target.ownerDocument) return target.ownerDocument;
  if (target.nodeType === 9) return target as unknown as Document;
  return target.document ?? document;
}

function KeyboardOverlay(): ReactNode {
  const presses = useScreencastStore((s) => s.presses);
  const visible = useScreencastStore((s) => s.visible);
  const fontSize = useSettingValue(SCREENCAST_FONT_SIZE.id, SCREENCAST_FONT_SIZE.default);
  const offset = useSettingValue(SCREENCAST_VERTICAL_OFFSET.id, SCREENCAST_VERTICAL_OFFSET.default);
  return (
    <div
      aria-hidden="true"
      data-screencast-keyboard=""
      data-visible={visible && presses.length > 0 ? 'true' : 'false'}
      className="wm-screencast-keyboard"
      style={{ fontSize: `${fontSize}px`, bottom: `${offset}%` }}
    >
      {presses.map((p) => (
        <span key={p.id} className="wm-screencast-press">
          {p.title !== undefined && <span className="wm-screencast-title">{p.title}</span>}
          <KeyCap className="wm-screencast-key">{p.keys}</KeyCap>
        </span>
      ))}
    </div>
  );
}

function MouseIndicator({ x, y }: { readonly x: number; readonly y: number }): ReactNode {
  return (
    <div
      aria-hidden="true"
      data-screencast-mouse=""
      className="wm-screencast-mouse"
      style={{
        width: MOUSE_INDICATOR_SIZE,
        height: MOUSE_INDICATOR_SIZE,
        left: x - MOUSE_INDICATOR_SIZE / 2,
        top: y - MOUSE_INDICATOR_SIZE / 2,
      }}
    />
  );
}

function OverlayIn({ doc }: { readonly doc: Document }): ReactNode {
  const keyboardHere = useScreencastStore((s) => (s.doc ?? document) === doc);
  const mouse = useScreencastStore((s) => (s.mouse?.doc === doc ? s.mouse : null));
  const content = (
    <>
      {keyboardHere && <KeyboardOverlay />}
      {mouse && <MouseIndicator x={mouse.x} y={mouse.y} />}
    </>
  );
  return doc === document ? content : createPortal(content, doc.body);
}

export default function ScreencastOverlay(): ReactNode {
  const popoutDocs = useSyncExternalStore(subscribePopoutDocuments, getPopoutDocuments);
  const all = useRegistry(coApp.commands);
  const overrides = useKeybindingsStore((s) => s.overrides);
  const timeout = useSettingValue(SCREENCAST_KEYBOARD_OVERLAY_TIMEOUT.id, SCREENCAST_KEYBOARD_OVERLAY_TIMEOUT.default);
  const platform = useMemo(() => detectPlatform(), []);
  // 监听器只随窗口集合重挂;命令表 / 改键 / 设置经 ref 取最新
  const latest = useRef({ all, overrides, timeout });
  latest.current = { all, overrides, timeout };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const l = latest.current;
      const described = describeScreencastKey(e, { all: l.all, get: (id) => coApp.commands.get(id) }, platform, l.overrides);
      if (described) recordScreencastPress(described.press, described.restart, eventDocument(e), l.timeout);
    };
    let down = false;
    const onMouseDown = (e: MouseEvent): void => {
      down = true;
      setScreencastMouse({ doc: eventDocument(e), x: e.clientX, y: e.clientY });
    };
    const onMouseMove = (e: MouseEvent): void => {
      if (down) setScreencastMouse({ doc: eventDocument(e), x: e.clientX, y: e.clientY });
    };
    const onMouseUp = (): void => {
      down = false;
      setScreencastMouse(null);
    };
    const windows = [window, ...popoutDocs.map((d) => d.defaultView).filter((w): w is Window & typeof globalThis => w !== null)];
    for (const w of windows) {
      w.addEventListener('keydown', onKeyDown, true);
      w.addEventListener('mousedown', onMouseDown, true);
      w.addEventListener('mousemove', onMouseMove, true);
      w.addEventListener('mouseup', onMouseUp, true);
    }
    return () => {
      for (const w of windows) {
        w.removeEventListener('keydown', onKeyDown, true);
        w.removeEventListener('mousedown', onMouseDown, true);
        w.removeEventListener('mousemove', onMouseMove, true);
        w.removeEventListener('mouseup', onMouseUp, true);
      }
    };
  }, [popoutDocs, platform]);

  return (
    <>
      <OverlayIn doc={document} />
      {popoutDocs.map((doc) => (
        <OverlayIn key={docKey(doc)} doc={doc} />
      ))}
    </>
  );
}

// popout 文档的稳定 key(收回前面的子窗时,后面子窗的浮层不重挂)
const docKeys = new WeakMap<Document, string>();
let nextDocKey = 0;
function docKey(doc: Document): string {
  let key = docKeys.get(doc);
  if (key === undefined) {
    nextDocKey += 1;
    key = `popout-${String(nextDocKey)}`;
    docKeys.set(doc, key);
  }
  return key;
}
