import * as z from "zod";

/** Rows 1..500, columns 1..1000, as the bridge accepts them. */
const Rows = z.number().int().min(1).max(500);
const Cols = z.number().int().min(1).max(1000);
const TerminalId = z.string().min(1);

export const TerminalOpenInputSchema = z.object({ id: z.string().min(1), rows: Rows, cols: Cols });
/** `seq` is where to subscribe from; 0 replays the whole kept buffer. */
export const TerminalOpenOutputSchema = z.object({
  terminalId: TerminalId,
  seq: z.number().int().min(0),
  rows: Rows,
  cols: Cols,
});

/** `n` counts the calls of one terminalId from 1; the bridge types only the next one in line. */
export const TerminalInputInputSchema = z.object({
  terminalId: TerminalId,
  /** Base64, up to 64 KB decoded. */
  data: z.string(),
  n: z.number().int().min(1),
});
export const TerminalResizeInputSchema = z.object({
  terminalId: TerminalId,
  rows: Rows,
  cols: Cols,
});
export const TerminalIdInputSchema = z.object({ terminalId: TerminalId });
export const TerminalOkOutputSchema = z.object({ ok: z.literal(true) });

export const TerminalSubscribeInputSchema = z.object({
  terminalId: TerminalId,
  cursor: z.number().int().min(0),
});
/**
 * One output frame. `reset` means `data` replaces what the screen holds; `ended` closes the
 * stream for good (`exit` is the status, null when closed under the client); `taken_over` means
 * another client opened the same agent.
 */
export const TerminalFrameSchema = z.object({
  seq: z.number().int(),
  data: z.string().optional(),
  reset: z.boolean().optional(),
  ended: z.boolean().optional(),
  exit: z.number().int().nullable().optional(),
  taken_over: z.boolean().optional(),
});
export type TerminalFrame = z.infer<typeof TerminalFrameSchema>;
