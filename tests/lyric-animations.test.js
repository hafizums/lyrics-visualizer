const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = { window: {}, Intl };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lyric-animations-extra.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lyric-animations.js'), 'utf8'), sandbox);
const { presets, render } = sandbox.window.LyricAnimations;

// Record canvas drawing commands so timing can be checked without a browser or audio device.
class RecordingCanvas {
  constructor() {
    this.state = { globalAlpha: 1, font: '10px sans-serif', filter: 'none', transform: [] };
    this.stack = [];
    this.draws = [];
    this.lines = [];
  }
  save() { this.stack.push({ ...this.state }); }
  restore() { this.state = this.stack.pop(); }
  translate(x, y) { this.state.transform = [...this.state.transform, ['translate', x, y]]; }
  scale(x, y) { this.state.transform = [...this.state.transform, ['scale', x, y]]; }
  measureText(text) { return { width: Array.from(text).length * parseFloat(this.font.match(/[\d.]+px/)[0]) * 0.55 }; }
  beginPath() {}
  rect(...rect) { this.state.rect = rect; }
  clip() { this.state.clip = this.state.rect; }
  moveTo(x, y) { this.state.pathStart = [x, y]; }
  lineTo(x, y) { this.state.pathEnd = [x, y]; }
  stroke() { if (this.globalAlpha > 0.001) this.lines.push({ ...this.state }); }
  strokeText() {}
  fillText(text, x, y) {
    if (this.globalAlpha > 0.001) this.draws.push({ text, x, y, ...this.state });
  }
}
for (const property of ['font', 'globalAlpha', 'textAlign', 'textBaseline', 'lineJoin', 'shadowBlur', 'lineWidth', 'strokeStyle', 'fillStyle', 'shadowColor', 'filter', 'lineCap']) {
  Object.defineProperty(RecordingCanvas.prototype, property, {
    get() { return this.state[property]; },
    set(value) { this.state[property] = value; },
  });
}

const lyric = {
  start: 0, end: 4,
  words: ['KEEP', 'THE', 'FIRE', 'ALIVE'].map((word, i) => ({ word, start: i, end: i + 1 })),
};
function frame(style, time, overrides = {}) {
  const ctx = new RecordingCanvas();
  const config = {
    ctx, style, lyric, time, width: 1080, height: 1920, x: 540, y: 960,
    fontFamily: "'Montserrat', sans-serif", fontSize: 120, textCase: 'none',
    primaryColor: '#ffffff', activeColor: '#00f2fe', glowColor: '#fe2c55',
    glowStrength: 0, strokeWidth: 2, reducedMotion: false, ...overrides,
  };
  render(config);
  assert.equal(ctx.stack.length, 0, 'canvas saves and restores must balance');
  assert.equal(ctx.globalAlpha, 1, 'opacity must not leak into later drawing');
  assert.equal(ctx.filter, 'none', 'blur must not leak into later drawing');
  ctx.draws.lines = ctx.lines;
  return ctx.draws;
}

test('the catalog contains twenty-two unique presets and preserves both favorites', () => {
  const ids = Array.from(presets, (preset) => preset.id);
  assert.equal(ids.length, 22);
  assert.equal(new Set(ids).size, 22);
  assert.equal(presets.filter((preset) => preset.isNew).length, 10);
  assert.ok(ids.includes('apple-scroll'));
  assert.ok(ids.includes('aesthetic-vhs'));
  assert.ok(!ids.some((id) => id.startsWith('ex-') || id === 'random-all'));
});

test('still lyrics draw the phrase once, in its original order', () => {
  assert.deepEqual(frame('still-lyrics', 1.5).map((draw) => draw.text), ['KEEP', 'THE', 'FIRE', 'ALIVE']);
});

test('word reveal does not show words before their vocal timing', () => {
  assert.deepEqual(frame('word-reveal', 1.25).map((draw) => draw.text), ['KEEP', 'THE']);
});

test('solo word replaces the previous word instead of cloning the phrase', () => {
  assert.deepEqual(frame('solo-word', 0.5).map((draw) => draw.text), ['KEEP']);
  assert.deepEqual(frame('solo-word', 1.5).map((draw) => draw.text), ['THE']);
});

test('typewriter reveals letters and keeps their left edge anchored', () => {
  const partial = frame('typewriter', 0.425)[0];
  const complete = frame('typewriter', 0.99)[0];
  assert.equal(partial.text, 'KE');
  assert.equal(complete.text, 'KEEP');
  assert.equal(partial.x - partial.text.length * 33, complete.x - complete.text.length * 33);
});

test('typewriter keeps combining marks attached to their letters', () => {
  const text = 'e\u0301x';
  const draws = frame('typewriter', 0.1, { lyric: { start: 0, end: 1, words: [{ word: text, start: 0, end: 1 }] } });
  assert.equal(draws[0].text, 'e\u0301');
});

test('karaoke fill overlays the same word in place with a growing clip', () => {
  const early = frame('karaoke-fill', 0.25).find((draw) => draw.fillStyle === '#00f2fe');
  const later = frame('karaoke-fill', 0.75).find((draw) => draw.fillStyle === '#00f2fe');
  assert.equal(early.text, 'KEEP');
  assert.equal(early.x, later.x);
  assert.equal(early.y, later.y);
  assert.ok(later.clip[2] > early.clip[2]);
});

test('word pop happens once at the beginning of a word', () => {
  const early = frame('word-pop', 0.1).find((draw) => draw.text === 'KEEP');
  const held = frame('word-pop', 0.5).find((draw) => draw.text === 'KEEP');
  assert.ok(early.transform.some((entry) => entry[0] === 'scale' && entry[1] > 1.1));
  assert.ok(held.transform.some((entry) => entry[0] === 'scale' && Math.abs(entry[1] - 1) < 0.001));
});

