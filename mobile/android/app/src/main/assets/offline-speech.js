(() => {
  if (window.top !== window || location.href !== "https://appassets.androidplatform.net/conversation/index.html" ||
      !window.claudexOfflineSpeech || "speechSynthesis" in window) return;
  // Host compatibility only: canonical per-reply controls own text cleaning and chunks.
  const bridge = window.claudexOfflineSpeech;
  const events = new EventTarget();
  let voices = [], serial = 0, context = 0, active = null, queue = [], suspended = false, unavailable = false;
  const notify = (u, type, error) => {
    const event = new Event(type);
    if (error) Object.defineProperty(event, "error", { value: error });
    u.dispatchEvent(event);
    if (typeof u["on" + type] === "function") u["on" + type](event);
  };
  const post = (value) => bridge.postMessage(JSON.stringify({ version: 1, context, ...value }));
  const pump = () => {
    if (active || !queue.length) return;
    active = queue.shift();
    const { id, utterance: u } = active;
    post({ type: "speak", id, text: u.text, lang: u.lang,
      voice: u.voice?.voiceURI || "", rate: u.rate });
  };
  class Utterance extends EventTarget {
    constructor(text = "") {
      super(); this.text = String(text); this.lang = ""; this.voice = null;
      this.rate = 1; this.pitch = 1; this.volume = 1;
      this.onstart = this.onend = this.onerror = null;
    }
  }
  const synth = {
    getVoices: () => voices.slice(),
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
    get speaking() { return !!active; },
    get pending() { return queue.length > 0; },
    speak(u) {
      if (!(u instanceof Utterance)) throw new TypeError("Expected SpeechSynthesisUtterance");
      if (suspended || unavailable) {
        queueMicrotask(() => notify(u, "error", suspended ? "canceled" : "voice-unavailable")); return;
      }
      if (!u.text.trim() || u.text.length > 1000 || queue.length >= 8 || !Number.isFinite(u.rate) || u.rate < 0.5 || u.rate > 2) {
        queueMicrotask(() => notify(u, "error", "invalid-argument")); return;
      }
      queue.push({ id: "speech-" + (++serial), utterance: u }); pump();
    },
    cancel() {
      const cancelled = [active, ...queue].filter(Boolean);
      active = null; queue = []; post({ type: "cancel" });
      for (const entry of cancelled) notify(entry.utterance, "error", "canceled");
    },
  };
  Object.defineProperty(window, "__claudexOfflineSpeechEvent", { value: (event) => {
    if (event.type === "voices") {
      if (Number.isSafeInteger(event.context)) {
        if (event.context < context) return;
        context = event.context;
      }
      voices = Object.freeze((event.voices || []).map(v => Object.freeze(v)));
      suspended = false; unavailable = false;
      events.dispatchEvent(new Event("voiceschanged")); return;
    }
    if (event.context !== undefined && event.context !== context) return;
    if (event.type === "cancelled") {
      suspended = true;
      const cancelled = [active, ...queue].filter(Boolean); active = null; queue = [];
      for (const entry of cancelled) notify(entry.utterance, "error", "canceled");
      return;
    }
    if (!active || event.id !== active.id) return;
    if (event.type === "start") { notify(active.utterance, "start"); return; }
    if (event.type !== "end" && event.type !== "error") return;
    if (event.error === "voice-unavailable") unavailable = true;
    const entry = active; active = null;
    notify(entry.utterance, event.type, event.error); pump();
  } });
  Object.defineProperty(window, "SpeechSynthesisUtterance", { value: Utterance });
  Object.defineProperty(window, "speechSynthesis", { value: synth });
  post({ type: "voices" });
})();
