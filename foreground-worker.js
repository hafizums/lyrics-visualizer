let segmenter;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const { FilesetResolver, ImageSegmenter } = await import('./vendor/mediapipe/vision_bundle.mjs');
      const files = await FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');
      segmenter = await ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: './vendor/mediapipe/selfie_segmenter.tflite' },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      self.postMessage({ id: data.id, ready: true });
      return;
    }
    segmenter.segment(data.frame, (result) => {
      // The selfie model has a single confidence channel: person probability.
      const mask = result.confidenceMasks[0];
      const values = mask.getAsFloat32Array();
      const alpha = new Uint8ClampedArray(values.length);
      for (let i = 0; i < values.length; i++) {
        const p = Math.max(0, Math.min(1, (values[i] - 0.35) / 0.3));
        alpha[i] = Math.round(p * p * (3 - 2 * p) * 255);
      }
      self.postMessage({ id: data.id, width: mask.width, height: mask.height, alpha }, [alpha.buffer]);
    });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message || String(error) });
  } finally {
    data.frame?.close();
  }
};
