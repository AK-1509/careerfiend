import path from "node:path";
import type { NextConfig } from "next";

const root = path.resolve(import.meta.dirname, "../..");
/** `npm run desktop:build`: a self-contained server (.next/standalone) for the installable app. */
const desktop = process.env.CAREERFIEND_DESKTOP_BUILD === "1";

const nextConfig: NextConfig = {
  // Workspace packages are TypeScript source.
  transpilePackages: [
    "@careerfiend/core",
    "@careerfiend/shared",
    "@careerfiend/db",
    "@careerfiend/profile",
    "@careerfiend/job-parser",
    "@careerfiend/matcher",
    "@careerfiend/documents",
    "@careerfiend/bullets",
    "@careerfiend/policy",
    "@careerfiend/form-engine",
    "@careerfiend/ai",
    "@careerfiend/email",
    "@careerfiend/worker",
  ],
  // Native modules and packages that read their own files at runtime stay external.
  serverExternalPackages: [
    "playwright",
    "playwright-core",
    "@sparticuz/chromium",
    "pdfkit",
    "@prisma/client",
    "@prisma/adapter-pg",
    "pg",
    "@electric-sql/pglite",
    "pglite-prisma-adapter",
    "unpdf",
    "docx",
    "jszip",
    "cheerio",
  ],
  turbopack: { root },
  outputFileTracingRoot: root,
  ...(desktop ? { output: "standalone" as const } : {}),
  outputFileTracingIncludes: {
    // The hosted worker's Chromium (brotli archives unpacked to /tmp at run time). The desktop app uses the computer's own browser.
    ...(desktop ? {} : { "/api/worker": ["../../node_modules/@sparticuz/chromium/**/*"] }),
    // Repo root marker.
    "/**": ["../../package.json", ...(desktop ? ["../../node_modules/@electric-sql/pglite/dist/**/*"] : [])],
  },
  // Résumé PDF uploads go through a server action (Vercel caps request bodies at 4.5 MB; MAX_UPLOAD_MB defaults to 4).
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
  // No next/image in the app: skip the optimizer (scripts/build-desktop.mjs also drops its native sharp binaries).
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default nextConfig;
