import { describe, expect, it } from 'vitest';
import { AiClassificationSchema } from '@guardia/shared';
import { MockAiProvider } from './mock.provider';

const base = { localTime: '11-10-2026 14:00', transcription: null, userText: null, chosenCategory: null } as const;

describe('MockAiProvider', () => {
  const ai = new MockAiProvider();

  it('un SOS sin texto es HIGH / OTRO_EMERGENCIA con baja confianza', async () => {
    const r = await ai.classify({ ...base, type: 'EMERGENCY_SOS' });
    expect(AiClassificationSchema.safeParse(r).success).toBe(true);
    expect(r.priority).toBe('HIGH');
    expect(r.category).toBe('OTRO_EMERGENCIA');
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('detecta asalto con arma y sugiere Carabineros', async () => {
    const r = await ai.classify({ ...base, type: 'EMERGENCY_SOS', transcription: 'me están asaltando con una pistola' });
    expect(r.category).toBe('ROBO_ASALTO');
    expect(r.suggested_agency).toBe('CARABINEROS');
    expect(r.flags.weapon_mentioned).toBe(true);
  });

  it('nunca devuelve categoría urbana para un SOS', async () => {
    const r = await ai.classify({ ...base, type: 'EMERGENCY_SOS', userText: 'hay un bache' });
    expect(['ROBO_ASALTO', 'VIOLENCIA_AGRESION', 'INCENDIO', 'SALUD', 'ACCIDENTE_TRANSITO', 'SOSPECHOSO', 'OTRO_EMERGENCIA']).toContain(r.category);
  });

  it('respeta la categoría elegida en un reporte urbano sin palabras clave', async () => {
    const r = await ai.classify({ ...base, type: 'CIVIC_REPORT', userText: 'frente a mi casa', chosenCategory: 'LUMINARIA' });
    expect(r.category).toBe('LUMINARIA');
    expect(r.priority).toBe('LOW');
    expect(r.suggested_agency).toBe('OBRAS_ASEO');
  });
});
