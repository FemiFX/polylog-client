// AudioWorklet processor: accumulates mono float32 mic audio and posts it to
// the main thread in ~20ms batches, where it is resampled to 24kHz PCM16.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._acc = [];
    this._n = 0;
    this._chunk = 960; // ~20ms at 48kHz
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this._acc.push(ch.slice());
      this._n += ch.length;
      if (this._n >= this._chunk) {
        const out = new Float32Array(this._n);
        let o = 0;
        for (const a of this._acc) { out.set(a, o); o += a.length; }
        this.port.postMessage(out, [out.buffer]);
        this._acc = [];
        this._n = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
