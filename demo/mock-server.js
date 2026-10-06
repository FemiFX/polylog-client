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

// What the speaker says, as the listener receives it in each language:
// Articles 1-7 of the Universal Declaration of Human Rights in the official
// UN translations, which the UN allows anyone to reproduce. Real speech is
// uneven -- a short sentence, then a long one -- and so is this.
const SCRIPT = {
  de: [
    "Alle Menschen sind frei und gleich an Würde und Rechten geboren. Sie sind mit Vernunft und Gewissen begabt und sollen einander im Geiste der Brüderlichkeit begegnen.",
    "Jeder hat Anspruch auf alle in dieser Erklärung verkündeten Rechte und Freiheiten, ohne irgendeinen Unterschied, etwa nach Rasse, Hautfarbe, Geschlecht, Sprache, Religion, politischer oder sonstiger Anschauung, nationaler oder sozialer Herkunft, Vermögen, Geburt oder sonstigem Stand. Des weiteren darf kein Unterschied gemacht werden auf Grund der politischen, rechtlichen oder internationalen Stellung des Landes oder Gebietes, dem eine Person angehört, gleichgültig ob dieses unabhängig ist, unter Treuhandschaft steht, keine Selbstregierung besitzt oder sonst in seiner Souveränität eingeschränkt ist.",
    "Jeder hat das Recht auf Leben, Freiheit und Sicherheit der Person.",
    "Niemand darf in Sklaverei oder Leibeigenschaft gehalten werden; Sklaverei und Sklavenhandel in allen ihren Formen sind verboten.",
    "Niemand darf der Folter oder grausamer, unmenschlicher oder erniedrigender Behandlung oder Strafe unterworfen werden.",
    "Jeder hat das Recht, überall als rechtsfähig anerkannt zu werden.",
    "Alle Menschen sind vor dem Gesetz gleich und haben ohne Unterschied Anspruch auf gleichen Schutz durch das Gesetz. Alle haben Anspruch auf gleichen Schutz gegen jede Diskriminierung, die gegen diese Erklärung verstößt, und gegen jede Aufhetzung zu einer derartigen Diskriminierung.",
  ],
  fr: [
    "Tous les êtres humains naissent libres et égaux en dignité et en droits. Ils sont doués de raison et de conscience et doivent agir les uns envers les autres dans un esprit de fraternité.",
    "Chacun peut se prévaloir de tous les droits et de toutes les libertés proclamés dans la présente Déclaration, sans distinction aucune, notamment de race, de couleur, de sexe, de langue, de religion, d'opinion politique ou de toute autre opinion, d'origine nationale ou sociale, de fortune, de naissance ou de toute autre situation. De plus, il ne sera fait aucune distinction fondée sur le statut politique, juridique ou international du pays ou du territoire dont une personne est ressortissante, que ce pays ou territoire soit indépendant, sous tutelle, non autonome ou soumis à une limitation quelconque de souveraineté.",
    "Tout individu a droit à la vie, à la liberté et à la sûreté de sa personne.",
    "Nul ne sera tenu en esclavage ni en servitude; l'esclavage et la traite des esclaves sont interdits sous toutes leurs formes.",
    "Nul ne sera soumis à la torture, ni à des peines ou traitements cruels, inhumains ou dégradants.",
    "Chacun a le droit à la reconnaissance en tous lieux de sa personnalité juridique.",
    "Tous sont égaux devant la loi et ont droit sans distinction à une égale protection de la loi. Tous ont droit à une protection égale contre toute discrimination qui violerait la présente Déclaration et contre toute provocation à une telle discrimination.",
  ],
  es: [
    "Todos los seres humanos nacen libres e iguales en dignidad y derechos y, dotados como están de razón y conciencia, deben comportarse fraternalmente los unos con los otros.",
    "Toda persona tiene todos los derechos y libertades proclamados en esta Declaración, sin distinción alguna de raza, color, sexo, idioma, religión, opinión política o de cualquier otra índole, origen nacional o social, posición económica, nacimiento o cualquier otra condición. Además, no se hará distinción alguna fundada en la condición política, jurídica o internacional del país o territorio de cuya jurisdicción dependa una persona, tanto si se trata de un país independiente, como de un territorio bajo administración fiduciaria, no autónomo o sometido a cualquier otra limitación de soberanía.",
    "Todo individuo tiene derecho a la vida, a la libertad y a la seguridad de su persona.",
    "Nadie estará sometido a esclavitud ni a servidumbre, la esclavitud y la trata de esclavos están prohibidas en todas sus formas.",
    "Nadie será sometido a torturas ni a penas o tratos crueles, inhumanos o degradantes.",
    "Todo ser humano tiene derecho, en todas partes, al reconocimiento de su personalidad jurídica.",
    "Todos son iguales ante la ley y tienen, sin distinción, derecho a igual protección de la ley. Todos tienen derecho a igual protección contra toda discriminación que infrinja esta Declaración y contra toda provocación a tal discriminación.",
  ],
};

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
    in_room: inRoom,
  }));

  let article = 0;
  let turn = 0;
  let switched = false;
  let cancelled = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Deterministic jitter, so every run of the demo streams at the same pace.
  let seed = 7;
  const jitter = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };

  (async () => {
    while (!cancelled && ws.readyState === ws.OPEN) {
      const lines = SCRIPT[lang] || SCRIPT.de;
      const text = lines[article % lines.length];
      const turnId = `turn-${++turn}`;
      switched = false;

      ws.send(JSON.stringify({ type: "translation_start", turn_id: turnId }));

      // Stream word by word: real translation arrives as a continuous stream,
      // and a client that only renders on translation_end will feel seconds
      // slower than the system actually is. Pauses follow the punctuation,
      // the way a speaker breathes.
      for (const word of text.split(" ")) {
        if (cancelled || ws.readyState !== ws.OPEN) return;
        if (switched) break;
        ws.send(JSON.stringify({ type: "translation_delta", turn_id: turnId, text: word + " " }));
        let pause = 110 + jitter(140);
        if (/[,;:]$/.test(word)) pause += 320;
        if (/[.!?]$/.test(word)) pause += 700;
        await sleep(pause);
      }

      ws.send(JSON.stringify({ type: "translation_end", turn_id: turnId }));
      // A language switch restarts the current passage in the new language.
      if (switched) continue;
      article += 1;
      await sleep(900 + jitter(900));
    }
  })();

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "set_language" && LANGUAGES.includes(msg.lang)) {
      lang = msg.lang;
      switched = true;
    }
    if (msg.type === "set_in_room") inRoom = Boolean(msg.in_room);
  });

  ws.on("close", () => { cancelled = true; });
});

server.listen(PORT, () => {
  console.log(`demo:      http://localhost:${PORT}`);
  console.log(`fatal path: http://localhost:${PORT}/?token=bad-token`);
});
