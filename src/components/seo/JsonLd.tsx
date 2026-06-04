import type { Graph, Thing } from 'schema-dts';

type Props = {
  /** A single schema.org entity (with `@context`) or a `@graph` of related entities. */
  data: Thing | Graph;
};

/**
 * Renders structured data as a native `<script type="application/ld+json">`.
 *
 * Per the official Next.js JSON-LD guide we use a plain `<script>` (not `next/script`,
 * which is for executable JS) and scrub `<` to its unicode escape to neutralise XSS
 * via `JSON.stringify`. See https://nextjs.org/docs/app/guides/json-ld
 */
export function JsonLd({ data }: Props) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
