'use client';

import {
  BLOCK_DAYS,
  BLOCK_REPEAT_DAYS,
  type AccountsOverview,
  type BlockItem,
  type ReviewItem,
  type StrikeItem,
} from '@guardia/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { blockDays, formatDateTime } from '@/lib/labels';
import { AdminShell, Card, errText, Notice, useOperatorSession } from '@/components/admin/AdminShell';
import { Button, Dialog, Field, Spinner, Tag, textareaClass } from '@/components/ui';

type DialogState =
  | { kind: 'approve'; block: BlockItem }
  | { kind: 'dismiss'; block: BlockItem }
  | { kind: 'lift'; block: BlockItem }
  | { kind: 'annul'; strike: StrikeItem }
  | { kind: 'review'; review: ReviewItem; grant: boolean }
  | null;

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

/**
 * Cuentas de vecinos (uso indebido, migración 0011; docs/plan-plataforma.md §5b). Lo que decide este municipio:
 * propuestas de bloqueo (la 3.ª falta), revisiones que pidieron los vecinos, bloqueos vigentes y faltas recientes.
 * Dos personas para bloquear: quien rechazó la alerta propone, otra persona decide.
 */
export default function AccountsPage() {
  const session = useOperatorSession(['ADMIN', 'SUPERVISOR']);
  const [data, setData] = useState<AccountsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.accounts());
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  if (!session) return null;
  const me = session.operator.id;
  const isAdmin = session.operator.role === 'ADMIN';

  const done = (next: AccountsOverview, text: string) => {
    setData(next);
    setDialog(null);
    setNotice(text);
  };

  return (
    <AdminShell session={session} title="Cuentas de vecinos">
      <p className="text-sm text-ink-muted -mt-3">
        Con 2 avisos falsos en 90 días la cuenta queda restringida (su SOS entra en prioridad media y no puede enviar reportes
        urbanos). La 3.ª falta propone un bloqueo, que decide una persona distinta de quien rechazó. Bloqueada, la app solo muestra
        los números de emergencia y cómo pedir revisión.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {!data ? (
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner /> Cargando…
        </div>
      ) : (
        <>
          <Card title={`Bloqueos por aprobar (${data.proposals.length})`}>
            {data.proposals.length === 0 ? (
              <p className="text-sm text-ink-muted">Ninguno.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.proposals.map((b) => {
                  const own = b.proposedById === me;
                  return (
                    <li key={b.id} className="py-3 flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{b.citizen.label}</div>
                        <div className="text-xs text-ink-muted">
                          {b.strikes} avisos falsos vigentes · propuesto por {b.proposedBy} el {formatDateTime(b.proposedAt)} · sugerido:{' '}
                          {blockDays(b.suggestedDays)}
                        </div>
                        {own ? <div className="text-xs text-medium mt-0.5">Lo propusiste tú: debe decidirlo otra persona.</div> : null}
                      </div>
                      <Button variant="danger" disabled={own} onClick={() => setDialog({ kind: 'approve', block: b })}>
                        Aprobar bloqueo
                      </Button>
                      <Button variant="quiet" disabled={own} onClick={() => setDialog({ kind: 'dismiss', block: b })}>
                        Descartar
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title={`Revisiones pendientes (${data.reviews.length})`}>
            {data.reviews.length === 0 ? (
              <p className="text-sm text-ink-muted">Ninguna.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.reviews.map((r) => (
                  <li key={r.id} className="py-3 space-y-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-medium">{r.citizen.label}</span>
                      <span className="text-xs text-ink-muted">
                        {r.targetSummary} · pedida el {formatDateTime(r.createdAt)}
                      </span>
                    </div>
                    {/* Texto del vecino: siempre como texto, nunca HTML (regla 9). */}
                    <blockquote className="text-sm border-l-2 border-line-strong pl-3 whitespace-pre-wrap">{r.text}</blockquote>
                    <div className="flex gap-2">
                      <Button variant="primary" onClick={() => setDialog({ kind: 'review', review: r, grant: true })}>
                        {r.target === 'STRIKE' ? 'Acoger y anular la falta' : 'Acoger y levantar el bloqueo'}
                      </Button>
                      <Button variant="quiet" onClick={() => setDialog({ kind: 'review', review: r, grant: false })}>
                        Mantener
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Bloqueos vigentes (${data.activeBlocks.length})`}>
            {data.activeBlocks.length === 0 ? (
              <p className="text-sm text-ink-muted">Ninguno.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.activeBlocks.map((b) => (
                  <li key={b.id} className="py-3 flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{b.citizen.label}</div>
                      <div className="text-xs text-ink-muted">
                        {b.endsAt ? `Hasta el ${formatDate(b.endsAt)}` : 'Sin plazo'} · aprobó {b.decidedBy ?? '—'}
                        {b.decisionNote ? ` · ${b.decisionNote}` : ''}
                      </div>
                    </div>
                    <Button variant="quiet" onClick={() => setDialog({ kind: 'lift', block: b })}>
                      Levantar bloqueo
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Faltas de los últimos 90 días">
            {data.strikes.length === 0 ? (
              <p className="text-sm text-ink-muted">Ninguna.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-ink-muted text-left">
                    <tr>
                      <th className="py-2 pr-3 font-normal">Fecha</th>
                      <th className="py-2 pr-3 font-normal">Vecino</th>
                      <th className="py-2 pr-3 font-normal">Evidencia</th>
                      <th className="py-2 pr-3 font-normal">La puso</th>
                      <th className="py-2 pr-3 font-normal">Estado</th>
                      <th className="py-2 font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.strikes.map((s) => (
                      <tr key={s.id} className="border-t border-line align-top">
                        <td className="py-2 pr-3 whitespace-nowrap text-ink-muted">{formatDateTime(s.createdAt)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{s.citizen.label}</td>
                        <td className="py-2 pr-3 max-w-[420px] whitespace-pre-wrap">{s.note}</td>
                        <td className="py-2 pr-3 whitespace-nowrap text-ink-muted">{s.decidedBy}</td>
                        <td className="py-2 pr-3">
                          {s.annulledAt ? (
                            <span title={s.annulReason ?? undefined}>
                              <Tag tone="neutral">Anulada</Tag>
                            </span>
                          ) : new Date(s.expiresAt) > new Date() ? (
                            <Tag tone="medium">Vigente hasta {formatDate(s.expiresAt)}</Tag>
                          ) : (
                            <Tag tone="neutral">Vencida</Tag>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          {!s.annulledAt ? (
                            <Button variant="ghost" className="h-8" onClick={() => setDialog({ kind: 'annul', strike: s })}>
                              Anular
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {dialog?.kind === 'approve' ? (
        <ApproveDialog
          block={dialog.block}
          canIndefinite={isAdmin}
          onClose={() => setDialog(null)}
          onDone={(next) => done(next, 'Bloqueo aprobado: el vecino fue avisado.')}
        />
      ) : null}
      {dialog?.kind === 'dismiss' ? (
        <TextDialog
          title="Descartar la propuesta de bloqueo"
          intro={`${dialog.block.citizen.label} no quedará bloqueado. Las faltas siguen vigentes.`}
          label="Motivo"
          confirmLabel="Descartar"
          onClose={() => setDialog(null)}
          onConfirm={async (note) =>
            done(await api.decideBlock(dialog.block.id, { approve: false, note }), 'Propuesta descartada.')
          }
        />
      ) : null}
      {dialog?.kind === 'lift' ? (
        <TextDialog
          title="Levantar el bloqueo"
          intro={`${dialog.block.citizen.label} podrá volver a usar la app desde ahora.`}
          label="Motivo"
          confirmLabel="Levantar"
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => done(await api.liftBlock(dialog.block.id, reason), 'Bloqueo levantado: el vecino fue avisado.')}
        />
      ) : null}
      {dialog?.kind === 'annul' ? (
        <TextDialog
          title="Anular la falta"
          intro="Se le devuelve la confianza al vecino y se le avisa. Si con esto ya no tiene 3 faltas, la propuesta de bloqueo abierta se descarta."
          label="Motivo"
          confirmLabel="Anular"
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => done(await api.annulStrike(dialog.strike.id, reason), 'Falta anulada: el vecino fue avisado.')}
        />
      ) : null}
      {dialog?.kind === 'review' ? (
        <TextDialog
          title={dialog.grant ? 'Acoger la revisión' : 'Mantener la decisión'}
          intro={
            dialog.grant
              ? dialog.review.target === 'STRIKE'
                ? 'Se anula la falta y se le responde al vecino.'
                : 'Se levanta el bloqueo (o se descarta la propuesta) y se le responde al vecino.'
              : 'La falta o el bloqueo se mantienen. Explícale al vecino por qué.'
          }
          label="Respuesta al vecino (la recibe tal cual)"
          confirmLabel={dialog.grant ? 'Acoger y responder' : 'Mantener y responder'}
          onClose={() => setDialog(null)}
          onConfirm={async (response) =>
            done(await api.resolveReview(dialog.review.id, { grant: dialog.grant, response }), 'Revisión respondida.')
          }
        />
      ) : null}
    </AdminShell>
  );
}

function ApproveDialog({
  block,
  canIndefinite,
  onClose,
  onDone,
}: {
  block: BlockItem;
  canIndefinite: boolean;
  onClose: () => void;
  onDone: (next: AccountsOverview) => void;
}) {
  const [days, setDays] = useState<number | null>(block.suggestedDays);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options: { value: number | null; label: string; help: string }[] = [
    { value: BLOCK_DAYS, label: '30 días', help: 'Primer bloqueo' },
    { value: BLOCK_REPEAT_DAYS, label: '6 meses', help: 'Reincidencia: ya cumplió un bloqueo en el último año' },
    ...(canIndefinite ? [{ value: null, label: 'Sin plazo', help: 'Solo por acoso o reincidencia grave' }] : []),
  ];
  return (
    <Dialog title="Aprobar el bloqueo" onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          {block.citizen.label} tiene {block.strikes} avisos falsos vigentes. Bloqueado, no podrá enviar SOS ni reportes desde la app;
          verá los números 133, 131 y 132 y cómo pedir revisión.
        </p>
        <fieldset className="space-y-1.5">
          <legend className="text-xs text-ink-muted mb-1">Plazo</legend>
          {options.map((o) => (
            <label
              key={String(o.value)}
              className={`flex gap-2 rounded-ctl border px-2.5 py-1.5 text-sm cursor-pointer ${days === o.value ? 'border-accent bg-accent/10' : 'border-line'}`}
            >
              <input type="radio" name="block-days" className="mt-1" checked={days === o.value} onChange={() => setDays(o.value)} />
              <span>
                <span className="font-medium">{o.label}</span>
                <span className="block text-xs text-ink-muted">{o.help}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label="Motivo (queda en la bitácora)">
          <textarea className={textareaClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button
          variant="danger"
          busy={busy}
          disabled={note.trim().length < 5}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              onDone(await api.decideBlock(block.id, { approve: true, days: days as 30 | 180 | null, note: note.trim() }));
            } catch (e) {
              setError(errText(e));
              setBusy(false);
            }
          }}
        >
          Bloquear {blockDays(days)}
        </Button>
      </div>
    </Dialog>
  );
}

function TextDialog({
  title,
  intro,
  label,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  intro: string;
  label: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={title} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{intro}</p>
        <Field label={label}>
          <textarea className={textareaClass} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={text.trim().length < 5}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm(text.trim());
            } catch (e) {
              setError(errText(e));
              setBusy(false);
            }
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
