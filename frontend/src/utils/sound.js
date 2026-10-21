// UI sound effects synthesised with the Web Audio API - no audio files to load.
// The mute preference is kept in localStorage and exposed as a tiny store so
// React components can subscribe with useSyncExternalStore.

const STORAGE_KEY = 'sound-muted';
const listeners = new Set();
let ctx;

// Each sound is a list of [frequency Hz, start offset s, duration s]
const SOUNDS = {
  add: [[660, 0, 0.08], [880, 0.08, 0.12]],
  wishlist: [[740, 0, 0.1]],
  success: [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12], [1047, 0.36, 0.25]],
  error: [[220, 0, 0.15], [180, 0.15, 0.2]],
  click: [[1200, 0, 0.03]],
};

function readMuted() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

let muted = readMuted();

export const soundStore = {
  subscribe: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  isMuted: () => muted,
  setMuted: (value) => {
    muted = value;
    try {
      localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      /* storage unavailable - keep the in-memory value */
    }
    listeners.forEach((fn) => fn());
  },
};

export function playSound(name) {
  const notes = SOUNDS[name];
  if (muted || !notes) return;
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    for (const [freq, offset, duration] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = name === 'error' ? 'square' : 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.15, now + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + duration + 0.02);
    }
  } catch {
    /* audio not supported - stay silent */
  }
}
