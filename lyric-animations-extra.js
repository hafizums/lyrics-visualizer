// Additional authored animations, with deterministic timing for seeking and export.
(function () {
  'use strict';

  const presets = [
    { id: 'center-reveal', name: 'Center Reveal', tier: 'melodic', desc: 'A curtain opens from the phrase center', icon: 'M3 5v14m18-14v14M10 12H5m3-3-3 3 3 3m6-3h5m-3-3 3 3-3 3', bass: 0.25, punch: 0.3, flow: 0.85 },
    { id: 'underline-follow', name: 'Underline Follow', tier: 'melodic', desc: 'A precise underline follows the vocal', icon: 'M4 6h16M4 11h16M4 18h7m4 0h5', bass: 0.32, punch: 0.35, flow: 0.72 },
    { id: 'focus-pull', name: 'Focus Pull', tier: 'chill', desc: 'Soft focus resolves into crisp lyrics', icon: 'M3 8V3h5m8 0h5v5m0 8v5h-5M8 21H3v-5M8 12h8', bass: 0.12, punch: 0.08, flow: 0.98 },
    { id: 'letter-cascade', name: 'Letter Cascade', tier: 'upbeat', desc: 'Letters settle in a gentle stagger', icon: 'M4 5v6m5-3v6m5-3v6m5-3v6', bass: 0.4, punch: 0.55, flow: 0.62 },
    { id: 'word-reel', name: 'Word Reel', tier: 'upbeat', desc: 'Words roll through a vertical reading window', icon: 'M7 3h10M4 8h16v8H4zM7 21h10m-5-10v2', bass: 0.52, punch: 0.5, flow: 0.7 },
    { id: 'split-verse', name: 'Split Verse', tier: 'drop', desc: 'Two lyric halves answer from opposite sides', icon: 'M3 5h8v6H3zm10 8h8v6h-8M15 7h6M3 17h6', bass: 0.65, punch: 0.7, flow: 0.45 },
    { id: 'masked-rise', name: 'Masked Rise', tier: 'melodic', desc: 'Lines rise through a fixed reveal window', icon: 'M3 7h18M3 17h18m-9-3V9m-3 3 3-3 3 3', bass: 0.28, punch: 0.32, flow: 0.9 },
    { id: 'final-word', name: 'Final Word', tier: 'drop', desc: 'A quiet lead-in lands on a large final word', icon: 'M5 4h14M8 8h8M3 13h18v7H3z', bass: 0.84, punch: 0.72, flow: 0.32 },
    { id: 'staircase', name: 'Staircase', tier: 'drop', desc: 'Sung words build a diagonal composition', icon: 'M3 5h7m-3 5h7m-3 5h7m-3 5h6', bass: 0.7, punch: 0.64, flow: 0.48 },
    { id: 'elastic-assemble', name: 'Elastic Assemble', tier: 'upbeat', desc: 'Words spring into place from alternating sides', icon: 'M3 6h5l-2 2 2 2M21 18h-5l2-2-2-2M9 12h6', bass: 0.56, punch: 0.72, flow: 0.42 },
  ].map((preset) => ({ ...preset, isNew: true }));
  const ids = new Set(presets.map((preset) => preset.id));
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const ease = (value) => 1 - Math.pow(1 - clamp(value), 3);
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const lettersOf = (text) => segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);

  function render(config) {
    const { ctx, style, lyric, time, width, height, x, y, reducedMotion } = config;
    if (!lyric || !lyric.words.length) return;
    const words = lyric.words.map((word, index) => ({ ...word, index,
      text: config.textCase === 'uppercase' ? word.word.toUpperCase()
        : config.textCase === 'lowercase' ? word.word.toLowerCase() : word.word,
    }));
    const age = Math.max(0, time - lyric.start);
    const duration = Math.max(0.08, lyric.end - lyric.start);
    const maxWidth = width * 0.82;
    const maxHeight = height * 0.76;
    const padding = config.strokeWidth * 2 + 3;
    let size = config.fontSize;
    let scene;

    function setFont(fontSize) { ctx.font = `900 ${fontSize}px ${config.fontFamily}`; }

    function wrap(tokens, fontSize, limit) {
      setFont(fontSize);
      const space = ctx.measureText(' ').width;
      const rows = [];
      let row = { words: [], width: 0 };
      for (const word of tokens) {
        const wordWidth = ctx.measureText(word.text).width;
        if (row.words.length && row.width + space + wordWidth > limit) {
          rows.push(row);
          row = { words: [], width: 0 };
        }
        row.width += (row.words.length ? space : 0) + wordWidth;
        row.words.push({ ...word, width: wordWidth });
      }
      if (row.words.length) rows.push(row);
      return { rows, space, size: fontSize, width: Math.max(0, ...rows.map((item) => item.width)), height: rows.length * fontSize * 1.25 };
    }

    function buildScene() {
      if (style === 'word-reel') {
        setFont(size);
        const wordWidth = Math.max(...words.map((word) => ctx.measureText(word.text).width));
        return { height: size * 5.4, fitX: (maxWidth - padding * 2) / Math.max(1, wordWidth) };
      }
      if (style === 'split-verse') {
        const midpoint = Math.ceil(words.length / 2);
        const limit = maxWidth * 0.43 - padding * 2;
        const first = wrap(words.slice(0, midpoint), size, limit);
        const second = wrap(words.slice(midpoint), size, limit);
        return { first, second, height: Math.max(first.height, second.height), fitX: limit / Math.max(1, first.width, second.width) };
      }
      if (style === 'final-word') {
        const lead = wrap(words.slice(0, -1), size * 0.6, maxWidth - padding * 2);
        const final = wrap(words.slice(-1), size * 1.5, maxWidth - padding * 2);
        const gap = lead.rows.length ? size * 0.35 : 0;
        return { lead, final, gap, height: lead.height + gap + final.height, fitX: (maxWidth - padding * 2) / Math.max(1, lead.width, final.width) };
      }
      if (style === 'staircase') {
        setFont(size);
        const tokens = words.map((word) => ({ ...word, width: ctx.measureText(word.text).width }));
        return { tokens, widest: Math.max(...tokens.map((word) => word.width)), height: size * 1.25 * words.length,
          fitX: (maxWidth * 0.7 - padding * 2) / Math.max(1, ...tokens.map((word) => word.width)) };
      }
      const block = wrap(words, size, maxWidth - padding * 2);
      return { block, height: block.height, fitX: (maxWidth - padding * 2) / Math.max(1, block.width) };
    }

    function draw(text, centerX, centerY, color = config.primaryColor) {
      if (!text) return;
      ctx.shadowBlur = 0;
      if (config.strokeWidth > 0) {
        ctx.lineWidth = config.strokeWidth * 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.strokeText(text, centerX, centerY);
      }
      ctx.fillStyle = color;
      ctx.shadowColor = config.glowColor;
      ctx.shadowBlur = config.glowStrength;
      ctx.fillText(text, centerX, centerY);
    }

    function drawBlock(block, centerX, centerY, paint) {
      setFont(block.size);
      block.rows.forEach((row, rowIndex) => {
        let left = centerX - row.width / 2;
        const baseline = centerY + (rowIndex - (block.rows.length - 1) / 2) * block.size * 1.25;
        row.words.forEach((word) => {
          ctx.save();
          paint(word, left + word.width / 2, baseline, row, rowIndex);
          ctx.restore();
          left += word.width + block.space;
        });
      });
    }

    ctx.save();
    try {
      for (let pass = 0; pass < 6; pass++) {
        scene = buildScene();
        const fit = Math.min(1, scene.fitX, maxHeight / Math.max(1, scene.height));
        if (fit >= 0.999) break;
        size *= Math.max(0.01, fit * 0.98);
      }
      scene = buildScene();
      setFont(size);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.translate(x, y);

      if (style === 'word-reel') {
        const active = words.findIndex((word) => time >= word.start && time < word.end);
        const index = active >= 0 ? active : time >= words[words.length - 1].end ? words.length - 1 : 0;
        const word = words[index];
        const enter = reducedMotion || index === 0 ? 1 : ease((time - word.start) / Math.min(0.24, (word.end - word.start) * 0.65));
        const position = index === 0 ? 0 : index - 1 + enter;
        words.forEach((item, i) => {
          const distance = i - position;
          if (Math.abs(distance) > 1.5) return;
          ctx.save();
          const scale = 1 - Math.min(1, Math.abs(distance)) * 0.3;
          ctx.translate(0, distance * size * 1.4);
          ctx.scale(scale, scale);
          ctx.globalAlpha *= clamp(1.5 - Math.abs(distance)) * (1 - Math.min(1, Math.abs(distance)) * 0.5);
          draw(item.text, 0, 0, i === index ? config.activeColor : config.primaryColor);
          ctx.restore();
        });
        return;
      }

      if (style === 'split-verse') {
        [scene.first, scene.second].forEach((block, side) => {
          if (!block.rows.length) return;
          const start = block.rows[0].words[0].start;
          const enter = reducedMotion ? Number(time >= start) : ease((time - start) / 0.28);
          ctx.save();
          ctx.globalAlpha *= enter;
          const travel = reducedMotion ? 0 : (1 - enter) * Math.min(size * 0.6, width * 0.06);
          const horizontal = (side === 0 ? -1 : 1) * (maxWidth * 0.265 + travel);
          drawBlock(block, horizontal, 0, (word, centerX, baseline) => draw(word.text, centerX, baseline));
          ctx.restore();
        });
        return;
      }

      if (style === 'final-word') {
        drawBlock(scene.lead, 0, -scene.height / 2 + scene.lead.height / 2, (word, centerX, baseline) => {
          ctx.globalAlpha *= reducedMotion ? Number(time >= word.start) : clamp((time - word.start) / 0.1);
          draw(word.text, centerX, baseline);
        });
        const final = words[words.length - 1];
        const enter = reducedMotion ? Number(time >= final.start) : ease((time - final.start) / Math.min(0.28, (final.end - final.start) * 0.7));
        ctx.save();
        ctx.globalAlpha *= enter;
        const centerY = scene.height / 2 - scene.final.height / 2;
        ctx.translate(0, centerY);
        const scale = reducedMotion ? 1 : 0.9 + enter * 0.1;
        ctx.scale(scale, scale);
        drawBlock(scene.final, 0, 0, (word, centerX, baseline) => draw(word.text, centerX, baseline, config.activeColor));
        ctx.restore();
        return;
      }

      if (style === 'staircase') {
        const travel = Math.max(0, maxWidth - scene.widest - padding * 2);
        scene.tokens.forEach((word, index) => {
          const enter = reducedMotion ? Number(time >= word.start) : ease((time - word.start) / 0.22);
          const centerX = -travel / 2 + (words.length > 1 ? index / (words.length - 1) : 0.5) * travel;
          const baseline = (index - (words.length - 1) / 2) * size * 1.25;
          ctx.save();
          ctx.globalAlpha *= enter;
          draw(word.text, centerX - (reducedMotion ? 0 : (1 - enter) * size * 0.3), baseline,
            time >= word.start && time < word.end ? config.activeColor : config.primaryColor);
          ctx.restore();
        });
        return;
      }

      if (style === 'center-reveal' && !reducedMotion) {
        const revealWidth = (scene.block.width + padding * 2) * ease(age / Math.min(0.55, duration * 0.4));
        ctx.beginPath();
        ctx.rect(-revealWidth / 2, -scene.height / 2 - padding, revealWidth, scene.height + padding * 2);
        ctx.clip();
      } else if (style === 'focus-pull' && !reducedMotion) {
        const focus = ease(age / Math.min(0.55, duration * 0.4));
        ctx.filter = `blur(${(1 - focus) * 8}px)`;
        ctx.globalAlpha *= clamp(age / Math.min(0.2, duration * 0.2));
        const scale = 1.04 - focus * 0.04;
        ctx.scale(scale, scale);
      }

      const letterCount = words.reduce((sum, word) => sum + lettersOf(word.text).length, 0);
      const delay = Math.min(0.035, duration * 0.25 / Math.max(1, letterCount));
      let letterIndex = 0;
      drawBlock(scene.block, 0, 0, (word, centerX, baseline, row) => {
        const progress = clamp((time - word.start) / Math.max(0.04, word.end - word.start));
        if (style === 'letter-cascade' && !reducedMotion) {
          // Keep joining scripts shaped as whole words; never detach accents from a letter.
          if (/[\u0600-\u0fff]/.test(word.text)) {
            const enter = ease((age - letterIndex * delay) / 0.24);
            ctx.globalAlpha *= enter;
            draw(word.text, centerX, baseline + (1 - enter) * size * 0.35);
            letterIndex += lettersOf(word.text).length;
            return;
          }
          let prefix = '';
          for (const letter of lettersOf(word.text)) {
            const enter = ease((age - letterIndex * delay) / 0.24);
            const letterX = centerX - word.width / 2 + ctx.measureText(prefix).width + ctx.measureText(letter).width / 2;
            ctx.save();
            ctx.globalAlpha *= enter;
            draw(letter, letterX, baseline + (1 - enter) * size * 0.35);
            ctx.restore();
            prefix += letter;
            letterIndex++;
          }
        } else if (style === 'masked-rise') {
          const enter = reducedMotion ? Number(time >= row.words[0].start) : ease((time - row.words[0].start) / 0.3);
          ctx.globalAlpha *= Number(enter > 0);
          ctx.beginPath();
          ctx.rect(-scene.block.width / 2 - padding, baseline - size * 0.65, scene.block.width + padding * 2, size * 1.3);
          ctx.clip();
          draw(word.text, centerX, baseline + (1 - enter) * size * 1.1);
        } else if (style === 'elastic-assemble') {
          const progress = clamp((time - word.start) / Math.min(0.36, (word.end - word.start) * 0.8));
          const enter = reducedMotion || progress >= 1 ? 1 : 1 - Math.exp(-7 * progress) * Math.cos(9 * progress);
          ctx.globalAlpha *= reducedMotion ? Number(time >= word.start) : clamp(progress * 4);
          const travel = Math.min(size * 0.65, width * 0.06);
          ctx.translate(centerX + (word.index % 2 ? 1 : -1) * (1 - enter) * travel, baseline);
          draw(word.text, 0, 0);
        } else {
          draw(word.text, centerX, baseline);
          if (style === 'underline-follow' && time >= word.start && time < word.end) {
            ctx.shadowBlur = 0;
            ctx.strokeStyle = config.activeColor;
            ctx.lineWidth = Math.max(2, size * 0.04);
            ctx.lineCap = 'round';
            ctx.globalAlpha *= reducedMotion ? 1 : 1 - clamp((progress - 0.85) / 0.15);
            ctx.beginPath();
            ctx.moveTo(centerX - word.width / 2, baseline + size * 0.57);
            ctx.lineTo(centerX - word.width / 2 + word.width * (reducedMotion ? 1 : ease(progress * 3)), baseline + size * 0.57);
            ctx.stroke();
          }
        }
      });
    } finally {
      ctx.restore();
    }
  }

  window.LyricExtraAnimations = { presets, ids, render };
})();
