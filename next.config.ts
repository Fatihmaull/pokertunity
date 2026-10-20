import type { NextConfig } from 'next';

/**
 * The content policy.
 *
 * This page asks a wallet to sign things, so an injected script would be a
 * signing prompt the reader trusts. React escapes what it renders, which is the
 * first defence; this is the one that holds if that ever fails.
 *
 * `unsafe-inline` on scripts is deliberate. The framework inlines its own
 * bootstrap, and dropping the directive needs a per-request nonce threaded
 * through middleware. The policy still buys the thing that matters most:
 * `script-src 'self'` loads scripts from this origin alone, and
 * `connect-src 'self'` keeps every fetch on this origin. Wallets run as
 * extensions and talk to their own nodes outside the page, so both directives
 * leave them free.
 */
const csp = [
  "default-src 'self'",
  // `unsafe-eval` is for development, where React Refresh evaluates the modules
  // it hot-swaps. A production build is eval-free, so production ships the
  // narrower policy.
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Every page here is top-level, and a signing prompt inside somebody else's
  // frame is the whole shape of a clickjacking attack.
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const nextConfig: NextConfig = {
  reactCompiler: true,

  // The protocol package ships TypeScript source, so that
  // one edit to a frame fails to compile on both sides at once.
  transpilePackages: ['@pokertunity/protocol'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'content-security-policy', value: csp },
          { key: 'x-content-type-options', value: 'nosniff' },
          // Belt and braces with frame-ancestors, for anything that predates it.
          { key: 'x-frame-options', value: 'DENY' },
          // A wallet address in a path stays on this site.
          { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
          { key: 'permissions-policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          {
            key: 'strict-transport-security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
