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
import { t } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { errorText } from "../../lib/user-error";

function Sheet({
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
          <Pressable accessibilityRole="button" hitSlop={8} onPress={onClose}>
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
    try {
      const bot = await createAssistant(name, role);
      await onCreated(bot);
    } catch (error) {
      Alert.alert(t("Could not create bot"), errorText(error));
      setBusy(false);
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
      setBots(list.filter((bot) => !bot.archivedAt));
    } catch (error) {
      Alert.alert(t("Could not load bots"), errorText(error));
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
          if (!bots?.some((b) => b.isDefault)) await setDefaultAssistant(bot.id).catch(() => {});
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
              accessibilityLabel={t("Switch assistant")}
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
              <Pressable accessibilityRole="button" onPress={() => void makeDefault(bot.id)}>
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

/** Single-chat wrapper: a pill showing the current assistant that opens the picker over the chat. */
export function AssistantSwitcher({
  botId,
  name,
  onSwitch,
  children,
}: {
  botId: string | null;
  name: string | null;
  onSwitch: (bot: Bot) => void;
  children: ReactNode;
}) {
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ flex: 1 }}>
      {children}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Switch assistant")}
        onPress={() => setOpen(true)}
        style={{
          position: "absolute",
          top: 8,
          right: 12,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 16,
          backgroundColor: tokens.background,
          borderWidth: 1,
          borderColor: tokens.foreground,
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 14 }}>{name || t("Assistants")}</Text>
      </Pressable>
      {open ? (
        <AssistantPickerModal
          currentBotId={botId}
          onClose={() => setOpen(false)}
          onSwitch={(bot) => {
            setOpen(false);
            onSwitch(bot);
          }}
        />
      ) : null}
    </View>
  );
}
