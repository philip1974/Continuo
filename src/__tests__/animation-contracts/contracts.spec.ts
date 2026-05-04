import { describe, it, expect } from 'vitest';
import {
  tabIndicatorLayoutId,
  panelTitleLayoutId,
  PANEL_MOUNT_TRANSITION,
  PANEL_MOUNT_INITIAL,
  PANEL_MOUNT_ANIMATE,
  PANEL_MOUNT_EXIT,
  EXIT_DURATION_MS,
  TAB_INDICATOR_SPRING,
  TAB_TITLE_SPRING,
} from '../../shell/motion/tokens';
import { useClosingStore } from '../../shell/motion/closing-store';

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

    it('exit 微上移 + 微缩放', () => {
      expect(PANEL_MOUNT_EXIT).toEqual({ opacity: 0, y: -4, scale: 0.99 });
    });

    it('EXIT_DURATION_MS 与 transition.duration 对齐(秒 → 毫秒)', () => {
      expect(EXIT_DURATION_MS).toBe(220);
    });
  });

  describe('落点 ③ 标题飞行', () => {
    it('TAB_TITLE_SPRING 与 doc 03 一致', () => {
      expect(TAB_TITLE_SPRING).toEqual({ type: 'spring', stiffness: 500, damping: 38 });
    });

    it('与 indicator spring 比 damping 更高(避免长距离飞行后过冲)', () => {
      expect(TAB_TITLE_SPRING.damping).toBeGreaterThan(TAB_INDICATOR_SPRING.damping);
      expect(TAB_TITLE_SPRING.stiffness).toBe(TAB_INDICATOR_SPRING.stiffness);
    });
  });

  describe('closing-store 行为', () => {
    it('mark/unmark 幂等且互不影响', () => {
      const s = useClosingStore.getState();
      s.unmark('zz'); // 干净起点
      s.mark('zz');
      expect(useClosingStore.getState().ids.has('zz')).toBe(true);
      s.mark('zz'); // 重复 mark 不抛
      expect(useClosingStore.getState().ids.has('zz')).toBe(true);
      s.unmark('zz');
      expect(useClosingStore.getState().ids.has('zz')).toBe(false);
      s.unmark('zz'); // 重复 unmark 不抛
    });

    it('mark 后返回的是新 Set 引用(供 React 订阅)', () => {
      const before = useClosingStore.getState().ids;
      useClosingStore.getState().mark('alpha');
      const after = useClosingStore.getState().ids;
      expect(after).not.toBe(before);
      expect(after.has('alpha')).toBe(true);
      useClosingStore.getState().unmark('alpha');
    });
  });
});
