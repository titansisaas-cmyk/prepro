class PreProCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.t0 = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n === 0) this.t0 = currentTime;
      this.buf.set(ch, this.n); this.n += ch.length;
      if (this.n >= 4096) { this.port.postMessage({ t0: this.t0, d: this.buf }, [this.buf.buffer]); this.buf = new Float32Array(4096); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('prepro-capture', PreProCapture);
