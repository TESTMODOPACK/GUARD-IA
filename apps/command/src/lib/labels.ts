import type {
  AiStatus,
  AlertCategory,
  AlertEventKind,
  AlertSource,
  AlertStatus,
  AreaSource,
  AuditKind,
  ContactCategory,
  DispatchOutcome,
  DispatchStatus,
  FieldAlarmKind,
  ImportanceLevel,
  ImportanceReason,
  OperatorRole,
  OutcomeVia,
  Priority,
  RejectReason,
  Subcategory,
  SuggestedAgency,
  TenantStatus,
  UnitKind,
  UnitStatus,
} from '@guardia/shared';

/** Vocabulario del operador. Una sola palabra por concepto, igual en botones, toasts y línea de tiempo. */

export const CATEGORY: Record<AlertCategory, string> = {
  ROBO_ASALTO: 'Robo o asalto',
  VIOLENCIA_AGRESION: 'Violencia o agresión',
  INCENDIO: 'Incendio',
  SALUD: 'Emergencia de salud',
  ACCIDENTE_TRANSITO: 'Accidente de tránsito',
  SOSPECHOSO: 'Situación sospechosa',
  OTRO_EMERGENCIA: 'Emergencia sin clasificar',
  BACHE: 'Bache',
  LUMINARIA: 'Luminaria',
  BASURA_MICROBASURAL: 'Basura o microbasural',
  SEMAFORO: 'Semáforo',
  AREA_VERDE: 'Área verde',
  ANIMAL: 'Animal',
  OTRO_URBANO: 'Reporte urbano sin clasificar',
};

export const PRIORITY: Record<Priority, string> = { HIGH: 'Alta', MEDIUM: 'Media', LOW: 'Baja' };

export const STATUS: Record<AlertStatus, string> = {
  PENDING: 'Nueva',
  ACKNOWLEDGED: 'En revisión',
  DISPATCHED: 'Unidad despachada',
  RESOLVED: 'Resuelta',
  REJECTED: 'Rechazada',
  CANCELLED: 'Cancelada por el vecino',
  UNROUTED: 'Sin cobertura',
};

export const AI_STATUS: Record<AiStatus, string> = {
  QUEUED: 'IA en cola',
  PROCESSING: 'IA analizando',
  DONE: 'IA lista',
  FAILED: 'IA no disponible',
  SKIPPED: 'Sin análisis de IA',
};

/** Se usa en la frase "SOS por {source}". */
export const SOURCE: Record<AlertSource, string> = {
  BUTTON: 'botón',
  VOICE: 'voz',
  DISCREET: 'modo discreto',
  FORM: 'formulario',
};

export const AGENCY: Record<SuggestedAgency, string> = {
  SEGURIDAD_MUNICIPAL: 'Seguridad municipal',
  CARABINEROS: 'Carabineros (133)',
  SAMU: 'SAMU (131)',
  BOMBEROS: 'Bomberos (132)',
  OBRAS_ASEO: 'Obras y aseo',
  PDI: 'PDI (134)',
};

/** Sin el número, para frases ("Derivado a Carabineros y SAMU"). */
export const AGENCY_SHORT: Record<SuggestedAgency, string> = {
  SEGURIDAD_MUNICIPAL: 'Seguridad municipal',
  CARABINEROS: 'Carabineros',
  SAMU: 'SAMU',
  BOMBEROS: 'Bomberos',
  OBRAS_ASEO: 'Obras y aseo',
  PDI: 'PDI',
};

