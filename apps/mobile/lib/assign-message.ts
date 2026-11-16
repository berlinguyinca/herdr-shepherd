export type AssignRequest = { target: string; task: string };

/** The chat message that hands work to an agent or role; null when there is no task. */
export function buildAssignMessage({ target, task }: AssignRequest): string | null {
  const work = task.trim();
  if (!work) return null;
  const who = target.trim();
  return who ? `Assign ${who}: ${work}` : `Assign: ${work}`;
}

/** The `threads/send` input for an assignment to the given assistant; null when there is no task. */
export function assignSendInput(botId: string, request: AssignRequest, clientNonce: string) {
  const text = buildAssignMessage(request);
  return text ? { botId, clientNonce, text } : null;
}
