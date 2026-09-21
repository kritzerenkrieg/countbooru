import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps = async () => {
  return { props: { title: "COUNTBOORU" } };
};

export default function Home({ title }: { title: string }) {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>
        COUNTBOORU — endpoint hit based animated counter
      </h1>
      <p>
         supported on github profile, embedded images, etc. Every request to{" "}
         <code>{`/{slug}`}</code> or <code>{`/{slug}.gif`}</code> (for example{" "}
         <code>/ken/profile-views.gif</code>) increments a Redis counter whose key
         is the path without the <code>.gif</code> extension, then returns a
         composed animated GIF of the current number using digit sprites in{" "}
         <code>/public/</code>.
      </p>

      <ul>
        <li>
          Create an Upstash Redis database and set{" "}
          <code>UPSTASH_REDIS_REST_URL</code> /{" "}
          <code>UPSTASH_REDIS_REST_TOKEN</code> in your Vercel project settings.
        </li>
        <li>Place digit sprites <code>0.gif</code> … <code>9.gif</code> in{" "}
          <code>/public/</code>.</li>
        <li>Deploy with <code>vercel --prod</code>.</li>
      </ul>

      <p>
        The <code>.gif</code> extension is optional — both{" "}
        <code>{`/{slug}`}</code> and <code>{`/{slug}.gif`}</code> work. GitHub profile
        READMEs, embedded images and other least-common-denominator contexts can
        use the extensionless form.
      </p>

      <p>Example paths:</p>
      <ul>
        <li><code>/ken/profile-views.gif</code> → Redis key <code>ken:profile-views</code></li>
        <li><code>/ken/commits.gif</code> → Redis key <code>ken:commits</code></li>
        <li><code>/project/downloads.gif</code> → Redis key <code>project:downloads</code></li>
      </ul>

      <p>
        This page itself has a live counter — reload the page and watch the
        number tick up as the embedded image loads:
      </p>

      <p>
        <strong>homepage hits:</strong>{" "}
        <img
          src="/homepage.gif"
          alt="homepage hit counter"
          width="auto"
          height="auto"
        />
      </p>

      <p>
        Source:{" "}
        <a
          href="https://github.com/kritzerenkrieg/countbooru"
          rel="noopener noreferrer"
          target="_blank"
        >
          https://github.com/kritzerenkrieg/countbooru
        </a>
      </p>
    </main>
  );
}
