import { OnboardError, runOnboard } from "../node/onboard.js";

try {
  await runOnboard({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    input: process.stdin,
    output: process.stdout,
    interactive: process.stdin.isTTY === true,
  });
} catch (error) {
  if (!(error instanceof OnboardError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
