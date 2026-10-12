/**
 * Celular chileno → E.164 (+569XXXXXXXX), el formato que valida `PhoneSchema` en la API.
 * Acepta "9 1234 5678", "+56 9 1234 5678" o "56912345678". Devuelve null si no es un celular válido.
 */
export function toE164(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('56') && digits.length === 11) digits = digits.slice(2);
  return /^9\d{8}$/.test(digits) ? `+56${digits}` : null;
}

/**
 * Teléfono en curso entre "Ingreso" y "Código". Vive solo en memoria: no va en la ruta (en la web
 * quedaría en la URL y el historial).
 */
let pending: string | null = null;
export const setPendingPhone = (p: string | null) => {
  pending = p;
};
export const getPendingPhone = () => pending;

/** +56912345678 → "+56 9 1234 5678". */
export function formatPhone(e164: string): string {
  const d = e164.replace(/^\+56/, '');
  return `+56 ${d.slice(0, 1)} ${d.slice(1, 5)} ${d.slice(5)}`;
}
