import { isRetryableError } from "@rakazo/core";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { AssistantSwitcher } from "../components/single-chat/assistant-picker";
import { StatusStrip } from "../components/single-chat/status-strip";
import { Thread } from "../components/thread/thread-screen";
import { currentApiBase, selectedSpaceId, selectSpace } from "../lib/api";
import { t, useI18n } from "../lib/i18n";
import { integrationsCacheScope } from "../lib/integrations-cache";
import { useMobileTokens } from "../lib/native";
import {
  threadRouteSpaceOnFocus,
  threadSpaceRequest,
  threadSpaceSwitchResult,
} from "../lib/notification-open";
import { singleChatOnly } from "../lib/server-config";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  loadVerifiedIntegrationsScope,
  subscribeSessionGeneration,
} from "../lib/session";
import { errorText } from "../lib/user-error";

export default function ThreadRoute() {
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const ready = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  const [owner, setOwner] = useState<{ key: string; generation: number; userId: string } | null>(
    null,
  );
  useEffect(() => {
    if (generation !== ready) return;
    const apiBase = currentApiBase();
    let cancelled = false;
    let notified = false;
    let timer: ReturnType<typeof setTimeout>;
    const verify = () =>
      void loadVerifiedIntegrationsScope()
        .then((saved) => (saved?.apiBase === apiBase ? saved : integrationsCacheScope()))
        .then((scope) => {
          if (
            !cancelled &&
            scope &&
            generation === currentSessionGeneration() &&
            apiBase === currentApiBase()
          )
            setOwner({
              key: JSON.stringify([apiBase, scope.userId]),
              generation,
              userId: scope.userId,
            });
        })
        .catch((error) => {
          if (!cancelled && !notified) Alert.alert(t("Could not continue"), errorText(error));
          notified = true;
          if (!cancelled && isRetryableError(error)) timer = setTimeout(verify, 5_000);
        });
    verify();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [generation, ready]);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const focused = useIsFocused();
  const { spaceId, botId, name } = useLocalSearchParams<{
    spaceId?: string | string[];
    botId?: string;
    name?: string;
  }>();
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(() => selectedSpaceId());
  const [switchFailed, setSwitchFailed] = useState(false);
  const [appliedFocus, setAppliedFocus] = useState(focused);
  // Before paint, so a stacked route cannot render its thread against a space
  // a newer notification selected.
  const focusSync = threadRouteSpaceOnFocus({
    focused,
    appliedFocus,
    activeSpaceId,
    liveSpaceId: selectedSpaceId(),
    switchFailed,
  });
  if (focusSync.appliedFocus !== appliedFocus) setAppliedFocus(focusSync.appliedFocus);
  if (focusSync.activeSpaceId !== activeSpaceId) setActiveSpaceId(focusSync.activeSpaceId);
  if (focusSync.switchFailed !== switchFailed) setSwitchFailed(focusSync.switchFailed);
  const request = threadSpaceRequest(spaceId, focusSync.activeSpaceId);

  useEffect(() => {
    if (!focused) return;
    const next = threadSpaceRequest(spaceId, activeSpaceId);
    if (next.action === "show") {
      setSwitchFailed(false);
      return;
    }
    if (next.action === "unavailable") {
      setSwitchFailed(true);
      return;
    }
    let cancelled = false;
    setSwitchFailed(false);
    const requestedSpaceId = next.spaceId;
    void selectSpace(requestedSpaceId).then((switched) => {
      if (cancelled) return;
      // selectSpace commits the id before it resolves; a failed write rolls it back.
      if (threadSpaceSwitchResult(requestedSpaceId, switched, selectedSpaceId()) === "ready") {
        setActiveSpaceId(requestedSpaceId);
        return;
      }
      setSwitchFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSpaceId, focused, spaceId]);

  if (request.action === "show" && !focusSync.switchFailed) {
    const chat = (
      <>
        {owner?.generation !== generation ? <ActivityIndicator color={tokens.foreground} /> : null}
        <View style={{ flex: 1, display: owner?.generation === generation ? "flex" : "none" }}>
          {owner ? (
            <Thread
              key={singleChatOnly() ? `${owner.key}:${botId ?? ""}` : owner.key}
              sessionEpoch={ready}
              userId={owner.userId}
            />
          ) : null}
        </View>
      </>
    );
    // Single-chat mode: a header pill switches this chat to another assistant without changing the default.
    return singleChatOnly() ? (
      <AssistantSwitcher
        botId={typeof botId === "string" ? botId : null}
        name={typeof name === "string" ? name : null}
        onSwitch={(bot) => router.setParams({ botId: bot.id, name: bot.name })}
      >
        {chat}
        <StatusStrip />
      </AssistantSwitcher>
    ) : (
      chat
    );
  }
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.background,
      }}
    >
      {request.action === "switch" && !focusSync.switchFailed ? (
        <ActivityIndicator color={tokens.foreground} />
      ) : (
        <View style={{ alignItems: "center", gap: 12 }}>
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>
            {t("Could not switch spaces")}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => router.replace("/")}>
            <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Return to inbox")}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
