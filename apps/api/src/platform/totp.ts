import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Segundo factor de la consola de plataforma: TOTP (RFC 6238, HMAC-SHA1, 6 dígitos, pasos de 30 s), el que
 * entienden Google Authenticator, Microsoft Authenticator, 1Password y similares. Sin dependencias.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Tolerancia de reloj: el paso actual y uno antes o después (±30 s). */
const WINDOW = 1;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('base32 inválido');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Secreto nuevo de 160 bits en base32 (lo que se escribe en la app de autenticación). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, '0');
}

/**
 * Devuelve el paso aceptado o null. Un paso igual o anterior al último usado se rechaza: el mismo código
 * no sirve dos veces aunque siga dentro de su ventana.
 */
export function verifyTotp(secretB32: string, code: string, lastStep: number | null, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(nowMs);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = now + d;
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secretB32, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Cifrado del secreto TOTP en la base (AES-256-GCM). La llave sale de PLATFORM_ENCRYPTION_KEY; quien lea la
 * base sin la llave no puede generar códigos. Formato: v1.<iv>.<tag>.<cifrado>, en base64url.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(rawKey: string) {
    this.key = createHash('sha256').update(`guardia-platform-totp:${rawKey}`).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
  }

  open(sealed: string): string {
    const [v, iv, tag, enc] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !enc) throw new Error('secreto cifrado con formato desconocido');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
  }
}
