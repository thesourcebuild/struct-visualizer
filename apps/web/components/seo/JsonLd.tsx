/**
 * Schema.org structured data, rendered into the static HTML so crawlers that do not run JavaScript
 * read it too. `<` is escaped so no string in the data can close the script element.
 */
export function JsonLd({ data }: { data: object }) {
  const json = JSON.stringify({ "@context": "https://schema.org", ...data }).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
