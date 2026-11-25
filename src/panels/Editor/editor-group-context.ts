// 编辑器面板所在的编辑器组(= dock 面板 id)。EditorPanel 提供,tab 栏 / 编辑引擎据此按组登记聚焦句柄、切换本组的 tab。
// 缺省 = 第一个组(测试直接渲染编辑器部件时)。BDD: src/__tests__/editor-groups/

import { createContext, useContext } from 'react';
import { PRIMARY_EDITOR_GROUP_ID } from '../../../electron/shared/editor-group-id';

export const EditorGroupIdContext = createContext<string>(PRIMARY_EDITOR_GROUP_ID);

export function useEditorGroupId(): string {
  return useContext(EditorGroupIdContext);
}
