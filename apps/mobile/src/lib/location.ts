import * as Location from 'expo-location';

export type Fix = { lat: number; lng: number; accuracyM?: number };

export class LocationError extends Error {}

/**
 * Ubicación para el SOS. Pide permiso "mientras se usa" y una lectura de alta precisión con tope de
 * 8 s; si el GPS tarda, usa la última posición conocida (mejor algo que nada en una emergencia).
 */
export async function currentFix(): Promise<Fix> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') {
    throw new LocationError('Sin permiso de ubicación no podemos decirle a la central dónde estás. Actívalo en Ajustes o llama al 133.');
  }
  const precise = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).then(toFix);
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 8000));
  const fix = await Promise.race([precise, timeout]);
  if (fix) return fix;
  const last = await Location.getLastKnownPositionAsync();
  if (last) return toFix(last);
  return precise; // sin respaldo: esperar la lectura en curso
}

function toFix(p: Location.LocationObject): Fix {
  return {
    lat: p.coords.latitude,
    lng: p.coords.longitude,
    accuracyM: p.coords.accuracy ?? undefined,
  };
}
