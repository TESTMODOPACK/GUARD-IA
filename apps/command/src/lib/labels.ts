import type {
  AiStatus,
  AlertCategory,
  AlertEventKind,
  AlertSource,
  AlertStatus,
  AuditKind,
  ContactCategory,
  DispatchStatus,
  ImportanceLevel,
  ImportanceReason,
  OperatorRole,
  Priority,
  RejectReason,
  Subcategory,
  SuggestedAgency,
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

export const DISPATCH_STATUS: Record<DispatchStatus, string> = {
  ASSIGNED: 'Asignada',
  EN_ROUTE: 'En camino',
  ON_SITE: 'En el lugar',
  CLOSED: 'Cerrado',
  CANCELLED: 'Cancelado',
};

export const UNIT_STATUS: Record<UnitStatus, string> = {
  AVAILABLE: 'Disponible',
  BUSY: 'Ocupada',
  OFFLINE: 'Fuera de servicio',
};

export const REJECT_REASON: Record<RejectReason, string> = {
  FALSE_ALARM: 'Falsa alarma',
  DUPLICATE: 'Duplicada',
  OUT_OF_SCOPE: 'Fuera del ámbito municipal',
  TEST: 'Prueba',
  OTHER: 'Otro motivo',
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
};

export const ROLE: Record<OperatorRole, string> = {
  ADMIN: 'Administrador',
  SUPERVISOR: 'Supervisor',
  OPERATOR: 'Operador',
};

export const ROLE_HELP: Record<OperatorRole, string> = {
  ADMIN: 'Todo, incluidos usuarios',
  SUPERVISOR: 'Turnos, directorio, unidades y panel',
  OPERATOR: 'Atiende alertas y marca su turno',
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
};

export function categoryLabel(c: AlertCategory | null, fallback = 'Sin clasificar') {
  return c ? CATEGORY[c] : fallback;
}

/** "Violencia o agresión · violencia intrafamiliar". */
export function classificationLabel(c: AlertCategory | null, sub: string | null | undefined, fallback = 'Sin clasificar') {
  const s = subcategoryLabel(sub);
  return s ? `${categoryLabel(c, fallback)} · ${s}` : categoryLabel(c, fallback);
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
