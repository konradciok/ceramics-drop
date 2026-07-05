#!/usr/bin/env node
/**
 * Idempotent setup: anna-ciok.com → 301 redirect to anna-ciok.studio
 *
 * Requires CLOUDFLARE_API_TOKEN with:
 *   - Zone Read (+ Zone Create if the zone is not onboarded yet)
 *   - DNS Edit for anna-ciok.com
 *   - Single Redirect / Dynamic URL Redirects Write for anna-ciok.com
 *
 * One-time prerequisite: anna-ciok.com must exist as an Active zone in Cloudflare
 * (Cloudflare Registrar domains usually auto-onboard; otherwise add via dashboard).
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... node scripts/cloudflare-com-redirect-setup.mjs
 *   npm run cf:com-redirect
 */

const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME ?? 'anna-ciok.com';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '3ebc59b80b15b6b4850ae0734a24ce26';
const TARGET_HOST = 'anna-ciok.studio';
const PLACEHOLDER_IP = '192.0.2.0';
const API_BASE = 'https://api.cloudflare.com/client/v4';
const REDIRECT_PHASE = 'http_request_dynamic_redirect';
const SKIP_ZONE_CREATE = process.env.SKIP_ZONE_CREATE === '1';

function token() {
  const t = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!t) {
    console.error(
      'Missing CLOUDFLARE_API_TOKEN.\n' +
        'Create a token with Zone Read, DNS Edit, and Single Redirect Edit for anna-ciok.com:\n' +
        '  https://dash.cloudflare.com/profile/api-tokens\n' +
        'Then run:\n' +
        '  CLOUDFLARE_API_TOKEN=... npm run cf:com-redirect',
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

function onboardingHint() {
  return (
    `Zone "${ZONE_NAME}" is not in this Cloudflare account.\n\n` +
    'One-time fix (dashboard — ~2 min):\n' +
    '  1. https://dash.cloudflare.com/?to=/:account/domains → Add a domain → anna-ciok.com → Free plan\n' +
    '     (Nameservers already point to magnolia/norman.ns.cloudflare.com — onboarding should skip NS cutover.)\n' +
    '  2. Create an API token with Zone Edit + DNS Edit + Single Redirect Edit for anna-ciok.com:\n' +
    '     https://dash.cloudflare.com/profile/api-tokens\n' +
    '  3. Re-run: CLOUDFLARE_API_TOKEN=... npm run cf:com-redirect\n'
  );
}

async function resolveZone() {
  const { result } = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (result.length > 0) {
    const zone = result[0];
    if (zone.status !== 'active') {
      console.warn(`Warning: zone status is "${zone.status}" (expected "active"). Continuing anyway.`);
    }
    console.log(`Zone: ${zone.name} (${zone.id}) status=${zone.status}`);
    return zone;
  }

  if (SKIP_ZONE_CREATE) {
    console.error(onboardingHint());
    process.exit(1);
  }

  console.log(`Zone "${ZONE_NAME}" not found — attempting API create…`);
  try {
    const { result: zone } = await cf('/zones', {
      method: 'POST',
      body: JSON.stringify({
        name: ZONE_NAME,
        account: { id: ACCOUNT_ID },
        type: 'full',
      }),
    });
    console.log(`Zone created: ${zone.name} (${zone.id}) status=${zone.status}`);
    return zone;
  } catch {
    console.error(onboardingHint());
    process.exit(1);
  }
}

async function listDnsRecords(zoneId) {
  const all = [];
  let page = 1;
  for (;;) {
    const { result, result_info: info } = await cf(
      `/zones/${zoneId}/dns_records?per_page=100&page=${page}`,
    );
    all.push(...result);
    if (page >= info.total_pages) break;
    page += 1;
  }
  return all;
}

function apexName(zoneName) {
  return zoneName;
}

async function ensureDns(zoneId, zoneName) {
  const records = await listDnsRecords(zoneId);
  const wanted = [
    { name: apexName(zoneName), label: '@' },
    { name: `www.${zoneName}`, label: 'www' },
  ];

  for (const { name, label } of wanted) {
    const existing = records.find(
      (r) => r.type === 'A' && r.name === name && r.content === PLACEHOLDER_IP && r.proxied,
    );
    if (existing) {
      console.log(`DNS OK: ${label} → ${PLACEHOLDER_IP} (proxied)`);
      continue;
    }

    const conflicting = records.filter((r) => {
      if (r.type !== 'A' && r.type !== 'AAAA' && r.type !== 'CNAME') return false;
      if (label === '@') return r.name === name;
      return r.name === name;
    });
    for (const r of conflicting) {
      console.log(`Removing conflicting ${r.type} ${r.name} → ${r.content}`);
      await cf(`/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
    }

    await cf(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'A',
        name: label === '@' ? '@' : 'www',
        content: PLACEHOLDER_IP,
        proxied: true,
        ttl: 1,
      }),
    });
    console.log(`DNS created: ${label} → ${PLACEHOLDER_IP} (proxied)`);
  }
}

function redirectRules() {
  return [
    {
      ref: 'com_to_studio_apex',
      description: 'com-to-studio-apex',
      expression: `(http.host eq "${ZONE_NAME}")`,
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
    },
    {
      ref: 'com_to_studio_www',
      description: 'com-to-studio-www',
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
    },
  ];
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

async function ensureRedirects(zoneId) {
  const rules = redirectRules();
  const existing = await getRedirectEntrypoint(zoneId);

  if (!existing) {
    await cf(`/zones/${zoneId}/rulesets`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Redirect rules ruleset',
        kind: 'zone',
        phase: REDIRECT_PHASE,
        rules,
      }),
    });
    console.log('Redirect ruleset created (2 rules).');
    return;
  }

  const byRef = new Map((existing.rules ?? []).map((r) => [r.ref ?? r.description, r]));
  let changed = false;
  for (const rule of rules) {
    if (!byRef.has(rule.ref)) {
      byRef.set(rule.ref, rule);
      changed = true;
    }
  }

  if (!changed && existing.rules?.length === rules.length) {
    console.log('Redirect rules OK (2 rules already present).');
    return;
  }

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
  await ensureDns(zone.id, zone.name);
  await ensureRedirects(zone.id);
  console.log('\nDone. Verify with:');
  console.log(`  curl -sI https://${ZONE_NAME}/kubki/k01 | grep -iE '^(HTTP|location):'`);
  console.log(`  curl -sI https://www.${ZONE_NAME}/en | grep -iE '^(HTTP|location):'`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
