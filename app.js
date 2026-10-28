/**
 * LyricTok Studio — 100% Local TikTok Lyrics & Audio Visualizer Engine
 */

(function () {
  'use strict';

  // =========================================================================
  // 1. APPLICATION STATE
  // =========================================================================
  const state = {
    aspect: '9:16', // '9:16' (1080x1920), '1:1' (1080x1080), '16:9' (1920x1080)
    canvasWidth: 1080,
    canvasHeight: 1920,
    showSafeZone: false,

    // Playback & Audio
    isPlaying: false,
    currentTime: 0,
    duration: 24,
    trimStart: 0,
    trimEnd: 24,
    waveformPeaks: [],
    rmsBuckets: [],
    bassBuckets: [],
    transientBuckets: [],

    // Lyrics & Sync
    lyrics: [],
    lyricsBehindPerson: false,
    personMaskFeather: 2,
    globalOffset: 0, // seconds
    tapSyncCursor: 0,

    // Background Media
    bgType: 'procedural', // 'procedural' | 'video' | 'images'
    bgTheme: 'cyber-neon',
    bgVideo: null,
    bgFrameStep: 1 / 30,
    exportVideoFrame: null,
    exportVideoFrameIdx: -1,
    bgImages: [], // Array of HTMLImageElement
    bgFit: 'cover', // 'cover' | 'contain'
    slideDuration: 4.0,
    kenBurns: true,
    beatSlide: false,
    currentSlideIndex: 0,
    lastSlideBeatTime: 0,

    // Lyric Style & Typography
    lyricStyle: 'aesthetic-vhs',
    fontFamily: "'Montserrat', sans-serif",
    fontSize: 68,
    textCase: 'uppercase', // 'none' | 'uppercase' | 'lowercase'
    primaryColor: '#ffffff',
    activeColor: '#00f2fe',
    glowColor: '#fe2c55',
    glowStrength: 25,
    strokeWidth: 4,
    posX: 0.5, // Normalized 0..1
    posY: 0.5, // Normalized 0..1

    // Visualizer & Particles
    spectrumMode: 'bottom-bars',
    reactivity: 1.4,
    particleMode: 'embers',
    particleCount: 45,
    songTitle: '',
    songArtist: '',

    // Camera & BG FX
    bassShake: 20,
    bgDim: 40,
    bgBlur: 0,
    vignette: 45,

    // Live Audio Metrics (updated 60fps)
    bassEnergy: 0,
    midEnergy: 0,
    highEnergy: 0,
    smoothBass: 0,
    beatPulse: 0,
    freqData: new Uint8Array(128),
    timeData: new Uint8Array(128),

    // Export & Offline Audio Analysis state
    audioBlob: null,
    audioExt: 'wav',
    decodedAudioBuffer: null,
    isExporting: false,
    exportCancelled: false,
    exportStopEarly: false,
    mediaRecorder: null,
    recordedChunks: [],
  };

  // =========================================================================
  // 2. DOM ELEMENTS & AUDIO SETUP
  // =========================================================================
  const canvas = document.getElementById('visualizerCanvas');
  const ctx = canvas.getContext('2d');
  const timelineCanvas = document.getElementById('timelineCanvas');
  const timelineCtx = timelineCanvas.getContext('2d');
  const foreground = new window.LyricForeground();
  const foregroundLayer = document.createElement('canvas');
  const foregroundCtx = foregroundLayer.getContext('2d');

  function personMaskStatus(message) {
    const el = document.getElementById('personMaskStatus');
    if (el.textContent !== message) el.textContent = message;
  }

  function personMaskSource() {
    if (state.bgType !== 'video' || !state.bgVideo || state.bgVideo.readyState < 2) return null;
    const frame = state.isExporting && state.exportVideoFrame;
    return {
      media: frame || state.bgVideo,
      key: frame ? state.exportVideoFrameIdx : state.bgVideo.currentTime,
      width: frame ? frame.width : state.bgVideo.videoWidth,
      height: frame ? frame.height : state.bgVideo.videoHeight,
    };
  }

  function disablePersonMask(error) {
    state.lyricsBehindPerson = false;
    foreground.dispose();
    document.getElementById('lyricsBehindPersonToggle').checked = false;
    document.getElementById('personMaskControls').classList.add('hidden');
    personMaskStatus(`Person masking unavailable: ${error.message}`);
    console.error('Person masking:', error);
  }

  function preparePersonLayer(w, h) {
    if (!state.lyricsBehindPerson) return false;
    const source = personMaskSource();
    if (!source) {
      personMaskStatus('Upload a background video with a person to use this effect.');
      return false;
    }
    if (!state.isExporting && !foreground.busy) {
      foreground.update(source.media, source.key).catch(disablePersonMask);
    }
    if (!foreground.hasMask || foreground.source !== source.media) return false;
    personMaskStatus('Active: lyrics appear behind people. Masking runs locally.');
    if (foregroundLayer.width !== w || foregroundLayer.height !== h) {
      foregroundLayer.width = w;
      foregroundLayer.height = h;
    }
    // Preserve the exact background, dimming and effects before drawing lyrics.
    foregroundCtx.clearRect(0, 0, w, h);
    foregroundCtx.drawImage(canvas, 0, 0);
    foregroundCtx.save();
    foregroundCtx.globalCompositeOperation = 'destination-in';
    const zoom = 1 + (state.bassShake / 100) * state.smoothBass * state.reactivity * 0.035;
    const scale = (state.bgFit === 'contain' ? Math.min : Math.max)(w / source.width, h / source.height);
    const dw = source.width * scale * zoom;
    const dh = source.height * scale * zoom;
    foregroundCtx.filter = `blur(${state.personMaskFeather + state.bgBlur}px)`;
    foregroundCtx.drawImage(foreground.mask, (w - dw) / 2, (h - dh) / 2, dw, dh);
    foregroundCtx.restore();
    return true;
  }

  // Create primary HTML5 Audio Element
  const audioEl = new Audio();
  audioEl.preload = 'auto';

  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let gainNode = null;
  let streamDest = null;

  function ensureAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;

      gainNode = audioCtx.createGain();
      gainNode.gain.value = parseFloat(document.getElementById('volumeSlider').value || '0.9');

      streamDest = audioCtx.createMediaStreamDestination();

      sourceNode = audioCtx.createMediaElementSource(audioEl);
      sourceNode.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      // Also route to streamDest so video exports capture full-volume clean audio
      analyser.connect(streamDest);

      state.freqData = new Uint8Array(analyser.frequencyBinCount);
      state.timeData = new Uint8Array(analyser.frequencyBinCount);
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  // =========================================================================
  // 3. SRT / LRC / VTT / PLAIN TEXT LYRICS PARSER & WORD INTERPOLATOR
  // =========================================================================

  /**
   * Parses timestamp string like "00:01:23,450" or "01:23.45" into seconds
   */
  function parseTimeString(str) {
    if (!str) return 0;
    const clean = str.trim().replace(',', '.');
    const parts = clean.split(':');
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(clean) || 0;
  }

  /**
   * Formats seconds into SRT timestamp "00:00:00,000"
   */
  function formatSrtTimestamp(sec) {
    const clamped = Math.max(0, sec);
    const hrs = Math.floor(clamped / 3600);
    const mins = Math.floor((clamped % 3600) / 60);
    const secs = Math.floor(clamped % 60);
    const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
    return (
      String(hrs).padStart(2, '0') + ':' +
      String(mins).padStart(2, '0') + ':' +
      String(secs).padStart(2, '0') + ',' +
      String(Math.min(999, ms)).padStart(3, '0')
    );
  }

  /**
   * Formats seconds for UI readout "1:05.2"
   */
  function formatShortTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const mins = Math.floor(sec / 60);
    const rem = (sec % 60).toFixed(1);
    return `${mins}:${rem.padStart(4, '0')}`;
  }

  /**
   * Splits a lyric line into word timings proportional to word length
   */
  function buildWordTimings(text, start, end) {
    const rawWords = text.trim().split(/\s+/).filter(Boolean);
    if (rawWords.length === 0) return [];
    const totalDuration = Math.max(0.15, end - start);
    // Weight each word by character length + small base constant so short words still get fair time
    const weights = rawWords.map((w) => w.length + 2);
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    let cursor = start;
    return rawWords.map((word, idx) => {
      const share = (weights[idx] / totalWeight) * totalDuration;
      const wStart = cursor;
      const wEnd = idx === rawWords.length - 1 ? end : cursor + share;
      cursor = wEnd;
      return { word, start: wStart, end: wEnd };
    });
  }

  /**
   * Universal Lyric Parser: Detects .SRT, .VTT, .LRC, or Plain Text
   */
  function parseLyricsUniversal(rawText, fallbackDuration = 24) {
    if (!rawText || !rawText.trim()) return [];
    const text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

    // 1. Check for SRT / WebVTT arrow format: "00:00:01,000 --> 00:00:04,000"
    if (text.includes('-->')) {
      const blocks = text.split(/\n\s*\n/);
      const parsed = [];
      const arrowRegex = /((?:\d{1,2}:)?\d{1,2}:\d{1,2}[,.]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{1,2}[,.]\d{1,3})/;

      for (const block of blocks) {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        let arrowLineIdx = -1;
        let match = null;
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(arrowRegex);
          if (m) {
            arrowLineIdx = i;
            match = m;
            break;
          }
        }
        if (match && arrowLineIdx !== -1) {
          const start = parseTimeString(match[1]);
          const end = Math.max(start + 0.2, parseTimeString(match[2]));
          const contentLines = lines.slice(arrowLineIdx + 1)
            .join(' ')
            .replace(/<[^>]+>/g, '') // Strip HTML tags like <i> or <font>
            .trim();
          if (contentLines) {
            parsed.push({
              id: 'lyr_' + Math.random().toString(36).slice(2, 9),
              start,
              end,
              text: contentLines,
              words: buildWordTimings(contentLines, start, end),
            });
          }
        }
      }
      if (parsed.length > 0) {
        parsed.sort((a, b) => a.start - b.start);
        return parsed;
      }
    }

    // 2. Check for LRC format: "[00:12.34]Lyric text"
    const lrcLineRegex = /^\[(\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?)\](.*)$/;
    const rawLines = text.split('\n');
    const lrcEntries = [];
    for (const line of rawLines) {
      const m = line.trim().match(lrcLineRegex);
      if (m) {
        const start = parseTimeString(m[1]);
        const content = m[2].replace(/<\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
        if (content) {
          lrcEntries.push({ start, text: content });
        }
      }
    }
    if (lrcEntries.length > 0) {
      lrcEntries.sort((a, b) => a.start - b.start);
      return lrcEntries.map((item, idx) => {
        const nextStart = idx < lrcEntries.length - 1 ? lrcEntries[idx + 1].start : item.start + 3.5;
        const end = Math.max(item.start + 0.4, Math.min(nextStart - 0.05, item.start + 6));
        return {
          id: 'lyr_' + Math.random().toString(36).slice(2, 9),
          start: item.start,
          end,
          text: item.text,
          words: buildWordTimings(item.text, item.start, end),
        };
      });
    }

    // 3. Fallback: Plain Text (one lyric line per non-empty row)
    const cleanLines = rawLines
      .map((l) => l.trim())
      .filter((l) => l && !/^\d+$/.test(l) && !/^\[.*\]$/.test(l));

    if (cleanLines.length === 0) return [];
    const totalDur = Math.max(10, fallbackDuration || state.duration || 24);
    const slot = totalDur / cleanLines.length;

    return cleanLines.map((lineText, i) => {
      const start = +(i * slot).toFixed(2);
      const end = +Math.max(start + 0.4, (i + 1) * slot - 0.15).toFixed(2);
      return {
        id: 'lyr_' + Math.random().toString(36).slice(2, 9),
        start,
        end,
        text: lineText,
        words: buildWordTimings(lineText, start, end),
      };
    });
  }

  /**
   * Recomputes word timings whenever a lyric's text or timestamps are edited
   */
  function refreshLyricWords(lyric) {
    lyric.words = buildWordTimings(lyric.text, lyric.start, lyric.end);
  }

  // =========================================================================
  // 4. WAVEFORM EXTRACTION & BUILT-IN SYNTH DEMO GENERATOR
  // =========================================================================

  /**
   * Extracts normalized waveform peaks, RMS energy, low-pass bass punch, and beat-onset transients
   */
  async function extractWaveformPeaks(arrayBuffer, numBuckets = 220) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const tempCtx = new AudioContextClass();
      const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
      state.decodedAudioBuffer = audioBuffer;
      const rawData = audioBuffer.getChannelData(0);
      const blockSize = Math.max(1, Math.floor(rawData.length / numBuckets));
      const peaks = [];
      const rmsList = [];
      const bassList = [];
      let maxPeak = 0.01;
      let maxRms = 0.01;
      let maxBass = 0.01;
      let lpState = 0;

      for (let i = 0; i < numBuckets; i++) {
        const start = i * blockSize;
        let peak = 0;
        let sqSum = 0;
        let bassSqSum = 0;
        for (let j = 0; j < blockSize; j++) {
          const sample = rawData[start + j] || 0;
          const val = Math.abs(sample);
          if (val > peak) peak = val;
          sqSum += sample * sample;
          // 1-pole low-pass filter (~180Hz cutoff) to isolate sub-bass & kick drum energy
          lpState = lpState * 0.93 + sample * 0.07;
          bassSqSum += lpState * lpState;
        }
        const rms = Math.sqrt(sqSum / blockSize);
        const bassRms = Math.sqrt(bassSqSum / blockSize);

        peaks.push(peak);
        rmsList.push(rms);
        bassList.push(bassRms);
        if (peak > maxPeak) maxPeak = peak;
        if (rms > maxRms) maxRms = rms;
        if (bassRms > maxBass) maxBass = bassRms;
      }
      tempCtx.close();

      state.waveformPeaks = peaks.map((p) => p / maxPeak);
      state.rmsBuckets = rmsList.map((r) => r / maxRms);
      state.bassBuckets = bassList.map((b) => b / maxBass);

      // Compute beat-onset transient flux (positive energy & bass jumps between buckets)
      let maxTrans = 0.01;
      const transRaw = state.rmsBuckets.map((r, idx) => {
        if (idx === 0) return r * 0.5;
        const dr = Math.max(0, r - state.rmsBuckets[idx - 1] * 0.88);
        const db = Math.max(0, state.bassBuckets[idx] - state.bassBuckets[idx - 1] * 0.85);
        const tVal = dr * 0.45 + db * 0.55;
        if (tVal > maxTrans) maxTrans = tVal;
        return tVal;
      });
      state.transientBuckets = transRaw.map((t) => t / maxTrans);
    } catch (e) {
      state.decodedAudioBuffer = null;
      // Fallback synthetic waveform & beat profile if browser cannot decode format offline
      state.waveformPeaks = Array.from({ length: numBuckets }, (_, i) =>
        0.25 + 0.65 * Math.abs(Math.sin(i * 0.23) * Math.cos(i * 0.07))
      );
      state.rmsBuckets = state.waveformPeaks.slice();
      state.bassBuckets = state.waveformPeaks.map((v, i) =>
        Math.min(1, v * (0.6 + 0.4 * Math.abs(Math.sin(i * 0.4))))
      );
      state.transientBuckets = state.waveformPeaks.map((v, i) =>
        i > 0 ? Math.max(0, v - state.waveformPeaks[i - 1]) : 0.3
      );
    }
  }

  /**
   * Generates a real 24-second Synthwave / TikTok Electronic Beat WAV file in memory
   * so the user can test all visualizers & beat-reactive effects immediately!
   */
  function generateDemoAudioBlob() {
    const sampleRate = 44100;
    const duration = 24; // 24 seconds @ 125 BPM
    const numSamples = sampleRate * duration;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    // WAV Header
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    const bpm = 125;
    const beatDur = 60 / bpm; // 0.48s per beat
    // Chord progression root frequencies (A minor -> F -> C -> G)
    const bassNotes = [55.0, 43.65, 65.41, 49.0];
    const leadNotes = [440, 523.25, 659.25, 587.33, 440, 659.25, 523.25, 392.0];

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const beatIndex = Math.floor(t / beatDur);
      const beatTime = t % beatDur;
      const barIndex = Math.floor(beatIndex / 4);

      // 1. Punchy 808 Kick Drum on every beat
      const kickFreq = 135 * Math.exp(-beatTime * 32) + 44;
      const kickEnv = Math.exp(-beatTime * 8.5);
      const kick = Math.sin(2 * Math.PI * kickFreq * beatTime) * kickEnv * 0.72;

      // 2. Crisp Snare / Clap on beats 1 and 3
      let snare = 0;
      if (beatIndex % 2 === 1) {
        const snareEnv = Math.exp(-beatTime * 18);
        const noise = (Math.sin(i * 12.9898) * 43758.5453) % 1;
        snare = noise * snareEnv * 0.35;
      }

      // 3. Off-beat Hi-Hat
      const halfBeatTime = (t + beatDur * 0.5) % beatDur;
      const hatEnv = Math.exp(-halfBeatTime * 45);
      const hatNoise = ((Math.cos(i * 78.233) * 19341.23) % 1) * hatEnv * 0.16;

      // 4. Sidechained Sub-Bass Saw
      const rootFreq = bassNotes[barIndex % bassNotes.length];
      const sidechain = Math.min(1, beatTime / 0.18);
      const saw = 2 * ((t * rootFreq) - Math.floor(0.5 + t * rootFreq));
      const bass = saw * sidechain * 0.28;

      // 5. Arpeggiated Synth Pluck (16th notes)
      const sixteenthDur = beatDur / 4;
      const arpIndex = Math.floor(t / sixteenthDur);
      const arpTime = t % sixteenthDur;
      const arpFreq = leadNotes[arpIndex % leadNotes.length];
      const arpEnv = Math.exp(-arpTime * 16);
      const arp = Math.sin(2 * Math.PI * arpFreq * t) * arpEnv * 0.22 * sidechain;

      const mix = Math.max(-0.98, Math.min(0.98, kick + snare + hatNoise + bass + arp));
      view.setInt16(44 + i * 2, mix * 32767, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  const DEMO_SRT = `1
00:00:00,200 --> 00:00:02,900
Turn the lights down low tonight

2
00:00:03,000 --> 00:00:05,800
Feel the bassline hit your soul

3
00:00:06,000 --> 00:00:08,800
Chasing neon dreams in stereo

4
00:00:09,000 --> 00:00:11,800
Every heartbeat synced in gold

5
00:00:12,000 --> 00:00:14,800
Drop your song and watch it glow

6
00:00:15,000 --> 00:00:17,800
Upload your SRT and let it roll

7
00:00:18,000 --> 00:00:20,800
Built for TikTok 100% local studio

8
00:00:21,000 --> 00:00:23,800
Now hit export and steal the show`;

  async function loadDemoProject() {
    const wavBlob = generateDemoAudioBlob();
    state.audioBlob = wavBlob;
    state.audioExt = 'wav';
    const url = URL.createObjectURL(wavBlob);
    audioEl.src = url;
    audioEl.load();

    const buf = await wavBlob.arrayBuffer();
    await extractWaveformPeaks(buf);

    state.duration = 24;
    state.trimStart = 0;
    state.trimEnd = 24;
    document.getElementById('trimStartInput').value = '0';
    document.getElementById('trimEndInput').value = '24';
    document.getElementById('durationLabel').textContent = formatShortTime(24);

    // Update UI badges
    document.getElementById('audioFileName').textContent = 'Neon_Pulse_Demo_125BPM.wav';
    const audioBadge = document.getElementById('audioStatusBadge');
    audioBadge.textContent = 'Demo Ready';
    audioBadge.classList.add('loaded');

    state.lyrics = parseLyricsUniversal(DEMO_SRT, 24);
    document.getElementById('lyricsFileName').textContent = 'demo_lyrics.srt (8 lines)';
    const lyrBadge = document.getElementById('lyricsStatusBadge');
    lyrBadge.textContent = `${state.lyrics.length} lines`;
    lyrBadge.classList.add('loaded');

    if (!state.songTitle) {
      state.songTitle = 'NEON PULSE (VIP)';
      state.songArtist = '@LyricTokStudio';
      document.getElementById('songTitleInput').value = state.songTitle;
      document.getElementById('songArtistInput').value = state.songArtist;
    }

    renderLyricsListUI();
  }

  // =========================================================================
  // 5. LYRICS LIST & TAP-TO-SYNC UI
  // =========================================================================
  function renderLyricsListUI() {
    const container = document.getElementById('lyricsListContainer');
    container.innerHTML = '';

    if (state.lyrics.length === 0) {
      container.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:12px;">
        No lyrics loaded yet.<br/>Upload an <b>.SRT</b> / <b>.LRC</b> file or click <b>Paste / Write Lyrics</b>!
      </div>`;
      return;
    }

    state.lyrics.forEach((lyr, idx) => {
      const row = document.createElement('div');
      row.className = 'lyric-item';
      row.dataset.index = idx;
      row.id = `lyric-row-${idx}`;

      row.innerHTML = `
        <div class="lyric-item-top">
          <div class="lyric-times">
            <span>#${idx + 1}</span>
            <input type="number" step="0.1" class="time-input start-time-in" value="${lyr.start.toFixed(2)}" title="Start time (seconds)" />
            <span>→</span>
            <input type="number" step="0.1" class="time-input end-time-in" value="${lyr.end.toFixed(2)}" title="End time (seconds)" />
          </div>
          <div class="lyric-actions">
            <button class="btn-xs seek-here-btn" title="Jump playback to this line">▶</button>
            <button class="btn-xs stamp-here-btn" title="Set this line's start to current playback time">📍</button>
            <button class="btn-xs del-line-btn" title="Delete line">✕</button>
          </div>
        </div>
        <input type="text" class="lyric-text-edit" value="${lyr.text.replace(/"/g, '&quot;')}" />
      `;

      // Event listeners for inline editing
      const startIn = row.querySelector('.start-time-in');
      const endIn = row.querySelector('.end-time-in');
      const textIn = row.querySelector('.lyric-text-edit');

      startIn.addEventListener('change', () => {
        lyr.start = Math.max(0, parseFloat(startIn.value) || 0);
        if (lyr.end <= lyr.start) {
          lyr.end = +(lyr.start + 1.5).toFixed(2);
          endIn.value = lyr.end.toFixed(2);
        }
        refreshLyricWords(lyr);
      });

      endIn.addEventListener('change', () => {
        lyr.end = Math.max(lyr.start + 0.2, parseFloat(endIn.value) || lyr.start + 1.5);
        refreshLyricWords(lyr);
      });

      textIn.addEventListener('input', () => {
        lyr.text = textIn.value;
        refreshLyricWords(lyr);
      });

      row.querySelector('.seek-here-btn').addEventListener('click', () => {
        seekTo(Math.max(0, lyr.start - state.globalOffset));
        state.tapSyncCursor = idx;
      });

      row.querySelector('.stamp-here-btn').addEventListener('click', () => {
        stampLyricAtIndex(idx);
      });

      row.querySelector('.del-line-btn').addEventListener('click', () => {
        state.lyrics.splice(idx, 1);
        renderLyricsListUI();
      });

      container.appendChild(row);
    });
  }

  function stampLyricAtIndex(idx) {
    if (idx < 0 || idx >= state.lyrics.length) return;
    const now = state.currentTime - state.globalOffset;
    const lyr = state.lyrics[idx];
    const oldDur = Math.max(1.2, lyr.end - lyr.start);
    lyr.start = +Math.max(0, now).toFixed(2);
    lyr.end = +(lyr.start + oldDur).toFixed(2);

    // Also clamp previous line's end time so lines don't overlap awkwardly
    if (idx > 0 && state.lyrics[idx - 1].end > lyr.start) {
      state.lyrics[idx - 1].end = +Math.max(state.lyrics[idx - 1].start + 0.25, lyr.start - 0.05).toFixed(2);
      refreshLyricWords(state.lyrics[idx - 1]);
    }
    refreshLyricWords(lyr);
    state.tapSyncCursor = (idx + 1) % state.lyrics.length;
    renderLyricsListUI();

    const activeRow = document.getElementById(`lyric-row-${idx}`);
    if (activeRow) activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Highlight currently active lyric row in the sidebar without rebuilding DOM
  let lastHighlightedIdx = -1;
  function updateActiveLyricRowHighlight(activeIdx) {
    if (activeIdx === lastHighlightedIdx) return;
    if (lastHighlightedIdx !== -1) {
      const prevEl = document.getElementById(`lyric-row-${lastHighlightedIdx}`);
      if (prevEl) prevEl.classList.remove('active');
    }
    if (activeIdx !== -1) {
      const currEl = document.getElementById(`lyric-row-${activeIdx}`);
      if (currEl) {
        currEl.classList.add('active');
      }
    }
    lastHighlightedIdx = activeIdx;
  }

  // =========================================================================
  // 6. PARTICLE SYSTEM (Audio-Reactive)
  // =========================================================================
  const particles = [];

  function initParticles() {
    particles.length = 0;
    for (let i = 0; i < 120; i++) {
      particles.push(createParticle(true));
    }
  }

  function createParticle(randomY = false) {
    return {
      x: Math.random(),
      y: randomY ? Math.random() : 1.05,
      vx: (Math.random() - 0.5) * 0.0008,
      vy: -(0.0006 + Math.random() * 0.0018),
      size: 2.5 + Math.random() * 9,
      alpha: 0.2 + Math.random() * 0.65,
      hueShift: Math.random(),
      phase: Math.random() * Math.PI * 2,
    };
  }

  function updateAndDrawParticles(w, h) {
    if (state.particleMode === 'none' || state.particleCount <= 0) return;

    const count = Math.min(particles.length, state.particleCount);
    const speedBoost = 1 + state.smoothBass * 3.2 * state.reactivity;

    ctx.save();
    // Never use expensive ctx.shadowBlur inside the particle loop; use additive blending or layered alpha
    for (let i = 0; i < count; i++) {
      const p = particles[i];
      p.phase += 0.03;

      if (state.particleMode === 'snow' || state.particleMode === 'confetti') {
        const mult = state.particleMode === 'confetti' ? 1.4 : 2.2;
        p.y += Math.abs(p.vy) * mult * speedBoost;
        p.x += (state.particleMode === 'confetti' ? Math.sin(p.phase * 1.8) * 0.0022 : 0.0006) * speedBoost;
        if (p.y > 1.05) {
          p.y = -0.05;
          p.x = Math.random();
        }
        if (p.x > 1.05) p.x = -0.05;
        if (p.x < -0.05) p.x = 1.05;
      } else {
        p.y += p.vy * speedBoost;
        p.x += p.vx + Math.sin(p.phase) * 0.0004;
        if (p.y < -0.05) {
          p.y = 1.05;
          p.x = Math.random();
        }
      }

      const px = p.x * w;
      const py = p.y * h;
      const radius = p.size * (1 + state.smoothBass * 0.55);
      const color = p.hueShift > 0.5 ? state.activeColor : state.glowColor;
      const baseAlpha = Math.min(1, p.alpha * (0.6 + state.smoothBass * 0.5));

      ctx.fillStyle = color;

      if (state.particleMode === 'embers') {
        // Fast 2-circle soft halo instead of Gaussian shadowBlur
        ctx.globalAlpha = baseAlpha * 0.25;
        ctx.beginPath();
        ctx.arc(px, py, radius * 2.1, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = baseAlpha;
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
      } else if (state.particleMode === 'confetti') {
        const darkCarnivalPalette = ['#b80f28', '#d4af37', '#7a0918', '#e8dcc4', '#1a1114'];
        const cColor = darkCarnivalPalette[i % darkCarnivalPalette.length];
        ctx.save();
        ctx.globalAlpha = baseAlpha;
        ctx.translate(px, py);
        ctx.rotate(p.phase * 1.1);
        ctx.scale(Math.cos(p.phase * 1.7), 1);
        ctx.fillStyle = cColor;
        if (i % 3 === 0) {
          ctx.beginPath();
          ctx.moveTo(0, -radius * 1.9);
          ctx.lineTo(radius * 1.0, 0);
          ctx.lineTo(0, radius * 1.9);
          ctx.lineTo(-radius * 1.0, 0);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.75, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      } else if (state.particleMode === 'stars') {
        ctx.globalAlpha = baseAlpha;
        drawFourPointStar(px, py, radius * 1.6);
      } else if (state.particleMode === 'hearts') {
        ctx.globalAlpha = baseAlpha;
        drawMiniHeart(px, py, radius * 1.8);
      } else if (state.particleMode === 'snow') {
        ctx.globalAlpha = baseAlpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, radius * 0.35);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - 6, py - 22 * speedBoost * 0.4);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawFourPointStar(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const rad = i % 2 === 0 ? r : r * 0.3;
      const angle = (i * Math.PI) / 4;
      const sx = x + Math.cos(angle) * rad;
      const sy = y + Math.sin(angle) * rad;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.fill();
  }

  function drawMiniHeart(x, y, size) {
    ctx.beginPath();
    const topCurveHeight = size * 0.3;
    ctx.moveTo(x, y + topCurveHeight);
    ctx.bezierCurveTo(x, y, x - size / 2, y, x - size / 2, y + topCurveHeight);
    ctx.bezierCurveTo(x - size / 2, y + (size + topCurveHeight) / 2, x, y + (size + topCurveHeight) / 1.4, x, y + size);
    ctx.bezierCurveTo(x, y + (size + topCurveHeight) / 1.4, x + size / 2, y + (size + topCurveHeight) / 2, x + size / 2, y + topCurveHeight);
    ctx.bezierCurveTo(x + size / 2, y, x, y, x, y + topCurveHeight);
    ctx.closePath();
    ctx.fill();
  }

  // =========================================================================
  // 7. BACKGROUND RENDERER (Video, Multi-Image Slideshow & Procedural Themes)
  // =========================================================================
  function drawProceduralTheme(w, h, t) {
    const bass = state.smoothBass * state.reactivity;
    const theme = state.bgTheme;

    if (theme === 'pitch-black') {
      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    if (theme === 'circus-tent') {
      // Dark Theatrical Band Freakshow / Worn Crimson Velvet Big-Top (Batched Draw Calls)
      const cx = w / 2;
      const cy = h / 2;
      const maxRad = Math.hypot(w, h) * 0.85;
      const numRays = 24;
      const rot = t * 0.14 + Math.sin(t * 0.9) * 0.04;

      ctx.save();
      // Base dark obsidian fill
      ctx.fillStyle = '#080509';
      ctx.fillRect(0, 0, w, h);

      // Batch all 12 crimson rays into 1 single path & 1 fill()
      ctx.fillStyle = '#24040a';
      ctx.beginPath();
      for (let i = 0; i < numRays; i += 2) {
        const a1 = rot + (i / numRays) * Math.PI * 2;
        const a2 = rot + ((i + 1) / numRays) * Math.PI * 2;
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, maxRad, a1, a2);
        ctx.closePath();
      }
      ctx.fill();

      // Batch entire Harlequin Diamond Stage Grid into 1 single path & 1 stroke()
      ctx.strokeStyle = `rgba(212, 175, 55, ${0.05 + bass * 0.05})`;
      ctx.lineWidth = 1.5;
      const dSize = 110;
      ctx.beginPath();
      for (let gx = 0; gx <= w + dSize; gx += dSize) {
        for (let gy = 0; gy <= h + dSize; gy += dSize * 1.4) {
          ctx.moveTo(gx, gy - dSize * 0.7);
          ctx.lineTo(gx + dSize * 0.5, gy);
          ctx.lineTo(gx, gy + dSize * 0.7);
          ctx.lineTo(gx - dSize * 0.5, gy);
          ctx.closePath();
        }
      }
      ctx.stroke();

      // Moody Crimson & Tarnished Gold Stage Spotlight Haze
      const spotR = Math.min(w, h) * (0.42 + bass * 0.1);
      const spotGrad = ctx.createRadialGradient(cx, cy, 10, cx, cy, spotR * 1.4);
      spotGrad.addColorStop(0, `rgba(184, 15, 40, ${0.32 + bass * 0.18})`);
      spotGrad.addColorStop(0.55, `rgba(212, 175, 55, ${0.08 + bass * 0.06})`);
      spotGrad.addColorStop(1, 'rgba(3, 2, 4, 0.88)');
      ctx.fillStyle = spotGrad;
      ctx.fillRect(0, 0, w, h);

      // Victorian Ornate Stage Frame Border & Batched Warm Stage Footlights (Zero shadowBlur)
      const pad = w * 0.04;
      ctx.strokeStyle = 'rgba(212, 175, 55, 0.32)';
      ctx.lineWidth = 2;
      ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);
      ctx.strokeStyle = 'rgba(184, 15, 40, 0.45)';
      ctx.strokeRect(pad + 6, pad + 6, w - (pad + 6) * 2, h - (pad + 6) * 2);

      const bulbCount = 11;
      const stepX = (w - pad * 2) / bulbCount;
      // Soft outer halo pass (1 draw call)
      ctx.fillStyle = 'rgba(212, 175, 55, 0.22)';
      ctx.beginPath();
      for (let i = 0; i < bulbCount; i++) {
        const bx = pad + stepX * (i + 0.5);
        ctx.moveTo(bx + 14, pad);
        ctx.arc(bx, pad, 14, 0, Math.PI * 2);
        ctx.moveTo(bx + 14, h - pad);
        ctx.arc(bx, h - pad, 14, 0, Math.PI * 2);
      }
      ctx.fill();

      // Bright bulb core pass (1 draw call)
      ctx.fillStyle = '#f5d061';
      ctx.beginPath();
      for (let i = 0; i < bulbCount; i++) {
        const bx = pad + stepX * (i + 0.5);
        ctx.moveTo(bx + 5, pad);
        ctx.arc(bx, pad, 5, 0, Math.PI * 2);
        ctx.moveTo(bx + 5, h - pad);
        ctx.arc(bx, h - pad, 5, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
      return;
    }

    if (theme === 'cyber-neon') {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#090418');
      grad.addColorStop(0.5, '#12092b');
      grad.addColorStop(1, '#041b2d');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Glowing audio-reactive orbs
      const orb1X = w * (0.3 + 0.2 * Math.sin(t * 0.7));
      const orb1Y = h * (0.35 + 0.15 * Math.cos(t * 0.5));
      const rad1 = w * (0.45 + bass * 0.18);
      const g1 = ctx.createRadialGradient(orb1X, orb1Y, 10, orb1X, orb1Y, rad1);
      g1.addColorStop(0, 'rgba(254, 44, 85, 0.38)');
      g1.addColorStop(1, 'rgba(254, 44, 85, 0)');
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, w, h);

      const orb2X = w * (0.7 + 0.2 * Math.cos(t * 0.6));
      const orb2Y = h * (0.65 + 0.15 * Math.sin(t * 0.8));
      const rad2 = w * (0.48 + bass * 0.2);
      const g2 = ctx.createRadialGradient(orb2X, orb2Y, 10, orb2X, orb2Y, rad2);
      g2.addColorStop(0, 'rgba(0, 242, 254, 0.34)');
      g2.addColorStop(1, 'rgba(0, 242, 254, 0)');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, w, h);

      // Perspective synthwave grid at bottom (Batched into 1 single stroke call)
      ctx.save();
      ctx.strokeStyle = `rgba(0, 242, 254, ${0.12 + bass * 0.15})`;
      ctx.lineWidth = 2;
      const horizonY = h * 0.72;
      ctx.beginPath();
      for (let i = -8; i <= 8; i++) {
        ctx.moveTo(w * 0.5 + i * 35, horizonY);
        ctx.lineTo(w * 0.5 + i * 240, h);
      }
      const scrollOffset = (t * 60) % 40;
      for (let y = horizonY; y < h; y += 38) {
        const py = y + scrollOffset * ((y - horizonY) / (h - horizonY));
        if (py < h) {
          ctx.moveTo(0, py);
          ctx.lineTo(w, py);
        }
      }
      ctx.stroke();
      ctx.restore();
    } else if (theme === 'midnight-aurora') {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#030914');
      grad.addColorStop(0.5, '#071c2c');
      grad.addColorStop(1, '#090d16');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      for (let band = 0; band < 3; band++) {
        ctx.save();
        ctx.beginPath();
        const baseY = h * (0.3 + band * 0.18);
        ctx.moveTo(0, h);
        for (let x = 0; x <= w; x += 40) {
          const wave = Math.sin(x * 0.004 + t * (0.8 + band * 0.3) + band) * (70 + bass * 90);
          ctx.lineTo(x, baseY + wave);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        const aGrad = ctx.createLinearGradient(0, baseY - 100, 0, h);
        const colors = [
          'rgba(16, 185, 129, 0.22)',
          'rgba(0, 242, 254, 0.20)',
          'rgba(124, 58, 237, 0.22)',
        ];
        aGrad.addColorStop(0, colors[band]);
        aGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = aGrad;
        ctx.fill();
        ctx.restore();
      }
    } else if (theme === 'sunset-phonk') {
      const grad = ctx.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, Math.max(w, h) * 0.75);
      grad.addColorStop(0, `rgb(${70 + bass * 80}, 8, 20)`);
      grad.addColorStop(0.6, '#1a040a');
      grad.addColorStop(1, '#050103');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Crimson sun disc
      const sunR = Math.min(w, h) * (0.22 + bass * 0.05);
      const sunGrad = ctx.createLinearGradient(0, h * 0.35 - sunR, 0, h * 0.35 + sunR);
      sunGrad.addColorStop(0, 'rgba(255, 30, 65, 0.45)');
      sunGrad.addColorStop(1, 'rgba(255, 120, 0, 0.05)');
      ctx.fillStyle = sunGrad;
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.42, sunR, 0, Math.PI * 2);
      ctx.fill();
    } else if (theme === 'dreamy-pastel') {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#1f1135');
      grad.addColorStop(0.5, '#2d1b4e');
      grad.addColorStop(1, '#132238');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      const g = ctx.createRadialGradient(w * 0.5, h * 0.4, 10, w * 0.5, h * 0.4, w * 0.65);
      g.addColorStop(0, `rgba(236, 72, 153, ${0.28 + bass * 0.15})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    } else if (theme === 'starfield') {
      ctx.fillStyle = '#05060b';
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      const cx = w / 2;
      const cy = h / 2;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      for (let i = 0; i < 90; i++) {
        const seed = (i * 9301 + 49297) % 233280;
        const angle = (seed / 233280) * Math.PI * 2;
        const dist = (((t * (0.25 + (i % 5) * 0.08) + i * 0.13) % 1) ** 2) * Math.max(w, h) * 0.7;
        const sx = cx + Math.cos(angle) * dist;
        const sy = cy + Math.sin(angle) * dist;
        const r = 1.2 + (dist / Math.max(w, h)) * 4.5;
        ctx.moveTo(sx + r, sy);
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Helper to draw an image or video element onto canvas with 'cover' or 'contain' fit + Ken Burns
   */
  function drawMediaFit(mediaEl, mediaW, mediaH, w, h, kenBurnsScale = 1, panX = 0, panY = 0) {
    if (!mediaW || !mediaH) return;

    if (state.bgFit === 'contain') {
      // First draw a darkened cover backdrop
      ctx.save();
      const coverScale = Math.max(w / mediaW, h / mediaH) * 1.05;
      const cw = mediaW * coverScale;
      const ch = mediaH * coverScale;
      ctx.globalAlpha = 0.35;
      ctx.drawImage(mediaEl, (w - cw) / 2, (h - ch) / 2, cw, ch);
      ctx.restore();

      // Then draw contained image in center
      const containScale = Math.min(w / mediaW, h / mediaH) * kenBurnsScale;
      const dw = mediaW * containScale;
      const dh = mediaH * containScale;
      ctx.drawImage(mediaEl, (w - dw) / 2 + panX, (h - dh) / 2 + panY, dw, dh);
    } else {
      // 'cover' mode
      const scale = Math.max(w / mediaW, h / mediaH) * kenBurnsScale;
      const dw = mediaW * scale;
      const dh = mediaH * scale;
      ctx.drawImage(mediaEl, (w - dw) / 2 + panX, (h - dh) / 2 + panY, dw, dh);
    }
  }

  function renderBackground(w, h, t) {
    // Always draw procedural theme underneath (acts as main BG or fallback)
    drawProceduralTheme(w, h, t);

    // Smooth bass zoom pulse (without rapid X/Y shaking)
    const pulseAmt = (state.bassShake / 100) * state.smoothBass * state.reactivity;
    const zoomBump = 1 + pulseAmt * 0.035;

    ctx.save();
    if (state.bgBlur > 0) {
      ctx.filter = `blur(${state.bgBlur}px)`;
    }

    ctx.translate(w / 2, h / 2);
    ctx.scale(zoomBump, zoomBump);
    ctx.translate(-w / 2, -h / 2);

    const exportStill = state.isExporting ? state.exportVideoFrame : null;
    if (state.bgType === 'video' && exportStill) {
      drawMediaFit(exportStill, exportStill.width || 1080, exportStill.height || 1920, w, h, 1);
    } else if (state.bgType === 'video' && state.bgVideo && state.bgVideo.readyState >= 2) {
      drawMediaFit(
        state.bgVideo,
        state.bgVideo.videoWidth || 1080,
        state.bgVideo.videoHeight || 1920,
        w,
        h,
        1
      );
    } else if (state.bgType === 'images' && state.bgImages.length > 0) {
      const count = state.bgImages.length;
      let idx = 0;
      let crossfadeAlpha = 0;

      if (state.beatSlide && count > 1) {
        idx = state.currentSlideIndex % count;
      } else if (count > 1) {
        const slideDur = Math.max(1, state.slideDuration);
        const totalCycle = t / slideDur;
        idx = Math.floor(totalCycle) % count;
        const frac = totalCycle - Math.floor(totalCycle);
        // Smooth 0.6s crossfade at end of each slide
        const fadePortion = Math.min(0.35, 0.6 / slideDur);
        if (frac > 1 - fadePortion) {
          crossfadeAlpha = (frac - (1 - fadePortion)) / fadePortion;
        }
      }

      const img = state.bgImages[idx];
      const kbProgress = (t % state.slideDuration) / state.slideDuration;
      const kbScale = state.kenBurns ? 1.0 + kbProgress * 0.12 : 1.0;
      const kbPanX = state.kenBurns ? Math.sin(t * 0.4 + idx) * 24 : 0;
      const kbPanY = state.kenBurns ? Math.cos(t * 0.35 + idx) * 20 : 0;

      drawMediaFit(img, img.naturalWidth, img.naturalHeight, w, h, kbScale, kbPanX, kbPanY);

      if (crossfadeAlpha > 0 && count > 1) {
        const nextImg = state.bgImages[(idx + 1) % count];
        ctx.globalAlpha = crossfadeAlpha;
        drawMediaFit(nextImg, nextImg.naturalWidth, nextImg.naturalHeight, w, h, 1.02, 0, 0);
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();

    // Darken / Dim Overlay
    if (state.bgDim > 0) {
      ctx.fillStyle = `rgba(5, 6, 12, ${state.bgDim / 100})`;
      ctx.fillRect(0, 0, w, h);
    }

    // Vignette & Subtle Cinema Halation
    if (state.vignette > 0) {
      const vStrength = (state.vignette / 100) * 0.85;
      const vGrad = ctx.createRadialGradient(
        w / 2,
        h / 2,
        Math.min(w, h) * 0.28,
        w / 2,
        h / 2,
        Math.max(w, h) * 0.72
      );
      vGrad.addColorStop(0, 'rgba(0,0,0,0)');
      vGrad.addColorStop(1, `rgba(0,0,0,${vStrength})`);
      ctx.fillStyle = vGrad;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // =========================================================================
  // 8. AUDIO SPECTRUM VISUALIZERS (4 Modes - Zero-Lag Batched Paths)
  // =========================================================================
  function renderAudioSpectrum(w, h) {
    if (state.spectrumMode === 'none') return;

    const bins = state.freqData;
    const mult = state.reactivity;

    ctx.save();
    if (state.spectrumMode === 'bottom-bars') {
      const numBars = 48;
      const totalWidth = w * 0.84;
      const startX = (w - totalWidth) / 2;
      const barStep = totalWidth / numBars;
      const barWidth = barStep * 0.62;
      const baseY = h * 0.86;

      // Single shared gradient and single batched path for all 48 bars!
      const grad = ctx.createLinearGradient(0, baseY, 0, baseY - h * 0.18);
      grad.addColorStop(0, state.activeColor);
      grad.addColorStop(1, state.glowColor);
      ctx.fillStyle = grad;

      ctx.beginPath();
      for (let i = 0; i < numBars; i++) {
        const distFromCenter = Math.abs(i - numBars / 2) / (numBars / 2);
        const binIdx = Math.floor(distFromCenter * 42);
        const val = (bins[binIdx] / 255) * mult;
        const barH = Math.max(8, val * (h * 0.2));
        const x = startX + i * barStep;
        ctx.rect(x, baseY - barH, barWidth, barH);
      }
      ctx.fill();
    } else if (state.spectrumMode === 'circle-ring') {
      const cx = w * state.posX;
      const cy = h * state.posY;
      const baseRadius = Math.min(w, h) * (0.25 + state.smoothBass * 0.04 * mult);
      const spikes = 72;

      ctx.strokeStyle = state.activeColor;
      ctx.lineWidth = 5;
      ctx.beginPath();
      for (let i = 0; i < spikes; i++) {
        const angle = (i / spikes) * Math.PI * 2 - Math.PI / 2;
        const mirrorIdx = i < spikes / 2 ? i : spikes - i;
        const val = (bins[mirrorIdx % 48] / 255) * mult;
        const len = 8 + val * (Math.min(w, h) * 0.14);

        const x1 = cx + Math.cos(angle) * baseRadius;
        const y1 = cy + Math.sin(angle) * baseRadius;
        const x2 = cx + Math.cos(angle) * (baseRadius + len);
        const y2 = cy + Math.sin(angle) * (baseRadius + len);

        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();

      // Inner ring
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius - 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (state.spectrumMode === 'mirror-wave') {
      const baseY = h * 0.82;
      const points = 48;
      const sliceW = w / (points - 1);

      for (let layer = 0; layer < 2; layer++) {
        ctx.beginPath();
        for (let i = 0; i < points; i++) {
          const v = (state.timeData[i * 2] - 128) / 128;
          const amp = v * 110 * mult * (layer === 0 ? 1 : -0.65);
          const x = i * sliceW;
          const y = baseY + amp;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = layer === 0 ? state.activeColor : state.glowColor;
        ctx.lineWidth = layer === 0 ? 5 : 3;
        ctx.stroke();
      }
    } else if (state.spectrumMode === 'center-pulse') {
      const cy = h * state.posY + state.fontSize * 1.4;
      const maxW = w * 0.72;
      const startX = (w - maxW) / 2;
      const bars = 36;
      const step = maxW / bars;

      ctx.fillStyle = state.activeColor;
      ctx.beginPath();
      for (let i = 0; i < bars; i++) {
        const dist = Math.abs(i - bars / 2) / (bars / 2);
        const bin = Math.floor(dist * 32);
        const val = (bins[bin] / 255) * mult;
        const hBar = 4 + val * 90;
        const x = startX + i * step;
        ctx.rect(x, cy - hBar / 2, step * 0.55, hBar);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  // =========================================================================
  // 9. SUPER COOL TIKTOK LYRIC VISUALIZER STYLES (8 ENGINES)
  // =========================================================================

  function applyTextCase(str) {
    if (!str) return '';
    if (state.textCase === 'uppercase') return str.toUpperCase();
    if (state.textCase === 'lowercase') return str.toLowerCase();
    return str;
  }

  function findActiveLyricInfo(effectiveTime) {
    let activeIdx = -1;
    for (let i = 0; i < state.lyrics.length; i++) {
      const l = state.lyrics[i];
      if (effectiveTime >= l.start && effectiveTime <= l.end) {
        activeIdx = i;
        break;
      }
    }
    // Also find nearest upcoming if between lines
    let nextIdx = -1;
    for (let i = 0; i < state.lyrics.length; i++) {
      if (state.lyrics[i].start > effectiveTime) {
        nextIdx = i;
        break;
      }
    }
    return { activeIdx, nextIdx };
  }

  /**
   * Word wrapping helper for canvas text
   */
  function wrapWordsIntoLines(wordsArray, maxWidth) {
    const lines = [];
    let currentLine = [];
    let currentWidth = 0;
    const spaceW = ctx.measureText(' ').width;

    for (const wObj of wordsArray) {
      const wText = applyTextCase(wObj.word);
      const wordW = ctx.measureText(wText).width;
      if (currentLine.length > 0 && currentWidth + spaceW + wordW > maxWidth) {
        lines.push(currentLine);
        currentLine = [{ ...wObj, displayWord: wText, width: wordW }];
        currentWidth = wordW;
      } else {
        currentLine.push({ ...wObj, displayWord: wText, width: wordW });
        currentWidth += (currentLine.length > 1 ? spaceW : 0) + wordW;
      }
    }
    if (currentLine.length > 0) lines.push(currentLine);
    return lines;
  }

  function renderHeaderBadge(w, h) {
    if (!state.songTitle && !state.songArtist) return;
    ctx.save();
    const yTop = h * 0.08;
    ctx.textAlign = 'center';

    if (state.songTitle) {
      ctx.font = `800 ${Math.round(w * 0.032)}px 'Montserrat', sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 10;
      ctx.fillText(state.songTitle.toUpperCase(), w / 2, yTop);
    }
    if (state.songArtist) {
      ctx.font = `600 ${Math.round(w * 0.022)}px 'Inter', sans-serif`;
      ctx.fillStyle = state.activeColor;
      ctx.fillText(state.songArtist, w / 2, yTop + w * 0.036);
    }
    ctx.restore();
  }

  const STYLE_PRESETS = window.LyricAnimations.presets;
  const STYLE_PRESET_MAP = Object.fromEntries(STYLE_PRESETS.map((preset) => [preset.id, preset]));
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');

  function analyzeBeatForLyricSlot(lineSlot, effectiveTime) {
    const dur = Math.max(1, state.duration || 24);
    const numB = state.waveformPeaks.length || 0;
    if (numB === 0) {
      return { beatScore: 0.55, bassLevel: 0.5, transientSpike: 0.4, transientDensity: 0.35, subBeatJump: 0 };
    }

    let startSec = Math.max(0, effectiveTime - 0.4);
    let endSec = Math.min(dur, effectiveTime + 1.2);
    if (lineSlot >= 0 && lineSlot < state.lyrics.length) {
      startSec = Math.max(0, state.lyrics[lineSlot].start);
      endSec = Math.max(startSec + 0.25, state.lyrics[lineSlot].end);
    }

    const bStart = Math.max(0, Math.min(numB - 1, Math.floor((startSec / dur) * numB)));
    const bEnd = Math.max(bStart, Math.min(numB - 1, Math.ceil((endSec / dur) * numB)));
    const count = Math.max(1, bEnd - bStart + 1);

    let rmsSum = 0;
    let bassSum = 0;
    let maxBass = 0;
    let maxTrans = 0;
    let hitCount = 0;
    let dropBucketIdx = -1;

    for (let i = bStart; i <= bEnd; i++) {
      const r = (state.rmsBuckets[i] !== undefined ? state.rmsBuckets[i] : state.waveformPeaks[i]) || 0;
      const b = (state.bassBuckets[i] !== undefined ? state.bassBuckets[i] : r) || 0;
      const tr = (state.transientBuckets[i] !== undefined ? state.transientBuckets[i] : 0) || 0;
      rmsSum += r;
      bassSum += b;
      if (b > maxBass) maxBass = b;
      if (tr > maxTrans) maxTrans = tr;
      if (tr >= 0.42) hitCount++;

      // Detect if a strong beat drop hits inside the second half of a longer lyric line
      if (
        endSec - startSec >= 2.0 &&
        i > bStart + Math.floor(count * 0.35) &&
        tr >= 0.62 &&
        b >= 0.65 &&
        dropBucketIdx === -1
      ) {
        dropBucketIdx = i;
      }
    }

    const avgRms = rmsSum / count;
    const avgBass = bassSum / count;
    const bassLevel = avgBass * 0.55 + maxBass * 0.45;
    const beatScore = Math.min(1, avgRms * 0.40 + bassLevel * 0.40 + maxTrans * 0.20);

    // If playback has crossed a mid-line beat drop, shift subBeatJump to 1 so the style cuts on the beat drop!
    const currBucket = Math.max(0, Math.min(numB - 1, Math.floor((Math.max(0, effectiveTime) / dur) * numB)));
    const subBeatJump = dropBucketIdx !== -1 && currBucket >= dropBucketIdx ? 1 : 0;

    return {
      beatScore,
      bassLevel,
      transientSpike: maxTrans,
      transientDensity: hitCount / count,
      subBeatJump,
    };
  }

  function getStyleMeta(styleId) {
    return STYLE_PRESET_MAP[styleId] || STYLE_PRESETS[0];
  }

  function selectLyricPreset(styleId) {
    if (!STYLE_PRESET_MAP[styleId]) return;
    state.lyricStyle = styleId;
    document.querySelectorAll('#lyricStyleGrid .preset-card').forEach((card) => {
      const selected = card.dataset.style === styleId;
      card.classList.toggle('active', selected);
      card.setAttribute('aria-pressed', String(selected));
    });
  }

  // Suggest one animation for this phrase. Typography and colors stay under user control.
  function pickBeatMatchedStyle(lineSlot, effectiveTime) {
    const metrics = analyzeBeatForLyricSlot(lineSlot, effectiveTime);
    const tier = metrics.subBeatJump || metrics.beatScore >= 0.65 || metrics.bassLevel >= 0.72 ? 'drop'
      : metrics.beatScore >= 0.45 ? 'upbeat' : metrics.beatScore < 0.26 ? 'chill' : 'melodic';
    const sustain = 1 - metrics.transientDensity;
    return STYLE_PRESETS.filter((preset) => preset.tier === tier).reduce((best, preset) => {
      const distance = Math.abs(preset.bass - metrics.bassLevel) * 0.4
        + Math.abs(preset.punch - metrics.transientSpike) * 0.35 + Math.abs(preset.flow - sustain) * 0.25;
      return distance < best.distance ? { id: preset.id, distance } : best;
    }, { id: 'soft-fade', distance: Infinity }).id;
  }

  function renderLyrics(w, h, t) {
    const effectiveTime = t - state.globalOffset;
    const { activeIdx, nextIdx } = findActiveLyricInfo(effectiveTime);
    updateActiveLyricRowHighlight(activeIdx);
    if (!state.lyrics.length) return;
    const style = state.lyricStyle;
    const cx = w * state.posX;
    const cy = h * state.posY;
    const maxLineW = w * 0.84;

    if (style !== 'apple-scroll' && style !== 'aesthetic-vhs') {
      if (activeIdx !== -1) {
        window.LyricAnimations.render({
          ctx, style, lyric: state.lyrics[activeIdx], time: effectiveTime,
          width: w, height: h, x: cx, y: cy,
          fontFamily: state.fontFamily, fontSize: state.fontSize, textCase: state.textCase,
          primaryColor: state.primaryColor, activeColor: state.activeColor,
          glowColor: state.glowColor, glowStrength: state.glowStrength, strokeWidth: state.strokeWidth,
          reducedMotion: !state.isExporting && motionPreference.matches,
        });
      }
      return;
    }

    // Preserve the original Flow Scroll and Indie Film rendering and width fitting.
    const savedFontSize = state.fontSize;
    ctx.save();
    try {
      const targetIdx = activeIdx !== -1 ? activeIdx : nextIdx;
      if (targetIdx !== -1 && state.lyrics[targetIdx] && state.lyrics[targetIdx].words.length > 0) {
        ctx.font = `900 ${state.fontSize}px ${state.fontFamily}`;
        let maxWordW = 0;
        for (const word of state.lyrics[targetIdx].words) {
          maxWordW = Math.max(maxWordW, ctx.measureText(applyTextCase(word.word)).width + state.strokeWidth * 3);
        }
        const maxAllowedWordW = (w * 0.86) / 1.25;
        if (maxWordW > maxAllowedWordW && maxWordW > 0) {
          state.fontSize = Math.max(28, Math.floor(state.fontSize * (maxAllowedWordW / maxWordW)));
        }
      }
      ctx.font = `900 ${state.fontSize}px ${state.fontFamily}`;
      ctx.textBaseline = 'middle';

      if (style === 'apple-scroll') {
      const centerIdx = activeIdx !== -1 ? activeIdx : nextIdx !== -1 ? Math.max(0, nextIdx - 1) : 0;
      const spacing = state.fontSize * 2.15;

      for (let offset = -2; offset <= 2; offset++) {
        const idx = centerIdx + offset;
        if (idx < 0 || idx >= state.lyrics.length) continue;

        const lyr = state.lyrics[idx];
        const isCurrent = idx === activeIdx;
        const yPos = cy + offset * spacing;
        const scale = isCurrent ? 1.05 + state.smoothBass * 0.04 : 0.82 - Math.abs(offset) * 0.06;
        const alpha = isCurrent ? 1.0 : Math.max(0.15, 0.45 - Math.abs(offset) * 0.14);

        ctx.save();
        ctx.translate(cx, yPos);
        ctx.scale(scale, scale);
        ctx.globalAlpha = alpha;

        const wrapped = wrapWordsIntoLines(lyr.words, maxLineW);
        const subLineH = state.fontSize * 1.18;
        let subY = -((wrapped.length - 1) * subLineH) / 2;

        ctx.textAlign = 'center';
        for (const row of wrapped) {
          const rowStr = row.map((r) => r.displayWord).join(' ');
          if (state.strokeWidth > 0 && isCurrent) {
            ctx.lineWidth = state.strokeWidth * 1.8;
            ctx.strokeStyle = 'rgba(0,0,0,0.75)';
            ctx.lineJoin = 'round';
            ctx.strokeText(rowStr, 0, subY);
          }
          ctx.fillStyle = isCurrent ? state.primaryColor : '#a0aec0';
          ctx.fillText(rowStr, 0, subY);
          subY += subLineH;
        }
        ctx.restore();
      }
    }

      else if (style === 'aesthetic-vhs') {
      // Draw subtle cinema letterbox bars at top and bottom
      const barH = h * 0.065;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, barH);
      ctx.fillRect(0, h - barH, w, barH);

      if (activeIdx === -1) {
        ctx.restore();
        return;
      }
      const lyr = state.lyrics[activeIdx];
      ctx.font = `italic 700 ${Math.round(state.fontSize * 0.88)}px ${state.fontFamily}`;
      const wrapped = wrapWordsIntoLines(lyr.words, maxLineW);
      const lineH = state.fontSize * 1.18;
      let startY = cy - ((wrapped.length - 1) * lineH) / 2;

      ctx.textAlign = 'center';
      for (const row of wrapped) {
        const text = row.map((r) => r.displayWord).join(' ');
        ctx.lineWidth = Math.max(4, state.strokeWidth * 2.2);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
        ctx.lineJoin = 'round';
        ctx.strokeText(text, cx, startY);

        ctx.fillStyle = '#ffe999';
        ctx.fillText(text, cx, startY);
        startY += lineH;
      }
    }
      ctx.restore();
    } finally {
      state.fontSize = savedFontSize;
    }
  }

  // =========================================================================
  // 10. TIKTOK SAFE ZONE OVERLAY (Preview Helper)
  // =========================================================================
  function renderTikTokSafeZone(w, h) {
    if (!state.showSafeZone || state.isExporting) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(0, 242, 254, 0.5)';
    ctx.fillStyle = 'rgba(254, 44, 85, 0.16)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);

    // Right action buttons zone (Like, Comment, Bookmark, Share)
    const rightW = w * 0.16;
    const rightH = h * 0.42;
    const rightX = w - rightW - w * 0.02;
    const rightY = h * 0.38;
    roundRect(ctx, rightX, rightY, rightW, rightH, 16);
    ctx.fill();
    ctx.stroke();

    // Bottom caption & music marquee zone
    const botH = h * 0.16;
    const botY = h - botH - h * 0.02;
    roundRect(ctx, w * 0.03, botY, w * 0.76, botH, 16);
    ctx.fill();
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '600 22px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('TikTok Buttons', rightX + rightW / 2, rightY + rightH / 2);
    ctx.fillText('TikTok Caption & Username Area', w * 0.41, botY + botH / 2);
    ctx.restore();
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  // =========================================================================
  // 11. INTERACTIVE TIMELINE RENDERER (Waveform + SRT Blocks + Playhead)
  // =========================================================================
  function renderTimeline() {
    const tw = timelineCanvas.width;
    const th = timelineCanvas.height;
    timelineCtx.clearRect(0, 0, tw, th);

    const dur = Math.max(1, state.duration);

    // 1. Draw Trim Shaded Region
    const trimStartX = (state.trimStart / dur) * tw;
    const trimEndX = (state.trimEnd / dur) * tw;
    timelineCtx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    timelineCtx.fillRect(trimStartX, 0, Math.max(2, trimEndX - trimStartX), th);

    // 2. Draw Audio Waveform Peaks
    const peaks = state.waveformPeaks;
    if (peaks.length > 0) {
      const barW = tw / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const x = i * barW;
        const timeAtBar = (i / peaks.length) * dur;
        const isPlayed = timeAtBar <= state.currentTime;
        const hBar = Math.max(3, peaks[i] * (th * 0.55));
        timelineCtx.fillStyle = isPlayed
          ? 'rgba(0, 242, 254, 0.55)'
          : 'rgba(255, 255, 255, 0.16)';
        timelineCtx.fillRect(x, th - hBar - 2, Math.max(1.5, barW * 0.7), hBar);
      }
    }

    // 3. Draw Synced Lyric Pills along the top track
    state.lyrics.forEach((lyr, idx) => {
      const s = lyr.start + state.globalOffset;
      const e = lyr.end + state.globalOffset;
      const x1 = (s / dur) * tw;
      const x2 = (e / dur) * tw;
      const wPill = Math.max(4, x2 - x1);
      const isCurrent = state.currentTime >= s && state.currentTime <= e;

      timelineCtx.fillStyle = isCurrent
        ? 'rgba(254, 44, 85, 0.85)'
        : 'rgba(0, 242, 254, 0.28)';
      timelineCtx.fillRect(x1, 4, wPill, 15);

      if (wPill > 28) {
        timelineCtx.fillStyle = '#ffffff';
        timelineCtx.font = '600 9px Inter, sans-serif';
        timelineCtx.fillText(lyr.text.slice(0, 12), x1 + 4, 14);
      }
    });

    // 4. Playhead Line
    const playX = (state.currentTime / dur) * tw;
    timelineCtx.strokeStyle = '#fe2c55';
    timelineCtx.lineWidth = 2;
    timelineCtx.beginPath();
    timelineCtx.moveTo(playX, 0);
    timelineCtx.lineTo(playX, th);
    timelineCtx.stroke();
  }

  // =========================================================================
  // 12. MAIN 60FPS ANIMATION LOOP & AUDIO FFT ANALYSIS
  // =========================================================================
  function updateAudioMetrics(nowSec) {
    if (analyser && state.isPlaying) {
      analyser.getByteFrequencyData(state.freqData);
      analyser.getByteTimeDomainData(state.timeData);

      // Compute Bass (bins 0..6), Mid (7..28), High (29..64)
      let bassSum = 0;
      for (let i = 0; i < 6; i++) bassSum += state.freqData[i];
      state.bassEnergy = bassSum / (6 * 255);

      let midSum = 0;
      for (let i = 6; i < 28; i++) midSum += state.freqData[i];
      state.midEnergy = midSum / (22 * 255);

      // Smooth bass & detect strong beat transients for image slide switching
      const prevBass = state.smoothBass;
      state.smoothBass = prevBass * 0.75 + state.bassEnergy * 0.25;

      if (
        state.beatSlide &&
        state.bgImages.length > 1 &&
        state.bassEnergy > 0.68 &&
        state.bassEnergy - prevBass > 0.12 &&
        nowSec - state.lastSlideBeatTime > 0.45
      ) {
        state.currentSlideIndex = (state.currentSlideIndex + 1) % state.bgImages.length;
        state.lastSlideBeatTime = nowSec;
      }
    } else {
      // Gentle idle breathing animation when paused
      state.smoothBass *= 0.92;
      for (let i = 0; i < state.freqData.length; i++) {
        state.freqData[i] = Math.max(8, state.freqData[i] * 0.9);
        state.timeData[i] = 128;
      }
    }
  }

  // Precomputed 256-point Hann-windowed DFT lookup tables for offline frame-exact audio analysis
  const OFFLINE_FFT_N = 256;
  const OFFLINE_FFT_BINS = 64;
  const HANN_WIN = new Float32Array(OFFLINE_FFT_N);
  const COS_LUT = new Float32Array(OFFLINE_FFT_BINS * OFFLINE_FFT_N);
  const SIN_LUT = new Float32Array(OFFLINE_FFT_BINS * OFFLINE_FFT_N);
  for (let n = 0; n < OFFLINE_FFT_N; n++) {
    HANN_WIN[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (OFFLINE_FFT_N - 1)));
  }
  for (let k = 0; k < OFFLINE_FFT_BINS; k++) {
    for (let n = 0; n < OFFLINE_FFT_N; n++) {
      const ang = (2 * Math.PI * k * n) / OFFLINE_FFT_N;
      COS_LUT[k * OFFLINE_FFT_N + n] = Math.cos(ang);
      SIN_LUT[k * OFFLINE_FFT_N + n] = Math.sin(ang);
    }
  }

  /**
   * Deterministically computes exact FFT frequency bins, waveform, and bass energy at timestamp t
   * directly from the decoded AudioBuffer so frame-by-frame exports never drop frames or desync.
   */
  function computeOfflineAudioMetricsAtTime(t) {
    if (state.decodedAudioBuffer) {
      const ch0 = state.decodedAudioBuffer.getChannelData(0);
      const sr = state.decodedAudioBuffer.sampleRate || 44100;
      const startSample = Math.max(0, Math.min(ch0.length - OFFLINE_FFT_N, Math.floor(t * sr)));

      const windowed = new Float32Array(OFFLINE_FFT_N);
      for (let n = 0; n < OFFLINE_FFT_N; n++) {
        const s = ch0[startSample + n] || 0;
        windowed[n] = s * HANN_WIN[n];
        if (n % 2 === 0) {
          state.timeData[n >> 1] = Math.max(0, Math.min(255, Math.round(128 + s * 127)));
        }
      }

      for (let k = 0; k < OFFLINE_FFT_BINS; k++) {
        let re = 0;
        let im = 0;
        const base = k * OFFLINE_FFT_N;
        for (let n = 0; n < OFFLINE_FFT_N; n++) {
          const wVal = windowed[n];
          re += wVal * COS_LUT[base + n];
          im -= wVal * SIN_LUT[base + n];
        }
        const mag = Math.hypot(re, im) / (OFFLINE_FFT_N * 0.25);
        const db = 20 * Math.log10(mag + 1e-6);
        // Map [-65dB .. -5dB] -> [0 .. 255]
        const norm = Math.max(0, Math.min(1, (db + 65) / 60));
        const byteVal = Math.round(norm * 255);
        state.freqData[k] = Math.round(state.freqData[k] * 0.68 + byteVal * 0.32);
      }
    } else {
      // Synthetic rhythmic fallback if audio format could not be decoded in browser
      for (let k = 0; k < 64; k++) {
        const pulse = Math.max(0, Math.sin(t * 8.2 - k * 0.12));
        state.freqData[k] = Math.round(40 + pulse * 180 * Math.exp(-k * 0.03));
        state.timeData[k] = Math.round(128 + Math.sin(t * 24 + k * 0.3) * 60 * pulse);
      }
    }

    let bassSum = 0;
    for (let i = 0; i < 6; i++) bassSum += state.freqData[i];
    state.bassEnergy = bassSum / (6 * 255);

    let midSum = 0;
    for (let i = 6; i < 28; i++) midSum += state.freqData[i];
    state.midEnergy = midSum / (22 * 255);

    const prevBass = state.smoothBass;
    state.smoothBass = prevBass * 0.72 + state.bassEnergy * 0.28;

    if (
      state.beatSlide &&
      state.bgImages.length > 1 &&
      state.bassEnergy > 0.68 &&
      state.bassEnergy - prevBass > 0.12 &&
      t - state.lastSlideBeatTime > 0.45
    ) {
      state.currentSlideIndex = (state.currentSlideIndex + 1) % state.bgImages.length;
      state.lastSlideBeatTime = t;
    }
  }

  function renderSingleCanvasFrameAtTime(t) {
    const w = state.canvasWidth;
    const h = state.canvasHeight;
    ctx.clearRect(0, 0, w, h);
    renderBackground(w, h, t);
    updateAndDrawParticles(w, h);
    renderAudioSpectrum(w, h);
    const hasPersonLayer = preparePersonLayer(w, h);
    renderLyrics(w, h, t);
    if (hasPersonLayer) ctx.drawImage(foregroundLayer, 0, 0);
    renderHeaderBadge(w, h);
    renderTikTokSafeZone(w, h);
  }

  function mainRenderLoop(timestamp) {
    if (state.isExporting) {
      // Yield while deterministic frame-by-frame Python FFmpeg export is driving the canvas
      requestAnimationFrame(mainRenderLoop);
      return;
    }

    const wallTime = timestamp * 0.001;

    if (!audioEl.paused) {
      state.currentTime = audioEl.currentTime;
      document.getElementById('currentTimeLabel').textContent = formatShortTime(state.currentTime);
    }

    updateAudioMetrics(wallTime);

    const renderTime = state.currentTime;
    renderSingleCanvasFrameAtTime(renderTime);
    renderTimeline();

    requestAnimationFrame(mainRenderLoop);
  }

  // =========================================================================
  // 13. PLAYBACK, SEEKING & VIDEO SYNC CONTROLS
  // =========================================================================
  function togglePlayPause() {
    ensureAudioContext();
    if (audioEl.paused) {
      if (state.currentTime >= state.duration - 0.1) {
        seekTo(0);
      }
      audioEl.play().then(() => {
        state.isPlaying = true;
        document.getElementById('playPauseBtn').textContent = '⏸';
        if (state.bgType === 'video' && state.bgVideo) {
          state.bgVideo.currentTime = audioEl.currentTime % (state.bgVideo.duration || 10);
          state.bgVideo.play().catch(() => {});
        }
      }).catch((err) => {
        console.warn('Playback failed:', err);
      });
    } else {
      audioEl.pause();
      state.isPlaying = false;
      document.getElementById('playPauseBtn').textContent = '▶';
      if (state.bgVideo) state.bgVideo.pause();
    }
  }

  function seekTo(sec) {
    foreground.reset();
    const clamped = Math.max(0, Math.min(state.duration || 24, sec));
    audioEl.currentTime = clamped;
    state.currentTime = clamped;
    document.getElementById('currentTimeLabel').textContent = formatShortTime(clamped);
    if (state.bgType === 'video' && state.bgVideo && state.bgVideo.duration) {
      state.bgVideo.currentTime = clamped % state.bgVideo.duration;
    }
  }

  audioEl.addEventListener('ended', () => {
    state.isPlaying = false;
    document.getElementById('playPauseBtn').textContent = '▶';
    if (state.bgVideo) state.bgVideo.pause();
  });

  // =========================================================================
  // 14. PYTHON + FFMPEG (NVENC / H.264 CFR) DETERMINISTIC VIDEO EXPORTER
  // =========================================================================
  function releaseExportVideoFrame() {
    if (state.exportVideoFrame && typeof state.exportVideoFrame.close === 'function') {
      state.exportVideoFrame.close();
    }
    state.exportVideoFrame = null;
    state.exportVideoFrameIdx = -1;
  }

  function wrapBgVideoTime(videoEl, targetSec) {
    const dur = videoEl.duration;
    if (!dur || !Number.isFinite(dur)) return 0;
    let t = targetSec % dur;
    if (t < 0) t += dur;
    if (t >= dur - 0.0005) t = 0;
    return t;
  }

  function seekVideoToPresentedFrame(videoEl, time) {
    return new Promise((resolve) => {
      if (!videoEl || !Number.isFinite(time)) {
        resolve();
        return;
      }
      if (!videoEl.seeking && videoEl.readyState >= 2 && Math.abs(videoEl.currentTime - time) < 0.0008) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        videoEl.removeEventListener('seeked', onSeeked);
        resolve();
      };
      const onSeeked = () => {
        if (typeof videoEl.requestVideoFrameCallback === 'function') {
          const timer = setTimeout(finish, 90);
          videoEl.requestVideoFrameCallback(() => {
            clearTimeout(timer);
            finish();
          });
        } else {
          requestAnimationFrame(() => requestAnimationFrame(finish));
        }
      };
      videoEl.addEventListener('seeked', onSeeked);
      setTimeout(finish, 450);
      try {
        videoEl.currentTime = time;
      } catch (err) {
        finish();
      }
    });
  }

  async function measureBgVideoFrameStep(videoEl) {
    const fallback = 1 / 30;
    if (!videoEl || typeof videoEl.requestVideoFrameCallback !== 'function') return fallback;
    if (videoEl.readyState < 2) {
      await new Promise((resolve) => {
        videoEl.addEventListener('loadeddata', () => resolve(), { once: true });
        setTimeout(resolve, 1200);
      });
    }
    const times = [];
    try {
      await videoEl.play();
    } catch (err) {
      return fallback;
    }
    await new Promise((resolve) => {
      const collect = (_now, meta) => {
        if (meta && Number.isFinite(meta.mediaTime)) times.push(meta.mediaTime);
        if (times.length >= 8) resolve();
        else videoEl.requestVideoFrameCallback(collect);
      };
      videoEl.requestVideoFrameCallback(collect);
      setTimeout(resolve, 700);
    });
    videoEl.pause();
    const deltas = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > 0.008 && d < 0.05) deltas.push(d);
    }
    if (!deltas.length) return fallback;
    deltas.sort((a, b) => a - b);
    const measured = deltas[Math.floor(deltas.length / 2)];
    const standards = [24, 25, 30, 48, 50, 60, 120].map((fps) => 1 / fps);
    let best = measured;
    let bestErr = Infinity;
    for (let i = 0; i < standards.length; i++) {
      const err = Math.abs(standards[i] - measured);
      if (err < bestErr) {
        bestErr = err;
        best = standards[i];
      }
    }
    return bestErr < 0.004 ? best : measured;
  }

  async function captureExportVideoFrame(videoEl, targetSec) {
    if (!videoEl || !videoEl.duration) return;
    const step = state.bgFrameStep > 0.008 ? state.bgFrameStep : 1 / 30;
    const wrapped = wrapBgVideoTime(videoEl, targetSec);
    const frameIdx = Math.floor((wrapped + step * 0.02) / step);
    if (state.exportVideoFrame && frameIdx === state.exportVideoFrameIdx) return;

    const snapped = Math.min(frameIdx * step, Math.max(0, videoEl.duration - 0.001));
    await seekVideoToPresentedFrame(videoEl, snapped);

    let bitmap = null;
    for (let attempt = 0; attempt < 3 && !bitmap; attempt++) {
      try {
        if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
          bitmap = await createImageBitmap(videoEl);
        }
      } catch (err) {
        bitmap = null;
      }
      if (!bitmap) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    }
    if (!bitmap) return;
    if (state.exportVideoFrame && typeof state.exportVideoFrame.close === 'function') {
      state.exportVideoFrame.close();
    }
    state.exportVideoFrame = bitmap;
    state.exportVideoFrameIdx = frameIdx;
  }

  function seekVideoElementFrameAccurate(videoEl, targetSec) {
    return captureExportVideoFrame(videoEl, targetSec);
  }

  function canvasToJpegBlob(quality = 0.92) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
    });
  }

  async function startVideoExport() {
    if (state.isExporting) return;

    // Pause live playback so offline rendering has 100% deterministic control
    audioEl.pause();
    state.isPlaying = false;
    document.getElementById('playPauseBtn').textContent = '▶';
    if (state.bgVideo) state.bgVideo.pause();

    const fpsSelect = document.getElementById('exportFpsSelect');
    const fps = fpsSelect ? parseInt(fpsSelect.value, 10) || 60 : 60;
    const trimStart = Math.max(0, state.trimStart);
    const trimEnd = Math.max(trimStart + 0.5, state.trimEnd);
    const clipDuration = trimEnd - trimStart;
    const totalFrames = Math.max(1, Math.round(clipDuration * fps));

    const cleanTitle = (state.songTitle || 'tiktok_lyrics_visualizer')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'tiktok_lyrics_visualizer';
    const downloadFilename = `${cleanTitle}_${state.aspect.replace(':', 'x')}_${fps}fps.mp4`;

    state.isExporting = true;
    state.exportCancelled = false;
    state.exportStopEarly = false;

    const modalEl = document.getElementById('exportModal');
    const statusTextEl = document.getElementById('exportStatusText');
    const progBarEl = document.getElementById('exportProgressBar');
    const pctLabelEl = document.getElementById('exportPercentLabel');
    const remLabelEl = document.getElementById('exportTimeRemaining');

    progBarEl.style.width = '0%';
    pctLabelEl.textContent = '0%';
    statusTextEl.textContent = 'Starting Python + FFmpeg H.264 Hardware Encoder...';
    remLabelEl.textContent = `0 / ${totalFrames} frames`;
    modalEl.classList.remove('hidden');

    let jobId = null;
    let bgPrepId = null;
    try {
      if (state.lyricsBehindPerson && state.bgType === 'video') {
        statusTextEl.textContent = 'Loading local person masking model...';
        await foreground.init();
        foreground.reset();
      }
      // 1. Initialize FFmpeg render job on Python server, uploading the pristine audio track
      const qs = new URLSearchParams({
        fps: String(fps),
        trimStart: String(trimStart),
        trimEnd: String(trimEnd),
        ext: state.audioExt || 'wav',
      });

      const startRes = await fetch(`/api/render/start?${qs.toString()}`, {
        method: 'POST',
        body: state.audioBlob || null,
      });
      const startData = await startRes.json();
      if (!startRes.ok || !startData.ok) {
        throw new Error(startData.error || 'Failed to start Python FFmpeg render job');
      }

      jobId = startData.jobId;
      const encoderName = startData.encoder || 'FFmpeg H.264';
      statusTextEl.textContent = `Rendering Constant-${fps}FPS MP4 via ${encoderName}...`;

      // Reset deterministic visual state at start of export
      state.freqData.fill(0);
      state.timeData.fill(128);
      state.smoothBass = 0;
      state.lastSlideBeatTime = trimStart;
      initParticles();
      releaseExportVideoFrame();
      let bgPrep = null;
      const bgPrefetch = new Map();
      if (state.bgType === 'video' && state.bgVideo) {
        if (state.bgVideoFile) {
          // Decode the background sequentially with FFmpeg (far faster than seeking per frame)
          statusTextEl.textContent = 'Decoding background video with FFmpeg...';
          try {
            const bq = new URLSearchParams({
              fps: String(fps),
              start: wrapBgVideoTime(state.bgVideo, trimStart).toFixed(3),
              frames: String(totalFrames),
              w: String(canvas.width),
              h: String(canvas.height),
            });
            const bres = await fetch(`/api/bg/prepare?${bq.toString()}`, {
              method: 'POST',
              body: state.bgVideoFile,
            });
            const bdata = await bres.json();
            if (bres.ok && bdata.ok) {
              bgPrep = bdata;
              bgPrepId = bdata.prepId;
            } else {
              console.warn('BG prepare failed, falling back to seek mode:', bdata.error);
            }
          } catch (err) {
            console.warn('BG prepare failed, falling back to seek mode:', err);
          }
          statusTextEl.textContent = `Rendering Constant-${fps}FPS MP4 via ${encoderName}...`;
        }
        if (!bgPrep) {
          state.bgFrameStep = await measureBgVideoFrameStep(state.bgVideo);
          state.bgVideo.pause();
        }
      }
      const fetchBgFrameOnce = async (idx) => {
        let lastErr = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const r = await fetch(`/api/bg/frame/${bgPrep.prepId}/${idx}`);
            if (!r.ok) throw new Error(`BG frame ${idx} HTTP ${r.status}`);
            return await createImageBitmap(await r.blob());
          } catch (err) {
            lastErr = err;
            await new Promise((res) => setTimeout(res, 150 * (attempt + 1)));
          }
        }
        throw lastErr;
      };
      const fetchBgFrame = (i) => {
        const idx = Math.min(i, bgPrep.count - 1);
        if (!bgPrefetch.has(idx)) {
          bgPrefetch.set(idx, fetchBgFrameOnce(idx));
        }
        return bgPrefetch.get(idx);
      };

      const BATCH_SIZE = 15;
      let batchBlobs = [];
      let pendingUploadPromise = Promise.resolve();
      const exportStartWall = performance.now();

      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        if (state.exportCancelled || state.exportStopEarly) {
          break;
        }

        const t = trimStart + frameIdx / fps;
        state.currentTime = t;

        // Hold each source frame across the 60fps ticks that fall between it.
        // Seeking those in-between times paints a blank frame.
        if (bgPrep) {
          for (let k = 1; k <= 8; k++) {
            if (frameIdx + k < totalFrames) fetchBgFrame(frameIdx + k);
          }
          const bmp = await fetchBgFrame(frameIdx);
          bgPrefetch.delete(Math.min(frameIdx, bgPrep.count - 1));
          releaseExportVideoFrame();
          state.exportVideoFrame = bmp;
          state.exportVideoFrameIdx = frameIdx;
        } else if (state.bgType === 'video' && state.bgVideo) {
          await captureExportVideoFrame(state.bgVideo, t);
        }

        // Compute exact audio FFT & bass pulse for timestamp t
        computeOfflineAudioMetricsAtTime(t);

        // Draw frame on canvas
        if (state.lyricsBehindPerson) {
          const source = personMaskSource();
          if (source) await foreground.update(source.media, source.key);
        }
        renderSingleCanvasFrameAtTime(t);

        // Kick off JPEG encoding without waiting: toBlob snapshots the canvas immediately,
        // so the next frame can be drawn while this one encodes in the background.
        batchBlobs.push(canvasToJpegBlob(0.9));

        // Flush batch of frames to Python FFmpeg stdin pipe
        if (batchBlobs.length >= BATCH_SIZE || frameIdx === totalFrames - 1) {
          const resolvedBlobs = (await Promise.all(batchBlobs)).filter(Boolean);
          const chunkPayload = new Blob(resolvedBlobs, { type: 'application/octet-stream' });
          batchBlobs = [];

          // Wait for previous batch upload before dispatching next so we pipeline CPU/GPU + I/O
          await pendingUploadPromise;
          pendingUploadPromise = fetch(`/api/render/chunk?jobId=${encodeURIComponent(jobId)}`, {
            method: 'POST',
            body: chunkPayload,
          }).then(async (r) => {
            if (!r.ok) {
              const errJson = await r.json().catch(() => ({}));
              throw new Error(errJson.error || 'FFmpeg pipe write failed');
            }
          });

          // Update progress UI
          const doneFrames = frameIdx + 1;
          const pct = Math.min(99, Math.round((doneFrames / totalFrames) * 100));
          progBarEl.style.width = `${pct}%`;
          pctLabelEl.textContent = `${pct}%`;

          const elapsedSec = (performance.now() - exportStartWall) / 1000;
          const renderFps = doneFrames / Math.max(0.1, elapsedSec);
          const etaSec = Math.max(0, (totalFrames - doneFrames) / Math.max(1, renderFps)).toFixed(1);
          remLabelEl.textContent = `Frame ${doneFrames}/${totalFrames} (${Math.round(renderFps)} fps • ~${etaSec}s left)`;
          document.getElementById('currentTimeLabel').textContent = formatShortTime(t);
          renderTimeline();
        }
      }

      // Flush any remaining frames if stopped early
      if (!state.exportCancelled && batchBlobs.length > 0) {
        await pendingUploadPromise;
        const finalChunk = new Blob((await Promise.all(batchBlobs)).filter(Boolean), { type: 'application/octet-stream' });
        const r = await fetch(`/api/render/chunk?jobId=${encodeURIComponent(jobId)}`, {
          method: 'POST',
          body: finalChunk,
        });
        if (!r.ok) {
          const errJson = await r.json().catch(() => ({}));
          throw new Error(errJson.error || 'FFmpeg final chunk write failed');
        }
      } else {
        await pendingUploadPromise;
      }

      if (state.exportCancelled) {
        await fetch(`/api/render/cancel?jobId=${encodeURIComponent(jobId)}`, { method: 'POST' });
        state.isExporting = false;
        modalEl.classList.add('hidden');
        return;
      }

      // 3. Finalize MP4 container (+faststart moov header & AAC audio muxing)
      statusTextEl.textContent = 'Finalizing H.264 + AAC MP4 container (+faststart)...';
      progBarEl.style.width = '100%';
      pctLabelEl.textContent = '100%';

      const finRes = await fetch(
        `/api/render/finish?jobId=${encodeURIComponent(jobId)}&filename=${encodeURIComponent(downloadFilename)}`,
        { method: 'POST' }
      );
      const finData = await finRes.json();
      if (!finRes.ok || !finData.ok) {
        throw new Error(finData.error || 'Failed to finalize MP4 file');
      }

      if (finData.savedPath) {
        statusTextEl.textContent = 'Saved!';
        alert(`MP4 saved to:\n${finData.savedPath}`);
      } else {
        // Fallback: browser download as a named blob
        statusTextEl.textContent = 'Saving MP4...';
        const dlRes = await fetch(finData.downloadUrl);
        if (!dlRes.ok) throw new Error('Failed to fetch rendered MP4');
        const mp4Blob = new Blob([await dlRes.blob()], { type: 'video/mp4' });
        const blobUrl = URL.createObjectURL(mp4Blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = downloadFilename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      }
    } catch (err) {
      console.error('Video export error:', err);
      alert(`MP4 Export Error: ${err.message}`);
      if (jobId) {
        fetch(`/api/render/cancel?jobId=${encodeURIComponent(jobId)}`, { method: 'POST' }).catch(() => {});
      }
    } finally {
      if (bgPrepId) {
        fetch(`/api/bg/cleanup?prepId=${encodeURIComponent(bgPrepId)}`, { method: 'POST' }).catch(() => {});
      }
      releaseExportVideoFrame();
      if (state.bgVideo) state.bgVideo.pause();
      state.isExporting = false;
      modalEl.classList.add('hidden');
    }
  }

  function finishVideoExport(cancelled = false) {
    if (!state.isExporting) return;
    if (cancelled) {
      state.exportCancelled = true;
    } else {
      state.exportStopEarly = true;
    }
  }

  // =========================================================================
  // 15. EVENT LISTENERS & UI BINDINGS
  // =========================================================================
  function bindUIEvents() {
    const personToggle = document.getElementById('lyricsBehindPersonToggle');
    personToggle.addEventListener('change', async () => {
      if (state.isExporting) {
        personToggle.checked = state.lyricsBehindPerson;
        return;
      }
      state.lyricsBehindPerson = personToggle.checked;
      foreground.reset();
      document.getElementById('personMaskControls').classList.toggle('hidden', !personToggle.checked);
      if (!personToggle.checked) {
        personMaskStatus('Upload a video, then enable to place lyrics behind people. Processing stays on this device.');
        return;
      }
      personMaskStatus('Loading local person masking model...');
      try {
        await foreground.init();
        if (state.lyricsBehindPerson) personMaskStatus('Ready. Upload a background video with a person.');
      } catch (error) { disablePersonMask(error); }
    });
    document.getElementById('personMaskFeatherSlider').addEventListener('input', (event) => {
      state.personMaskFeather = Number(event.target.value);
      document.getElementById('personMaskFeatherVal').textContent = `${state.personMaskFeather}px`;
    });
    // Panel Tabs Switching
    document.querySelectorAll('.panel-tabs').forEach((tabGroup) => {
      const buttons = tabGroup.querySelectorAll('.tab-btn');
      const parentPanel = tabGroup.parentElement;
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          buttons.forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          parentPanel.querySelectorAll('.tab-content').forEach((tc) => tc.classList.remove('active'));
          const target = document.getElementById(btn.dataset.tab);
          if (target) target.classList.add('active');
        });
      });
    });

    // Quick switch to Lyrics & Sync Tab
    document.getElementById('switchToSyncTabBtn').addEventListener('click', () => {
      const syncTabBtn = document.querySelector('[data-tab="tab-lyrics"]');
      if (syncTabBtn) syncTabBtn.click();
    });

    // Aspect Ratio Switcher
    document.querySelectorAll('.aspect-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.aspect-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.aspect = btn.dataset.aspect;
        if (state.aspect === '9:16') {
          state.canvasWidth = 1080;
          state.canvasHeight = 1920;
        } else if (state.aspect === '1:1') {
          state.canvasWidth = 1080;
          state.canvasHeight = 1080;
        } else {
          state.canvasWidth = 1920;
          state.canvasHeight = 1080;
        }
        canvas.width = state.canvasWidth;
        canvas.height = state.canvasHeight;
      });
    });

    // Safe Zone Toggle
    document.getElementById('safeZoneToggle').addEventListener('change', (e) => {
      state.showSafeZone = e.target.checked;
    });

    // Load Demo Button
    document.getElementById('loadDemoBtn').addEventListener('click', () => {
      loadDemoProject();
    });

    // Audio File Upload (Click & Drag-and-Drop)
    const audioInput = document.getElementById('audioInput');
    const audioDropzone = document.getElementById('audioDropzone');

    async function handleAudioFile(file) {
      if (!file) return;
      state.audioBlob = file;
      const extMatch = file.name.match(/\.([a-z0-9]+)$/i);
      state.audioExt = extMatch ? extMatch[1].toLowerCase() : 'mp3';
      const url = URL.createObjectURL(file);
      audioEl.src = url;
      audioEl.load();

      document.getElementById('audioFileName').textContent = file.name;
      const badge = document.getElementById('audioStatusBadge');
      badge.textContent = 'Loaded';
      badge.classList.add('loaded');

      // Auto-populate song title from filename if empty
      const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');
      state.songTitle = cleanName;
      document.getElementById('songTitleInput').value = cleanName;

      audioEl.onloadedmetadata = () => {
        state.duration = audioEl.duration || 30;
        state.trimStart = 0;
        state.trimEnd = +state.duration.toFixed(1);
        document.getElementById('trimStartInput').value = '0';
        document.getElementById('trimEndInput').value = state.trimEnd;
        document.getElementById('durationLabel').textContent = formatShortTime(state.duration);
      };

      const arrayBuf = await file.arrayBuffer();
      await extractWaveformPeaks(arrayBuf);
    }

    audioInput.addEventListener('change', (e) => handleAudioFile(e.target.files[0]));
    setupDragDrop(audioDropzone, (files) => handleAudioFile(files[0]));

    // Lyrics File Upload (.SRT, .LRC, .VTT, .TXT)
    const lyricsInput = document.getElementById('lyricsInput');
    const lyricsDropzone = document.getElementById('lyricsDropzone');

    async function handleLyricsFile(file) {
      if (!file) return;
      const rawText = await file.text();
      const parsed = parseLyricsUniversal(rawText, state.duration);
      state.lyrics = parsed;

      document.getElementById('lyricsFileName').textContent = `${file.name} (${parsed.length} lines)`;
      const badge = document.getElementById('lyricsStatusBadge');
      badge.textContent = `${parsed.length} lines`;
      badge.classList.add('loaded');

      renderLyricsListUI();
    }

    lyricsInput.addEventListener('change', (e) => handleLyricsFile(e.target.files[0]));
    setupDragDrop(lyricsDropzone, (files) => handleLyricsFile(files[0]));

    // Background Video or Multiple Images Upload
    const bgInput = document.getElementById('bgInput');
    const bgDropzone = document.getElementById('bgDropzone');
    const bgMediaList = document.getElementById('bgMediaList');
    const clearBgBtn = document.getElementById('clearBgBtn');

    function handleBgFiles(fileList) {
      if (!fileList || fileList.length === 0) return;
      foreground.reset();
      const files = Array.from(fileList);
      const videoFile = files.find((f) => f.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(f.name));

      bgMediaList.innerHTML = '';

      if (videoFile) {
        if (state.bgVideo) {
          state.bgVideo.pause();
          state.bgVideo.removeAttribute('src');
          state.bgVideo.remove();
        }
        releaseExportVideoFrame();
        const vid = document.createElement('video');
        vid.src = URL.createObjectURL(videoFile);
        vid.muted = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.preload = 'auto';
        vid.setAttribute('playsinline', '');
        vid.style.cssText = 'position:fixed;left:0;bottom:0;width:8px;height:8px;opacity:0;pointer-events:none;';
        document.body.appendChild(vid);
        vid.load();
        if (state.isPlaying) vid.play().catch(() => {});

        state.bgVideo = vid;
        state.bgVideoFile = videoFile;
        state.bgType = 'video';

        document.getElementById('bgFileName').textContent = videoFile.name;
        const badge = document.getElementById('bgStatusBadge');
        badge.textContent = 'Video BG';
        badge.classList.add('loaded');
        bgMediaList.classList.add('hidden');
        clearBgBtn.classList.remove('hidden');
      } else {
        // One or Multiple Images
        const imageFiles = files.filter((f) => f.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name));
        if (imageFiles.length === 0) return;

        state.bgImages = [];
        state.currentSlideIndex = 0;
        bgMediaList.classList.remove('hidden');

        imageFiles.forEach((imgFile) => {
          const url = URL.createObjectURL(imgFile);
          const img = new Image();
          img.src = url;
          state.bgImages.push(img);

          const thumb = document.createElement('img');
          thumb.src = url;
          thumb.className = 'media-thumb-item';
          bgMediaList.appendChild(thumb);
        });

        state.bgType = 'images';
        document.getElementById('bgFileName').textContent =
          imageFiles.length === 1 ? imageFiles[0].name : `${imageFiles.length} Images Slideshow`;
        const badge = document.getElementById('bgStatusBadge');
        badge.textContent = `${imageFiles.length} Image(s)`;
        badge.classList.add('loaded');
        clearBgBtn.classList.remove('hidden');
      }
    }

    bgInput.addEventListener('change', (e) => handleBgFiles(e.target.files));
    setupDragDrop(bgDropzone, (files) => handleBgFiles(files));

    clearBgBtn.addEventListener('click', () => {
      if (state.bgVideo) {
        state.bgVideo.pause();
        state.bgVideo.removeAttribute('src');
        state.bgVideo.remove();
      }
      releaseExportVideoFrame();
      state.bgVideo = null;
      state.bgVideoFile = null;
      state.bgImages = [];
      state.bgType = 'procedural';
      bgMediaList.innerHTML = '';
      bgMediaList.classList.add('hidden');
      clearBgBtn.classList.add('hidden');
      document.getElementById('bgFileName').textContent = 'Upload Video or Multiple Images';
      const badge = document.getElementById('bgStatusBadge');
      badge.textContent = 'Procedural BG';
      badge.classList.remove('loaded');
    });

    // Procedural Background Theme Picker
    document.querySelectorAll('#bgThemeGrid .chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#bgThemeGrid .chip-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.bgTheme = btn.dataset.bgTheme;
      });
    });

    // Trim Range Inputs
    const trimStartIn = document.getElementById('trimStartInput');
    const trimEndIn = document.getElementById('trimEndInput');
    trimStartIn.addEventListener('change', () => {
      state.trimStart = Math.max(0, parseFloat(trimStartIn.value) || 0);
    });
    trimEndIn.addEventListener('change', () => {
      state.trimEnd = Math.max(state.trimStart + 1, parseFloat(trimEndIn.value) || state.duration);
    });
    document.getElementById('resetTrimBtn').addEventListener('click', () => {
      state.trimStart = 0;
      state.trimEnd = +state.duration.toFixed(1);
      trimStartIn.value = 0;
      trimEndIn.value = state.trimEnd;
    });

    // Paste Lyrics Modal
    const pasteModal = document.getElementById('pasteLyricsModal');
    const rawLyricsTextarea = document.getElementById('rawLyricsTextarea');
    document.getElementById('openPasteModalBtn').addEventListener('click', () => {
      if (state.lyrics.length > 0 && !rawLyricsTextarea.value.trim()) {
        rawLyricsTextarea.value = state.lyrics
          .map((l, i) => `${i + 1}\n${formatSrtTimestamp(l.start)} --> ${formatSrtTimestamp(l.end)}\n${l.text}`)
          .join('\n\n');
      }
      pasteModal.classList.remove('hidden');
    });
    document.getElementById('closePasteModalBtn').addEventListener('click', () => pasteModal.classList.add('hidden'));
    document.getElementById('cancelPasteBtn').addEventListener('click', () => pasteModal.classList.add('hidden'));
    document.getElementById('applyPasteBtn').addEventListener('click', () => {
      const parsed = parseLyricsUniversal(rawLyricsTextarea.value, state.duration);
      if (parsed.length > 0) {
        state.lyrics = parsed;
        document.getElementById('lyricsFileName').textContent = `Custom Lyrics (${parsed.length} lines)`;
        const badge = document.getElementById('lyricsStatusBadge');
        badge.textContent = `${parsed.length} lines`;
        badge.classList.add('loaded');
        renderLyricsListUI();
      }
      pasteModal.classList.add('hidden');
    });

    // Global Lyric Offset Controls
    const offsetSlider = document.getElementById('lyricOffsetSlider');
    const offsetLabel = document.getElementById('offsetValueLabel');
    function updateOffset(val) {
      state.globalOffset = +Math.max(-5, Math.min(5, val)).toFixed(2);
      offsetSlider.value = state.globalOffset;
      offsetLabel.textContent = (state.globalOffset >= 0 ? '+' : '') + state.globalOffset.toFixed(2) + 's';
    }
    offsetSlider.addEventListener('input', () => updateOffset(parseFloat(offsetSlider.value)));
    document.getElementById('offsetMinusBtn').addEventListener('click', () => updateOffset(state.globalOffset - 0.1));
    document.getElementById('offsetPlusBtn').addEventListener('click', () => updateOffset(state.globalOffset + 0.1));
    document.getElementById('offsetResetBtn').addEventListener('click', () => updateOffset(0));

    // Tap-to-Sync & Lyric Toolbar Actions
    document.getElementById('tapSyncBtn').addEventListener('click', () => {
      stampLyricAtIndex(state.tapSyncCursor);
    });

    document.getElementById('addLyricLineBtn').addEventListener('click', () => {
      const lastEnd = state.lyrics.length > 0 ? state.lyrics[state.lyrics.length - 1].end : state.currentTime;
      const start = +lastEnd.toFixed(2);
      const end = +(start + 2.5).toFixed(2);
      const text = 'New lyric line...';
      state.lyrics.push({
        id: 'lyr_' + Math.random().toString(36).slice(2, 9),
        start,
        end,
        text,
        words: buildWordTimings(text, start, end),
      });
      renderLyricsListUI();
    });

    document.getElementById('autoDistributeBtn').addEventListener('click', () => {
      if (state.lyrics.length === 0) return;
      const slot = state.duration / state.lyrics.length;
      state.lyrics.forEach((lyr, i) => {
        lyr.start = +(i * slot).toFixed(2);
        lyr.end = +Math.max(lyr.start + 0.4, (i + 1) * slot - 0.12).toFixed(2);
        refreshLyricWords(lyr);
      });
      renderLyricsListUI();
    });

    document.getElementById('exportSrtBtn').addEventListener('click', () => {
      if (state.lyrics.length === 0) return;
      const srtContent = state.lyrics
        .map((l, idx) => {
          const s = Math.max(0, l.start + state.globalOffset);
          const e = Math.max(s + 0.2, l.end + state.globalOffset);
          return `${idx + 1}\n${formatSrtTimestamp(s)} --> ${formatSrtTimestamp(e)}\n${l.text}`;
        })
        .join('\n\n');
      const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(state.songTitle || 'synced_lyrics').toLowerCase().replace(/\s+/g, '_')}.srt`;
      a.click();
    });

    document.getElementById('randomizeStyleSectionBtn').addEventListener('click', () => {
      const effectiveTime = state.currentTime - state.globalOffset;
      const { activeIdx, nextIdx } = findActiveLyricInfo(effectiveTime);
      const slot = activeIdx !== -1 ? activeIdx : nextIdx !== -1 ? nextIdx : 0;
      selectLyricPreset(pickBeatMatchedStyle(slot, effectiveTime));
    });

    // Typography & Colors
    document.getElementById('fontFamilySelect').addEventListener('change', (e) => {
      state.fontFamily = e.target.value;
    });
    const fontSizeSlider = document.getElementById('fontSizeSlider');
    const fontSizeInput = document.getElementById('fontSizeInput');
    function setFontSize(value) {
      const size = Number(value);
      if (!Number.isFinite(size)) return;
      state.fontSize = Math.max(Number(fontSizeSlider.min), Math.min(Number(fontSizeSlider.max), Math.round(size)));
      fontSizeSlider.value = state.fontSize;
      fontSizeInput.value = state.fontSize;
      document.getElementById('fontSizeVal').textContent = `${state.fontSize}px`;
    }
    fontSizeSlider.addEventListener('input', () => {
      setFontSize(fontSizeSlider.value);
    });
    fontSizeInput.addEventListener('input', () => {
      // Allow an unfinished number while typing; normalize it on commit.
      if (fontSizeInput.validity.valid && fontSizeInput.value !== '') {
        setFontSize(fontSizeInput.value);
      }
    });
    fontSizeInput.addEventListener('change', () => {
      setFontSize(fontSizeInput.value === '' ? state.fontSize : fontSizeInput.value);
    });

    document.querySelectorAll('[data-case]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-case]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.textCase = btn.dataset.case;
      });
    });

    document.getElementById('primaryColorPicker').addEventListener('input', (e) => (state.primaryColor = e.target.value));
    document.getElementById('activeColorPicker').addEventListener('input', (e) => (state.activeColor = e.target.value));
    document.getElementById('glowColorPicker').addEventListener('input', (e) => (state.glowColor = e.target.value));

    const glowSlider = document.getElementById('glowStrengthSlider');
    glowSlider.addEventListener('input', () => {
      state.glowStrength = parseInt(glowSlider.value, 10);
      document.getElementById('glowStrengthVal').textContent = state.glowStrength;
    });

    const strokeSlider = document.getElementById('strokeWidthSlider');
    strokeSlider.addEventListener('input', () => {
      state.strokeWidth = parseInt(strokeSlider.value, 10);
      document.getElementById('strokeWidthVal').textContent = `${state.strokeWidth}px`;
    });

    const posYSlider = document.getElementById('posYSlider');
    posYSlider.addEventListener('input', () => {
      state.posY = parseInt(posYSlider.value, 10) / 100;
    });
    document.getElementById('centerPosBtn').addEventListener('click', () => {
      state.posX = 0.5;
      state.posY = 0.5;
      posYSlider.value = 50;
    });

    // Direct Canvas Dragging to reposition lyrics
    let isDraggingCanvas = false;
    canvas.addEventListener('pointerdown', (e) => {
      isDraggingCanvas = true;
      updateCanvasPosFromPointer(e);
    });
    window.addEventListener('pointermove', (e) => {
      if (isDraggingCanvas) updateCanvasPosFromPointer(e);
    });
    window.addEventListener('pointerup', () => {
      isDraggingCanvas = false;
    });

    function updateCanvasPosFromPointer(e) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      state.posX = Math.max(0.15, Math.min(0.85, (e.clientX - rect.left) / rect.width));
      state.posY = Math.max(0.12, Math.min(0.88, (e.clientY - rect.top) / rect.height));
      posYSlider.value = Math.round(state.posY * 100);
    }

    // Audio Visualizer & Particles Controls
    document.querySelectorAll('#spectrumModeGrid .chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#spectrumModeGrid .chip-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.spectrumMode = btn.dataset.spectrum;
      });
    });

    const reactSlider = document.getElementById('reactivitySlider');
    reactSlider.addEventListener('input', () => {
      state.reactivity = parseFloat(reactSlider.value);
      document.getElementById('reactivityVal').textContent = `${state.reactivity.toFixed(1)}x`;
    });

    document.querySelectorAll('#particleModeGrid .chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#particleModeGrid .chip-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.particleMode = btn.dataset.particles;
      });
    });

    const pCountSlider = document.getElementById('particleCountSlider');
    pCountSlider.addEventListener('input', () => {
      state.particleCount = parseInt(pCountSlider.value, 10);
      document.getElementById('particleCountVal').textContent = state.particleCount;
    });

    document.getElementById('songTitleInput').addEventListener('input', (e) => (state.songTitle = e.target.value));
    document.getElementById('songArtistInput').addEventListener('input', (e) => (state.songArtist = e.target.value));

    // BG & Camera FX Controls
    const bassShakeSlider = document.getElementById('bassShakeSlider');
    bassShakeSlider.addEventListener('input', () => {
      state.bassShake = parseInt(bassShakeSlider.value, 10);
      document.getElementById('bassShakeVal').textContent = `${state.bassShake}%`;
    });

    const bgDimSlider = document.getElementById('bgDimSlider');
    bgDimSlider.addEventListener('input', () => {
      state.bgDim = parseInt(bgDimSlider.value, 10);
      document.getElementById('bgDimVal').textContent = `${state.bgDim}%`;
    });

    const bgBlurSlider = document.getElementById('bgBlurSlider');
    bgBlurSlider.addEventListener('input', () => {
      state.bgBlur = parseInt(bgBlurSlider.value, 10);
      document.getElementById('bgBlurVal').textContent = `${state.bgBlur}px`;
    });

    const vignetteSlider = document.getElementById('vignetteSlider');
    vignetteSlider.addEventListener('input', () => {
      state.vignette = parseInt(vignetteSlider.value, 10);
      document.getElementById('vignetteVal').textContent = `${state.vignette}%`;
    });

    document.querySelectorAll('[data-fit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-fit]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.bgFit = btn.dataset.fit;
      });
    });

    const slideDurSlider = document.getElementById('slideDurationSlider');
    slideDurSlider.addEventListener('input', () => {
      state.slideDuration = parseFloat(slideDurSlider.value);
      document.getElementById('slideDurationVal').textContent = `${state.slideDuration.toFixed(1)}s`;
    });

    document.getElementById('kenBurnsToggle').addEventListener('change', (e) => (state.kenBurns = e.target.checked));
    document.getElementById('beatSlideToggle').addEventListener('change', (e) => (state.beatSlide = e.target.checked));

    // Transport Controls & Timeline Scrubbing
    document.getElementById('playPauseBtn').addEventListener('click', togglePlayPause);
    document.getElementById('restartBtn').addEventListener('click', () => seekTo(0));

    const volSlider = document.getElementById('volumeSlider');
    let isSpeakerMuted = false;
    volSlider.addEventListener('input', () => {
      const v = parseFloat(volSlider.value);
      if (gainNode && !isSpeakerMuted) {
        gainNode.gain.value = v;
      } else if (!gainNode) {
        audioEl.volume = v;
      }
    });

    document.getElementById('muteToggleBtn').addEventListener('click', () => {
      isSpeakerMuted = !isSpeakerMuted;
      if (gainNode) {
        gainNode.gain.value = isSpeakerMuted ? 0 : parseFloat(volSlider.value);
      } else {
        audioEl.muted = isSpeakerMuted;
      }
      document.getElementById('muteToggleBtn').textContent = isSpeakerMuted ? '🔇' : '🔊';
    });

    let isScrubbing = false;
    const timelineWrapper = document.getElementById('timelineWrapper');
    function scrubFromEvent(e) {
      const rect = timelineWrapper.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      seekTo(ratio * state.duration);
    }
    timelineWrapper.addEventListener('pointerdown', (e) => {
      isScrubbing = true;
      scrubFromEvent(e);
    });
    window.addEventListener('pointermove', (e) => {
      if (isScrubbing) scrubFromEvent(e);
    });
    window.addEventListener('pointerup', () => {
      isScrubbing = false;
    });

    // Global Window Drag-and-Drop: Drop Song + SRT + Video/Images all at once!
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      const dropped = Array.from(e.dataTransfer.files);
      const bgBatch = [];
      dropped.forEach((f) => {
        const name = f.name.toLowerCase();
        if (f.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(name)) {
          handleAudioFile(f);
        } else if (/\.(srt|lrc|vtt|txt)$/i.test(name)) {
          handleLyricsFile(f);
        } else if (
          f.type.startsWith('video/') ||
          f.type.startsWith('image/') ||
          /\.(mp4|webm|mov|jpg|jpeg|png|webp|gif)$/i.test(name)
        ) {
          bgBatch.push(f);
        }
      });
      if (bgBatch.length > 0) {
        handleBgFiles(bgBatch);
      }
    });

    // Keyboard Shortcuts (Space = Play/Pause, M = Stamp Next Lyric Line)
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (e.defaultPrevented || e.target.closest('[role="combobox"]') || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        stampLyricAtIndex(state.tapSyncCursor);
      }
    });

    // Video Export Modal Actions
    document.getElementById('exportVideoBtn').addEventListener('click', startVideoExport);
    document.getElementById('stopSaveEarlyBtn').addEventListener('click', () => finishVideoExport(false));
    document.getElementById('cancelExportBtn').addEventListener('click', () => finishVideoExport(true));
  }

  function setupDragDrop(dropzoneEl, onFilesCallback) {
    ['dragenter', 'dragover'].forEach((evt) => {
      dropzoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach((evt) => {
      dropzoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.remove('dragover');
      });
    });
    dropzoneEl.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        onFilesCallback(e.dataTransfer.files);
      }
    });
  }

  // =========================================================================
  // 15B. CURATED LYRIC ANIMATIONS (Search + Motion Filter)
  // =========================================================================
  function buildStylePresetGrid() {
    const grid = document.getElementById('lyricStyleGrid');
    grid.replaceChildren();
    STYLE_PRESETS.forEach((preset) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset-card';
      button.dataset.style = preset.id;
      button.dataset.tier = preset.tier;
      button.innerHTML = `<span class="preset-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${preset.icon}"/></svg></span><span class="preset-name"></span><span class="preset-desc"></span>`;
      button.querySelector('.preset-name').textContent = preset.name;
      button.querySelector('.preset-desc').textContent = preset.desc;
      button.addEventListener('click', () => selectLyricPreset(preset.id));
      grid.append(button);
    });
    selectLyricPreset(state.lyricStyle);

    const search = document.getElementById('presetSearchInput');
    const chips = Array.from(document.querySelectorAll('#presetTierChips [data-tier]'));
    const labels = { all: 'All', new: 'New', chill: 'Minimal', melodic: 'Smooth', upbeat: 'Word timing', drop: 'Bold' };
    let activeTier = 'all';
    function filter() {
      const query = search.value.trim().toLowerCase();
      let visible = 0;
      grid.querySelectorAll('.preset-card').forEach((card) => {
        const preset = getStyleMeta(card.dataset.style);
        const matches = (activeTier === 'all' || (activeTier === 'new' ? preset.isNew : preset.tier === activeTier))
          && `${preset.name} ${preset.desc}`.toLowerCase().includes(query);
        card.hidden = !matches;
        if (matches) visible++;
      });
      document.getElementById('presetEmptyMessage').hidden = visible > 0;
    }
    chips.forEach((chip) => {
      const tier = chip.dataset.tier;
      const count = tier === 'all' ? STYLE_PRESETS.length
        : STYLE_PRESETS.filter((preset) => tier === 'new' ? preset.isNew : preset.tier === tier).length;
      chip.textContent = `${labels[tier]} (${count})`;
      chip.addEventListener('click', () => {
        activeTier = tier;
        chips.forEach((item) => {
          const active = item === chip;
          item.classList.toggle('active', active);
          item.setAttribute('aria-pressed', String(active));
        });
        filter();
      });
    });
    search.addEventListener('input', filter);
    filter();
  }

  function setupDragDrop(dropzoneEl, onFilesCallback) {
    ['dragenter', 'dragover'].forEach((evt) => {
      dropzoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach((evt) => {
      dropzoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.remove('dragover');
      });
    });
    dropzoneEl.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        onFilesCallback(e.dataTransfer.files);
      }
    });
  }

  // =========================================================================
  // 16. INITIALIZE STUDIO
  // =========================================================================
  initParticles();
  buildStylePresetGrid();
  bindUIEvents();
  loadDemoProject();
  requestAnimationFrame(mainRenderLoop);
})();
