// 编码 / 行尾选择器的列表项(纯函数;VSCode editorStatus ChangeEncodingAction / ChangeEOLAction 的 picks)。
// BDD: src/__tests__/editor-text-encoding/

import {
  isDecodableEncoding,
  TEXT_ENCODING_IDS,
  TEXT_ENCODINGS,
  type TextEncodingId,
} from '../../../electron/shared/text-encoding';
import type { LineEnding } from '@/panels/Editor/editor-encoding';
import type { EncodingPickRequest } from './store';

export interface EncodingPickItem {
  /** 'reopen' / 'save'(第一步)、编码 id、'LF' / 'CRLF'。 */
  readonly id: string;
  /** 文案:第一步与行尾给 i18n key(labelKey),编码给显示名(label,不翻译,同 VSCode)。 */
  readonly label?: string;
  readonly labelKey?: string;
  /** 次要文字(编码 id,同 VSCode description)。 */
  readonly description?: string;
}

export const LINE_ENDINGS: readonly LineEnding[] = ['LF', 'CRLF'];

/**
 * 列表项与初始选中行。current:tab 当前编码 / 行尾(选中它;utf8bom 的 tab 在「重新打开」里没有 utf8bom,选中其别名 utf8,
 * 同 VSCode aliasMatchIndex)。
 */
export function encodingPickItems(
  request: EncodingPickRequest,
  current: { readonly encoding?: TextEncodingId; readonly eol?: LineEnding } = {},
): { readonly items: readonly EncodingPickItem[]; readonly selectedIndex: number } {
  if (request.kind === 'action') {
    return {
      items: [
        { id: 'reopen', labelKey: 'encoding_picker.reopen' },
        { id: 'save', labelKey: 'encoding_picker.save' },
      ],
      selectedIndex: 0,
    };
  }
  if (request.kind === 'eol') {
    const items = LINE_ENDINGS.map((eol) => ({ id: eol, label: eol }));
    return { items, selectedIndex: current.eol === 'CRLF' ? 1 : 0 };
  }
  const ids = request.kind === 'save' ? TEXT_ENCODING_IDS : TEXT_ENCODING_IDS.filter(isDecodableEncoding);
  const items = ids.map((id) => ({ id, label: TEXT_ENCODINGS[id].labelLong, description: id }));
  let selectedIndex = current.encoding === undefined ? -1 : ids.indexOf(current.encoding);
  if (selectedIndex < 0 && current.encoding === 'utf8bom') selectedIndex = ids.indexOf('utf8');
  return { items, selectedIndex: Math.max(0, selectedIndex) };
}
