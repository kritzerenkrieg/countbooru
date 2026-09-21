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
  // Rewrites are matched in definition order, so the more specific `.gif` rule
  // comes first. Both forms below hit the counter:
  //   /ken/profile-views.gif  -> /api/counter/ken/profile-views
  //   /ken/profile-views      -> /api/counter/ken/profile-views   (fallback)
  async rewrites() {
    return [
      { source: "/:slug(.+)\\.gif", destination: "/api/counter/:slug" },
      { source: "/:slug(.+)", destination: "/api/counter/:slug" },
    ];
  },
};

export default nextConfig;
