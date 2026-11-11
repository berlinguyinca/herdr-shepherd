/** A failure the person can act on. Messages never carry a token or password. */
export class TuiError extends Error {
  override name = "TuiError";
}
