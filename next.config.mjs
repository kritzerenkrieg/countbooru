/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The counter route reads the digit sprites from /public at runtime, so they
  // have to travel with the serverless function when deployed to Vercel.
  // (Next.js 14 expects this key under `experimental`.)
  experimental: {
    outputFileTracingIncludes: {
      "/api/counter/[...slug]": ["./public/*.gif"],
    },
  },
  // Same rewrite as vercel.json, but applied by `next dev` / `next start` too
  // (vercel.json rewrites are only applied by the Vercel platform or `vercel dev`).
  // "/ken/profile-views.gif" -> "/api/counter/ken/profile-views"
  async rewrites() {
    return [
      { source: "/:slug(.+)\\.gif", destination: "/api/counter/:slug" },
    ];
  },
};

export default nextConfig;
