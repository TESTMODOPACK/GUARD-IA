import { describe, expect, it } from 'vitest';
import {
  AiClassificationSchema,
  CreateAlertMetaSchema,
  canTransitionAlert,
  canTransitionDispatch,
  ChangeTenantStatusSchema,
  isValidRut,
  normalizeRut,
  OtpVerifySchema,
  PlatformChangePasswordSchema,
  RutSchema,
  TENANT_TRANSITIONS,
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
  const flags = {
    possible_false_alarm: false,
    weapon_mentioned: true,
    people_injured: false,
    minor_involved: false,
    language_other_than_spanish: false,
  };
  it('valida una salida completa (triage-v2)', () => {
    const r = AiClassificationSchema.safeParse({
      category: 'ROBO_ASALTO',
      subcategory: 'ASALTO_EN_CURSO',
      priority: 'HIGH',
      agencies: [{ agency: 'CARABINEROS', reason: 'Asalto con arma en curso' }],
      confidence: 0.9,
      summary: 'Asalto en curso',
      operator_questions: ['¿El asaltante sigue en el lugar?'],
      location: { mentioned: 'plaza de la esquina', comuna: null, elsewhere: false },
      flags,
    });
    expect(r.success).toBe(true);
  });

  it('rechaza una institución que no existe', () => {
    const r = AiClassificationSchema.safeParse({
      category: 'BACHE',
      subcategory: null,
      priority: 'LOW',
      agencies: [{ agency: 'MUNICIPIO', reason: 'x' }],
      confidence: 0.5,
      summary: 'x',
      operator_questions: [],
      location: { mentioned: null, comuna: null, elsewhere: false },
      flags,
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

describe('RUT y municipios (plataforma)', () => {
  it('normaliza y valida el dígito verificador', () => {
    expect(RutSchema.parse('12.345.678-5')).toBe('12345678-5');
    expect(RutSchema.parse('11111111-1')).toBe('11111111-1');
    expect(RutSchema.safeParse('12.345.678-9').success).toBe(false);
    expect(isValidRut('9999999-K')).toBe(isValidRut(normalizeRut('9.999.999-k')));
  });

  it('el estado del municipio solo avanza por las transiciones de la base', () => {
    expect(TENANT_TRANSITIONS.ONBOARDING).toEqual(['ACTIVE', 'TERMINATED']);
    expect(TENANT_TRANSITIONS.TERMINATED).toEqual([]);
    expect(ChangeTenantStatusSchema.safeParse({ status: 'SUSPENDED', reason: 'mora', confirmName: 'Providencia' }).success).toBe(false);
  });

  it('la contraseña de plataforma pide 12 caracteres', () => {
    expect(PlatformChangePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'corta12345' }).success).toBe(false);
    expect(PlatformChangePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'una-clave-larga' }).success).toBe(true);
  });
});
