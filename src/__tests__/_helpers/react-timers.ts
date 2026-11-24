// 测试共享 helper:在 React act() 内推进假计时器(调用方须已 vi.useFakeTimers())。
import { act } from '@testing-library/react';
import { vi } from 'vitest';

export const advanceInAct = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));
