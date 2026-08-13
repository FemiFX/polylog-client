/**
 * Mock translation server — replays a scripted "event" so the client can be
 * driven end to end with no backend.
 *
 * It implements the listener side of PROTOCOL.md, including the two behaviours
 * worth exercising in a client: streamed deltas rather than whole sentences, and
 * a fatal-vs-retriable error distinction.
 *
 *   npm install && npm run demo   →  http://localhost:8080
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = Number(process.env.PORT || 8080);

const LANGUAGES = ["de", "fr", "es"];

// Fictional conference remarks, per language.
const SCRIPT = {
  de: [
    "Guten Morgen und herzlich willkommen zu unserer Jahreskonferenz.",
    "Bevor wir beginnen, ein kurzer Hinweis zum Ablauf des heutigen Tages.",
    "Die erste Sitzung dauert etwa vierzig Minuten, danach gibt es eine Pause.",
  ],
  fr: [
    "Bonjour et bienvenue à notre conférence annuelle.",
    "Avant de commencer, quelques mots sur le déroulement de la journée.",
    "La première session dure environ quarante minutes, suivie d'une pause.",
  ],
  es: [
    "Buenos días y bienvenidos a nuestra conferencia anual.",
    "Antes de empezar, unas palabras sobre el programa de hoy.",
    "La primera sesión dura unos cuarenta minutos, seguida de una pausa.",
  ],
};

const SPEAKERS = ["Speaker A", "Speaker B"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname === "/" ? "/demo/index.html" : url.pathname;
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ server, path: undefined });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.pathname.split("/").pop();
  let lang = url.searchParams.get("lang") || "de";
  let inRoom = url.searchParams.get("in_room") === "1";

  // Demonstrates the fatal path: a client must NOT reconnect on this.
  if (token === "bad-token") {
    ws.send(JSON.stringify({
      type: "error",
      code: "invalid_token",
      message: "Unknown event token.",
      retry: false,
    }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({
    type: "welcome",
    event_name: "Annual Conference (demo)",
    language: lang,
    languages: LANGUAGES,
    current_speaker: SPEAKERS[0],
    in_room: inRoom,
  }));

  let turn = 0;
  let cancelled = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    while (!cancelled && ws.readyState === ws.OPEN) {
      const lines = SCRIPT[lang] || SCRIPT.de;
      const text = lines[turn % lines.length];
      const speaker = SPEAKERS[turn % SPEAKERS.length];
      const turnId = `turn-${++turn}`;

      ws.send(JSON.stringify({ type: "speaker_label", speaker }));
      ws.send(JSON.stringify({ type: "translation_start", turn_id: turnId }));

      // Stream word by word: real translation arrives as a continuous stream,
      // and a client that only renders on translation_end will feel seconds
      // slower than the system actually is.
      for (const word of text.split(" ")) {
        if (cancelled || ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({ type: "translation_delta", turn_id: turnId, text: word + " " }));
        await sleep(140);
      }

      ws.send(JSON.stringify({ type: "translation_end", turn_id: turnId }));
      await sleep(1200);
    }
  })();

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "set_language" && LANGUAGES.includes(msg.lang)) {
      lang = msg.lang;
      ws.send(JSON.stringify({ type: "speaker_label", speaker: SPEAKERS[0] }));
    }
    if (msg.type === "set_in_room") inRoom = Boolean(msg.in_room);
  });

  ws.on("close", () => { cancelled = true; });
});

server.listen(PORT, () => {
  console.log(`demo:      http://localhost:${PORT}`);
  console.log(`fatal path: http://localhost:${PORT}/?token=bad-token`);
});
