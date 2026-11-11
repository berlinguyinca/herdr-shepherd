import { runTui } from "../tui/commands.js";
import { TuiError } from "../tui/errors.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await runTui({
    argv: process.argv.slice(2),
    env: process.env,
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    signal: controller.signal,
  });
} catch (error) {
  if (!(error instanceof TuiError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
