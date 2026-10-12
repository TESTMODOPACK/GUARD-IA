import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';

// Con la app abierta, el aviso de la central se muestra igual (banner + lista).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export type PushResult =
  | { state: 'registered' }
  | { state: 'denied' }
  | { state: 'unavailable'; reason: string };

/**
 * Registra este teléfono para recibir los avisos de la central (PUT /me/devices).
 * No hay token en la web, en emuladores, en Expo Go para Android (desde SDK 53) ni sin proyecto EAS:
 * en esos casos se informa y la app sigue; el estado del caso llega igual por WebSocket.
 */
export async function registerDevice(): Promise<PushResult> {
  if (Platform.OS === 'web') return { state: 'unavailable', reason: 'la versión web no recibe avisos' };
  if (!Device.isDevice) return { state: 'unavailable', reason: 'emulador sin servicio de avisos' };
  if (Platform.OS === 'android' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    return { state: 'unavailable', reason: 'Expo Go en Android no recibe avisos; requiere la app de desarrollo' };
  }
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return { state: 'unavailable', reason: 'falta el proyecto EAS para emitir avisos' };

  // Android 13+: sin un canal creado no aparece el permiso ni hay token.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('alertas', {
      name: 'Estado de mis alertas',
      importance: Notifications.AndroidImportance.MAX,
    });
  }

  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== 'granted') return { state: 'denied' };

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  await api.upsertDevice({
    expoPushToken: token.data,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    appVersion: Constants.expoConfig?.version,
  });
  return { state: 'registered' };
}
