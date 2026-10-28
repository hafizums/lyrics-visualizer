// A small collection of lyric-led animations. Each preset has one motion idea.
(function () {
  'use strict';

  const presets = [
    { id: 'aesthetic-vhs', name: 'Indie Film', tier: 'chill', desc: 'Warm italic cinema subtitles', icon: 'M3 6h18v12H3z M7 3v3m10-3v3M7 18v3m10-3v3', bass: 0.18, punch: 0.12, flow: 0.8 },
    { id: 'apple-scroll', name: 'Flow Scroll', tier: 'chill', desc: 'Surrounding lines with depth', icon: 'M6 5h12M3 12h18M6 19h12', bass: 0.14, punch: 0.1, flow: 0.92 },
    { id: 'still-lyrics', name: 'Still Lyrics', tier: 'chill', desc: 'A clean phrase with no motion', icon: 'M4 7h16M4 12h16M7 17h10', bass: 0.05, punch: 0.02, flow: 0.7 },
    { id: 'soft-fade', name: 'Soft Fade', tier: 'chill', desc: 'Fade in, hold, then fade out', icon: 'M4 8v8m5-11v14m6-14v14m5-11v8', bass: 0.22, punch: 0.16, flow: 0.96 },
    { id: 'line-rise', name: 'Line Rise', tier: 'melodic', desc: 'The phrase gently settles upward', icon: 'M4 18h16M12 14V4m-4 4 4-4 4 4', bass: 0.3, punch: 0.22, flow: 0.88 },
    { id: 'word-reveal', name: 'Word Reveal', tier: 'melodic', desc: 'Each word appears as it is sung', icon: 'M3 8h5v8H3zM11 8h4v8h-4m7-8h3', bass: 0.35, punch: 0.42, flow: 0.66 },
    { id: 'karaoke-fill', name: 'Karaoke Fill', tier: 'melodic', desc: 'Color sweeps through sung words', icon: 'M3 7h18v10H3zM3 7h10v10M7 10v4', bass: 0.38, punch: 0.2, flow: 0.76 },
    { id: 'typewriter', name: 'Typewriter', tier: 'upbeat', desc: 'Letters reveal with the vocal timing', icon: 'M3 8h6m-3 0v9m7-9h4m-4 4h3m5-7v15', bass: 0.42, punch: 0.48, flow: 0.65 },
    { id: 'word-pop', name: 'Word Pop', tier: 'upbeat', desc: 'One small pop on each sung word', icon: 'M7 8h10v10H7zM12 2v3M3 7l2 2m16-2-2 2', bass: 0.5, punch: 0.65, flow: 0.5 },
    { id: 'solo-word', name: 'Solo Word', tier: 'drop', desc: 'Only the current word, large and clear', icon: 'M5 19 12 4l7 15M8 14h8', bass: 0.8, punch: 0.86, flow: 0.2 },
    { id: 'poster-stack', name: 'Poster Stack', tier: 'drop', desc: 'Build a centered stack of words', icon: 'M6 4h12M3 9h18M5 14h14M8 19h8', bass: 0.74, punch: 0.58, flow: 0.4 },
    { id: 'slide-cut', name: 'Slide Cut', tier: 'drop', desc: 'One quick slide for each new phrase', icon: 'M3 12h8m-3-3 3 3-3 3M15 6h6v12h-6z', bass: 0.68, punch: 0.94, flow: 0.3 },
  ].concat(window.LyricExtraAnimations.presets);

  const clamp = (value) => Math.max(0, Math.min(1, value));
  const easeOut = (value) => 1 - Math.pow(1 - clamp(value), 3);
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

  function render(config) {
    const { ctx, style, lyric, time, width, height, x, y, reducedMotion } = config;
    if (!lyric || !lyric.words.length) return;
    if (window.LyricExtraAnimations.ids.has(style)) {
      window.LyricExtraAnimations.render(config);
      return;
    }
    const age = Math.max(0, time - lyric.start);
    const remaining = Math.max(0, lyric.end - time);
    const duration = Math.max(0.08, lyric.end - lyric.start);
    const textCase = (text) => config.textCase === 'uppercase' ? text.toUpperCase()
      : config.textCase === 'lowercase' ? text.toLowerCase() : text;
    const words = lyric.words.map((word) => ({ ...word, text: textCase(word.word) }));
    const active = words.findIndex((word) => time >= word.start && time < word.end);
    const soloIndex = active !== -1 ? active : time >= words[words.length - 1].end ? words.length - 1 : 0;
    const tokens = style === 'solo-word' ? [words[soloIndex]] : words;
    const maxWidth = width * 0.84;
    const maxHeight = height * 0.76;
    let size = config.fontSize * (style === 'solo-word' ? 1.3 : 1);
    let rows;
    let space;

    // Measure the actual selected typeface and fit both the line width and block height.
    function layout() {
      ctx.font = `900 ${size}px ${config.fontFamily}`;
      space = ctx.measureText(' ').width;
      rows = [];
      let row = [];
      let rowWidth = 0;
      for (const word of tokens) {
        const wordWidth = ctx.measureText(word.text).width;
        const cellWidth = wordWidth * (style === 'word-pop' ? 1.16 : 1);
        if (row.length && (style === 'poster-stack' || rowWidth + space + cellWidth > maxWidth)) {
          rows.push({ words: row, width: rowWidth });
          row = [];
          rowWidth = 0;
        }
        rowWidth += (row.length ? space : 0) + cellWidth;
        row.push({ ...word, width: wordWidth, cellWidth });
      }
      if (row.length) rows.push({ words: row, width: rowWidth });
    }

    ctx.save();
    try {
      for (let pass = 0; pass < 6; pass++) {
        layout();
        const widestWord = Math.max(...rows.flatMap((row) => row.words.map((word) => word.cellWidth)));
        const blockHeight = rows.length * size * 1.2;
        const fit = Math.min(1, (maxWidth - config.strokeWidth * 4) / Math.max(1, widestWord), maxHeight / blockHeight);
        if (fit >= 0.999) break;
        size *= Math.max(0.01, fit * 0.98);
      }
      layout();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.translate(x, y);

      if (!reducedMotion) {
        if (style === 'soft-fade') {
          const fade = Math.min(clamp(age / Math.min(0.36, duration * 0.3)), clamp(remaining / Math.min(0.3, duration * 0.25)));
          ctx.globalAlpha = fade * fade * (3 - 2 * fade);
        } else if (style === 'line-rise') {
          ctx.translate(0, (1 - easeOut(age / 0.32)) * size * 0.45);
          ctx.globalAlpha = Math.min(clamp(age / 0.2), clamp(remaining / 0.16));
        } else if (style === 'slide-cut') {
          ctx.translate(-(1 - easeOut(age / 0.18)) * width * 0.15, 0);
          ctx.globalAlpha = clamp(age / 0.06);
        }
      }

      function drawText(text, centerX, centerY, color = config.primaryColor) {
        if (!text) return;
        ctx.shadowBlur = 0;
        if (config.strokeWidth > 0) {
          ctx.lineWidth = config.strokeWidth * 2;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
          ctx.strokeText(text, centerX, centerY);
        }
        ctx.fillStyle = color;
        ctx.shadowColor = config.glowColor;
        ctx.shadowBlur = config.glowStrength;
        ctx.fillText(text, centerX, centerY);
      }

      let wordIndex = 0;
      const lineHeight = size * 1.2;
      rows.forEach((row, rowIndex) => {
        let left = -row.width / 2;
        const baseline = (rowIndex - (rows.length - 1) / 2) * lineHeight;
        row.words.forEach((word) => {
          const center = left + word.cellWidth / 2;
          const sung = time >= word.end;
          const current = time >= word.start && time < word.end;
          const progress = clamp((time - word.start) / Math.max(0.04, word.end - word.start));
          ctx.save();
          if (style === 'word-reveal') {
            ctx.globalAlpha *= reducedMotion ? Number(time >= word.start) : clamp((time - word.start) / 0.1);
            drawText(word.text, center, baseline);
          } else if (style === 'typewriter') {
            const letters = segmenter ? Array.from(segmenter.segment(word.text), (part) => part.segment) : Array.from(word.text);
            const count = reducedMotion ? (time >= word.start ? letters.length : 0) : Math.ceil(letters.length * clamp(progress / 0.85));
            const text = letters.slice(0, count).join('');
            // Anchor letters to the complete word so existing letters never jump sideways.
            drawText(text, center - word.width / 2 + ctx.measureText(text).width / 2, baseline);
          } else if (style === 'karaoke-fill') {
            ctx.globalAlpha *= 0.55;
            drawText(word.text, center, baseline);
            ctx.globalAlpha /= 0.55;
            if (progress > 0) {
              ctx.beginPath();
              const pad = config.strokeWidth * 2 + 2;
              ctx.rect(center - word.width / 2 - pad, baseline - size, (word.width + pad * 2) * progress, size * 2);
              ctx.clip();
              drawText(word.text, center, baseline, config.activeColor);
            }
          } else if (style === 'word-pop') {
            const pop = current && !reducedMotion ? 1 + Math.sin(Math.PI * clamp((time - word.start) / 0.2)) * 0.16 : 1;
            ctx.translate(center, baseline);
            ctx.scale(pop, pop);
            ctx.globalAlpha *= current || sung ? 1 : 0.3;
            drawText(word.text, 0, 0, current ? config.activeColor : config.primaryColor);
          } else if (style === 'poster-stack') {
            const enter = reducedMotion ? 1 : easeOut((age - wordIndex * 0.045) / 0.18);
            ctx.globalAlpha *= enter;
            drawText(word.text, center, baseline + (1 - enter) * size * 0.12, current ? config.activeColor : config.primaryColor);
          } else {
            drawText(word.text, center, baseline);
          }
          ctx.restore();
          left += word.cellWidth + space;
          wordIndex++;
        });
      });
    } finally {
      ctx.restore();
    }
  }

  window.LyricAnimations = { presets, render };
})();
