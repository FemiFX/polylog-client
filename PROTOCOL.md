# Live translation WebSocket protocol

Two endpoints. The **host** streams microphone audio up; **listeners** receive
translated text and optionally audio down. Listeners are free fan-out — they open
no upstream translation session, so listener count doesn't affect cost.

```
 host browser                                        listener phones
      │                                                    ▲
      │ binary PCM16 24 kHz mono                           │ JSON deltas
      ▼                                                    │
 /ws/host/{token} ──► server ──► N translation sessions ──► /ws/listen/{token}?lang=
                        │         (one per target language)
                        └──► VAD · speaker-ID · language-ID · recorder
```

## Host endpoint

`WS /ws/host/{token}`

**Client → server**

| Message | Form | Notes |
|---|---|---|
| audio frame | binary | PCM16, **24 kHz, mono, little-endian**. See [`src/pcm.js`](src/pcm.js) |
| `"ping"` | text | Keepalive |

**Server → client**

| Message | Meaning |
|---|---|
| `host_ready` | Session accepted; start sending audio |
| `pong` | Keepalive reply |
| `error` | See the error object below |

Sessions open on **first host connect**, not when the event is created — an event
nobody has joined costs nothing upstream.

## Listener endpoint

`WS /ws/listen/{token}?lang=<code>&in_room=<0|1>`

`in_room=1` means the listener is physically present. It matters: see
*Echo suppression* below.

**Client → server**

| Message | Payload |
|---|---|
| `set_language` | `{ "lang": "de" }` |
| `set_in_room` | `{ "in_room": true }` |

**Server → client**

| Message | Payload | Meaning |
|---|---|---|
| `welcome` | `{ event_name, language, languages[], current_speaker, in_room }` | Sent on connect. `languages` drives the picker |
| `translation_start` | `{ turn_id }` | A display block begins |
| `translation_delta` | `{ turn_id, text }` | Append to the current block |
| `translation_end` | `{ turn_id }` | Block complete |
| `translation_audio_delta` | `{ turn_id, audio }` | Base64 PCM, when spoken output is enabled |
| `source_transcript_delta` | `{ turn_id, text }` | **Secondary monitor line only.** Never substitute this for the translation |
| `speaker_label` | `{ speaker }` | Attribution for the current block |
| `error` | `{ code, message, retry }` | See below |

## Errors and reconnection

The `error` message carries a `retry` flag, and honouring it is the difference
between a client that recovers and one that hammers a closed door:

```json
{ "code": "event_not_live", "message": "…", "retry": true }
```

- `retry: true` — transient. The event hasn't started yet, or the server is
  restarting. **Reconnect with backoff.**
- `retry: false` — fatal. Bad token, or the requested language isn't offered.
  **Stop.** Reconnecting cannot fix it, and retrying a bad token forever is how
  you get rate-limited.

Recommended backoff: start at 1s, multiply by 1.5 per attempt, cap at 15s.

## Echo suppression

An in-room listener whose selected language **is the language currently being
spoken** receives nothing — they can hear the room. Remote listeners always
receive the translation.

Two details that are easy to get wrong:

1. **The decision follows detected speech, never a speaker's declared profile.**
   A speaker registered as English-speaking may switch to German mid-sentence; if
   routing followed the profile, every in-room German listener would get a
   redundant translation of speech they can already hear.
2. **It is suppression, not audio cancellation.** No AEC is involved — the server
   simply doesn't send that segment.

## Latency

Expect roughly **3–4 seconds** end to end, and design the UI for it.

The upstream translation stream carries no utterance boundaries, so the server
buffers briefly (~1s) before presenting, by which time local VAD, speaker-ID and
language-ID have resolved for that segment. Output time is mapped back to the
input segment that produced it using a *measured* input→output lag, smoothed as
an EMA — not a fixed constant, because it varies with load.

Block boundaries: a speaker change or a long pause *arms* a split, but the cut
only fires at the next sentence end, so a sentence is never shattered across two
blocks. A client that renders each `translation_delta` immediately will look
correct; one that waits for `translation_end` before showing anything will feel
several seconds slower than it is.
