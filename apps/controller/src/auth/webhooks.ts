export async function verifyWebhookSignature(payload: string, signature: string | null, secret: string | undefined): Promise<boolean> {
  if (!signature || !secret) return false;
  const expectedPrefix = 'sha256=';
  if (!signature.startsWith(expectedPrefix)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  const actual = signature.slice(expectedPrefix.length);
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return difference === 0;
}
