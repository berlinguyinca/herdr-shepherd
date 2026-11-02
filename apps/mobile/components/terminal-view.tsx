import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useTerminal } from "../lib/terminal";
import {
  createLoadGate,
  createOutputBatcher,
  encodeToWeb,
  type NativeMsg,
  type PageState,
  pageReducer,
  terminalFontSize,
} from "../lib/terminal-bridge";
import { terminalHtml } from "../lib/terminal-html.generated";
import { compactKeyRow } from "../lib/terminal-keys";
import { createTerminalHandler } from "../lib/terminal-view-handler";
import { TerminalKeyRow } from "./terminal-key-row";

const SOURCE = { html: terminalHtml };
// Nothing but the inline page may load.
const ORIGINS = ["about:*"];
const NOTICE_MS = 3000;

/** What an ended terminal says; a reason this app does not know reads as the generic text. */
function endedText(reason: string | undefined, t: (text: string) => string): string {
  switch (reason) {
    case "host_offline":
      return t("The host went offline");
    case "input_overflow":
    case "input_gap":
    case "stale":
    case "relay_error":
      return t("The terminal was reset, reopen it");
    case "pane_closed":
      return t("The pane was closed");
    case "herdr_unavailable":
      return t("herdr is not running on the host");
    case "invalid_pane":
      return t("That pane cannot be opened here");
    case "too_many_terminals":
      return t("Too many open terminals");
    default:
      return t("Session ended");
  }
}

/**
 * One agent's terminal: an xterm page in a WebView, wired to the agent's terminal session. A
 * reloaded or crashed page has lost its screen, so it remounts (new key, new client, full
 * replay); so does another agent.
 */
export function TerminalView({
  agentId,
  focused,
  keyboardOffset = 0,
}: {
  agentId: string;
  focused: boolean;
  /** The height above this view that the keyboard must also clear; the parent knows it. */
  keyboardOffset?: number;
}) {
  const [saved, setMount] = useState({ agentId, generation: 0, uncapped: false });
  // Another agent starts clean: a remount count or an uncapped page belongs to the one before.
  const mount = saved.agentId === agentId ? saved : { agentId, generation: 0, uncapped: false };
  return (
    <TerminalPage
      key={`${agentId}:${mount.generation}`}
      agentId={agentId}
      focused={focused}
      keyboardOffset={keyboardOffset}
      uncapped={mount.uncapped}
      onReload={(next) =>
        setMount({ agentId, generation: mount.generation + 1, uncapped: next.uncapped })
      }
    />
  );
}

