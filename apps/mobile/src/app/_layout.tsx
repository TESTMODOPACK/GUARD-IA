import { BricolageGrotesque_600SemiBold, BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque';
import { Manrope_400Regular, Manrope_500Medium, Manrope_700Bold } from '@expo-google-fonts/manrope';
import { useFonts } from 'expo-font';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { EmergencyBar } from '@/components/EmergencyBar';
import { syncAccount } from '@/lib/api';
import { connectCitizen, disconnectCitizen } from '@/lib/realtime';
import { hasCurrentConsent, initSession, useSession } from '@/lib/session';
import { color } from '@/theme';

/**
 * Raíz: carga fuentes y sesión, y decide qué pantallas existen.
 * Sin sesión → ingreso; con sesión sin el consentimiento vigente → consentimiento; si no → inicio.
 */
export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_700Bold,
  });
  const { ready, session } = useSession();
  const pathname = usePathname();

  useEffect(() => {
    void initSession();
  }, []);

  // Canal en vivo /citizen mientras haya sesión con consentimiento vigente.
  const liveFor = session && hasCurrentConsent(session) ? session.citizen.id : null;
  useEffect(() => {
    if (!liveFor) return;
    connectCitizen();
    // Estado de la cuenta al abrir (bloqueo, restricción; 0011): la sesión guardada puede estar desactualizada.
    void syncAccount();
    return () => disconnectCitizen();
  }, [liveFor]);

  // Sin fuentes o sesión aún: fondo del tema, sin parpadeo blanco.
  if (!fontsLoaded || !ready) return <View style={{ flex: 1, backgroundColor: color.bg }} />;

  const signedIn = !!session;
  const consented = hasCurrentConsent(session);
  // Cuenta bloqueada por uso indebido (decisión 13-10-2026): la app queda sin uso; solo el bloqueo, el estado de
  // la cuenta (pedir revisión) y Mis datos. Los números de emergencia siguen abajo, siempre.
  const blocked = session?.citizen.account?.level === 'BLOCKED';

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={['top', 'bottom']}>
        <View style={{ flex: 1 }}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}>
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="login" />
              <Stack.Screen name="verify" />
            </Stack.Protected>
            <Stack.Protected guard={signedIn && !consented}>
              <Stack.Screen name="consent" />
            </Stack.Protected>
            <Stack.Protected guard={signedIn && consented && !blocked}>
              <Stack.Screen name="index" />
              <Stack.Screen name="sos" options={{ animation: 'fade', gestureEnabled: false }} />
              <Stack.Screen name="alert/[id]" />
              <Stack.Screen name="cases" />
              <Stack.Screen name="voice" />
              <Stack.Screen name="report" />
              <Stack.Screen name="discreet" options={{ animation: 'none', gestureEnabled: false }} />
            </Stack.Protected>
            <Stack.Protected guard={signedIn && consented && blocked}>
              <Stack.Screen name="blocked" options={{ gestureEnabled: false }} />
            </Stack.Protected>
            <Stack.Protected guard={signedIn && consented}>
              <Stack.Screen name="account" />
              <Stack.Screen name="privacy" />
            </Stack.Protected>
          </Stack>
        </View>
        {/* Cuenta regresiva: solo "No enviar". Modo discreto: nada que delate la app. */}
        {/* La pantalla de bloqueo ya trae los números en grande. */}
        {pathname !== '/sos' && pathname !== '/discreet' && pathname !== '/blocked' ? <EmergencyBar /> : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
