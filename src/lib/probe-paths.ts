/** Matches common vuln-scanner probe paths so the Worker can 404 them early
 *  (before OpenNext logs them as errors / Sentry ingests them). */
// The credentials/sysinfo/phpinfo/config/backup group is anchored to the path
// ROOT (^\/) so a legitimate nested asset like /uploads/backup.webp is NOT
// matched — only /backup.* etc. at the root are treated as probes.
const PROBE_PATH = /(^\/\.(env|git|aws|ssh))|(\/wp-(login|admin|content))|(^\/(credentials|sysinfo|phpinfo|config|backup)\.)|(\.(php|cgi|asp|aspx)$)/i;

export function isProbePath(pathname: string): boolean {
  return PROBE_PATH.test(pathname);
}
