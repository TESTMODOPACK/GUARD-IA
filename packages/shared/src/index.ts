export * from './enums';
export * from './schemas/common';
export * from './schemas/auth';
export * from './schemas/alert';
export * from './schemas/incident';
export * from './schemas/ops';
export * from './schemas/ai';
export * from './triage-rules';
export * from './geo';
export * from './citizen-notices';
export * from './schemas/privacy';
export * from './schemas/admin';
export * from './schemas/platform';
export * from './schemas/account';
export * from './schemas/field';
export * from './schemas/areas';
export * from './ws-events';

/** Ventana en la que el vecino puede cancelar su propia alerta. */
export const CANCEL_WINDOW_SECONDS = 30;

/** Versión vigente del consentimiento que la app debe aceptar antes de la primera alerta. */
export const CONSENT_VERSION = '2026-10-v1';

export const API_PREFIX = 'v1';
