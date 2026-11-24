import { z } from 'zod';
import { SESSION_ID_MAX } from './session-id-limits';

/**
 * MCP 工具 / IPC 入参的 session_id 边界单一来源(terminal / hook-bridge / debug 共用)。
 * 协议包的 session_id 只 min(1) 无上限,Continuo 侧统一收窄到 SESSION_ID_MAX(E203)。
 */
export const sessionIdSchema = z.string().min(1).max(SESSION_ID_MAX);
