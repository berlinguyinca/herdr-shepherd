import { isRetryableError, isUnauthorizedError } from "@rakazo/core";
import { Redirect, useNavigation } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { rpc } from "../../lib/api";
import { setDefaultAssistant } from "../../lib/assistant-actions";
import { t } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { openTailscale } from "../../lib/open-tailscale";
import { loadSessionToken } from "../../lib/session";
import { connectShepherd } from "../../lib/shepherd-connect";
import {
  type BotsOutcome,
  type FailureReason,
  type OpenOutcome,
  resolveSingleChat,
  shouldOpenSession,
} from "../../lib/single-chat-state";
import { errorText } from "../../lib/user-error";
import { CreateAssistantModal } from "./assistant-picker";

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
  const [creating, setCreating] = useState(false);

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
        const result = await connectShepherd();
        if (result.kind !== "connected") {
          if (!cancelled)
            setOpen({
              kind: "failed",
              reason: result.kind === "connect-tailscale" ? "tailscale" : "update",
            });
          return false;
        }
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
          // Recent runs reveal assistants bots/list omits; failing to read them is not fatal.
          const runs = await rpc("runs/list", { filter: "recent" })
            .then((r) => r.runs)
            .catch(() => []);
          if (!cancelled) setBots({ kind: "loaded", bots: list, runs });
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

  // Coming back from Tailscale re-checks on its own, so the person never has to find Try again.
  const needsTailscale = state.kind === "connect-tailscale";
  useEffect(() => {
    if (!needsTailscale) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") setAttempt((n) => n + 1);
    });
    return () => sub.remove();
  }, [needsTailscale]);

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
      {state.kind === "connect-tailscale" ? (
        <>
          <Text style={label}>{t("Connect Tailscale")}</Text>
          <Text style={label}>
            {t("This server is only reachable from your Tailscale network.")}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              void openTailscale(
                (url) => Linking.openURL(url),
                Platform.OS === "android" ? "android" : "ios",
              ).catch(() => undefined)
            }
          >
            <Text style={label}>{t("Open Tailscale")}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={state.retry}>
            <Text style={label}>{t("Try again")}</Text>
          </Pressable>
        </>
      ) : null}
      {state.kind === "update-app" ? <Text style={label}>{t("Update the app")}</Text> : null}
      {state.kind === "empty" ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            onCreateAssistant?.();
            setCreating(true);
          }}
        >
          <Text style={label}>{t("Create assistant")}</Text>
        </Pressable>
      ) : null}
      {creating ? (
        <CreateAssistantModal
          onClose={() => setCreating(false)}
          onCreated={async (bot) => {
            // The first assistant becomes the default, then the list reloads and the chat opens.
            await setDefaultAssistant(bot.id).catch((error) =>
              Alert.alert(t("Could not set default assistant"), errorText(error)),
            );
            setCreating(false);
            setAttempt((n) => n + 1);
          }}
        />
      ) : null}
    </View>
  );
}
