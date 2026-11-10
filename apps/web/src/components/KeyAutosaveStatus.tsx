import { Trans } from "@lingui/react/macro";
import type { KeyAutosaveStatus as Status } from "../lib/use-key-autosave";

/** A quiet line under the key field: what the automatic save and model refresh are doing. */
export function KeyAutosaveStatus({ status }: { status: Status }) {
  return (
    <p className="mt-1 min-h-5 text-body-sm text-muted-foreground" role="status" aria-live="polite">
      {status.phase === "saving" ? <Trans>Saving…</Trans> : null}
      {status.phase === "saved" ? <Trans>Saved</Trans> : null}
      {status.phase === "finding" ? <Trans>Finding models…</Trans> : null}
    </p>
  );
}
