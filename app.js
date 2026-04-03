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

  // Subdivision multipliers relative to quarter note
  const SUBDIVISIONS = [
    { id: 'half', multiplier: 2 },
    { id: 'quarter', multiplier: 1 },
    { id: 'eighth', multiplier: 0.5 },
    { id: 'sixteenth', multiplier: 0.25 },
  ];

  // --- State ---
  let running = false;
  let bpm = 120;
  let beats = [];           // active beat objects { id, spawnTime, targetTime, element, hit, missed, clicked }
  let timingRecords = [];   // { timestamp, offsetMs } - positive = late, negative = early
  let totalHits = 0;
  let totalMisses = 0;
  let beatIdCounter = 0;
  let nextSlotTime = 0;     // next 16th-note slot time
  let slotIndex = 0;        // which 16th-note slot we're on (0-based)
  let nextMetronomeTime = 0; // next quarter-note metronome tick
  let animFrameId = null;
  let audioCtx = null;
  let subdivisionFreqs = { half: 0, quarter: 100, eighth: 0, sixteenth: 0 };

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
  const resetBtn = document.getElementById('reset-btn');
  const midiStatus = document.getElementById('midi-status');

  // Subdivision sliders
  const freqSliders = {};
  SUBDIVISIONS.forEach(sub => {
    const slider = document.getElementById(`freq-${sub.id}`);
    const valSpan = document.querySelector(`.freq-val[data-for="freq-${sub.id}"]`);
    freqSliders[sub.id] = { slider, valSpan };
    slider.addEventListener('input', () => {
      subdivisionFreqs[sub.id] = parseInt(slider.value);
      valSpan.textContent = slider.value + '%';
    });
  });

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

  // Schedule the steady BPM metronome click (plays every quarter note, independent of hit beats)
  function scheduleMetronomeTick(targetTime) {
    if (!audioCtx) return;
    const delay = (targetTime - performance.now()) / 1000;
    if (delay < 0) return;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 1000;
    osc.type = 'sine';
    const startAt = audioCtx.currentTime + delay;
    gain.gain.setValueAtTime(0.12, startAt);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.06);
    osc.start(startAt);
    osc.stop(startAt + 0.06);
  }

  // --- Beat management ---
  // Determine which subdivisions land on a given 16th-note slot index
  function shouldSpawnAtSlot(slot) {
    // slot is 0-based index of 16th notes within the measure
    // 16th: every slot, 8th: every 2, quarter: every 4, half: every 8
    const candidates = [];
    if (slot % 8 === 0 && subdivisionFreqs.half > 0) {
      if (Math.random() * 100 < subdivisionFreqs.half) candidates.push('half');
    }
    if (slot % 4 === 0 && subdivisionFreqs.quarter > 0) {
      if (Math.random() * 100 < subdivisionFreqs.quarter) candidates.push('quarter');
    }
    if (slot % 2 === 0 && subdivisionFreqs.eighth > 0) {
      // Don't double-spawn if already covered by quarter
      if (!candidates.length && Math.random() * 100 < subdivisionFreqs.eighth) candidates.push('eighth');
    }
    if (subdivisionFreqs.sixteenth > 0) {
      if (!candidates.length && Math.random() * 100 < subdivisionFreqs.sixteenth) candidates.push('sixteenth');
    }
    return candidates;
  }

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
        if (running) {
          beat.element.classList.add('missed');
          totalMisses++;
          showFeedback('MISS', 'miss');

          updateSessionStats();
        }

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
    const now = performance.now();

    if (running) {
      const quarterMs = 60000 / bpm;
      const sixteenthMs = quarterMs / 4;

      // Schedule steady metronome ticks on every quarter note
      while (nextMetronomeTime <= now + TRAVEL_TIME_MS) {
        scheduleMetronomeTick(nextMetronomeTime);
        nextMetronomeTime += quarterMs;
      }

      // Spawn hittable beats on 16th-note grid + schedule their arrival clicks
      while (nextSlotTime <= now + TRAVEL_TIME_MS) {
        const subs = shouldSpawnAtSlot(slotIndex);
        if (subs.length > 0) {
          spawnBeat(nextSlotTime);

        }
        nextSlotTime += sixteenthMs;
        slotIndex++;
      }
    }

    // Always update beats (animate + play arrival clicks for beats already on screen)
    updateBeats(now);

    // Periodically update averages (every 500ms)
    if (!gameLoop._lastAvgUpdate || now - gameLoop._lastAvgUpdate > 500) {
      gameLoop._lastAvgUpdate = now;
      updateAverages();
    }

    // Keep looping as long as running or beats remain on screen
    if (running || beats.length > 0) {
      animFrameId = requestAnimationFrame(gameLoop);
    } else {
      animFrameId = null;
    }
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
    slotIndex = 0;
    gameLoop._lastAvgUpdate = 0;

    // Clear track
    track.querySelectorAll('.beat').forEach(el => el.remove());

    updateSessionStats();
    updateAverages();

    // First beat arrives at hit line after TRAVEL_TIME_MS
    nextSlotTime = performance.now() + TRAVEL_TIME_MS;
    // Metronome starts clicking immediately (not delayed by travel time)
    const quarterMs = 60000 / bpm;
    nextMetronomeTime = performance.now() + quarterMs;

    startBtn.disabled = true;
    stopBtn.disabled = false;
    bpmInput.disabled = true;

    animFrameId = requestAnimationFrame(gameLoop);
  }

  function stop() {
    running = false;
    // Don't cancel animFrame — let remaining on-screen beats continue animating and clicking

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

  function resetStats() {
    timingRecords = [];
    totalHits = 0;
    totalMisses = 0;
    updateSessionStats();
    updateAverages();
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  resetBtn.addEventListener('click', resetStats);

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
