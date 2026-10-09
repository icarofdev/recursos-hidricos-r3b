// Maintain this local blocklist as password guidance changes. Compare case-insensitively
// after Unicode compatibility normalization; never apply it to existing login attempts.
const commonPasswords = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  'admin123',
  'admin123!',
  'admin@123',
  'changeme123!',
  'iloveyou123!',
  'letmein123!',
  'password',
  'password1',
  'password123',
  'password123!',
  'password@123',
  'qwerty123',
  'qwerty123!',
  'senha123',
  'senha123!',
  'senha1234',
  'senha@123',
  'welcome123!',
]);

export function isCommonPassword(value: string): boolean {
  return commonPasswords.has(value.normalize('NFKC').trim().toLowerCase());
}
