import type { NextConfig } from 'next';

/** Consola de plataforma: app aparte de la central, con su propio dominio, sesión y CSP (Caddy). */
const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@guardia/shared'],
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000',
  },
};

export default nextConfig;