/** Detalle de la categoría (agente de clasificación, migración 0005). */
export const SUBCATEGORY: Record<Subcategory, string> = {
  ASALTO_EN_CURSO: 'asalto en curso',
  PORTONAZO_ENCERRONA: 'portonazo o encerrona',
  ROBO_VIVIENDA: 'robo en vivienda',
  ROBO_VEHICULO: 'robo de o desde vehículo',
  ROBO_CONSUMADO: 'robo ya ocurrido',
  VIOLENCIA_INTRAFAMILIAR: 'violencia intrafamiliar',
  RINA: 'riña',
  AGRESION_CON_ARMA: 'agresión con arma',
  DISPAROS: 'disparos',
  VIOLENCIA_SEXUAL: 'violencia sexual',
  AMENAZAS: 'amenazas',
  INCENDIO_VIVIENDA: 'en vivienda',
  INCENDIO_VEHICULO: 'de vehículo',
  INCENDIO_PASTIZAL: 'de pastizal o cerro',
  FUGA_GAS: 'fuga de gas',
  RIESGO_ELECTRICO: 'riesgo eléctrico',
  INCONSCIENTE: 'persona inconsciente',
  DIFICULTAD_RESPIRATORIA: 'dificultad para respirar',
  DOLOR_PECHO: 'dolor de pecho',
  CONVULSION: 'convulsión',
  HERIDA_CAIDA: 'herida o caída',
  INTOXICACION: 'intoxicación',
  PARTO: 'parto',
  RIESGO_SUICIDA: 'riesgo suicida',
  CHOQUE_CON_HERIDOS: 'choque con heridos',
  CHOQUE_SIN_HERIDOS: 'choque sin heridos',
  ATROPELLO: 'atropello',
  VOLCAMIENTO: 'volcamiento',
  PERSONA_SOSPECHOSA: 'persona sospechosa',
  VEHICULO_SOSPECHOSO: 'vehículo sospechoso',
  DROGAS: 'drogas',
  DESORDEN_RUIDOS: 'desorden o ruidos',
  PERSONA_DESAPARECIDA: 'persona desaparecida',
  RESCATE: 'rescate',
  INUNDACION: 'inundación',
  ANIMAL_PELIGROSO: 'animal peligroso',
  BACHE_CALZADA: 'en la calle',
  VEREDA_DANADA: 'vereda dañada',
  TAPA_FALTANTE: 'cámara sin tapa',
  LUMINARIA_APAGADA: 'apagada',
  LUMINARIA_INTERMITENTE: 'intermitente',
  POSTE_DANADO: 'poste dañado',
  CABLE_CORTADO: 'cable cortado o caído',
  MICROBASURAL: 'microbasural',
  ESCOMBROS: 'escombros',
  RETIRO_PENDIENTE: 'retiro pendiente',
  VOLUMINOSOS: 'voluminosos',
  SEMAFORO_APAGADO: 'apagado',
  SEMAFORO_INTERMITENTE: 'intermitente',
  SEMAFORO_DANADO: 'dañado',
  ARBOL_RIESGO: 'árbol con riesgo de caer',
  PODA_MANTENCION: 'poda o mantención',
  MOBILIARIO_DANADO: 'juegos o mobiliario dañado',
  RIEGO: 'riego',
  ANIMAL_AGRESIVO: 'agresivo',
  ANIMAL_HERIDO: 'herido',
  ANIMAL_MUERTO: 'muerto',
  ANIMAL_ABANDONADO: 'abandonado',
  VEHICULO_ABANDONADO: 'vehículo abandonado',
  RUIDOS_MOLESTOS: 'ruidos molestos',
  RAYADOS: 'rayados',
  OCUPACION_VIA_PUBLICA: 'ocupación de la vía pública',
};

export function subcategoryLabel(s: string | null | undefined): string | null {
  return s ? (SUBCATEGORY[s as Subcategory] ?? s.toLowerCase().replace(/_/g, ' ')) : null;
}

/** Lo que informa la unidad (por radio, por ahora). */
export const DISPATCH_OUTCOME: Record<DispatchOutcome, string> = {
  RESOLVED_ON_SITE: 'Atendido en el lugar',
  REFERRED: 'Derivado a otra institución',
  NEEDS_SUPPORT: 'En proceso, pide apoyo',
  NOT_FOUND: 'No se encontró nada',
  DIFFERENT_SITUATION: 'Era otra situación',
  FALSE_ALARM_CONFIRMED: 'Falsa alarma confirmada',
};

export const DISPATCH_OUTCOME_HELP: Record<DispatchOutcome, string> = {
  RESOLVED_ON_SITE: 'Se resolvió. Cierra el despacho y libera la unidad.',
  REFERRED: 'Se entregó a Carabineros, SAMU o Bomberos. Cierra el despacho.',
  NEEDS_SUPPORT: 'La unidad sigue en el lugar y necesita otra unidad o una institución.',
  NOT_FOUND: 'Nadie en el lugar ni señales del hecho. Cierra el despacho; vuelve a llamar al vecino.',
  DIFFERENT_SITUATION: 'Lo que había no era lo reportado. Indica qué era: corrige la clasificación.',
  FALSE_ALARM_CONFIRMED: 'Se comprobó que fue broma o engaño. Cierra el despacho y luego rechaza la alerta.',
};

/** Quién informó el resultado (0012). */
export const OUTCOME_VIA: Record<OutcomeVia, string> = {
  CENTRAL: 'registrado por la central',
  FIELD: 'informado desde terreno',
};

