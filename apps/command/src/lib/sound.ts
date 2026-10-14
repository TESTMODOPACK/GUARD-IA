'use client';

/**
 * Avisos sonoros cortos con Web Audio (sin archivos). Dos tonos distintos:
 * `sos` al entrar un SOS, `high` cuando la IA lo confirma como prioridad alta.
 * El navegador exige una interacción previa del usuario; si no la hubo, no suena.
 */
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function ping(kind: 'sos' | 'high' | 'panic') {
  const c = context();
  if (!c || c.state !== 'running') return;
  // Pánico de un funcionario de terreno (0012): sirena corta, distinta de un SOS.
  const notes = kind === 'sos' ? [880, 1174] : kind === 'panic' ? [988, 740, 988, 740, 988, 740] : [660, 660, 880];
  const t0 = c.currentTime;
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.16);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.16 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.14);
    osc.connect(gain).connect(c.destination);
    osc.start(t0 + i * 0.16);
    osc.stop(t0 + i * 0.16 + 0.15);
  });
}

/** Llamar en el primer click para que el navegador permita audio después. */
export function unlockAudio() {
  context();
}
