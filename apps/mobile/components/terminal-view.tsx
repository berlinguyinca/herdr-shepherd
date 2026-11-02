import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useTerminal } from "../lib/terminal";
import {
  base64ToBytes,
  createOutputBatcher,
  decodeFromWeb,
  encodeToWeb,
  type NativeMsg,
  terminalFontSize,
} from "../lib/terminal-bridge";
import { terminalHtml } from "../lib/terminal-html.generated";

const SOURCE = { html: terminalHtml };
// Nothing but the inline page may load.
const ORIGINS = ["about:*"];

/** One agent's terminal: an xterm page in a WebView, wired to the agent's terminal session. */
export function TerminalView({ agentId, focused }: { agentId: string; focused: boolean }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const dark = useResolvedAppearance() === "dark";
  const { fontScale } = useWindowDimensions();
  const { state, write, resize, reopen, onOutput } = useTerminal(agentId);
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const send = (msg: NativeMsg) => web.current?.postMessage(encodeToWeb(msg));
  const sendRef = useRef(send);
  sendRef.current = send;

  const batcher = useMemo(
    () =>
      createOutputBatcher(
        (msg) => sendRef.current(msg),
        (run) => {
          const id = requestAnimationFrame(run);
          return () => cancelAnimationFrame(id);
        },
      ),
    [],
  );
  useEffect(() => {
    const stop = onOutput((chunk) => batcher.push(chunk));
    return () => {
      stop();
      batcher.dispose();
    };
  }, [batcher, onOutput]);
  useEffect(() => batcher.setReady(ready), [batcher, ready]);
  useEffect(() => {
    if (ready) send({ t: "theme", dark });
  }, [ready, dark]);
  useEffect(() => {
    if (ready && focused) send({ t: "focus" });
  }, [ready, focused]);

  const onMessage = (event: WebViewMessageEvent) => {
    const msg = decodeFromWeb(event.nativeEvent.data);
    if (!msg) return;
    if (msg.t === "ready") setReady(true);
    else if (msg.t === "in") write(base64ToBytes(msg.b64));
    else if (msg.t === "size") resize(msg.rows, msg.cols);
    else if (msg.t === "copy") void Clipboard.setStringAsync(msg.text);
  };

  const overlay =
    state === "connecting"
      ? t("Connecting…")
      : state === "ended"
        ? t("Session ended")
        : state === "taken_over"
          ? t("Opened elsewhere")
          : state === "error"
            ? t("Connection lost. Retrying…")
            : null;

  return (
    <View style={styles.fill}>
      <WebView
        ref={web}
        source={SOURCE}
        originWhitelist={ORIGINS}
        javaScriptEnabled
        injectedJavaScriptBeforeContentLoaded={`window.__fontSize=${terminalFontSize(fontScale)};true;`}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={(request) => request.url.startsWith("about:")}
        setSupportMultipleWindows={false}
        bounces={false}
        scrollEnabled={false}
        overScrollMode="never"
        textZoom={100}
        automaticallyAdjustContentInsets={false}
        hideKeyboardAccessoryView
        keyboardDisplayRequiresUserAction
        style={styles.web}
        containerStyle={styles.web}
      />
      {overlay ? (
        <View
          pointerEvents="box-none"
          style={[
            styles.overlay,
            { backgroundColor: tokens.background, borderColor: tokens.border },
          ]}
        >
          <Text testID="terminal-status" style={[styles.status, { color: tokens.foreground }]}>
            {overlay}
          </Text>
          {state === "taken_over" ? (
            <Pressable
              accessibilityRole="button"
              onPress={reopen}
              style={[styles.button, { borderColor: tokens.border }]}
            >
              <Text style={[styles.buttonLabel, { color: tokens.foreground }]}>{t("Reopen")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  web: { flex: 1, backgroundColor: "transparent" },
  overlay: {
    position: "absolute",
    top: 8,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  status: { fontSize: 13, lineHeight: 18 },
  button: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonLabel: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
});
