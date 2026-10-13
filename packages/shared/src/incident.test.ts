import { describe, expect, it } from 'vitest';
import { incidentImportance, type ImportanceInput } from './schemas/incident';

const civic = (o: Partial<ImportanceInput> = {}): ImportanceInput => ({
  type: 'CIVIC_REPORT',
  category: 'BACHE',
  maxPriority: 'LOW',
  citizenCount: 1,
  recurrenceCount: 0,
  weapon: false,
  injured: false,
  minor: false,
  possibleFalseAlarm: false,
  maxTrust: 100,
  ...o,
});
const sos = (o: Partial<ImportanceInput> = {}): ImportanceInput => civic({ type: 'EMERGENCY_SOS', category: null, maxPriority: null, ...o });

describe('incidentImportance', () => {
  it('un bache reportado una vez es de importancia baja', () => {
    expect(incidentImportance(civic())).toMatchObject({ score: 20, level: 'BAJA' });
  });

  it('sube con cada vecino distinto que confirma el problema', () => {
    expect(incidentImportance(civic({ citizenCount: 3 }))).toMatchObject({ score: 40, level: 'MEDIA' });
    const five = incidentImportance(civic({ citizenCount: 5 }));
    expect(five).toMatchObject({ score: 50, level: 'MEDIA' });
    expect(five.reasons).toContain('MANY_CITIZENS');
    // El aporte por vecinos tiene tope (+30): 20 vecinos no lo vuelven crítico solo.
    expect(incidentImportance(civic({ citizenCount: 20 })).score).toBe(50);
  });

  it('marca recurrencia cuando el problema vuelve después de resuelto', () => {
    const r = incidentImportance(civic({ recurrenceCount: 2, citizenCount: 2 }));
    expect(r.reasons).toEqual(expect.arrayContaining(['RECURRENT', 'MANY_CITIZENS']));
    expect(r).toMatchObject({ score: 50, level: 'MEDIA' });
    expect(incidentImportance(civic({ recurrenceCount: 2, citizenCount: 3 })).level).toBe('ALTA');
  });

  it('un semáforo es más importante que un bache', () => {
    expect(incidentImportance(civic({ category: 'SEMAFORO' })).level).toBe('MEDIA');
    expect(incidentImportance(civic({ category: 'SEMAFORO', maxPriority: 'HIGH', citizenCount: 4 }))).toMatchObject({ level: 'CRITICA' });
  });

  it('un mismo vecino de baja confianza no infla un reporte', () => {
    expect(incidentImportance(civic({ maxTrust: 20 })).score).toBe(10);
  });

  it('un SOS nunca baja de importancia media, aunque parezca falsa alarma', () => {
    const r = incidentImportance(sos({ maxPriority: 'LOW', possibleFalseAlarm: true, maxTrust: 10 }));
    expect(r.score).toBe(40);
    expect(r.level).toBe('MEDIA');
  });

  it('un SOS sin clasificar se trata como urgente', () => {
    expect(incidentImportance(sos())).toMatchObject({ score: 75, level: 'ALTA' });
    expect(incidentImportance(sos({ maxPriority: 'HIGH' })).level).toBe('CRITICA');
  });

  it('varios vecinos y señales de riesgo suben un SOS', () => {
    const r = incidentImportance(sos({ maxPriority: 'MEDIUM', citizenCount: 3, weapon: true }));
    expect(r.score).toBe(65 + 5 + 10 + 8);
    expect(r.reasons).toEqual(['SOS', 'PRIORITY_MEDIUM', 'MANY_CITIZENS', 'WEAPON']);
  });

  it('la sospecha de falsa alarma no resta si otros vecinos lo confirman', () => {
    const one = incidentImportance(sos({ maxPriority: 'MEDIUM', possibleFalseAlarm: true }));
    const two = incidentImportance(sos({ maxPriority: 'MEDIUM', possibleFalseAlarm: true, citizenCount: 2 }));
    expect(one.reasons).toContain('POSSIBLE_FALSE_ALARM');
    expect(two.reasons).not.toContain('POSSIBLE_FALSE_ALARM');
    expect(two.score).toBeGreaterThan(one.score);
  });
});
