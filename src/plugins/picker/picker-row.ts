// 命令面板 / Quick Open 列表行的共享样式。
//
// 弹窗内容区背景是 --md-surface-container-high(= bg-hover),选中行若用 bg-hover 与背景计算值完全相同,看不出
// 选中项。选中行:accent 低透明度底 + 左侧 accent 竖条(VSCode Quick Input 的选中行同样是明显的强调底色);竖条
// 对弹窗背景两主题均 ≥ 3:1(规范见 src/__tests__/picker-shared/)。未选中行占同宽透明边,切换选中不跳动;
// 鼠标悬停用更淡的 accent 底(bg-hover 在弹窗上同样不可见)。

const PICKER_ROW_BASE_CLASS_NAME =
  'flex cursor-pointer items-center gap-2 border-l-2 px-3 text-xs';
const PICKER_ROW_SELECTED_CLASS_NAME =
  `${PICKER_ROW_BASE_CLASS_NAME} border-accent bg-accent/15 text-fg`;
const PICKER_ROW_IDLE_CLASS_NAME =
  `${PICKER_ROW_BASE_CLASS_NAME} border-transparent text-fg-muted hover:bg-accent/10`;

export function pickerRowClassName(selected: boolean): string {
  return selected ? PICKER_ROW_SELECTED_CLASS_NAME : PICKER_ROW_IDLE_CLASS_NAME;
}