function TerminalPage({
  agentId,
  focused,
  keyboardOffset,
  uncapped,
  onReload,
}: {
  agentId: string;
  focused: boolean;
  keyboardOffset: number;
  uncapped: boolean;
  onReload: (next: PageState) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const dark = useResolvedAppearance() === "dark";
  const { fontScale } = useWindowDimensions();
  // Set while this page is being rebuilt: the terminal stays open for the page that follows.
  const rebuilding = useRef(false);
  const { state, reason, write, setZoom, reopen, onOutput } = useTerminal(
    agentId,
    undefined,
    rebuilding,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const page = useRef<PageState>({ generation: 0, ready: false, dropped: false, uncapped });
  const advance = (event: "ready" | "gone" | "overflow") => {
    const next = pageReducer(page.current, event);
    const reload = next.generation !== page.current.generation;
    page.current = next;
    if (reload) {
      rebuilding.current = true;
      onReload(next);
    } else setReady(next.ready);
  };
  const advanceRef = useRef(advance);
  advanceRef.current = advance;
  const allowLoad = useMemo(createLoadGate, []);
  const send = (msg: NativeMsg) => web.current?.postMessage(encodeToWeb(msg));
  const sendRef = useRef(send);
  sendRef.current = send;

  // The key row's display state; the handler owns the sticky Ctrl and the cursor mode.
  const [ctrl, setCtrl] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [zoom, setZoom_] = useState(false);
  // How the page fits the pane (its size and the share of the font it got), for the caption.
  const [fit, setFit] = useState<{ rows: number; cols: number; pct: number } | null>(null);
  const [captionShort, setCaptionShort] = useState(false);
  const [notice, setNotice] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const softKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const insets = useSafeAreaInsets();
  // The handler is made once; what it calls is always the latest render's.
  const deps = {
    ready: () => advance("ready"),
    write,
    setZoom,
    onZoom: setZoom_,
    isLive: () => stateRef.current === "live",
    onFit: setFit,
    // Clipboard text is never logged: it can hold anything.
    readClipboard: () => Clipboard.getStringAsync(),
    writeClipboard: (text: string) => Clipboard.setStringAsync(text),
    send,
    onCtrl: setCtrl,
    onSelection: setHasSelection,
    onNotice: () => {
      setNotice(true);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(false), NOTICE_MS);
    },
  };
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const handler = useMemo(
    () =>
      createTerminalHandler({
        ready: () => depsRef.current.ready(),
        write: (bytes) => depsRef.current.write(bytes),
        setZoom: (on) => depsRef.current.setZoom(on),
        onZoom: (on) => depsRef.current.onZoom(on),
        isLive: () => depsRef.current.isLive(),
        onFit: (next) => depsRef.current.onFit(next),
        readClipboard: () => depsRef.current.readClipboard(),
        writeClipboard: (text) => depsRef.current.writeClipboard(text),
        send: (msg) => depsRef.current.send(msg),
        onCtrl: (on) => depsRef.current.onCtrl(on),
        onSelection: (has) => depsRef.current.onSelection(has),
        onNotice: () => depsRef.current.onNotice(),
      }),
    [],
  );

  const batcher = useMemo(
    () =>
      createOutputBatcher(
        (msg) => sendRef.current(msg),
        (run) => {
          const id = requestAnimationFrame(run);
          return () => cancelAnimationFrame(id);
        },
        {
          maxPendingBytes: uncapped ? Number.POSITIVE_INFINITY : undefined,
          onOverflow: () => advanceRef.current("overflow"),
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
  const fontSize = terminalFontSize(fontScale);
  useEffect(() => {
    // The page starts at the size injected on load; this follows a change while it is open.
    if (ready) send({ t: "font", size: fontSize });
  }, [ready, fontSize]);
  const wasFocused = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (focused) send({ t: "focus" });
    // Hidden under Chat: no soft keyboard and no focus left to raise one.
    else if (wasFocused.current) send({ t: "blur" });
    wasFocused.current = focused;
  }, [ready, focused]);

  const onMessage = (event: WebViewMessageEvent) => handler.onMessage(event.nativeEvent.data);

  const stateText = {
    connecting: t("Connecting…"),
    live: null,
    ended: endedText(reason, t),
    // "gone": the terminal 404ed on resubscribe; nobody announced a takeover.
    taken_over:
      reason === "gone" ? t("This terminal was closed or opened elsewhere") : t("Opened elsewhere"),
    // Only while the client is actually backing off before another try.
    error: t("Connection lost. Retrying…"),
    busy: t("Too many open terminals, close one to continue"),
    failed: t("Could not open the terminal"),
    relay_down: t("The host's terminal relay is not running"),
  }[state];
  const overlay = stateText ?? (notice ? t("Too large to copy or paste") : null);
  // Where nothing will happen on its own, the person can ask again.
  const canReopen =
    state === "taken_over" || state === "ended" || state === "failed" || state === "relay_down";
  // Only while the pane is scaled, and not under a status text.
  const caption =
    !overlay && fit && fit.pct !== 100
      ? captionShort
        ? `${fit.pct}%`
        : t("{cols}x{rows} at {pct}%", { cols: fit.cols, rows: fit.rows, pct: fit.pct })
      : null;

  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={keyboardOffset}
      style={styles.fill}
    >
      <View style={styles.fill}>
        <WebView
          ref={web}
          source={SOURCE}
          originWhitelist={ORIGINS}
          javaScriptEnabled
          injectedJavaScriptBeforeContentLoaded={`window.__fontSize=${fontSize};window.__dark=${dark};true;`}
          onContentProcessDidTerminate={() => advance("gone")}
          onRenderProcessGone={() => advance("gone")}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={allowLoad}
          setSupportMultipleWindows={false}
          bounces={false}
          scrollEnabled={false}
          overScrollMode="never"
          textZoom={100}
          automaticallyAdjustContentInsets={false}
          dataDetectorTypes="none"
          hideKeyboardAccessoryView
          keyboardDisplayRequiresUserAction={false}
          style={styles.web}
          containerStyle={styles.web}
        />
        {caption ? (
          <Pressable
            testID="terminal-pane-size"
            accessibilityRole="button"
            accessibilityLabel={t("Pane size")}
            onPress={() => setCaptionShort((short) => !short)}
            style={[
              styles.caption,
              { backgroundColor: tokens.background, borderColor: tokens.border },
            ]}
          >
            <Text style={[styles.captionText, { color: tokens.foreground }]}>{caption}</Text>
          </Pressable>
        ) : null}
        {overlay ? (
          <View
            pointerEvents="box-none"
            style={[
              styles.overlay,
              { backgroundColor: tokens.background, borderColor: tokens.border },
            ]}
          >
            <Text
              testID="terminal-status"
              accessibilityLiveRegion="polite"
              style={[styles.status, { color: tokens.foreground }]}
            >
              {overlay}
            </Text>
            {canReopen ? (
              <Pressable
                accessibilityRole="button"
                onPress={reopen}
                style={[styles.button, { borderColor: tokens.border }]}
              >
                <Text style={[styles.buttonLabel, { color: tokens.foreground }]}>
                  {t("Reopen")}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      <TerminalKeyRow
        ctrl={ctrl}
        keyboardOn={softKeyboardVisible}
        hasSelection={hasSelection}
        // The home indicator is only in the way while no keyboard covers it.
        bottomInset={softKeyboardVisible ? 0 : insets.bottom}
        // An iPad with no soft keyboard showing is taken to have a hardware keyboard, so the row
        // shrinks. An iPad whose keyboard is only hidden gets the compact row too, and the
        // toggle is then off.
        compact={compactKeyRow({
          isPad: Platform.OS === "ios" && Platform.isPad,
          softKeyboardVisible,
        })}
        onKey={handler.pressKey}
        onToggleCtrl={handler.toggleCtrl}
        onToggleKeyboard={() => send({ t: "keyboard", on: !softKeyboardVisible })}
        zoom={zoom}
        zoomDisabled={state !== "live"}
        onToggleZoom={handler.toggleZoom}
        onPaste={() => void handler.paste()}
        onCopy={handler.copy}
      />
    </KeyboardAvoidingView>
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
  caption: {
    position: "absolute",
    top: 6,
    right: 8,
    opacity: 0.85,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  captionText: { fontSize: 11, lineHeight: 15 },
  status: { fontSize: 13, lineHeight: 18 },
  button: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonLabel: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
});
