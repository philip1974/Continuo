// topic 16 i18n: 注册 Settings 通用 tab 内的「语言」select 项。
// 沿用 GeneralTabPlugin 注册 theme 的模式 — 用 titleKey/descriptionKey 走 i18n catalog。

import { Plugin } from '@/plugins/Plugin';

export default class LanguageSettingPlugin extends Plugin {
  onload(): void {
    this.addSettingItem({
      id: 'general.language',
      category: 'general',
      title: 'Language',
      titleKey: 'settings.general.language.title',
      description: "Choose Continuo's UI language. Changes take effect immediately.",
      descriptionKey: 'settings.general.language.description',
      type: 'select',
      default: 'en',
      // enum option label 是该语言的自称写法 — 不走 i18n 翻译（用户看到 "中文" 而非 "Chinese"）
      enum: [
        { value: 'en', label: 'English' },
        { value: 'zh', label: '中文' },
        { value: 'ko', label: '한국어' },
      ],
      priority: 2,
    });
  }
}
