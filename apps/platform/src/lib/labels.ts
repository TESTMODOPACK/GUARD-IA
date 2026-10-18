import type {
  ComunaServiceStatus,
  IncidentNature,
  PlatformAction,
  PlatformRole,
  ReadinessKey,
  SubprocessorService,
  TenantStatus,
} from '@guardia/shared';

/** Vocabulario de la consola. Una sola palabra por concepto, igual en tablas, mapas y diálogos. */

/** Estado del municipio; en las tablas de comunas se lee como "el municipio de esta comuna está…". */
export const SERVICE_STATUS: Record<ComunaServiceStatus, string> = {
  AVAILABLE: 'Sin servicio',
  ONBOARDING: 'En implementación',
  ACTIVE: 'En servicio',
  SUSPENDED: 'Suspendido',
  TERMINATED: 'De baja',
};

/** Color de cada estado en mapa y etiquetas. El rojo es solo para SOS: aquí no se usa. */
export const SERVICE_COLOR: Record<ComunaServiceStatus, string> = {
  AVAILABLE: '#5b7091',
  ONBOARDING: '#1fa8f0',
  ACTIVE: '#4cc38a',
  SUSPENDED: '#f2b134',
  TERMINATED: '#3a4d6b',
};

export const SERVICE_TONE: Record<ComunaServiceStatus, 'neutral' | 'accent' | 'ok' | 'medium' | 'faint'> = {
  AVAILABLE: 'neutral',
  ONBOARDING: 'accent',
  ACTIVE: 'ok',
  SUSPENDED: 'medium',
  TERMINATED: 'faint',
};

/** Botón que lleva a cada estado. */
export const STATUS_ACTION: Record<TenantStatus, string> = {
  ONBOARDING: 'Volver a implementación',
  ACTIVE: 'Activar',
  SUSPENDED: 'Suspender',
  TERMINATED: 'Dar de baja',
};

/** Qué pasa con los vecinos y la central al confirmar cada estado. */
export const STATUS_EFFECT: Record<TenantStatus, string> = {
  ONBOARDING: 'Solo los teléfonos de prueba llegan a la central.',
  ACTIVE: 'Desde ahora todas las alertas de la comuna llegan a esta central.',
  SUSPENDED:
    'Los SOS y reportes siguen llegando (el SOS nunca se corta). El municipio no puede crear cuentas nuevas y ve un aviso en su central.',
  TERMINATED:
    'Las alertas nuevas de la comuna quedarán fuera de cobertura ("llama al 133"). Las cuentas del municipio dejan de entrar. No se puede deshacer: volver exige un alta nueva.',
};

export const ROLE: Record<PlatformRole, string> = {
  SUPERADMIN: 'Superadministrador',
  IMPLEMENTATION: 'Implementación y comercial',
  FINANCE: 'Finanzas',
  SUPPORT: 'Soporte técnico',
};

export const READINESS: Record<ReadinessKey, { label: string; who: string }> = {
  ADMIN_READY: { label: 'Administrador municipal con contraseña propia', who: 'Se crea aquí; el administrador cambia la temporal al entrar' },
  OPERATORS: { label: 'Al menos 2 operadores o supervisores activos', who: 'Los crea el administrador en su central' },
  CONTACT_CARABINEROS: { label: 'Directorio: Carabineros', who: 'Directorio de la central' },
  CONTACT_SAMU: { label: 'Directorio: SAMU', who: 'Directorio de la central' },
  CONTACT_BOMBEROS: { label: 'Directorio: Bomberos', who: 'Directorio de la central' },
  CONTACT_MUNICIPAL: { label: 'Directorio: seguridad o emergencia municipal', who: 'Directorio de la central' },
  UNITS: { label: 'Al menos 1 unidad en terreno', who: 'Unidades de la central' },
  SHIFTS_FIRST_WEEK: { label: 'Turnos programados para la primera semana', who: 'Turnos de la central' },
  CONTRACT_SIGNED: { label: 'Contrato firmado, con su referencia', who: 'Fecha y referencia en la ficha' },
  DPA_SIGNED: { label: 'Contrato de encargo de datos firmado (Ley 21.719, art. 15 bis)', who: 'Fecha y referencia en la ficha' },
  DPIA_APPROVED: { label: 'Evaluación de impacto aprobada por el municipio (art. 15 ter)', who: 'Fecha y referencia en la ficha' },
  PRIVACY_CONTACT: { label: 'Contacto de privacidad para los vecinos', who: 'Lo fija el administrador en «Privacidad» de su central' },
  SUBPROCESSORS: { label: 'Subencargados en uso autorizados por escrito', who: 'Se registran aquí, en «Subencargados autorizados»' },
  E2E_TEST: {
    label: 'Prueba de extremo a extremo: SOS de un teléfono de prueba, despachado y resuelto',
    who: 'Con un teléfono de prueba y la central',
  },
};

