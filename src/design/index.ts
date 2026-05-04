// Nous shell-ui design 共享组件层(LM 本地副本)。
// 同步源:Nous/packages/shells/shell-ui/src/design/
// Token 来源:src/styles/nous-tokens.css(--md-* / --wm-*)
// 注意:.js 后缀是 Nous 的 ESM 风格,LM 走 Vite,直接去掉。

export { Badge, type BadgeProps, type BadgeVariant } from './Badge';
export {
  Button,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from './Button';
export {
  IconButton,
  type IconButtonProps,
  type IconButtonSize,
} from './IconButton';
export {
  NavRailButton,
  type NavRailButtonProps,
} from './NavRailButton';
export {
  MenuItem,
  type MenuItemProps,
  type MenuItemVariant,
} from './MenuItem';
export {
  TabNav,
  TabNavItem,
  type TabNavProps,
  type TabNavItemProps,
} from './TabNav';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedControlOption,
  type SegmentedControlSize,
} from './SegmentedControl';
export { Card, type CardProps, type ChatCardTone } from './Card';
export { Input, type InputProps, type InputVariant } from './Input';
export { Modal, type ModalProps } from './Modal';
export { ScrollArea, type ScrollAreaProps } from './ScrollArea';
export { Separator, type SeparatorProps } from './Separator';
export { Spinner, type SpinnerProps, type SpinnerSize } from './Spinner';
export { Tabs, type TabsProps, type TabItem } from './Tabs';
export {
  Textarea,
  type TextareaProps,
  type TextareaVariant,
} from './Textarea';
