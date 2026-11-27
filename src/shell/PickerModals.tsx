// 工作台选择器(命令面板 / Quick Open 含转到行 / 打开最近 / 颜色主题 / 编码与行尾):画在触发它的窗口(popout 子窗里打开 → portal 进子窗,见
// picker-window)。App 顶层常驻挂载。BDD: src/__tests__/popout-picker/

import { CommandPalette } from '@/plugins/command-palette/CommandPalette';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { QuickOpenModal } from '@/plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { OpenRecentModal } from '@/plugins/open-recent/OpenRecentModal';
import { useOpenRecentStore } from '@/plugins/open-recent/store';
import { ThemePickerModal } from '@/plugins/theme-picker/ThemePickerModal';
import { useThemePickerStore } from '@/plugins/theme-picker/store';
import { EncodingPickerModal } from '@/plugins/editor-encoding/EncodingPickerModal';
import { useEncodingPickerStore } from '@/plugins/editor-encoding/store';
import { PickerPortal } from '@/plugins/picker/picker-window';
import type { CommandRegistry } from '@/plugins/registries/CommandRegistry';

export function PickerModals({ commands }: { readonly commands: CommandRegistry }) {
  return (
    <>
      <PickerPortal store={useCommandPaletteStore}>
        <CommandPalette commands={commands} />
      </PickerPortal>
      <PickerPortal store={useQuickOpenStore}>
        <QuickOpenModal />
      </PickerPortal>
      <PickerPortal store={useOpenRecentStore}>
        <OpenRecentModal />
      </PickerPortal>
      <PickerPortal store={useThemePickerStore}>
        <ThemePickerModal />
      </PickerPortal>
      <PickerPortal store={useEncodingPickerStore}>
        <EncodingPickerModal />
      </PickerPortal>
    </>
  );
}
