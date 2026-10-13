import type {
  AlertDetail,
  AlertEvent,
  AlertSummary,
  CitizenAlert,
  Dispatch,
  GeoContext,
  IncidentInfo,
  MediaPublic,
  RejectReason,
  Triage,
  TriageLabel,
  Unit,
} from '@guardia/shared';
import { TriageSchema } from '@guardia/shared';
import type {
  AlertEventRow,
  AlertRow,
  DispatchRow,
  MediaRow,
  UnitRow,
} from '../db/schema';

const iso = (d: Date) => d.toISOString();

/** Un triage guardado por otra versión del agente que ya no valida se omite (la ficha sigue igual). */
function triageOrNull(v: unknown): Triage | null {
  if (!v) return null;
  const r = TriageSchema.safeParse(v);
  return r.success ? r.data : null;
}
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export interface AlertRowExtras {
  hasAudio: boolean;
  hasPhoto: boolean;
  citizenTrustScore: number | null;
  incident: IncidentInfo | null;
}

export function toAlertSummary(row: AlertRow, x: AlertRowExtras): AlertSummary {
  return {
    id: row.id,
    tenantId: row.tenantId,
    citizenId: row.citizenId,
    type: row.type,
    source: row.source,
    location: { lat: row.lat, lng: row.lng },
    accuracyM: row.accuracyM,
    category: row.category,
    subcategory: row.subcategory,
    priority: row.priority,
    suggestedAgency: row.suggestedAgency,
    aiStatus: row.aiStatus,
    aiSummary: row.aiSummary,
    status: row.status,
    hasAudio: x.hasAudio,
    hasPhoto: x.hasPhoto,
    citizenTrustScore: x.citizenTrustScore,
    citizenRestricted: row.citizenRestricted,
    incident: x.incident,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export interface AlertDetailExtras extends AlertRowExtras {
  citizenPhone: string | null;
  citizenName: string | null;
  citizenStrikes: number;
  media: MediaPublic[];
  dispatches: Dispatch[];
  events: AlertEvent[];
  triageLabel: TriageLabel | null;
  geo: GeoContext;
}

export function toAlertDetail(row: AlertRow, x: AlertDetailExtras): AlertDetail {
  return {
    ...toAlertSummary(row, x),
    addressHint: row.addressHint,
    userText: row.userText,
    transcription: row.transcription,
    aiConfidence: row.aiConfidence,
    aiFlags: (row.aiFlags as AlertDetail['aiFlags']) ?? null,
    aiError: row.aiError,
    triage: triageOrNull(row.aiTriage),
    triageLabel: x.triageLabel,
    geo: x.geo,
    acknowledgedBy: row.acknowledgedBy,
    resolvedAt: isoOrNull(row.resolvedAt),
    citizenPhone: x.citizenPhone,
    citizenName: x.citizenName,
    citizenStrikes: x.citizenStrikes,
    media: x.media,
    dispatches: x.dispatches,
    events: x.events,
  };
}

export function toDispatch(row: DispatchRow, unitCode: string): Dispatch {
  return {
    id: row.id,
    alertId: row.alertId,
    unitId: row.unitId,
    unitCode,
    operatorId: row.operatorId,
    status: row.status,
    notes: row.notes,
    outcome: row.outcome,
    outcomeNote: row.outcomeNote,
    outcomeAt: isoOrNull(row.outcomeAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    closedAt: isoOrNull(row.closedAt),
  };
}

export function toAlertEvent(row: AlertEventRow): AlertEvent {
  return {
    id: row.id,
    alertId: row.alertId,
    actorType: row.actorType,
    actorId: row.actorId,
    kind: row.kind,
    payload: row.payload,
    createdAt: iso(row.createdAt),
  };
}

export function toUnit(row: UnitRow): Unit {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    kind: row.kind,
    status: row.status,
    lastLocation:
      row.lastLat !== null && row.lastLng !== null ? { lat: row.lastLat, lng: row.lastLng } : null,
    lastSeenAt: isoOrNull(row.lastSeenAt),
  };
}

export function toMediaPublic(
  row: MediaRow,
  signed: { url: string; expiresAt: string } | null,
): MediaPublic {
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes,
    durationS: row.durationS,
    url: signed?.url ?? null,
    expiresAt: signed?.expiresAt ?? null,
  };
}

export function toCitizenAlert(
  row: AlertRow,
  tenantName: string | null,
  active: { unitCode: string; status: DispatchRow['status']; updatedAt: Date } | null,
  comunaName: string | null = null,
  closed: { reason: RejectReason; strikeCount: number | null } | null = null,
): CitizenAlert {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    category: row.category,
    status: row.status,
    tenantName,
    comunaName,
    closeReason: closed?.reason ?? null,
    strikeCount: closed?.strikeCount ?? null,
    activeDispatch: active
      ? { unitCode: active.unitCode, status: active.status, updatedAt: iso(active.updatedAt) }
      : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
