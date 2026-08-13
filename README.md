# polylog-client

Browser client for a **live speech-translation** system: a speaker talks, and
attendees read subtitles in their own language on their own phones, a few seconds
later.

This repository holds the client half — the listener runtime, the AudioWorklet
microphone capture, and the [WebSocket protocol specification](PROTOCOL.md). The
translation server is separate.

No dependencies. `ws` is a devDependency, used only by the demo.

## Run the demo

```bash
npm install
npm run demo        # http://localhost:8080
```

A mock server replays a scripted conference session, so you can watch subtitles
stream in, switch language mid-sentence, and see the reconnection behaviour —
with no translation backend and no API keys.

Then try [`/?token=bad-token`](http://localhost:8080/?token=bad-token) to see the
fatal-error path: the client stops rather than reconnecting.

## Using it

```js
import { ListenerClient } from "polylog-client";

const client = new ListenerClient({
  url: "wss://example.com/ws/listen/EVENT_TOKEN",
  lang: "de",
  inRoom: false,
});

client.on("delta",  ({ turnId, full }) => render(turnId, full));
client.on("status", ({ state }) => showConnectionState(state));
client.connect();

client.setLanguage("fr");   // switches in place, no reconnect
client.setInRoom(true);     // enables echo suppression
```

| Event | Fires when |
|---|---|
| `welcome` | Connected. Carries event name and the offered languages |
| `blockStart` / `delta` / `blockEnd` | A subtitle block begins, grows, completes |
| `sourceTranscript` | Source-language monitor line — **never** a substitute for the translation |
| `speaker` | Speaker attribution changed |
| `audio` | Base64 PCM, when spoken output is enabled |
| `status` | `connecting` · `connected` · `reconnecting` · `disconnected` · `closed` |
| `error` | Server error, carrying the `retry` flag |

## Three things this client gets right

**It distinguishes fatal from transient errors.** The server's `error` message
carries `retry`. `retry: true` means the event hasn't started or the server is
restarting — reconnect with backoff. `retry: false` means a bad token or an
unoffered language — stop. Reconnecting can't fix those, and retrying a bad token
forever is how a client gets rate-limited.

**Backoff resets on connection, not on attempt.** A server that accepts a socket
and immediately closes it would otherwise produce a tight reconnect loop pinned
at the base delay. The reset happens in `onopen`.

**Block state is keyed by turn id.** Deltas are accumulated per turn rather than
appended to "the current block", so a late or out-of-order delta can't corrupt an
earlier one. A delta for a turn that was never opened is still rendered — a
listener joining mid-sentence should see the tail rather than nothing.

## Audio capture

[`src/pcm.js`](src/pcm.js) and [`src/capture-worklet.js`](src/capture-worklet.js)
capture microphone audio as **PCM16, 24 kHz, mono** — the format the host
endpoint expects.

They use an `AudioWorklet` rather than the deprecated `ScriptProcessorNode`,
which matters here: `ScriptProcessorNode` runs on the main thread, so any layout
or paint work causes audible dropouts. An `AudioWorklet` runs on the audio
rendering thread and doesn't.

## The protocol

[PROTOCOL.md](PROTOCOL.md) documents both endpoints in full: message shapes,
the error contract, echo suppression, and the latency budget.

Two points worth reading before building against it:

- **Echo suppression is routing, not audio cancellation.** An in-room listener
  whose selected language is the one currently being spoken receives nothing —
  they can hear the room. The decision follows *detected* speech, never a
  speaker's declared profile, because speakers switch language mid-talk.
- **Expect 3–4 seconds end to end**, and design the UI for it. The server buffers
  briefly so local voice-activity and language detection can resolve before text
  is presented. Render each delta as it arrives; a client that waits for
  `translation_end` will feel far slower than the system is.

## Licence

MIT — see [LICENSE](LICENSE).
