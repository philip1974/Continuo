import './Card.css';
import type { HTMLAttributes } from 'react';

export type ChatCardTone =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'tool_running'
  | 'tool_waiting'
  | 'tool_error'
  | 'summary'
  | 'compact'
  | 'error'
  | 'system';

/**
 * Props for a bordered surface container.
 *
 * Use for grouped content such as `<Card tone="assistant">Message</Card>`.
 * `tone` is optional; omitting it renders the neutral surface treatment.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional semantic surface tone. Defaults to the neutral card style. */
  readonly tone?: ChatCardTone;
}

export function Card({ tone, className, children, ...rest }: CardProps) {
  return (
    <div
      {...rest}
      className={`wm-card${className != null ? ` ${className}` : ''}`}
      data-tone={tone ?? undefined}
    >
      {children}
    </div>
  );
}