test('poster stack uses a separate row for every word', () => {
  const draws = frame('poster-stack', 1);
  assert.equal(new Set(draws.map((draw) => draw.y)).size, 4);
});

test('seeking back produces the same animation commands', () => {
  for (const preset of presets) {
    if (['apple-scroll', 'aesthetic-vhs'].includes(preset.id)) continue;
    const before = frame(preset.id, 0.1);
    frame(preset.id, 3.5);
    assert.deepEqual(frame(preset.id, 0.1), before, preset.id);
  }
});

test('reduced motion removes entrance movement from phrase animations', () => {
  for (const style of ['soft-fade', 'line-rise', 'slide-cut', 'poster-stack']) {
    const draws = frame(style, 0.01, { reducedMotion: true });
    assert.equal(draws.length, 4, style);
    assert.ok(draws.every((draw) => draw.globalAlpha === 1), style);
    assert.ok(draws.every((draw) => draw.transform.length === 1), style);
  }
});

test('large text fits vertically in portrait, square, and landscape outputs', () => {
  for (const [width, height] of [[1080, 1920], [1080, 1080], [1920, 1080]]) {
    const draws = frame('poster-stack', 2, { fontSize: 500, width, height });
    const size = parseFloat(draws[0].font.match(/[\d.]+px/)[0]);
    const top = Math.min(...draws.map((draw) => draw.y)) - size / 2;
    const bottom = Math.max(...draws.map((draw) => draw.y)) + size / 2;
    assert.ok(bottom - top <= height * 0.76);
  }
});

test('center reveal opens its mask without moving the text', () => {
  const early = frame('center-reveal', 0.05)[0];
  const held = frame('center-reveal', 0.8)[0];
  assert.ok(early.clip[2] < held.clip[2]);
  assert.equal(early.x, held.x);
  assert.equal(early.y, held.y);
});

test('underline follow draws a single accent under only the sung word', () => {
  const first = frame('underline-follow', 0.2);
  const second = frame('underline-follow', 1.2);
  assert.equal(first.lines.length, 1);
  assert.equal(second.lines.length, 1);
  assert.equal(first.lines[0].strokeStyle, '#00f2fe');
  assert.notDeepEqual(first.lines[0].pathStart, second.lines[0].pathStart);
});

test('focus pull resolves blur and restores canvas filtering', () => {
  assert.notEqual(frame('focus-pull', 0.05)[0].filter, 'blur(0px)');
  assert.equal(frame('focus-pull', 0.8)[0].filter, 'blur(0px)');
  assert.equal(frame('focus-pull', 0.05, { reducedMotion: true })[0].filter, 'none');
});

test('letter cascade preserves text order, accents, and joining scripts', () => {
  assert.equal(frame('letter-cascade', 2).map((draw) => draw.text).join(''), 'KEEPTHEFIREALIVE');
  const words = [{ word: 'e\u0301x', start: 0, end: 1 }, { word: 'حلم', start: 1, end: 2 }];
  const draws = frame('letter-cascade', 1.5, { lyric: { start: 0, end: 2, words } });
  assert.deepEqual(draws.map((draw) => draw.text), ['e\u0301', 'x', 'حلم']);
});

test('word reel brings the next word to the same central baseline', () => {
  const entering = frame('word-reel', 1.01).find((draw) => draw.text === 'THE');
  const held = frame('word-reel', 1.5).find((draw) => draw.text === 'THE');
  assert.ok(entering.transform.findLast((item) => item[0] === 'translate')[2] > 0);
  assert.equal(held.transform.findLast((item) => item[0] === 'translate')[2], 0);
});

test('split verse waits for the second half of the vocal before answering', () => {
  assert.deepEqual(frame('split-verse', 1.5).map((draw) => draw.text), ['KEEP', 'THE']);
  const draws = frame('split-verse', 2.5);
  assert.deepEqual(draws.map((draw) => draw.text), ['KEEP', 'THE', 'FIRE', 'ALIVE']);
  assert.ok(draws[0].x < 0 && draws[2].x > 0);
});

test('masked rise clips separate rows to their fixed windows', () => {
  const draws = frame('masked-rise', 3.5, { fontSize: 500 });
  assert.equal(draws.length, 4);
  assert.ok(draws.every((draw) => draw.clip && draw.clip[3] > 0));
  assert.ok(new Set(draws.map((draw) => draw.clip[1])).size > 1);
});

test('final word holds its large emphasis until the last word is sung', () => {
  assert.deepEqual(frame('final-word', 2.5).map((draw) => draw.text), ['KEEP', 'THE', 'FIRE']);
  const draws = frame('final-word', 3.5);
  const final = draws.find((draw) => draw.text === 'ALIVE');
  assert.equal(final.fillStyle, '#00f2fe');
  assert.ok(parseFloat(final.font.match(/[\d.]+px/)[0]) > parseFloat(draws[0].font.match(/[\d.]+px/)[0]));
});

test('staircase retains each word once in a diagonal reading order', () => {
  const draws = frame('staircase', 3.5);
  assert.deepEqual(draws.map((draw) => draw.text), ['KEEP', 'THE', 'FIRE', 'ALIVE']);
  for (let index = 1; index < draws.length; index++) {
    assert.ok(draws[index].x > draws[index - 1].x);
    assert.ok(draws[index].y > draws[index - 1].y);
  }
});

test('elastic assemble shows only sung words and settles after each arrival', () => {
  const draws = frame('elastic-assemble', 1.5);
  assert.deepEqual(draws.map((draw) => draw.text), ['KEEP', 'THE']);
  const original = frame('elastic-assemble', 0.5)[0];
  assert.deepEqual(original.transform, draws[0].transform);
});