export const ACTION: Record<PlatformAction, string> = {
  LOGIN: 'Ingresó a la consola',
  LOGIN_FAILED: 'Intento de ingreso fallido',
  LOGOUT: 'Cerró sesión',
  LOCKED: 'Cuenta bloqueada por intentos',
  TOTP_ENROLLED: 'Activó el segundo factor',
  PASSWORD_CHANGED: 'Cambió su contraseña',
  USER_CREATED: 'Creó una cuenta de plataforma',
  USER_UPDATED: 'Modificó una cuenta de plataforma',
  USER_RESET: 'Restableció una cuenta de plataforma',
  TENANT_CREATED: 'Dio de alta un municipio',
  TENANT_UPDATED: 'Editó la ficha de un municipio',
  TENANT_STATUS_CHANGED: 'Cambió el estado de un municipio',
  TENANT_ADMIN_CREATED: 'Creó el administrador municipal',
  TENANT_ADMIN_RESET: 'Restableció el acceso del administrador municipal',
  TEST_PHONE_ADDED: 'Agregó un teléfono de prueba',
  TEST_PHONE_REMOVED: 'Quitó un teléfono de prueba',
  SUBPROCESSOR_CREATED: 'Agregó un subencargado al catálogo',
  SUBPROCESSOR_UPDATED: 'Modificó un subencargado',
  SUBPROCESSOR_AUTHORIZED: 'Registró la autorización de un subencargado',
  SUBPROCESSOR_REVOKED: 'Revocó la autorización de un subencargado',
  INCIDENT_OPENED: 'Declaró un incidente de seguridad',
  INCIDENT_UPDATED: 'Actualizó un incidente de seguridad',
  INCIDENT_TENANT_NOTIFIED: 'Avisó un incidente a un municipio',
};

/** Ley 21.719 (0014): qué servicio presta cada subencargado. */
export const SUBPROCESSOR_SERVICE: Record<SubprocessorService, string> = {
  AI: 'Inteligencia artificial',
  SMS: 'Mensajes SMS',
  PUSH: 'Avisos al teléfono',
  HOSTING: 'Servidor',
  STORAGE: 'Archivos',
  BACKUP: 'Respaldo',
  MAPS: 'Mapas',
  OTHER: 'Otro',
};

/** Naturaleza de un incidente de seguridad (art. 14 sexies). */
export const INCIDENT_NATURE: Record<IncidentNature, string> = {
  DESTRUCTION: 'Destrucción de datos',
  LEAK: 'Filtración',
  LOSS: 'Pérdida de datos',
  ALTERATION: 'Alteración de datos',
  UNAUTHORIZED_ACCESS: 'Acceso no autorizado',
};

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  // Fechas sin hora (YYYY-MM-DD): mostrar tal cual, sin corrimiento por zona horaria.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso.split('-').reverse().join('-');
  return new Date(iso).toLocaleDateString('es-CL');
}
