import { describe, it, expect } from 'vitest';
import { isProbePath } from './probe-paths';

describe('vuln-scanner probe filter', () => {
  it('flags common probe paths', () => {
    for (const p of ['/.env', '/.env.local', '/wp-login.php', '/credentials.js', '/sysinfo.cgi', '/.git/config']) {
      expect(isProbePath(p)).toBe(true);
    }
  });
  it('passes real paths through', () => {
    for (const p of ['/pl', '/api/checkout', '/uploads/x.webp', '/uploads/backup.webp', '/pl/config.json', '/koszyk']) {
      expect(isProbePath(p)).toBe(false);
    }
  });
});
