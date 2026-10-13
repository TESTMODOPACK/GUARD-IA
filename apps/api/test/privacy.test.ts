/**
 * Derechos ARCO contra base real (pnpm test:db): export y supresión por anonimización (migración 0002).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import type { MediaService } from '../src/media/media.service';
import { PrivacyService } from '../src/privacy/privacy.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

d('derechos ARCO', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let privacy: PrivacyService;
  let citizenId: string;
  let alertId: string;
  const phone = '+5699' + String(Date.now()).slice(-7);

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    // La purga real toca el storage; aquí basta con saber que se llamó.
    privacy = new PrivacyService(dbs, { purgeExpired: async () => 0 } as unknown as MediaService);

    const [c] = await admin<{ id: string }[]>`
      INSERT INTO citizen (phone, name, consent_version, consent_at) VALUES (${phone}, 'Vecina Prueba', 'v1', now()) RETURNING id`;
    citizenId = c.id;
    const [a] = await admin<{ id: string }[]>`
      INSERT INTO alert (citizen_id, type, source, lat, lng, accuracy_m, user_text, transcription, ai_summary)
      VALUES (${citizenId}, 'EMERGENCY_SOS', 'VOICE', -33.443812, -70.653291, 8, 'vivo en calle Falsa 123', 'me están siguiendo', 'resumen')
      RETURNING id`;
    alertId = a.id;
    await admin`INSERT INTO media (alert_id, kind, storage_key, mime, bytes, retention_until)
                VALUES (${alertId}, 'AUDIO', ${'test/' + randomUUID()}, 'audio/mp4', 1000, now() + interval '90 days')`;
    await admin`INSERT INTO device (citizen_id, expo_push_token, platform) VALUES (${citizenId}, ${'ExponentPushToken[' + randomUUID() + ']'}, 'android')`;
    await admin`INSERT INTO refresh_token (kind, citizen_id, token_hash, expires_at) VALUES ('CITIZEN', ${citizenId}, ${randomUUID()}, now() + interval '1 day')`;
  });

  afterAll(async () => {
    if (citizenId) {
      await admin`DELETE FROM alert WHERE citizen_id = ${citizenId}`;
      await admin`DELETE FROM citizen WHERE id = ${citizenId}`;
    }
    await admin.end({ timeout: 5 });
    await dbs.onModuleDestroy();
  });

  it('export devuelve los datos del propio vecino', async () => {
    const out = await privacy.export(citizenId);
    expect(out.citizen.phone).toBe(phone);
    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0].userText).toBe('vivo en calle Falsa 123');
    expect(out.alerts[0].media).toHaveLength(1);
    expect(out.devices).toHaveLength(1);
  });

  it('erase_citizen rechaza a quien no es el propio vecino', async () => {
    const other = randomUUID();
    await expect(
      dbs.asCitizen(other, (tx) => tx.execute(sql`select erase_citizen(${citizenId}::uuid)`)),
    ).rejects.toThrow();
    await expect(dbs.asSystem((tx) => tx.execute(sql`select erase_citizen(${citizenId}::uuid)`))).rejects.toThrow();
    const [still] = await admin<{ phone: string }[]>`SELECT phone FROM citizen WHERE id = ${citizenId}`;
    expect(still.phone).toBe(phone);
  });

  it('la supresión anonimiza y conserva el registro del caso', async () => {
    const res = await privacy.erase(citizenId);
    expect(res.erased).toBe(true);

    const [c] = await admin<{ phone: string; name: string | null; consent_version: string | null; blocked_at: Date | null }[]>`
      SELECT phone, name, consent_version, blocked_at FROM citizen WHERE id = ${citizenId}`;
    expect(c.phone).toMatch(/^\+999\d{11}$/);
    expect(c.name).toBeNull();
    expect(c.consent_version).toBeNull();
    expect(c.blocked_at).not.toBeNull();

    const [a] = await admin<{ user_text: string | null; transcription: string | null; ai_summary: string | null; lat: number; lng: number; accuracy_m: number | null; type: string }[]>`
      SELECT user_text, transcription, ai_summary, lat, lng, accuracy_m, type FROM alert WHERE id = ${alertId}`;
    expect(a.type).toBe('EMERGENCY_SOS'); // el caso sigue en el registro
    expect([a.user_text, a.transcription, a.ai_summary, a.accuracy_m]).toEqual([null, null, null, null]);
    expect(a.lat).toBe(-33.444);
    expect(a.lng).toBe(-70.653);

    const [m] = await admin<{ due: boolean }[]>`SELECT retention_until <= now() AS due FROM media WHERE alert_id = ${alertId}`;
    expect(m.due).toBe(true);
    const [{ n: devices }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM device WHERE citizen_id = ${citizenId}`;
    const [{ n: tokens }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM refresh_token WHERE subject_id = ${citizenId}`;
    expect([devices, tokens]).toEqual([0, 0]);

    // El número real queda libre para registrarse de nuevo.
    const [{ n: taken }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM citizen WHERE phone = ${phone}`;
    expect(taken).toBe(0);
  });
});
