// 转到定义的结果处理(VSCode DefinitionAction / symbolNavigation 的极简对应;引擎无关,CodeMirror 入口见 codemirror-go-to-definition):
// - 一个结果 → 跳转:先记下当前位置(⌃- 退回),经 openFileInEditor 打开 / 切到目标文件(当前组,同 VSCode 在当前编辑器组打开),
//   光标落在定义名开头并居中;
// - 多个结果 → 选择器列出(文件 + 行 + 该行预览)让用户选。VSCode 默认 editor.gotoLocation.multipleDefinitions = peek(内联
//   peek 视图),本项目没有 peek,用选择器代替;
// - 没有结果 → VSCode 的「未找到 'x' 的定义」提示(⌘ 单击触发时静默,VSCode 同:muteMessage)。
// 扩展点:⇧F12 引用 / ⌥F12 peek 等「一组位置」的结果同样可交给 showLocations / goToLocation(位置类型 TsLocation 通用)。
// BDD: src/__tests__/editor-go-to-definition/

import { openFileInEditor } from '@/plugins/co-app';
import { notify } from '@/notifications/notify';
import { notifyFailure } from '@/notifications/notify-thrown-error';
import { t } from '@/i18n';
import { useDefinitionPickerStore } from '@/plugins/definition-picker/store';
import type { TsLocation, TsRequestReply } from '../../../electron/shared/ts-language';
import { recordNavigationOrigin } from './navigation-history';

/** 跳到一个位置(记导航来处;打开失败提示)。 */
export async function goToLocation(loc: TsLocation): Promise<boolean> {
  recordNavigationOrigin();
  const r = await openFileInEditor(loc.path, { line: loc.line, column: loc.column });
  if (!r.ok) {
    notifyFailure(r);
    return false;
  }
  return true;
}

/** 多个位置 → 选择器;一个 → 直接跳。 */
export function showLocations(locations: readonly TsLocation[]): void {
  if (locations.length === 1) {
    void goToLocation(locations[0]!);
    return;
  }
  if (locations.length > 1) useDefinitionPickerStore.getState().show(locations);
}

/**
 * 处理一次转到定义的应答。word = 请求位置的单词(提示文案用);mute = ⌘ 单击触发(无结果不提示)。
 * 返回是否有可去的定义。
 */
export function handleDefinitionReply(reply: TsRequestReply, word: string | undefined, mute: boolean): boolean {
  if (reply.status === 'cancelled') return false;
  if (reply.status === 'ok' && reply.definitions.length > 0) {
    showLocations(reply.definitions);
    return true;
  }
  if (!mute) notify.info(word === undefined ? t('editor.definition.none') : t('editor.definition.none_for', { name: word }));
  return false;
}
