import { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv } from 'crypto';
import { env } from './env';

export function generateToken(numBytes: number = 32): string {
  return randomBytes(numBytes).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function deriveAccountKEK(accountId: string): Buffer {
  const masterKeyBuffer = Buffer.from(env.masterKey, 'hex');
  return createHmac('sha256', masterKeyBuffer).update(accountId).digest();
}

export function encryptPrivateKey(pem: string, kek: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const encrypted = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('base64') + ':' + encrypted.toString('base64') + ':' + tag.toString('base64');
}

export function decryptPrivateKey(encrypted: string, kek: Buffer): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted key format');
  const iv = Buffer.from(parts[0], 'base64');
  const ciphertext = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const decipher = createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

export function computeEd25519Fingerprint(publicKeySSH: string): string {
  const parts = publicKeySSH.trim().split(/\s+/);
  const keyData = Buffer.from(parts.length >= 2 ? parts[1] : parts[0], 'base64');
  const hash = createHash('sha256').update(keyData).digest('base64');
  const noPadding = hash.replace(/=+$/, '');
  return `SHA256:${noPadding}`;
}
