/**
 * 该按键是否发生在 IME(拼音 / 日文 / 韩文输入法)组合期间。组合中的 Enter 是确认候选词、Esc 是
 * 取消组合、方向键是移动候选 —— 不应被输入框当成提交 / 取消 / 移动选择。
 * `isComposing` 是标准字段;`keyCode === 229` 兜底(部分浏览器 / 输入法下组合结束那次按键的
 * isComposing 已为 false,但 keyCode 仍为 229)。React 事件传 `e.nativeEvent`。
 */
export function isImeComposing(e: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return e.isComposing || e.keyCode === 229;
}
