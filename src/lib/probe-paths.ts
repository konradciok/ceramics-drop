/** Matches common vuln-scanner probe paths so the Worker can 404 them early
 *  (before OpenNext logs them as errors / Sentry ingests them). */
const PROBE_PATH = /(^\/\.(env|git|aws|ssh))|(\/wp-(login|admin|content))|(\/(credentials|sysinfo|phpinfo|config|backup)\.)|(\.(php|cgi|asp|aspx)$)/i;

export function isProbePath(pathname: string): boolean {
  return PROBE_PATH.test(pathname);
}
