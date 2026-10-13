import path from "node:path";
import type { NextConfig } from "next";

const root = path.resolve(import.meta.dirname, "../..");

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
  outputFileTracingIncludes: {
    // The hosted worker's Chromium (brotli archives unpacked to /tmp at run time).
    "/api/worker": ["../../node_modules/@sparticuz/chromium/**/*"],
    // Repo root marker.
    "/**": ["../../package.json"],
  },
  // Résumé PDF uploads go through a server action (Vercel caps request bodies at 4.5 MB; MAX_UPLOAD_MB defaults to 4).
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
  poweredByHeader: false,
};

export default nextConfig;
