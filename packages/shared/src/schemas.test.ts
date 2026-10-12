import { describe, expect, it } from 'vitest';
import {
  AiClassificationSchema,
  CreateAlertMetaSchema,
  canTransitionAlert,
  canTransitionDispatch,
  OtpVerifySchema,
} from './index';

describe('CreateAlertMetaSchema', () => {
  const base = {
    type: 'EMERGENCY_SOS',
    source: 'BUTTON',
    location: { lat: -33.61, lng: -70.58 },
  };

  it('acepta un SOS mínimo', () => {
    expect(CreateAlertMetaSchema.safeParse(base).success).toBe(true);
  });

  it('rechaza categoría urbana en un SOS', () => {
    const r = CreateAlertMetaSchema.safeParse({ ...base, category: 'BACHE' });
    expect(r.success).toBe(false);
  });

  it('rechaza DISCREET en reporte urbano', () => {
    const r = CreateAlertMetaSchema.safeParse({
      ...base,
      type: 'CIVIC_REPORT',
      source: 'DISCREET',
      category: 'BACHE',
    });
    expect(r.success).toBe(false);
  });

  it('rechaza coordenadas fuera de rango', () => {
    const r = CreateAlertMetaSchema.safeParse({ ...base, location: { lat: 95, lng: 0 } });
    expect(r.success).toBe(false);
  });
});

describe('transiciones', () => {
  it('alerta: PENDING puede cancelarse, DISPATCHED no', () => {
    expect(canTransitionAlert('PENDING', 'CANCELLED')).toBe(true);
    expect(canTransitionAlert('DISPATCHED', 'CANCELLED')).toBe(false);
    expect(canTransitionAlert('DISPATCHED', 'ACKNOWLEDGED')).toBe(true);
    expect(canTransitionAlert('RESOLVED', 'PENDING')).toBe(false);
  });

  it('despacho: CLOSED es terminal', () => {
    expect(canTransitionDispatch('ASSIGNED', 'EN_ROUTE')).toBe(true);
    expect(canTransitionDispatch('CLOSED', 'EN_ROUTE')).toBe(false);
  });
});

describe('AiClassificationSchema', () => {
  it('valida una salida completa', () => {
    const r = AiClassificationSchema.safeParse({
      category: 'ROBO_ASALTO',
      priority: 'HIGH',
      suggested_agency: 'CARABINEROS',
      confidence: 0.9,
      summary: 'Asalto en curso',
      flags: {
        possible_false_alarm: false,
        weapon_mentioned: true,
        people_injured: false,
        minor_involved: false,
        language_other_than_spanish: false,
      },
    });
    expect(r.success).toBe(true);
  });

  it('rechaza confidence > 1', () => {
    const r = AiClassificationSchema.safeParse({
      category: 'BACHE',
      priority: 'LOW',
      suggested_agency: 'OBRAS_ASEO',
      confidence: 1.5,
      summary: 'x',
      flags: {
        possible_false_alarm: false,
        weapon_mentioned: false,
        people_injured: false,
        minor_involved: false,
        language_other_than_spanish: false,
      },
    });
    expect(r.success).toBe(false);
  });
});

describe('OtpVerifySchema', () => {
  it('exige E.164 y 6 dígitos', () => {
    expect(OtpVerifySchema.safeParse({ phone: '+56912345678', code: '123456' }).success).toBe(true);
    expect(OtpVerifySchema.safeParse({ phone: '912345678', code: '123456' }).success).toBe(false);
    expect(OtpVerifySchema.safeParse({ phone: '+56912345678', code: '12' }).success).toBe(false);
  });
});