/** Lo mismo que DISPATCH_OUTCOME_HELP, dicho al funcionario de terreno. */
export const FIELD_OUTCOME_HELP: Record<DispatchOutcome, string> = {
  RESOLVED_ON_SITE: 'Lo resolviste. La central cierra el caso.',
  REFERRED: 'Lo entregaste a Carabineros, SAMU o Bomberos. Di a quién en la nota.',
  NEEDS_SUPPORT: 'Sigues en el lugar y necesitas otra unidad o una institución. La central recibe un aviso con sonido.',
  NOT_FOUND: 'Nadie en el lugar ni señales del hecho.',
  DIFFERENT_SITUATION: 'No era lo reportado. Elige qué era: la central lo confirma.',
  FALSE_ALARM_CONFIRMED: 'Comprobaste que fue broma o engaño. Describe qué viste u oíste.',
};

/** Avisos de terreno en la central (0012). */
export const FIELD_ALARM: Record<FieldAlarmKind, string> = {
  PANIC: 'Pánico del funcionario',
  SUPPORT: 'Pide apoyo',
  LATE: 'No marcó "en camino"',
  NO_NEWS: 'Sin noticias de la unidad',
};

export const DISPATCH_STATUS: Record<DispatchStatus, string> = {
  ASSIGNED: 'Asignada',
  EN_ROUTE: 'En camino',
  ON_SITE: 'En el lugar',
  CLOSED: 'Cerrado',
  CANCELLED: 'Cancelado',
};

export const UNIT_KIND: Record<UnitKind, string> = { PATRULLA: 'Patrulla', MOTO: 'Moto', INSPECTOR: 'Inspector' };

export const UNIT_STATUS: Record<UnitStatus, string> = {
  AVAILABLE: 'Disponible',
  BUSY: 'Ocupada',
  OFFLINE: 'Fuera de servicio',
};

export const REJECT_REASON: Record<RejectReason, string> = {
  ACCIDENTAL: 'Activación accidental',
  MISREPORTED: 'Mal reportado, de buena fe',
  DUPLICATE: 'Duplicada',
  OUT_OF_SCOPE: 'Fuera del ámbito municipal',
  TEST: 'Prueba',
  FALSE_ALARM: 'Aviso falso intencional',
  OTHER: 'Otro motivo',
};

/** Orden en el diálogo: primero los de buena fe; el que sanciona, al final y nunca marcado por defecto. */
export const REJECT_REASON_ORDER: RejectReason[] = ['ACCIDENTAL', 'MISREPORTED', 'DUPLICATE', 'OUT_OF_SCOPE', 'TEST', 'OTHER', 'FALSE_ALARM'];

/** Cuándo usar cada motivo y qué le pasa a la cuenta del vecino. */
export const REJECT_REASON_HELP: Record<RejectReason, string> = {
  ACCIDENTAL: 'SOS sin habla, bolsillo, se canceló tarde. Sin efecto en la cuenta.',
  MISREPORTED: 'Era un reporte urbano, o la categoría o el lugar estaban mal. Sin efecto.',
  DUPLICATE: 'La situación ya está en atención por otra alerta. Sin efecto.',
  OUT_OF_SCOPE: 'No corresponde al municipio; el vecino recibe a quién acudir. Sin efecto.',
  TEST: '"Estoy probando la app". Sin efecto; si se repite, usa aviso falso.',
  OTHER: 'Ninguno de los anteriores. Sin efecto.',
  FALSE_ALARM: 'Broma, engaño o acoso. Cuenta como falta por 90 días y el vecino recibe una advertencia.',
};

export const EVENT_KIND: Record<AlertEventKind, string> = {
  CREATED: 'Alerta recibida',
  AI_PROCESSED: 'Análisis de IA',
  AI_FAILED: 'La IA no pudo analizar',
  ACKNOWLEDGED: 'Recibo acusado',
  DISPATCHED: 'Unidad despachada',
  DISPATCH_STATUS: 'Estado de la unidad',
  NOTE: 'Nota',
  REJECTED: 'Rechazada',
  RESOLVED: 'Resuelta',
  CANCELLED: 'Cancelada por el vecino',
  PUSH_SENT: 'Aviso enviado al vecino',
  RECLASSIFIED: 'Clasificación revisada',
  REFERRED: 'Derivado a otras instituciones',
  TRANSFERRED: 'Traspaso entre municipios',
  FIELD_REPORT: 'Resultado en terreno',
  FIELD_ALARM: 'Aviso de terreno',
  AREA_CHANGED: 'Cambio de área',
};

