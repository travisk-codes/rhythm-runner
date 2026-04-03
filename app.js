(() => {
  // --- Config ---
  const HIT_LINE_PERCENT = 0.12;
  const HIT_WINDOW_MS = 120;    // +/- ms for a "hit"
  const GOOD_WINDOW_MS = 80;
  const GREAT_WINDOW_MS = 40;
  const PERFECT_WINDOW_MS = 15;
  const TRAVEL_TIME_MS = 2000;   // time for a beat to cross the full track
  const BEAT_SIZE = 28;

  const AVERAGE_WINDOWS = [
    { label: '5s', ms: 5000 },
    { label: '10s', ms: 10000 },
    { label: '30s', ms: 30000 },
    { label: '1m', ms: 60000 },
    { label: '2m', ms: 120000 },
    { label: '5m', ms: 300000 },
    { label: '10m', ms: 600000 },
    { label: '30m', ms: 1800000 },
  ];

  // --- State ---
  let running = false;
  let bpm = 120;
  let beats = [];           // active beat objects { id, spawnTime, targetTime, element, hit, missed }
  let timingRecords = [];   // { timestamp, offsetMs } - positive = late, negative = early
  let totalHits = 0;
  let totalMisses = 0;
  let beatIdCounter = 0;
  let nextBeatTime = 0;
  let animFrameId = null;
  let audioCtx = null;

  // --- DOM ---
  const track = document.getElementById('track');
  const feedback = document.getElementById('feedback');
  const averagesEl = document.getElementById('averages');
  const hitsCountEl = document.getElementById('hits-count');
  const missesCountEl = document.getElementById('misses-count');
  const accuracyEl = document.getElementById('accuracy');
  const bpmInput = document.getElementById('bpm');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const midiStatus = document.getElementById('midi-status');

  // --- Init average cards ---
  const avgCards = {};
  AVERAGE_WINDOWS.forEach(w => {
    const card = document.createElement('div');
    card.className = 'avg-card';
    card.innerHTML = `
      <div class="label">${w.label}</div>
      <div class="value no-data">--</div>
      <div class="direction"></div>
    `;
    averagesEl.appendChild(card);
    avgCards[w.label] = {
      el: card,
      valueEl: card.querySelector('.value'),
      dirEl: card.querySelector('.direction'),
    };
  });

  // --- Audio ---
  function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playHitSound(quality) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (quality === 'perfect') {
      osc.frequency.value = 880;
    } else if (quality === 'great') {
      osc.frequency.value = 660;
    } else {
      osc.frequency.value = 520;
    }

    osc.type = 'sine';
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  }

  function playMissSound() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 200;
    osc.type = 'sawtooth';
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
  }

  // --- Beat management ---
  function spawnBeat(targetTime) {
    const el = document.createElement('div');
    el.className = 'beat';
    track.appendChild(el);

    const beat = {
      id: ++beatIdCounter,
      spawnTime: targetTime - TRAVEL_TIME_MS,
      targetTime,
      element: el,
      hit: false,
      missed: false,
    };
    beats.push(beat);
  }

  function updateBeats(now) {
    const trackWidth = track.offsetWidth;

    beats.forEach(beat => {
      if (beat.hit || beat.missed) return;

      const elapsed = now - beat.spawnTime;
      const progress = elapsed / TRAVEL_TIME_MS;

      // Beat travels from right (100%) to hit line position, then continues left
      // At progress=0, beat is at right edge. At progress=1, beat is at hit line.
      // After progress=1, beat continues past the hit line.
      const totalTravel = 1.0; // normalized full track
      const hitLinePos = HIT_LINE_PERCENT;

      // Map: progress 0 -> position 1.0 (right edge), progress 1.0 -> position hitLinePos
      const position = 1.0 - (progress * (1.0 - hitLinePos));

      const pixelX = position * trackWidth - BEAT_SIZE / 2;
      beat.element.style.left = pixelX + 'px';

      // Check if beat has passed the hit window
      if (now > beat.targetTime + HIT_WINDOW_MS) {
        beat.missed = true;
        beat.element.classList.add('missed');
        totalMisses++;
        showFeedback('MISS', 'miss');
        playMissSound();
        updateSessionStats();

        // Remove after a moment
        setTimeout(() => {
          beat.element.remove();
        }, 300);
      }
    });

    // Clean up old beats
    beats = beats.filter(b => {
      if ((b.hit || b.missed) && !document.contains(b.element)) return false;
      return true;
    });
  }

  // --- Hit detection ---
  function attemptHit() {
    if (!running) return;

    const now = performance.now();
    let closestBeat = null;
    let closestOffset = Infinity;

    beats.forEach(beat => {
      if (beat.hit || beat.missed) return;
      const offset = now - beat.targetTime;
      if (Math.abs(offset) < Math.abs(closestOffset) && Math.abs(offset) <= HIT_WINDOW_MS) {
        closestBeat = beat;
        closestOffset = offset;
      }
    });

    if (closestBeat) {
      closestBeat.hit = true;
      closestBeat.element.classList.add('hit');
      totalHits++;

      const absOffset = Math.abs(closestOffset);
      let quality, cssClass;
      if (absOffset <= PERFECT_WINDOW_MS) {
        quality = 'perfect';
        cssClass = 'perfect';
      } else if (absOffset <= GREAT_WINDOW_MS) {
        quality = 'great';
        cssClass = 'great';
      } else {
        quality = 'good';
        cssClass = 'good';
      }

      const direction = closestOffset < -2 ? 'early' : closestOffset > 2 ? 'late' : '';
      const dirText = direction ? ` (${Math.round(absOffset)}ms ${direction})` : '';
      showFeedback(`${quality.toUpperCase()}${dirText}`, cssClass);
      playHitSound(quality);
      flashScreen('hit');

      timingRecords.push({ timestamp: Date.now(), offsetMs: closestOffset });

      setTimeout(() => {
        closestBeat.element.remove();
      }, 300);

      updateSessionStats();
      updateAverages();
    }
  }

  // --- Feedback ---
  function showFeedback(text, cssClass) {
    feedback.textContent = text;
    feedback.className = `show ${cssClass}`;

    // Force reflow for animation restart
    void feedback.offsetWidth;
    feedback.className = `show ${cssClass}`;
  }

  function flashScreen(type) {
    track.classList.remove('screen-flash-hit', 'screen-flash-miss');
    void track.offsetWidth;
    track.classList.add(type === 'hit' ? 'screen-flash-hit' : 'screen-flash-miss');
  }

  // --- Stats ---
  function updateSessionStats() {
    hitsCountEl.textContent = `Hits: ${totalHits}`;
    missesCountEl.textContent = `Misses: ${totalMisses}`;
    const total = totalHits + totalMisses;
    const pct = total > 0 ? Math.round((totalHits / total) * 100) : 0;
    accuracyEl.textContent = `Accuracy: ${total > 0 ? pct + '%' : '--%'}`;
  }

  function updateAverages() {
    const now = Date.now();

    AVERAGE_WINDOWS.forEach(w => {
      const card = avgCards[w.label];
      const cutoff = now - w.ms;
      const relevant = timingRecords.filter(r => r.timestamp >= cutoff);

      if (relevant.length === 0) {
        card.valueEl.textContent = '--';
        card.valueEl.className = 'value no-data';
        card.dirEl.textContent = '';
        card.dirEl.className = 'direction';
        return;
      }

      // Average signed offset
      const avgOffset = relevant.reduce((s, r) => s + r.offsetMs, 0) / relevant.length;
      // Average absolute offset
      const avgAbs = relevant.reduce((s, r) => s + Math.abs(r.offsetMs), 0) / relevant.length;

      card.valueEl.textContent = `${avgAbs.toFixed(1)}ms`;
      card.valueEl.className = 'value';

      if (Math.abs(avgOffset) < 3) {
        card.dirEl.textContent = 'on time';
        card.dirEl.className = 'direction on-time';
      } else if (avgOffset < 0) {
        card.dirEl.textContent = `${Math.abs(avgOffset).toFixed(1)}ms early`;
        card.dirEl.className = 'direction early';
      } else {
        card.dirEl.textContent = `${avgOffset.toFixed(1)}ms late`;
        card.dirEl.className = 'direction late';
      }
    });
  }

  // --- Game loop ---
  function gameLoop(timestamp) {
    if (!running) return;

    const now = performance.now();

    // Spawn beats on schedule
    while (nextBeatTime <= now + TRAVEL_TIME_MS) {
      spawnBeat(nextBeatTime);
      nextBeatTime += (60000 / bpm);
    }

    updateBeats(now);

    // Periodically update averages (every 500ms)
    if (!gameLoop._lastAvgUpdate || now - gameLoop._lastAvgUpdate > 500) {
      gameLoop._lastAvgUpdate = now;
      updateAverages();
    }

    animFrameId = requestAnimationFrame(gameLoop);
  }

  // --- Start / Stop ---
  function start() {
    if (running) return;
    initAudio();

    bpm = parseInt(bpmInput.value) || 120;
    bpm = Math.max(40, Math.min(300, bpm));
    bpmInput.value = bpm;

    running = true;
    beats = [];
    timingRecords = [];
    totalHits = 0;
    totalMisses = 0;
    beatIdCounter = 0;
    gameLoop._lastAvgUpdate = 0;

    // Clear track
    track.querySelectorAll('.beat').forEach(el => el.remove());

    updateSessionStats();
    updateAverages();

    // First beat arrives at hit line after TRAVEL_TIME_MS
    nextBeatTime = performance.now() + TRAVEL_TIME_MS;

    startBtn.disabled = true;
    stopBtn.disabled = false;
    bpmInput.disabled = true;

    animFrameId = requestAnimationFrame(gameLoop);
  }

  function stop() {
    running = false;
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    startBtn.disabled = false;
    stopBtn.disabled = true;
    bpmInput.disabled = false;
  }

  // --- Input handlers ---
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'KeyJ' || e.code === 'KeyK') {
      e.preventDefault();
      attemptHit();
    }
  });

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  // --- MIDI ---
  async function initMIDI() {
    if (!navigator.requestMIDIAccess) {
      midiStatus.textContent = 'MIDI: not supported';
      return;
    }

    try {
      const access = await navigator.requestMIDIAccess();

      function onMIDIMessage(event) {
        const [status, note, velocity] = event.data;
        // Note On (0x90) or Control Change with velocity > 0
        if ((status & 0xF0) === 0x90 && velocity > 0) {
          attemptHit();
        }
      }

      function connectInputs() {
        const inputs = Array.from(access.inputs.values());
        if (inputs.length > 0) {
          midiStatus.textContent = `MIDI: ${inputs.length} device${inputs.length > 1 ? 's' : ''}`;
          midiStatus.classList.add('connected');
        } else {
          midiStatus.textContent = 'MIDI: no devices';
          midiStatus.classList.remove('connected');
        }

        inputs.forEach(input => {
          input.onmidimessage = onMIDIMessage;
        });
      }

      access.onstatechange = () => connectInputs();
      connectInputs();
    } catch (err) {
      midiStatus.textContent = 'MIDI: access denied';
    }
  }

  initMIDI();
})();
