import { describe, it, expect } from 'vitest';
import {
  tabIndicatorLayoutId,
  panelTitleLayoutId,
  PANEL_MOUNT_TRANSITION,
  PANEL_MOUNT_INITIAL,
  PANEL_MOUNT_ANIMATE,
} from '../../shell/motion/tokens';

describe('动画落点契约', () => {
  describe('落点 ① indicator layoutId', () => {
    it('以 group 为单位生成,跨 group 不冲突', () => {
      expect(tabIndicatorLayoutId('group-1')).toBe('tab-indicator-group-1');
      expect(tabIndicatorLayoutId('group-2')).toBe('tab-indicator-group-2');
      expect(tabIndicatorLayoutId('group-1')).not.toBe(tabIndicatorLayoutId('group-2'));
    });

    it('panel 标题 layoutId 以 panel id 为单位(落点 ③ 备用)', () => {
      expect(panelTitleLayoutId('editor')).toBe('panel-title-editor');
    });
  });

  describe('落点 ② PanelMount 动画 token', () => {
    it('transition 与 doc 03 一致:220ms + 自定 ease', () => {
      expect(PANEL_MOUNT_TRANSITION.duration).toBe(0.22);
      expect(PANEL_MOUNT_TRANSITION.ease).toEqual([0.32, 0.72, 0, 1]);
    });

    it('initial 微下移 + 微缩放', () => {
      expect(PANEL_MOUNT_INITIAL).toEqual({ opacity: 0, y: 8, scale: 0.98 });
    });

    it('animate 回到自然态', () => {
      expect(PANEL_MOUNT_ANIMATE).toEqual({ opacity: 1, y: 0, scale: 1 });
    });
  });
});
