import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { TuiError } from "./errors.js";

export type Prompter = {
  ask(question: string): Promise<string>;
  /** Reads a line without echoing it (passwords). */
  askSecret(question: string): Promise<string>;
  /** Next line, or undefined at end of input; no prompt text. */
  nextLine(): Promise<string | undefined>;
  close(): void;
};

/** Line prompts over any stream pair; the secret prompt never echoes what is typed. */
export function createPrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  terminal: boolean,
): Prompter {
  let muted = false;
  const echo = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output: echo, terminal });
  const queue: string[] = [];
  let closed = false;
  let waiting: ((line: string | undefined) => void) | undefined;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    waiting?.(undefined);
    waiting = undefined;
  });
  const nextLine = async (): Promise<string | undefined> => {
    const buffered = queue.shift();
    if (buffered !== undefined) return buffered;
    if (closed) return undefined;
    return new Promise<string | undefined>((resolve) => {
      waiting = resolve;
    });
  };
  const required = async (): Promise<string> => {
    const line = await nextLine();
    if (line === undefined) throw new TuiError("Input ended before the questions were answered.");
    return line.trim();
  };
  return {
    nextLine,
    async ask(question) {
      output.write(`${question}: `);
      return required();
    },
    async askSecret(question) {
      output.write(`${question}: `);
      muted = true;
      try {
        return await required();
      } finally {
        muted = false;
        output.write("\n");
      }
    },
    close: () => rl.close(),
  };
}
