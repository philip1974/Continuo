// topic 16 i18n: 注册 Settings 通用 tab 内的「语言」select 项(spec 单一来源见 core-setting-specs.GENERAL_LANGUAGE)。

import { Plugin } from '@/plugins/Plugin';
import { GENERAL_LANGUAGE } from '@/plugins/settings/core-setting-specs';

export default class LanguageSettingPlugin extends Plugin {
  onload(): void {
    this.addSettingItem(GENERAL_LANGUAGE);
  }
}
