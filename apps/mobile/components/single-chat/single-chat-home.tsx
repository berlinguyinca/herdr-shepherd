import { isRetryableError } from "@rakazo/core";
import { Redirect, useNavigation } from "expo-router";
import { useEffect, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { openOwnerSession, rpc } from "../../lib/api";
import { t } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { loadSessionToken } from "../../lib/session";
import { type BotsOutcome, type OpenOutcome, resolveSingleChat } from "../../lib/single-chat-state";

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

  // Each attempt reads the saved session, opens one only if missing, then lists the bots.
  useEffect(() => {
    let cancelled = false;
    setOpen({ kind: "idle" });
    setBots({ kind: "pending" });
    void (async () => {
      const saved = Boolean(await loadSessionToken());
      if (cancelled) return;
      setHasSession(saved);
      if (!saved) {
        setOpen({ kind: "pending" });
        try {
          await openOwnerSession();
        } catch (error) {
          if (!cancelled)
            setOpen({
              kind: "failed",
              reason: isRetryableError(error) ? "network" : "refused",
            });
          return;
        }
        if (cancelled) return;
        setOpen({ kind: "ok" });
      }
      try {
        const list = await rpc("bots/list");
        if (!cancelled) setBots({ kind: "loaded", bots: list });
      } catch {
        if (!cancelled) setBots({ kind: "failed" });
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
