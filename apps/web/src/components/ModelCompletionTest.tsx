import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { sanitizeModelConnectionError } from "../lib/model-connection-preflight";
import { errorText } from "../lib/user-error";

export type ModelCompletionResult = { reply: string; latencyMs: number };

type TestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "ok"; result: ModelCompletionResult }
  | { phase: "failed"; message: string };

/**
 * Sends one tiny real request to the chosen model and shows whether it answered, what it said
 * and how long it took. `resetKey` changes whenever what is being tested does, clearing the result.
 */
export function ModelCompletionTest({
  run,
  disabled,
  resetKey,
  className,
}: {
  run: () => Promise<ModelCompletionResult>;
  disabled?: boolean;
  resetKey: string;
  className?: string;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<TestState>({ phase: "idle" });
  const revision = useRef(0);

  // A different model, key or server makes an earlier result (or a request in flight) stale.
  useEffect(() => {
    revision.current += 1;
    setState({ phase: "idle" });
  }, [resetKey]);
  useEffect(
    () => () => {
      revision.current += 1;
    },
    [],
  );

  async function test() {
    const mine = ++revision.current;
    setState({ phase: "testing" });
    try {
      const result = await run();
      if (mine === revision.current) setState({ phase: "ok", result });
    } catch (error) {
      if (mine !== revision.current) return;
      const message = sanitizeModelConnectionError(errorText(error, t`The model test failed.`));
      setState({ phase: "failed", message });
    }
  }

  return (
    <div className={className}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || state.phase === "testing"}
        onClick={() => void test()}
      >
        {state.phase === "testing" ? <Trans>Testing…</Trans> : <Trans>Test model</Trans>}
      </Button>
      {state.phase === "ok" ? (
        <p className="mt-2 text-body-sm text-success" role="status">
          {state.result.reply ? (
            <Trans>
              Works. The model replied “{state.result.reply}” in {state.result.latencyMs} ms.
            </Trans>
          ) : (
            <Trans>Works. The model answered in {state.result.latencyMs} ms.</Trans>
          )}
        </p>
      ) : null}
      {state.phase === "failed" ? (
        <p className="mt-2 text-body-sm text-destructive" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
