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
      title: 'Segunda advertencia: cuenta restringida',
      body: `Es el segundo aviso falso en 90 días. ${base} El SOS sigue funcionando, pero no podrás enviar reportes urbanos mientras tengas dos avisos vigentes. Si se repite, tu municipalidad puede bloquear tu cuenta.`,
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
  // Una prueba repetida cuenta como aviso falso (0011): llega con activeStrikes y la misma advertencia.
  return reason === 'FALSE_ALARM' || (reason === 'TEST' && activeStrikes !== null)
    ? falseAlarmNotice(activeStrikes ?? 1)
    : BY_REASON[reason];
}

/** "30 días", "6 meses" o "hasta nuevo aviso". */
export function blockTerm(days: number | null): string {
  if (days === null) return 'hasta nuevo aviso';
  return days === 180 ? 'por 6 meses' : `por ${days} días`;
}

/** Bloqueo aprobado por el supervisor (0011). La app queda sin uso; siempre recuerda los números de emergencia. */
export function blockNotice(days: number | null, tenantName: string): CitizenNotice {
  return {
    title: 'Tu cuenta fue bloqueada',
    body: `${tenantName} bloqueó tu cuenta ${blockTerm(days)} por avisos falsos reiterados. No podrás enviar alertas desde la app. Ante una emergencia llama al 133, 131 o 132. Puedes pedir revisión en "Estado de tu cuenta".`,
    warning: true,
  };
}

export const UNBLOCK_NOTICE: CitizenNotice = {
  title: 'Tu cuenta fue desbloqueada',
  body: 'Ya puedes volver a usar la app. El SOS es solo para emergencias reales.',
  warning: false,
};

export const STRIKE_ANNULLED_NOTICE: CitizenNotice = {
  title: 'Anulamos una advertencia',
  body: 'Revisamos un aviso que habíamos marcado como falso y lo anulamos. Disculpa las molestias.',
  warning: false,
};

/** Respuesta a una solicitud de revisión: siempre con el texto que escribió el municipio. */
export function reviewNotice(granted: boolean, response: string): CitizenNotice {
  return {
    title: granted ? 'Acogimos tu solicitud de revisión' : 'Revisamos tu solicitud',
    body: response,
    warning: false,
  };
}
