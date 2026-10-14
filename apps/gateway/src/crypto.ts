import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Random alphanumeric secret (no modulo bias: randomInt is uniform). */
export const generateSecret = (length = 24): string => Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export const encrypt = (plain: string, key: Buffer): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

export const decrypt = (encoded: string, key: Buffer): string => {
  const raw = Buffer.from(encoded, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

/** 32-byte key from a 64-hex-char string (the SECRETS_KEY variable). */
export const parseKey = (hex: string): Buffer => {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('SECRETS_KEY must be 64 hexadecimal characters (32 bytes)')
  return Buffer.from(hex, 'hex')
}
