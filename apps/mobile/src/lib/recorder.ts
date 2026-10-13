import { requestRecordingPermissionsAsync, setAudioModeAsync, type AudioRecorder } from 'expo-audio';
import { Platform } from 'react-native';
import type { UploadFile } from './api';

/** Tope de grabación del SOS por voz y del modo discreto (sección 9 del doc de Fase 0). */
export const MAX_RECORDING_S = 15;

export class MicError extends Error {}

/** Permiso de micrófono y modo de audio para grabar. Lanza MicError con un texto para el vecino. */
export async function prepareMic(): Promise<void> {
  const { granted } = await requestRecordingPermissionsAsync();
  if (!granted) {
    throw new MicError('Sin permiso de micrófono no podemos grabar. Actívalo en Ajustes, usa el botón SOS o llama al 133.');
  }
  await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
}

/**
 * Prepara y empieza a grabar. Una sesión nativa puede quedar a medias (intento anterior, pulsación
 * muy corta o la app recargada en desarrollo mientras grababa): Android rechaza preparar de nuevo
 * ("already been prepared") o grabar (IllegalStateException). En ese caso se cierra la sesión
 * trabada y se prepara una nueva, una sola vez.
 */
export async function startRecording(recorder: AudioRecorder): Promise<void> {
  try {
    await recorder.prepareToRecordAsync();
    recorder.record();
  } catch (e) {
    console.warn('grabadora trabada, se reinicia la sesión:', (e as Error)?.message ?? e);
    try {
      await recorder.stop();
    } catch {
      // Sin sesión que cerrar: seguir.
    }
    await recorder.prepareToRecordAsync();
    recorder.record();
  }
}

/** Archivo de la grabación con el tipo que acepta la API: .m4a (audio/mp4) en el teléfono, webm en la web. */
export function audioFile(uri: string): UploadFile {
  return Platform.OS === 'web'
    ? { uri, name: 'sos.webm', type: 'audio/webm' }
    : { uri, name: 'sos.m4a', type: 'audio/mp4' };
}
