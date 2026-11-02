/**
 * Route ids for /agent. Agent ids may contain a literal "%XX" (e.g. "...:wD%3ApF"), and the router
 * percent-decodes query values a variable number of times. Encoding then swapping "%" for "$"
 * yields a value that no number of decodes changes ("$" is never produced by encodeURIComponent).
 */
export function agentRouteId(id: string): string {
  return encodeURIComponent(id).replace(/%/g, "$");
}

export function agentIdFromRoute(param: string | string[] | undefined): string | null {
  const value = Array.isArray(param) ? param[0] : param;
  if (typeof value !== "string" || value === "") return null;
  try {
    const id = decodeURIComponent(value.replace(/\$/g, "%"));
    return id === "" ? null : id;
  } catch {
    return null;
  }
}
