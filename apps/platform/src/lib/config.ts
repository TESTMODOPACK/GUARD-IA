/** URL base de la API (sin /v1). En producción la fija NEXT_PUBLIC_API_URL al construir la imagen. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const API_BASE = `${API_URL}/v1`;
/** sessionStorage: la sesión de la consola vive solo en la pestaña donde se ingresó. */
export const SESSION_KEY = 'guardia.platform.session';