export const ROLE: Record<OperatorRole, string> = {
  ADMIN: 'Administrador',
  SUPERVISOR: 'Supervisor',
  OPERATOR: 'Operador',
  ASSISTANT: 'Apoyo administrativo',
  FIELD: 'Terreno',
};

export const ROLE_HELP: Record<OperatorRole, string> = {
  ADMIN: 'Todo, incluidos usuarios',
  SUPERVISOR: 'Turnos, directorio, unidades y panel',
  OPERATOR: 'Atiende alertas y marca su turno',
  ASSISTANT: 'Consulta alertas, panel y bitácora y escribe notas; no actúa sobre las alertas',
  FIELD: 'Inspector o patrullero: recibe despachos e informa desde su teléfono en /terreno',
};

export const CONTACT_CATEGORY: Record<ContactCategory, string> = {
  CARABINEROS: 'Carabineros',
  PDI: 'PDI',
  SAMU: 'SAMU',
  BOMBEROS: 'Bomberos',
  SALUD: 'Salud (CESFAM, hospital)',
  MUNICIPAL: 'Municipalidad',
  SERVICIOS_BASICOS: 'Servicios básicos (luz, agua, gas)',
  JUNTA_VECINOS: 'Junta de vecinos',
  EMERGENCIA_MUNICIPAL: 'Emergencia municipal',
  OTRO: 'Otro',
};

/** Contactos que sirven para derivar según la institución que sugiere la IA o el tipo de caso. */
export const CONTACTS_FOR_AGENCY: Record<SuggestedAgency, ContactCategory[]> = {
  CARABINEROS: ['CARABINEROS'],
  SAMU: ['SAMU', 'SALUD'],
  BOMBEROS: ['BOMBEROS', 'SERVICIOS_BASICOS'],
  SEGURIDAD_MUNICIPAL: ['EMERGENCIA_MUNICIPAL', 'MUNICIPAL', 'JUNTA_VECINOS'],
  OBRAS_ASEO: ['MUNICIPAL', 'SERVICIOS_BASICOS'],
  PDI: ['PDI'],
};

export const AUDIT_KIND: Record<AuditKind, string> = {
  LOGIN: 'Ingresó a la central',
  LOGIN_FAILED: 'Intento de ingreso fallido',
  LOGOUT: 'Cerró sesión',
  PASSWORD_CHANGED: 'Cambió su contraseña',
  OPERATOR_CREATED: 'Creó un usuario',
  OPERATOR_UPDATED: 'Modificó un usuario',
  PASSWORD_RESET: 'Restableció una contraseña',
  SHIFT_PLANNED: 'Programó un turno',
  SHIFT_REMOVED: 'Eliminó un turno',
  SHIFT_STARTED: 'Inició turno',
  SHIFT_ENDED: 'Terminó turno',
  UNIT_CREATED: 'Creó una unidad',
  UNIT_UPDATED: 'Cambió una unidad',
  CONTACT_CREATED: 'Agregó un contacto',
  CONTACT_UPDATED: 'Editó un contacto',
  CONTACT_REMOVED: 'Desactivó un contacto',
  ALERT_TRANSFERRED: 'Traspasó una alerta a otro municipio',
  TENANT_STATUS_CHANGED: 'Cambió el estado del municipio en Guard-IA',
  CITIZEN_BLOCKED: 'Aprobó el bloqueo de un vecino',
  CITIZEN_BLOCK_DISMISSED: 'Descartó una propuesta de bloqueo',
  CITIZEN_UNBLOCKED: 'Levantó el bloqueo de un vecino',
  STRIKE_ANNULLED: 'Anuló una falta',
  REVIEW_RESOLVED: 'Respondió una solicitud de revisión',
  AREA_CREATED: 'Creó un área',
  AREA_UPDATED: 'Modificó un área',
  AREA_RULES_UPDATED: 'Cambió qué reportes atiende cada área',
  AREA_MODE_CHANGED: 'Cambió el modo de las áreas',
  ALERT_AREA_CHANGED: 'Pasó una alerta a otra área',
};

/** Cómo llegó una alerta a su área (0013). Se usa en "Área: Aseo y ornato, {source}". */
export const AREA_SOURCE: Record<AreaSource, string> = {
  AUTO: 'según las reglas del municipio',
  AI: 'según la clasificación del agente',
  OPERATOR: 'asignada por la central',
};

/** Aviso fijo bajo la barra superior según el estado del municipio (0010). Activo: sin aviso. */
export const TENANT_STATUS_NOTICE: Partial<Record<TenantStatus, string>> = {
  ONBOARDING:
    'Municipio en implementación: solo llegan a esta central las alertas de los teléfonos de prueba. Los vecinos aún ven "fuera de cobertura".',
  SUSPENDED:
    'Servicio suspendido por Guard-IA: los SOS y reportes siguen llegando con normalidad, pero no se pueden crear cuentas nuevas. Contacta a Guard-IA.',
};

