#!/usr/bin/env node
/**
 * Idempotent setup: www.anna-ciok.studio → 301 redirect to anna-ciok.studio
 * (P0-01 / SEO-001 — canonical host, confirmed live: the zone has zero rules
 * in the http_request_dynamic_redirect phase and zero Page Rules today, so
 * both apex and www serve identical content on bare 200s).
 *
 * Unlike scripts/cloudflare-com-redirect-setup.mjs (a separate zone bridging
 * a whole secondary domain), both apex and www already have real proxied
 * DNS records on this zone — no DNS step is needed here, only the redirect
 * rule itself.
 *
 * Requires a CLOUDFLARE_API_TOKEN with:
 *   - Zone Read
 *   - Single Redirect / Dynamic URL Redirects Write for anna-ciok.studio
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... node scripts/cloudflare-studio-www-redirect-setup.mjs
 *   npm run cf:studio-www-redirect
 */

const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME ?? 'anna-ciok.studio';
const TARGET_HOST = 'anna-ciok.studio';
const API_BASE = 'https://api.cloudflare.com/client/v4';
const REDIRECT_PHASE = 'http_request_dynamic_redirect';

function token() {
  const t = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!t) {
    console.error(
      'Missing CLOUDFLARE_API_TOKEN.\n' +
        'Create a token with Zone Read and Single Redirect Edit for anna-ciok.studio:\n' +
        '  https://dash.cloudflare.com/profile/api-tokens\n' +
        'Then run:\n' +
        '  CLOUDFLARE_API_TOKEN=... npm run cf:studio-www-redirect',
    );
    process.exit(1);
  }
  return t;
}

async function cf(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(
      `Cloudflare API ${options.method ?? 'GET'} ${path}: ${JSON.stringify(body.errors)}`,
    );
  }
  return body;
}

async function resolveZone() {
  const { result } = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (result.length === 0) {
    console.error(`Zone "${ZONE_NAME}" not found in this Cloudflare account/token scope.`);
    process.exit(1);
  }
  const zone = result[0];
  if (zone.status !== 'active') {
    console.warn(`Warning: zone status is "${zone.status}" (expected "active"). Continuing anyway.`);
  }
  console.log(`Zone: ${zone.name} (${zone.id}) status=${zone.status}`);
  return zone;
}

function redirectRule() {
  return {
    ref: 'studio_www_to_apex',
    description: 'studio-www-to-apex',
    expression: `(http.host eq "www.${ZONE_NAME}")`,
    action: 'redirect',
    action_parameters: {
      from_value: {
        target_url: {
          expression: `concat("https://${TARGET_HOST}", http.request.uri.path)`,
        },
        status_code: 301,
        preserve_query_string: true,
      },
    },
  };
}

async function getRedirectEntrypoint(zoneId) {
  try {
    const { result } = await cf(
      `/zones/${zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`,
    );
    return result;
  } catch (err) {
    if (String(err.message).includes('10003') || String(err.message).includes('7000')) {
      return null;
    }
    throw err;
  }
}

async function ensureRedirect(zoneId) {
  const rule = redirectRule();
  const existing = await getRedirectEntrypoint(zoneId);

  if (!existing) {
    await cf(`/zones/${zoneId}/rulesets`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Redirect rules ruleset',
        kind: 'zone',
        phase: REDIRECT_PHASE,
        rules: [rule],
      }),
    });
    console.log('Redirect ruleset created (1 rule).');
    return;
  }

  const byRef = new Map((existing.rules ?? []).map((r) => [r.ref ?? r.description, r]));
  if (byRef.has(rule.ref)) {
    console.log('Redirect rule OK (already present).');
    return;
  }
  byRef.set(rule.ref, rule);

  const merged = [...byRef.values()];
  await cf(`/zones/${zoneId}/rulesets/${existing.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: existing.name ?? 'Redirect rules ruleset',
      kind: 'zone',
      phase: REDIRECT_PHASE,
      rules: merged,
    }),
  });
  console.log(`Redirect ruleset updated (${merged.length} rule(s)).`);
}

async function main() {
  const zone = await resolveZone();
  await ensureRedirect(zone.id);
  console.log('\nDone. Verify with:');
  console.log(`  curl -sI https://www.${ZONE_NAME}/kubki/k01 | grep -iE '^(HTTP|location):'`);
  console.log(`  curl -sI https://${ZONE_NAME}/kubki/k01 | grep -iE '^HTTP:'`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
