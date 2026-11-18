import type { Bot } from "@rakazo/contracts";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../../lib/api";
import { createAssistant, setDefaultAssistant } from "../../lib/assistant-actions";
import { assistantCandidates } from "../../lib/default-assistant";
import { t } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { errorText } from "../../lib/user-error";

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const tokens = useMobileTokens();
  return (
    <Modal
      animationType="slide"
      presentationStyle={Platform.OS === "ios" ? "formSheet" : "fullScreen"}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, backgroundColor: tokens.background, padding: 20, gap: 16 }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: tokens.foreground, fontSize: 20, fontWeight: "600" }}>{title}</Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            onPress={onClose}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text style={{ color: tokens.foreground, fontSize: 17 }}>{t("Close")}</Text>
          </Pressable>
        </View>
        {children}
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Name (required) and role (optional) form; calls onCreated with the new assistant. */
export function CreateAssistantModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (bot: Bot) => Promise<void> | void;
}) {
  const tokens = useMobileTokens();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    let bot: Bot;
    try {
      bot = await createAssistant(name, role);
    } catch (error) {
      Alert.alert(t("Could not create assistant"), errorText(error));
      setBusy(false);
      return;
    }
    // The assistant exists now: a later failure must not offer a second create.
    try {
      await onCreated(bot);
    } catch (error) {
      Alert.alert(t("Could not continue"), errorText(error));
      onClose();
    }
  };
  const input = {
    color: tokens.foreground,
    fontSize: 16,
    borderWidth: 1,
    borderColor: tokens.foreground,
    borderRadius: 8,
    padding: 12,
  };
  return (
    <Sheet title={t("New assistant")} onClose={onClose}>
      <TextInput
        accessibilityLabel={t("Name")}
        placeholder={t("Name")}
        placeholderTextColor={tokens.foreground}
        value={name}
        onChangeText={setName}
        autoFocus
        style={input}
      />
      <TextInput
        accessibilityLabel={t("Role (optional)")}
        placeholder={t("Role (optional)")}
        placeholderTextColor={tokens.foreground}
        value={role}
        onChangeText={setRole}
        multiline
        style={[input, { minHeight: 80 }]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || !name.trim() }}
        disabled={busy || !name.trim()}
        onPress={() => void submit()}
        style={{ opacity: busy || !name.trim() ? 0.4 : 1, alignItems: "center", padding: 12 }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>
          {busy ? t("Creating…") : t("Create")}
        </Text>
      </Pressable>
    </Sheet>
  );
}

/** Lists live assistants, marks the default, lets the user switch, set a default, or create one. */
export function AssistantPickerModal({
  currentBotId,
  onClose,
  onSwitch,
}: {
  currentBotId: string | null;
  onClose: () => void;
  onSwitch: (bot: Bot) => void;
}) {
  const tokens = useMobileTokens();
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try {
      const list = await rpc("bots/list");
      const runs = await rpc("runs/list", { filter: "recent" })
        .then((r) => r.runs)
        .catch(() => []);
      setBots(assistantCandidates(list, runs));
    } catch (error) {
      Alert.alert(t("Could not load assistants"), errorText(error));
      setBots((prev) => prev ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const makeDefault = async (botId: string) => {
    try {
      await setDefaultAssistant(botId);
      await load();
    } catch (error) {
      Alert.alert(t("Could not set default assistant"), errorText(error));
    }
  };

  if (creating)
    return (
      <CreateAssistantModal
        onClose={() => setCreating(false)}
        onCreated={async (bot) => {
          if (!bots?.some((b) => b.isDefault))
            await setDefaultAssistant(bot.id).catch((error) =>
              Alert.alert(t("Could not set default assistant"), errorText(error)),
            );
          onSwitch(bot);
        }}
      />
    );
  const text = { color: tokens.foreground, fontSize: 16 };
  return (
    <Sheet title={t("Assistants")} onClose={onClose}>
      {bots === null ? <ActivityIndicator color={tokens.foreground} /> : null}
      <ScrollView contentContainerStyle={{ gap: 4 }}>
        {bots?.map((bot) => (
          <View
            key={bot.id}
            style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={bot.name}
              accessibilityState={{ selected: bot.id === currentBotId }}
              onPress={() => onSwitch(bot)}
              style={{ flex: 1 }}
            >
              <Text style={{ ...text, fontWeight: bot.id === currentBotId ? "700" : "400" }}>
                {bot.name}
              </Text>
            </Pressable>
            {bot.isDefault ? (
              <Text style={{ ...text, opacity: 0.6 }}>{t("Default")}</Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t("Set as default")}: ${bot.name}`}
                onPress={() => void makeDefault(bot.id)}
              >
                <Text style={text}>{t("Set as default")}</Text>
              </Pressable>
            )}
          </View>
        ))}
      </ScrollView>
      <Pressable accessibilityRole="button" onPress={() => setCreating(true)}>
        <Text style={{ ...text, fontWeight: "600" }}>{t("Create assistant")}</Text>
      </Pressable>
    </Sheet>
  );
}
