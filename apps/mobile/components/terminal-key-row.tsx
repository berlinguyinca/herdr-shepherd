import { useEffect, useMemo, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { createKeyRepeater, KEY_ROW, type KeyName } from "../lib/terminal-keys";

const TAP = 44;
const PRESS_DELAY_MS = 60;
// A hardware keyboard needs the row less: it stays, one line at a reduced height.
const COMPACT_HEIGHT = 32;

const GLYPHS: Record<string, string> = { Left: "←", Down: "↓", Up: "↑", Right: "→" };

/**
 * One line of keys above the soft keyboard: Esc, a sticky Ctrl, Tab, arrows and a few symbols,
 * plus the keyboard toggle, Paste and (while text is selected) Copy. It scrolls sideways where
 * the screen is narrower than the keys; every key keeps a 44 pt tap target. Held arrows repeat.
 */
export function TerminalKeyRow({
  ctrl,
  keyboardOn,
  hasSelection,
  compact,
  onKey,
  onToggleCtrl,
  onToggleKeyboard,
  onPaste,
  onCopy,
}: {
  ctrl: boolean;
  keyboardOn: boolean;
  hasSelection: boolean;
  compact: boolean;
  onKey: (key: KeyName) => void;
  onToggleCtrl: () => void;
  onToggleKeyboard: () => void;
  onPaste: () => void;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const fire = useRef(onKey);
  fire.current = onKey;
  const repeater = useMemo(() => createKeyRepeater((key) => fire.current(key)), []);
  useEffect(() => repeater.release, [repeater]);

  const names: Record<string, string> = {
    Esc: t("Escape"),
    Ctrl: t("Control"),
    Tab: t("Tab"),
    Left: t("Left"),
    Down: t("Down"),
    Up: t("Up"),
    Right: t("Right"),
    "|": t("Pipe"),
    "~": t("Tilde"),
    "/": t("Slash"),
    "-": t("Dash"),
  };
  const vertical = compact ? (TAP - COMPACT_HEIGHT) / 2 : 0;

  const button = (
    id: string,
    label: string,
    accessibilityLabel: string,
    handlers: {
      onPress?: () => void;
      onPressIn?: () => void;
      onPressOut?: () => void;
      // Holds the press-in back, so a swipe that scrolls the row does not press the key under it.
      unstable_pressDelay?: number;
    },
    selected = false,
  ) => (
    <Pressable
      key={id}
      testID={`terminal-key-${id}`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      hitSlop={{ top: vertical, bottom: vertical }}
      {...handlers}
      style={[
        styles.key,
        {
          height: compact ? COMPACT_HEIGHT : TAP,
          backgroundColor: selected ? tokens.primary : tokens.card,
          borderColor: tokens.border,
        },
      ]}
    >
      <Text
        style={[styles.label, { color: selected ? tokens.primaryForeground : tokens.foreground }]}
      >
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View
      style={[styles.bar, { borderTopColor: tokens.border, backgroundColor: tokens.background }]}
    >
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        accessibilityLabel={t("Terminal keys")}
        contentContainerStyle={styles.content}
      >
        {button(
          "keyboard",
          "⌨",
          keyboardOn ? t("Hide keyboard") : t("Show keyboard"),
          { onPress: onToggleKeyboard },
          keyboardOn,
        )}
        {KEY_ROW.map((key) =>
          key === "Ctrl"
            ? button("Ctrl", "Ctrl", t("Control"), { onPress: onToggleCtrl }, ctrl)
            : button(key, GLYPHS[key] ?? key, names[key] ?? key, {
                onPressIn: () => repeater.press(key),
                onPressOut: repeater.release,
                unstable_pressDelay: PRESS_DELAY_MS,
              }),
        )}
        {button("paste", t("Paste"), t("Paste"), { onPress: onPaste })}
        {hasSelection ? button("copy", t("Copy"), t("Copy"), { onPress: onCopy }) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  content: { flexGrow: 1, gap: 4, paddingHorizontal: 8, alignItems: "center" },
  key: {
    flexGrow: 1,
    minWidth: TAP,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
});
