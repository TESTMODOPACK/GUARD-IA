/**
 * Georreferencia (migración 0006): reconocer la comuna que nombra el vecino y decidir si la alerta
 * se traspasa sola a la municipalidad donde ocurre el hecho.
 */

/** Clave para comparar nombres de comuna: minúsculas, sin tildes ni "comuna/municipalidad de". */
export function comunaKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(?:i\.?\s*)?(?:ilustre\s+)?(?:municipalidad|comuna|municipio)\s+de\s+/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Traspaso automático por el agente. Solo si TODO se cumple:
 * - la alerta sigue nueva (nadie la acusó ni despachó);
 * - el vecino nombra una comuna atendida por otro municipio de Guard-IA;
 * - el hecho ocurre lejos del vecino (triage.location.elsewhere) o el GPS está a menos de
 *   `maxDistanceM` de esa comuna (el vecino está en el límite);
 * - la central de destino tiene al menos un operador conectado (si no, se queda y se sugiere).
 */
export const AUTO_TRANSFER = { maxDistanceM: 3000 } as const;

/** Municipios vecinos dentro de este margen (o de la precisión del GPS, si es mayor) se muestran como "cerca del límite". */
export const NEAR_BOUNDARY_MIN_M = 150;
