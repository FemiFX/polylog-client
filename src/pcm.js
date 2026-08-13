// Shared browser audio helpers: capture (mic -> 24kHz PCM16) and playback.
const TARGET_RATE = 24000;

// Stateful linear-interpolation resampler that preserves continuity across buffers.
class Resampler {
  constructor(inRate, outRate) {
    this.ratio = inRate / outRate;
    this.carry = new Float32Array(0);
    this.t = 0;
  }
  process(input) {
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry);
    buf.set(input, this.carry.length);
    const out = [];
    while (Math.ceil(this.t) < buf.length) {
      const i = Math.floor(this.t);
      const frac = this.t - i;
      out.push(buf[i] * (1 - frac) + buf[i + 1] * frac);
      this.t += this.ratio;
    }
    const keep = Math.floor(this.t);
    this.carry = buf.slice(keep);
    this.t -= keep;
    return Float32Array.from(out);
  }
}

function floatToInt16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
}

// Captures a MediaStream and delivers 24kHz PCM16 Int16Array chunks to onChunk.
class PcmCapture {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.ctx = null;
    this.node = null;
    this.source = null;
  }
  async start(stream) {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.audioWorklet.addModule('/static/capture-worklet.js');
    const resampler = new Resampler(this.ctx.sampleRate, TARGET_RATE);
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor');
    this.node.port.onmessage = (e) => {
      const resampled = resampler.process(e.data);
      if (resampled.length) this.onChunk(floatToInt16(resampled));
    };
    this.source.connect(this.node);
    // Worklet must be in the graph to pull; route to a muted gain node.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink);
    sink.connect(this.ctx.destination);
  }
  stop() {
    if (this.source) this.source.disconnect();
    if (this.node) this.node.disconnect();
    if (this.ctx) this.ctx.close();
  }
}

// Builds a 16-bit PCM WAV Blob from an Int16Array (used for voice-sample upload).
function encodeWav(int16, rate) {
  const buffer = new ArrayBuffer(44 + int16.length * 2);
  const v = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + int16.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, int16.length * 2, true);
  for (let i = 0; i < int16.length; i++) v.setInt16(44 + i * 2, int16[i], true);
  return new Blob([buffer], { type: 'audio/wav' });
}

// Gapless playback of base64 PCM16 chunks via the Web Audio API.
class PcmPlayer {
  constructor() {
    this.ctx = null;
    this.nextTime = 0;
    this.jitter = 0.2;
  }
  start() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.nextTime = this.ctx.currentTime + this.jitter;
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  pause() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  playBase64(b64, rate) {
    if (!this.ctx) this.start();
    const bin = atob(b64);
    const n = bin.length >> 1;
    const dv = new DataView(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) f32[i] = dv.getInt16(i * 2, true) / 32768;
    const buf = this.ctx.createBuffer(1, n, rate || TARGET_RATE);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (this.nextTime < now) this.nextTime = now + this.jitter;
    src.start(this.nextTime);
    this.nextTime += buf.duration;
  }
}

window.PcmCapture = PcmCapture;
window.PcmPlayer = PcmPlayer;
window.encodeWav = encodeWav;
