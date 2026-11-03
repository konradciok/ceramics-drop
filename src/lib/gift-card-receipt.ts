const encoder = new TextEncoder();
const PURPOSE = 'gift-card-order-receipt-v1';

async function key(secret: string, usage: Array<'sign' | 'verify'>) {
  if (!secret) throw new Error('Receipt signing unavailable');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}
function encoded(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export async function createGiftCardReceipt(orderId: string, secret: string, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + 7 * 86400;
  const signature = await crypto.subtle.sign('HMAC', await key(secret,['sign']), encoder.encode(`${PURPOSE}:${orderId}:${expires}`));
  return `${expires}.${encoded(new Uint8Array(signature))}`;
}
export async function verifyGiftCardReceipt(orderId: string, token: string, secret: string, now = Date.now()): Promise<boolean> {
  const match = /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || Number(match[1]) <= Math.floor(now / 1000)) return false;
  try {
    const signature = Uint8Array.from(atob(match[2].replaceAll('-','+').replaceAll('_','/')+'='), c=>c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC',await key(secret,['verify']),signature,encoder.encode(`${PURPOSE}:${orderId}:${match[1]}`));
  } catch { return false; }
}
