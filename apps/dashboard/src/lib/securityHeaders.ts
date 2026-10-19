interface SecurityHeadersOptions {
  apiUrl: string;
  isProduction: boolean;
}

interface HeaderEntry {
  key: string;
  value: string;
}

function toWebSocketOrigin(origin: string): string {
  return origin.replace(/^http/, "ws");
}

function buildContentSecurityPolicy({ apiUrl, isProduction }: SecurityHeadersOptions): string {
  const apiOrigin = new URL(apiUrl).origin;

  // 'unsafe-inline' is required for scripts: Next.js emits inline bootstrap
  // scripts and next-themes injects an inline theme script to avoid a flash of
  // the wrong theme. Removing it needs per-request nonces, which forces every
  // page to render dynamically. 'unsafe-eval' is development-only (React
  // Refresh) and never sent in production.
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(isProduction ? [] : ["'unsafe-eval'"])];

  // Socket.io connects to the API origin over polling and WebSocket.
  const connectSrc = [
    "'self'",
    apiOrigin,
    toWebSocketOrigin(apiOrigin),
    ...(isProduction ? [] : ["ws://localhost:*"]),
  ];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    // Tailwind/shadcn and sonner set inline styles at runtime.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": connectSrc,
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    // The GitHub App setup posts a form to github.com (the manifest flow in
    // useGitHub.ts), and GitHub then redirects back to the API, so both must be
    // allowed or "Create GitHub App" is silently blocked.
    "form-action": ["'self'", "https://github.com", apiOrigin],
    // Clickjacking protection: the panel is never legitimately embedded.
    "frame-ancestors": ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

/**
 * Response headers applied to every dashboard route (#73).
 * @param options - API origin the browser talks to, and whether this is a production build
 * @returns Header entries in the shape Next.js `headers()` expects
 */
export function buildSecurityHeaders(options: SecurityHeadersOptions): HeaderEntry[] {
  const headers: HeaderEntry[] = [
    { key: "Content-Security-Policy", value: buildContentSecurityPolicy(options) },
    // Older browsers that predate CSP frame-ancestors.
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];

  if (options.isProduction) {
    // No includeSubDomains/preload: this commits the browser to HTTPS on the
    // exact host only, so it cannot break a sibling subdomain that serves HTTP.
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
  }

  return headers;
}
