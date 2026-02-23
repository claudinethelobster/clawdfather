import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from 'crypto';

export function deriveAccountKEK(masterKey: string, accountId: string): Buffer {
  const keyMaterial = Buffer.from(masterKey, 'hex');
  const info = `clawdfather:account-kek:${accountId}`;
  return Buffer.from(
    hkdfSync('sha256', keyMaterial, Buffer.alloc(0), info, 32)
  );
}

export function encryptPrivateKey(plaintext: string, kek: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${nonce.toString('base64')}:${ciphertext.toString('base64')}:${authTag.toString('base64')}`;
}

export function decryptPrivateKey(encrypted: string, kek: Buffer): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted key format');
  const nonce = Buffer.from(parts[0], 'base64');
  const ciphertext = Buffer.from(parts[1], 'base64');
  const authTag = Buffer.from(parts[2], 'base64');
  const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

export function generateSessionToken(): string {
  return 'clf_' + randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function computeEd25519Fingerprint(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2) throw new Error('Invalid OpenSSH public key format');
  const keyData = Buffer.from(parts[1], 'base64');
  const hash = createHash('sha256').update(keyData).digest('base64');
  const trimmed = hash.replace(/=+$/, '');
  return `SHA256:${trimmed}`;
}
