import type { RejectReason } from './enums';

/**
 * Lo que se le dice al vecino cuando la central cierra su alerta sin despacho (push y pantalla de la
 * alerta en la app). Un solo lugar para que la API y la app digan lo mismo y para revisarlo con
 * asesoría legal (docs/plan-plataforma.md §5b). Nunca culpar al vecino por un error de buena fe.
 */
export interface CitizenNotice {
  title: string;
  body: string;
  /** Advertencia formal por aviso falso (la app la destaca). */
  warning: boolean;
}

const BY_REASON: Record<Exclude<RejectReason, 'FALSE_ALARM'>, CitizenNotice> = {
  ACCIDENTAL: {
    title: 'Cerramos tu alerta',
    body: 'Parece una activación accidental; no pasa nada. Si necesitas ayuda, vuelve a pedirla o llama al 133.',
    warning: false,
  },
  MISREPORTED: {
    title: 'Revisamos tu aviso',
    body: 'No corresponde a una emergencia. Para problemas de la calle (baches, luminarias, basura) usa "Reportar" en la app.',
    warning: false,
  },
  DUPLICATE: {
    title: 'Ya estamos atendiendo esta situación',
    body: 'Otro vecino la reportó y la central ya está en eso. Gracias por avisar.',
    warning: false,
  },
  OUT_OF_SCOPE: {
    title: 'Tu aviso no corresponde a la central municipal',
    body: 'Si es una emergencia, llama al 133 (Carabineros), 131 (SAMU) o 132 (Bomberos).',
    warning: false,
  },
  TEST: {
    title: 'La app es solo para emergencias reales',
    body: 'Cerramos tu alerta de prueba. Usa el SOS solo cuando necesites ayuda.',
    warning: false,
  },
  OTHER: {
    title: 'Tu alerta fue cerrada',
    body: 'La central cerró el caso sin despacho. Si sigues en peligro, llama al 133.',
    warning: false,
  },
};

/** Advertencia por aviso falso según cuántas faltas vigentes tiene ahora (1.ª, 2.ª, 3.ª o más). */
export function falseAlarmNotice(activeStrikes: number): CitizenNotice {
  const base = 'Usar el SOS sin una emergencia real resta recursos a quien sí los necesita.';
  if (activeStrikes <= 1) {
    return {
      title: 'Advertencia por aviso falso',
      body: `Recibimos un aviso falso desde tu cuenta. ${base} Si se repite, tu cuenta puede ser restringida.`,
      warning: true,
    };
  }
  if (activeStrikes === 2) {
    return {
      title: 'Segunda advertencia por aviso falso',
      body: `Es el segundo aviso falso en 90 días. ${base} Si se repite, tu municipalidad puede bloquear tu cuenta.`,
      warning: true,
    };
  }
  return {
    title: 'Tu cuenta está en revisión',
    body: `Tienes ${activeStrikes} avisos falsos en 90 días. Tu municipalidad revisará el bloqueo de tu cuenta. Ante una emergencia real, llama al 133, 131 o 132.`,
    warning: true,
  };
}

export function rejectNotice(reason: RejectReason, activeStrikes: number | null): CitizenNotice {
  return reason === 'FALSE_ALARM' ? falseAlarmNotice(activeStrikes ?? 1) : BY_REASON[reason];
}
