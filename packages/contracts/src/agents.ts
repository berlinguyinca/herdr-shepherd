import * as z from "zod";

/** Agent statuses the Shepherd bridge reports, most urgent first. */
export const AGENT_STATUSES = ["blocked", "done", "working", "idle", "unknown", "closed"] as const;
export const AgentStatusSchema = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** One agent as the bridge sends it; the wire keys are snake_case. */
export const AgentRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  machine: z.string().nullable(),
  /** A status this app does not know yet reads as unknown rather than failing the list. */
  status: AgentStatusSchema.catch("unknown"),
  summary: z.string(),
  updated_at: z.string(),
  has_conversation: z.boolean(),
});
export type AgentRow = z.infer<typeof AgentRowSchema>;

/**
 * A rendered inspector event. `data` may carry `withheld: true` with a `withheld_reason`, and
 * `<key>_more: true` when the text, output or diff under `<key>` was cut at 2000 characters.
 */
export const AgentEventSchema = z.object({
  seq: z.number().int(),
  rev: z.number().int(),
  kind: z.string(),
  agent_id: z.string(),
  parent_agent_id: z.string().nullable(),
  ts: z.string(),
  sensitive: z.boolean(),
  redacted: z.boolean(),
  truncated: z.boolean(),
  size: z.number(),
  data: z.record(z.string(), z.unknown()),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const AgentListInputSchema = z.object({ showOlder: z.boolean().optional() });
export const AgentListOutputSchema = z.object({
  agents: z.array(AgentRowSchema),
  hiddenCount: z.number().int().nonnegative(),
  /** Pass to `agents/subscribeList`; frames after it are newer than this list. */
  cursor: z.number().int(),
});

export const AgentIdInputSchema = z.object({ id: z.string().min(1) });
export const AgentGetOutputSchema = z.object({
  agent: AgentRowSchema,
  hasConversation: z.boolean(),
});

export const AgentMessagesInputSchema = AgentIdInputSchema.extend({
  beforeSeq: z.number().int().nullable().optional(),
  limit: z.number().int().positive().optional(),
});
/** Newest first. `rev` is the session revision to subscribe from. */
export const AgentMessagesOutputSchema = z.object({
  events: z.array(AgentEventSchema),
  hasMore: z.boolean(),
  newestSeq: z.number().int().nullable(),
  rev: z.number().int(),
});

export const AgentEventInputSchema = AgentIdInputSchema.extend({ seq: z.number().int() });

/** `cursor` is the session `rev` for one agent, the list `cursor` for the list; -1 is a full snapshot. */
export const AgentSubscribeInputSchema = AgentIdInputSchema.extend({
  cursor: z.number().int().min(-1),
});
export const AgentSubscribeListInputSchema = z.object({ cursor: z.number().int().min(-1) });
export const AgentStreamFrameSchema = z.object({ seq: z.number().int(), event: AgentEventSchema });
export const AgentListFrameSchema = z.object({ seq: z.number().int(), row: AgentRowSchema });
