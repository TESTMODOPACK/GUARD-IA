import { hash as argonHash } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';

// Sin caracteres que se confunden al dictarlos o copiarlos (0/O, 1/l/I).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** Contraseña temporal de 14 caracteres (~80 bits). Se muestra una vez al administrador. */
export function temporaryPassword(): string {
  let out = '';
  for (let i = 0; i < 14; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export const hashPassword = (plain: string) => argonHash(plain);
