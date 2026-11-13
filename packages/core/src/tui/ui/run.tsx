import { render } from "ink";
import type { AppProps } from "./app.js";
import { App } from "./app.js";

export type RunUiOptions = AppProps & {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  /** Quits the view, as Ctrl-C does. */
  signal?: AbortSignal;
};

/** Full-screen view on the alternate screen; resolves once it has quit and restored the terminal. */
export async function runUi(options: RunUiOptions): Promise<void> {
  const app = render(<App client={options.client} onAttach={options.onAttach} />, {
    stdin: options.input,
    stdout: options.output,
    alternateScreen: true,
    // The view handles Ctrl-C itself, so quitting also ends the streams.
    exitOnCtrlC: false,
  });
  const quit = () => app.unmount();
  options.signal?.addEventListener("abort", quit);
  try {
    await app.waitUntilExit();
  } finally {
    options.signal?.removeEventListener("abort", quit);
  }
}
