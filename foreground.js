/* Local person segmentation. Preview work runs off the UI thread; exports await it. */
window.LyricForeground = class {
  constructor() {
    this.mask = document.createElement('canvas');
    this.input = document.createElement('canvas');
    this.input.width = this.input.height = 256;
    this.inputCtx = this.input.getContext('2d');
    this.pending = new Map();
    this.generation = 0;
    this.sequence = 0;
  }

  init() {
    if (!this.ready) {
      this.ready = (async () => {
        this.worker = new Worker('foreground-worker.js');
        this.worker.onmessage = ({ data }) => {
          const pending = this.pending.get(data.id);
          if (!pending) return;
          this.pending.delete(data.id);
          clearTimeout(pending.timer);
          data.error ? pending.reject(new Error(data.error)) : pending.resolve(data);
        };
        this.worker.onerror = () => this.fail(new Error('Could not load the local person masking engine.'));
        await this.request({ type: 'init' });
      })().catch((error) => {
        this.worker?.terminate();
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(message, transfer = []) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Person masking timed out. Turn it off and on to retry.'));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  reset() {
    this.generation++;
    this.key = null;
    this.hasMask = false;
  }

  dispose() {
    this.reset();
    this.worker?.terminate();
    this.fail(new Error('Person masking stopped.'));
    this.ready = null;
  }

  async update(source, key) {
    // Drain any preview request before starting a frame-exact export request.
    if (this.busy) await this.busy;
    if (this.source === source && this.key === key && this.hasMask) return;
    const generation = this.generation;
    const task = (async () => {
      await this.init();
      this.inputCtx.drawImage(source, 0, 0, 256, 256);
      const frame = await createImageBitmap(this.input);
      const result = await this.request({ type: 'segment', frame }, [frame]);
      if (generation !== this.generation) return;
      this.mask.width = result.width;
      this.mask.height = result.height;
      const image = this.mask.getContext('2d').createImageData(result.width, result.height);
      for (let i = 0; i < result.alpha.length; i++) {
        image.data[i * 4 + 3] = result.alpha[i];
      }
      this.mask.getContext('2d').putImageData(image, 0, 0);
      this.source = source;
      this.key = key;
      this.hasMask = true;
    })();
    this.busy = task;
    try { await task; } finally { if (this.busy === task) this.busy = null; }
  }
};
