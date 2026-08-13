/**
 * Reference listener client for the live-translation WebSocket protocol.
 *
 * Handles the parts that are easy to get wrong: distinguishing retriable from
 * fatal errors, backing off correctly, keeping block state coherent when deltas
 * arrive out of order, and switching language without dropping the connection.
 *
 * Rendering is yours — this emits events and holds no DOM.
 *
 *   const client = new ListenerClient({
 *     url: "wss://example.com/ws/listen/TOKEN",
 *     lang: "de",
 *     inRoom: false,
 *   });
 *   client.on("delta", ({ turnId, text }) => appendToBlock(turnId, text));
 *   client.on("status", ({ state }) => showStatus(state));
 *   client.connect();
 *
 * See PROTOCOL.md for the full message contract.
 */

export class ListenerClient {
  /**
   * @param {object} opts
   * @param {string} opts.url        Listener WebSocket URL, token included.
   * @param {string} [opts.lang]     Initial target language code.
   * @param {boolean} [opts.inRoom]  True if physically present (enables echo suppression).
   * @param {number} [opts.retryBaseMs=1000]
   * @param {number} [opts.retryMaxMs=15000]
   * @param {number} [opts.retryFactor=1.5]
   */
  constructor({
    url,
    lang = null,
    inRoom = false,
    retryBaseMs = 1000,
    retryMaxMs = 15000,
    retryFactor = 1.5,
  }) {
    if (!url) throw new Error("ListenerClient requires a url");
    this.url = url;
    this.lang = lang;
    this.inRoom = inRoom;

    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.retryFactor = retryFactor;
    this._retryDelay = retryBaseMs;
    this._retryTimer = null;

    this.ws = null;
    this.closedByUs = false;
    /** Accumulated text per turn id, so a late delta can't corrupt an earlier block. */
    this.blocks = new Map();
    this.languages = [];
    this.eventName = null;
    this.currentSpeaker = null;

    this._handlers = new Map();
  }

  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return this;
  }

  off(event, handler) {
    this._handlers.get(event)?.delete(handler);
    return this;
  }

  _emit(event, payload) {
    for (const handler of this._handlers.get(event) || []) {
      try {
        handler(payload);
      } catch (err) {
        // A throwing listener must not take down the socket.
        console.error(`[polylog] handler for "${event}" threw`, err);
      }
    }
  }

  connect() {
    this.closedByUs = false;
    clearTimeout(this._retryTimer);

    const url = new URL(this.url);
    if (this.lang) url.searchParams.set("lang", this.lang);
    url.searchParams.set("in_room", this.inRoom ? "1" : "0");

    this._emit("status", { state: "connecting" });
    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => {
      // Reset backoff only on a genuinely established connection, not on an
      // attempt -- otherwise a server that accepts and immediately closes
      // produces a tight reconnect loop at the base delay.
      this._retryDelay = this.retryBaseMs;
      this._emit("status", { state: "connected" });
    };

    this.ws.onmessage = (event) => this._onMessage(event);

    this.ws.onclose = () => {
      this._emit("status", { state: "disconnected" });
      if (!this.closedByUs) this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      // Browsers deliberately give no detail here. onclose follows; reconnect
      // is handled there so it isn't attempted twice.
      this._emit("status", { state: "error" });
    };
  }

  _scheduleReconnect() {
    const delay = Math.min(this._retryDelay, this.retryMaxMs);
    this._emit("status", { state: "reconnecting", delayMs: delay });
    this._retryTimer = setTimeout(() => this.connect(), delay);
    this._retryDelay = Math.min(this._retryDelay * this.retryFactor, this.retryMaxMs);
  }

  _onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "welcome":
        this.eventName = msg.event_name ?? null;
        this.languages = msg.languages ?? [];
        this.currentSpeaker = msg.current_speaker ?? null;
        if (msg.language) this.lang = msg.language;
        this._emit("welcome", msg);
        break;

      case "translation_start":
        this.blocks.set(msg.turn_id, "");
        this._emit("blockStart", { turnId: msg.turn_id });
        break;

      case "translation_delta": {
        // Tolerate a delta for a turn we never saw start -- a client that
        // connects mid-sentence should still render the tail.
        const prev = this.blocks.get(msg.turn_id) ?? "";
        const text = prev + (msg.text ?? "");
        this.blocks.set(msg.turn_id, text);
        this._emit("delta", { turnId: msg.turn_id, text: msg.text ?? "", full: text });
        break;
      }

      case "translation_end":
        this._emit("blockEnd", {
          turnId: msg.turn_id,
          full: this.blocks.get(msg.turn_id) ?? "",
        });
        break;

      case "translation_audio_delta":
        this._emit("audio", { turnId: msg.turn_id, audio: msg.audio });
        break;

      case "source_transcript_delta":
        // Secondary monitor line only. Never render this in place of the
        // translation -- it is the source language, not the target.
        this._emit("sourceTranscript", { turnId: msg.turn_id, text: msg.text ?? "" });
        break;

      case "speaker_label":
        this.currentSpeaker = msg.speaker ?? null;
        this._emit("speaker", { speaker: this.currentSpeaker });
        break;

      case "error":
        this._emit("error", msg);
        // Honouring `retry` is the whole point: a bad token or an unoffered
        // language cannot be fixed by trying again, and retrying forever is how
        // a client gets itself rate-limited.
        if (msg.retry === false) {
          this.closedByUs = true;
          this.close();
        }
        break;

      default:
        this._emit("message", msg);
    }
  }

  _send(type, payload = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type, ...payload }));
    return true;
  }

  /** Switch target language in place; no reconnect needed. */
  setLanguage(lang) {
    this.lang = lang;
    // Clear accumulated blocks: they hold the previous language's text, and
    // keeping them would interleave two languages in one transcript.
    this.blocks.clear();
    return this._send("set_language", { lang });
  }

  /** Tell the server whether this listener is physically in the room. */
  setInRoom(inRoom) {
    this.inRoom = Boolean(inRoom);
    return this._send("set_in_room", { in_room: this.inRoom });
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this._retryTimer);
    this.ws?.close();
    this._emit("status", { state: "closed" });
  }
}

export default ListenerClient;
