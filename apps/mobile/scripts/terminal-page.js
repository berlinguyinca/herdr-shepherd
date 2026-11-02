// The page inside the terminal WebView. Plain script, inlined by build-terminal-html.mjs;
// every decision worth testing lives in lib/terminal-bridge.ts. Keep this small.
(() => {
  const themes = {
    dark: {
      background: "#141414",
      foreground: "#e8e8e8",
      cursor: "#e8e8e8",
      cursorAccent: "#141414",
      selectionBackground: "#3d5a80",
      black: "#64686a",
      red: "#ef5350",
      green: "#66bb6a",
      yellow: "#ffca28",
      blue: "#64b5f6",
      magenta: "#ce93d8",
      cyan: "#4dd0e1",
      white: "#d3d7cf",
      brightBlack: "#7f8788",
      brightRed: "#ff8a80",
      brightGreen: "#a5d6a7",
      brightYellow: "#ffe082",
      brightBlue: "#90caf9",
      brightMagenta: "#e1bee7",
      brightCyan: "#80deea",
      brightWhite: "#ffffff",
    },
    light: {
      background: "#fcfcfc",
      foreground: "#1a1a1a",
      cursor: "#1a1a1a",
      cursorAccent: "#fcfcfc",
      selectionBackground: "#b3d4fc",
      black: "#1a1a1a",
      red: "#c62828",
      green: "#2e7d32",
      yellow: "#8d6e00",
      blue: "#1565c0",
      magenta: "#8e24aa",
      cyan: "#007f8a",
      white: "#737373",
      brightBlack: "#5f6368",
      brightRed: "#d32f2f",
      brightGreen: "#338237",
      brightYellow: "#916d00",
      brightBlue: "#1874cf",
      brightMagenta: "#9c27b0",
      brightCyan: "#008088",
      brightWhite: "#666666",
    },
  };
  const post = (msg) => {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  };
  const toB64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (text) => {
    const s = atob(text),
      out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };

  const term = new Terminal({
    fontFamily: 'ui-monospace, Menlo, "Roboto Mono", monospace',
    fontSize: window.__fontSize || 13,
    scrollback: 5000,
    cursorBlink: true,
    // Option types Meta (ESC-prefixed) on the iPad hardware keyboard.
    macOptionIsMeta: true,
    theme: window.__dark === false ? themes.light : themes.dark,
    // Remote output can carry OSC 8 hyperlinks. Activating one must do nothing: no dialog, no
    // navigation. (There is no link policy in this view yet.)
    linkHandler: { activate() {} },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("t"));
  // The native side owns the keyboard; a tap must not raise the web one.
  term.textarea.setAttribute("inputmode", "none");
  // Whatever dismisses the keyboard, a later focus must not raise it again.
  term.textarea.addEventListener("blur", () => term.textarea.setAttribute("inputmode", "none"));

  const encoder = new TextEncoder();
  // A Ctrl pending from the key row applies to the next input: a single character goes through
  // controlByte (the key row's own table, inlined at build time), anything else passes through
  // unchanged. Either way Ctrl is spent and native is told. An IME word arriving in one onData
  // spends Ctrl without applying it; that fails visibly, the word types as it is.
  let ctrl = false;
  const spendCtrl = () => {
    if (!ctrl) return;
    ctrl = false;
    post({ t: "ctrlUsed" });
  };
  term.onData((data) => {
    if (ctrl) {
      spendCtrl();
      const byte = controlByte(data);
      if (byte !== undefined) data = String.fromCharCode(byte);
    }
    post({ t: "in", b64: toB64(encoder.encode(data)) });
  });
  term.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 255;
    post({ t: "in", b64: toB64(bytes) });
  });
  // Clipboard text is capped at 1 MB of UTF-8 (MAX_CLIPBOARD_BYTES in terminal-bridge.ts); a
  // larger selection never crosses the bridge.
  const MAX_CLIPBOARD = 1048576;
  const copySelection = () => {
    if (!term.hasSelection()) return;
    const text = term.getSelection();
    if (text.length > MAX_CLIPBOARD || encoder.encode(text).length > MAX_CLIPBOARD) {
      post({ t: "tooLarge" });
      return;
    }
    post({ t: "copy", text });
  };
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || !event.metaKey) return true;
    if (event.key === "c" && term.hasSelection()) copySelection();
    else if (event.key === "v") {
      // Native reads the clipboard and answers with a paste message.
      event.preventDefault();
      post({ t: "pasteRequest" });
    } else return true;
    return false;
  });
  let selected = false;
  term.onSelectionChange(() => {
    if (term.hasSelection() === selected) return;
    selected = !selected;
    post({ t: "selection", has: selected });
  });
  let appCursor = false;
  const syncMode = () => {
    const on = term.modes.applicationCursorKeysMode;
    if (on === appCursor) return;
    appCursor = on;
    post({ t: "appCursor", on });
  };

  let last = "";
  const sendSize = () => {
    // Laid out at zero (hidden, or not sized yet) fits to nothing: wait for a real size.
    if (!document.body.clientWidth || !document.body.clientHeight) return;
    fit.fit();
    const key = term.rows + "x" + term.cols;
    if (key === last) return;
    last = key;
    post({ t: "size", rows: term.rows, cols: term.cols });
  };
  let queued = 0;
  const refit = () => {
    cancelAnimationFrame(queued);
    queued = requestAnimationFrame(sendSize);
  };
  window.addEventListener("resize", refit);
  window.addEventListener("orientationchange", refit);
  new ResizeObserver(refit).observe(document.body);

  const onMessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.t === "out" && typeof msg.b64 === "string") term.write(fromB64(msg.b64), syncMode);
    else if (msg.t === "clear") {
      term.reset();
      syncMode();
    } else if (msg.t === "theme") term.options.theme = msg.dark ? themes.dark : themes.light;
    else if (msg.t === "focus") term.focus();
    else if (msg.t === "blur") {
      // The view went away: no soft keyboard, and no focus left to raise one.
      term.textarea.setAttribute("inputmode", "none");
      term.textarea.blur();
    } else if (msg.t === "copy") copySelection();
    else if (msg.t === "ctrl") ctrl = msg.on === true;
    else if (msg.t === "keyboard") {
      if (msg.on) {
        // Blur first: iOS only reloads the input view for a changed input mode on a fresh focus.
        term.textarea.blur();
        term.textarea.setAttribute("inputmode", "text");
        term.focus();
      } else {
        // Stay focused with no soft keyboard, so a hardware keyboard keeps typing.
        term.textarea.setAttribute("inputmode", "none");
        term.textarea.blur();
        term.focus();
      }
    } else if (msg.t === "paste" && typeof msg.b64 === "string") {
      if (msg.b64.length > Math.ceil((MAX_CLIPBOARD * 4) / 3) + 4) post({ t: "tooLarge" });
      else {
        // Pasted text is never a control byte: a pending Ctrl is dropped first.
        spendCtrl();
        term.paste(new TextDecoder().decode(fromB64(msg.b64)));
      }
    } else if (msg.t === "font" && typeof msg.size === "number" && Number.isFinite(msg.size)) {
      // A new size changes rows and cols; refit reports them through the normal size message.
      term.options.fontSize = Math.min(32, Math.max(8, msg.size));
      refit();
    }
  };
  // iOS delivers to window, Android to document.
  window.addEventListener("message", onMessage);
  document.addEventListener("message", onMessage);

  sendSize();
  post({ t: "ready" });
})();
