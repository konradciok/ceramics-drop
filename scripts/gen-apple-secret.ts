/**
 * Mint the Sign in with Apple client-secret JWT for the Supabase Apple
 * provider (ES256, Apple-capped at 6 months validity — see
 * docs/customer-accounts-runbook.md for the rotation procedure).
 *
 * Usage:
 *   npm run apple:client-secret -- \
 *     --key ./AuthKey_ABC123XYZ.p8 \
 *     --key-id ABC123XYZ \
 *     --team-id TEAMID1234 \
 *     --services-id studio.anna-ciok.web \
 *     [--days 180]
 *
 * Prints the JWT to stdout — paste it into Supabase Dashboard → Auth →
 * Providers → Apple → "Secret Key". Nothing is written to disk and the .p8
 * never leaves your machine.
 */
import { readFileSync } from 'node:fs';
import { SignJWT, importPKCS8 } from 'jose';

const MAX_DAYS = 180; // Apple rejects exp > 15777000s (~6 months) from iat.

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const keyPath = arg('key');
  const keyId = arg('key-id');
  const teamId = arg('team-id');
  const servicesId = arg('services-id');
  const days = Math.min(Number(arg('days') ?? MAX_DAYS), MAX_DAYS);

  if (!keyPath || !keyId || !teamId || !servicesId || !Number.isFinite(days) || days <= 0) {
    console.error(
      'Usage: npm run apple:client-secret -- --key <AuthKey_XXX.p8> --key-id <KEYID> --team-id <TEAMID> --services-id <SERVICES_ID> [--days 180]',
    );
    process.exit(1);
  }

  const pkcs8 = readFileSync(keyPath, 'utf8');
  const privateKey = await importPKCS8(pkcs8, 'ES256');

  const nowSecs = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId) // Apple Developer Team ID
    .setSubject(servicesId) // the Services ID acting as OAuth client_id
    .setAudience('https://appleid.apple.com')
    .setIssuedAt(nowSecs)
    .setExpirationTime(nowSecs + days * 24 * 60 * 60)
    .sign(privateKey);

  const expires = new Date((nowSecs + days * 24 * 60 * 60) * 1000).toISOString().slice(0, 10);
  console.error(`Apple client secret (expires ${expires} — set a rotation reminder ~1 month earlier):\n`);
  console.log(jwt);
}

main().catch((err) => {
  console.error('apple client secret generation failed:', err);
  process.exit(1);
});
