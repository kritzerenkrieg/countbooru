import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps = async () => {
  return { props: { title: "Minimal GIF Counter" } };
};

export default function Home({ title }: { title: string }) {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Minimal multi-counter animated GIF hit counter</h1>
      <p>
        Every request to <code>{"/{anything}.gif"}</code> (for example{" "}
        <code>/ken/profile-views.gif</code>) increments a Redis counter whose
        key is the path without the <code>.gif</code> extension, then returns a
        composed animated GIF of the current number using digit sprites in{" "}
        <code>/public/</code>.
      </p>
      <ul>
        <li>
          Create an Upstash Redis database and set{" "}
          <code>UPSTASH_REDIS_REST_URL</code> /{" "}
          <code>UPSTASH_REDIS_REST_TOKEN</code> in your Vercel project settings.
        </li>
        <li>Place digit sprites <code>0.gif</code> … <code>9.gif</code> in <code>/public/</code>.</li>
        <li>Deploy with <code>vercel --prod</code>.</li>
      </ul>
      <p>
        Example paths:
      </p>
      <ul>
        <li><code>/ken/profile-views.gif</code> → Redis key <code>ken:profile-views</code></li>
        <li><code>/ken/commits.gif</code> → Redis key <code>ken:commits</code></li>
        <li><code>/project/downloads.gif</code> → Redis key <code>project:downloads</code></li>
      </ul>
    </main>
  );
}
