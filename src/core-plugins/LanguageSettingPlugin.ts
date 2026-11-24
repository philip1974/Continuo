// topic 16 i18n: 注册 Settings 通用 tab 内的「语言」select 项(spec 单一来源见 core-setting-specs.GENERAL_LANGUAGE)。

import { Plugin } from '@/plugins/Plugin';
import { languageSettingSpec } from '@/plugins/settings/core-setting-specs';
import { useSettingsStore } from '@/stores/settings.store';

export default class LanguageSettingPlugin extends Plugin {
  onload(): void {
    // systemLocale 已在 bootCorePlugins 前由 main-app bootstrap 注入。
    this.addSettingItem(languageSettingSpec(useSettingsStore.getState().systemLocale));
  }
}
