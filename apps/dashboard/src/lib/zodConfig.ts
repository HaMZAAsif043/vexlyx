import { z } from "zod";

// Zod's JIT compiles validators with `new Function`. The dashboard's
// Content-Security-Policy deliberately has no 'unsafe-eval' (securityHeaders.ts),
// so the browser blocks that probe and reports a console error on every page load
// even though Zod falls back to its normal parser. Turning JIT off up front avoids
// the probe; the cost is negligible for forms this small.
z.config({ jitless: true });
