import { isRetryableError, isUnauthorizedError } from "@rakazo/core";
import { Redirect, useNavigation } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { openOwnerSession, rpc } from "../../lib/api";
import { t } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { loadSessionToken } from "../../lib/session";
import {
  type BotsOutcome,
  type FailureReason,
  type OpenOutcome,
  resolveSingleChat,
  shouldOpenSession,
} from "../../lib/single-chat-state";

/**
 * The app's root in single-chat mode: opens the owner session silently, finds the default assistant,
 * and shows its chat. Never navigates to sign-in or server setup.
 */
export function SingleChatHome({ onCreateAssistant }: { onCreateAssistant?: () => void }) {
  const tokens = useMobileTokens();
  const navigation = useNavigation();
  const [attempt, setAttempt] = useState(0);
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [open, setOpen] = useState<OpenOutcome>({ kind: "idle" });
  const [bots, setBots] = useState<BotsOutcome>({ kind: "pending" });

  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  // Each attempt reads the saved session, opens one if missing or refused by the last attempt, then lists the bots.
  // A saved session the list refuses is stale: it is reopened once, then the list is tried again.
  const lastFailure = useRef<FailureReason | null>(null);
  useEffect(() => {
    let cancelled = false;
    let openedThisAttempt = false;
    setOpen({ kind: "idle" });
    setBots({ kind: "pending" });
    const openSession = async () => {
      openedThisAttempt = true;
      setOpen({ kind: "pending" });
      try {
        await openOwnerSession();
      } catch (error) {
        if (!cancelled)
          setOpen({ kind: "failed", reason: isRetryableError(error) ? "network" : "refused" });
        return false;
      }
      if (cancelled) return false;
      setOpen({ kind: "ok" });
      return true;
    };
    void (async () => {
      const saved = Boolean(await loadSessionToken());
      if (cancelled) return;
      setHasSession(saved);
      if (
        shouldOpenSession({
          hasSession: saved,
          openedThisAttempt,
          lastFailure: lastFailure.current,
        })
      )
        if (!(await openSession())) return;
      for (;;) {
        try {
          const list = await rpc("bots/list");
          lastFailure.current = null;
          if (!cancelled) setBots({ kind: "loaded", bots: list });
          return;
        } catch (error) {
          if (cancelled) return;
          const reason: FailureReason = isUnauthorizedError(error) ? "auth" : "other";
          lastFailure.current = reason;
          if (!shouldOpenSession({ hasSession: true, openedThisAttempt, lastFailure: reason })) {
            setBots({ kind: "failed", reason });
            return;
          }
          if (!(await openSession())) return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const state = resolveSingleChat({
    hasSession,
    open,
    bots,
    retry: () => setAttempt((n) => n + 1),
  });

  // The existing thread route reads its bot from route params, so it is opened rather than re-hosted.
  if (state.kind === "ready")
    return (
      <Redirect
        href={{
          pathname: "/thread",
          params: { botId: state.bot.id, name: state.bot.name },
        }}
      />
    );

  const label = { color: tokens.foreground, fontSize: 16 };
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        backgroundColor: tokens.background,
      }}
    >
      {state.kind === "connecting" ? <ActivityIndicator color={tokens.foreground} /> : null}
      {state.kind === "offline" ? (
        <>
          <Text style={label}>{t("Can't reach the assistant")}</Text>
          <Pressable accessibilityRole="button" onPress={state.retry}>
            <Text style={label}>{t("Retry")}</Text>
          </Pressable>
        </>
      ) : null}
      {state.kind === "empty" ? (
        <Pressable accessibilityRole="button" onPress={onCreateAssistant}>
          <Text style={label}>{t("Create assistant")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
