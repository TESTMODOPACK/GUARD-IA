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
 * Prepara y empieza a grabar. Si quedó una sesión preparada (un intento anterior que no llegó a
 * grabar, o una pulsación muy corta), Android rechaza preparar de nuevo con "AudioRecorder has
 * already been prepared": en ese caso se usa la sesión que ya existe.
 */
export async function startRecording(recorder: AudioRecorder): Promise<void> {
  try {
    await recorder.prepareToRecordAsync();
  } catch (e) {
    if (!/already been prepared/i.test(String((e as Error)?.message ?? e))) throw e;
  }
  recorder.record();
}

/** Archivo de la grabación con el tipo que acepta la API: .m4a (audio/mp4) en el teléfono, webm en la web. */
export function audioFile(uri: string): UploadFile {
  return Platform.OS === 'web'
    ? { uri, name: 'sos.webm', type: 'audio/webm' }
    : { uri, name: 'sos.m4a', type: 'audio/mp4' };
}
