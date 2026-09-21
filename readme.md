# COUNTBOORU
endpoint hit based animated counter, supported on github profile, embedded images, etc

### Live Demo: https://countbooru.vercel.app/

limited api hits, recommended to:

### host yourself, NOW!

current repo hits:
![Repo Counter](https://countbooru.vercel.app/countbooru/repo/hit.gif)

Stack
- Next.js (Pages Router, Node.js runtime)
- Upstash Redis (INCR for atomic counters)
- Vercel deployment
- GIF composition by hand: the route decodes the digit sprites (LZW, sub-blocks,
  interlacing, disposal) and re-encodes the composed frames with a hand-rolled
  LZW encoder, so no native modules, canvas or image libraries are needed.

Concept
- Any request to /{slug}.gif is rewritten by Vercel to /api/counter/{slug}.
- The path itself becomes the Redis key by replacing "/" with ":".
  Examples:
    /ken/profile-views.gif   → Redis key "ken:profile-views"
    /ken/commits.gif         → Redis key "ken:commits"
    /project/downloads.gif   → Redis key "project:downloads"
- The API route increments the counter atomically with Redis INCR, renders
  the digits from public digit sprites (0.gif .. 9.gif), composes
  a multi-frame animated GIF, and returns it with Content-Type: image/gif.

Structure
- pages/api/counter/[...slug].ts  main counter logic (catch-all, multi-segment paths)
- pages/index.tsx                tiny landing page with examples
- public/                        digit sprites (0.gif .. 9.gif)
- vercel.json                    rewrites /{slug}.gif → /api/counter/{slug}
- next.config.mjs                the same rewrite, applied by next dev / next start
- package.json
- tsconfig.json
- readme.md

Prerequisites
- Node.js 18+
- npm

Digit sprites
- Place 0.gif through 9.gif in /public/.
- Any canvas size works (the sprites shipped here are 45x100); they are composed
  left to right, so the output width is the sum of the sprite widths and the
  output height is the tallest sprite. Mixed sizes are allowed.
- Sprites are expected to use a transparent background (a transparent index in
  the color table). Their canvas is replayed frame by frame, honouring GIF
  disposal methods, and composited over a transparent canvas.
- Sprites may be animated and may have their own frame count and delays; the
  composed GIF keeps each character running on its own clock. The composed loop
  is as long as the longest sprite cycle, capped at 3 seconds
  (MAX_LOOP_CS in the route) so the payload stays small.
- Sprite files are read (and decoded once, then cached) at request time, so no
  rebuild is needed after replacing them. next.config.mjs lists them in
  experimental.outputFileTracingIncludes so they are bundled into the
  serverless function on Vercel.
- The generated GIF writes its transparent index as white, matching the
  convention of the sprites: GIF has no real alpha, so a viewer that flattens
  transparency onto the palette color still shows the characters on white
  instead of on a black box.

Environment variables (Vercel project settings, or .env locally)
- UPSTASH_REDIS_REST_URL    required   Upstash Redis REST URL
- UPSTASH_REDIS_REST_TOKEN  required   Upstash Redis REST token
  (both are shown on the database page of the Upstash console; these are the
   names Redis.fromEnv() reads, so anything copied from the dashboard just works)

Local development
- npm install
- copy .env.example to .env and fill in UPSTASH_REDIS_REST_URL /
  UPSTASH_REDIS_REST_TOKEN
  (with no credentials at all the counter route answers 503)
- npm run dev
- Visit http://localhost:3000/ken/profile-views.gif (it increments and returns a GIF)
- For a production-mode run against real Upstash Redis: npm run build && npm run start
- The .gif → /api/counter rewrite lives in next.config.mjs so `next dev` and
  `next start` behave like Vercel; the copy in vercel.json is what the Vercel
  platform applies at the edge. Keep the two in sync.

Deployment to Vercel
- Create a free Upstash Redis database at upstash.com
- Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN as environment
  variables in your Vercel project settings.
- Add your digit sprites to /public/.
- Deploy: npx vercel --prod
- Visit your domain/{slug}.gif — no API prefix, no extra routes.

Notes and tradeoffs
- This is intentionally minimal: no authentication, no dashboard, no rate
  limits, no caching beyond Redis. fork and make it yourself.
- The GIF is assembled from plain Buffer writes plus a hand-rolled LZW encoder
  (lzwEncode) and sub-block packer (packSubBlocks), so no native modules or
  image libraries are needed.
- Digit sprites do not have to match: mixed sizes, frame counts and loop speeds
  are all handled (each character keeps its own timing). What does matter is
  that sprites set a transparent background, otherwise they are drawn as opaque
  rectangles.
- Sprite decoding is cached per instance, so the first request after a cold
  start pays the decode cost and later ones only pay for encoding. Encoding
  scales with the number of digits and frames written.
- Counter values are unlimited-width decimal strings; multi-digit numbers work.
- Error handling: Redis failures return 503, render failures return 500,
  malformed paths return 400.

Credits:
https://github.com/charlie0129/aniclock - source of inspiration
@K_KOKAGE on Twitter/X - gif artist