export const IMPORTANCE: Record<ImportanceLevel, string> = {
  CRITICA: 'Crítica',
  ALTA: 'Alta',
  MEDIA: 'Media',
  BAJA: 'Baja',
};

/** Por qué una situación tiene la importancia que tiene (se muestra en la ficha). */
export const IMPORTANCE_REASON: Record<ImportanceReason, string> = {
  SOS: 'Es un SOS',
  PRIORITY_HIGH: 'La IA la clasificó urgente',
  PRIORITY_MEDIUM: 'La IA la clasificó de prioridad media',
  UNCLASSIFIED_SOS: 'SOS aún sin clasificar: se trata como urgente',
  MANY_CITIZENS: 'Varios vecinos la reportaron',
  RECURRENT: 'Ya se había resuelto aquí y volvió',
  DANGEROUS_CATEGORY: 'Riesgo para el tránsito',
  WEAPON: 'Mencionan un arma',
  INJURED: 'Hay personas heridas',
  MINOR: 'Hay un menor involucrado',
  POSSIBLE_FALSE_ALARM: 'Posible falsa alarma (un solo reporte)',
  LOW_TRUST: 'Vecino con baja confianza (un solo reporte)',
};

/**
 * Cuánto lleva esperando, para la cola: 0:42 y 12:05 en la primera hora (el operador cuenta
 * segundos), después "hace 3 h" o "hace 2 d" (un reloj "22 h 06" se confunde con una hora del día).
 */
export function formatWait(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s < 86_400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86_400)} d`;
}

/** "hace 5 min", "hace 3 h": para el último reporte de un grupo. */
export function formatSince(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return 'recién';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86_400)} d`;
}

/** Duración en segundos como la lee un supervisor: 45 s, 3 min, 1 h 20. */
export function formatDuration(s: number | null): string {
  if (s === null) return '—';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')}`;
}

export const FLAG: Record<string, string> = {
  possible_false_alarm: 'Posible falsa alarma',
  weapon_mentioned: 'Menciona un arma',
  people_injured: 'Heridos',
  minor_involved: 'Menor involucrado',
  language_other_than_spanish: 'Otro idioma',
  security_relevant: 'Carácter de seguridad',
};

export function categoryLabel(c: AlertCategory | null, fallback = 'Sin clasificar') {
  return c ? CATEGORY[c] : fallback;
}

/** "Violencia o agresión · violencia intrafamiliar". */
export function classificationLabel(c: AlertCategory | null, sub: string | null | undefined, fallback = 'Sin clasificar') {
  const s = subcategoryLabel(sub);
  return s ? `${categoryLabel(c, fallback)} · ${s}` : categoryLabel(c, fallback);
}

/** 1.ª, 2.ª, 3.ª… */
export function ordinal(n: number): string {
  return `${n}.ª`;
}

/** Qué pasa con la cuenta del vecino si se pone esta falta (escalera de 0011, mismos umbrales que la base). */
export function strikeConsequence(nextStrike: number, openBlock: 'PROPOSED' | 'ACTIVE' | null): string {
  const n = `Será su ${ordinal(nextStrike)} falta en 90 días`;
  if (nextStrike <= 1) return `${n}: recibe una advertencia y su confianza baja 25 puntos.`;
  if (nextStrike === 2) {
    return `${n}: la cuenta queda restringida (su SOS entra en prioridad media y no puede enviar reportes urbanos).`;
  }
  if (openBlock) return `${n}: ya tiene un bloqueo ${openBlock === 'ACTIVE' ? 'vigente' : 'propuesto'}; no se propone otro.`;
  return `${n}: se propondrá bloquear su cuenta. Lo decide un supervisor o el administrador, no quien rechaza.`;
}

/** Plazo de un bloqueo: "30 días", "6 meses" o "sin plazo". */
export function blockDays(days: number | null): string {
  if (days === null) return 'sin plazo';
  return days === 180 ? '6 meses' : `${days} días`;
}

/** "Carabineros, SAMU y Bomberos". */
export function agencyList(list: readonly SuggestedAgency[]): string {
  const names = list.map((a) => AGENCY_SHORT[a]);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}

/** Edad de una alerta como lo lee un operador: 0:42, 12:05, 1 h 03. */
export function formatAge(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')}`;
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(iso));
}
