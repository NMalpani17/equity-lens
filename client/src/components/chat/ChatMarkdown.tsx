import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { Citation } from "@/lib/chatApi";
import {
  CITE_PREFIX,
  DATA_PREFIX,
  linkCitations,
  linkDataRefs,
} from "@/lib/chatFormat";
import type { DataSource } from "@/lib/reportsApi";

interface ChatMarkdownProps {
  content: string;
  citations?: Citation[];
  onCite?: (citation: Citation) => void;
  /** Market-data sources cited as [D1], [D2] (research reports). */
  dataSources?: DataSource[];
  onDataSource?: (source: DataSource) => void;
}

const REF_CLASS =
  "ml-0.5 rounded-sm pl-0.5 align-super text-[0.7em] font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Markdown for model output. Raw HTML is never rendered (skipHtml), unsafe
 * URLs are dropped by react-markdown's default urlTransform, and external
 * links open in a new tab without referrer or opener access.
 */
export function ChatMarkdown({
  content,
  citations = [],
  onCite,
  dataSources = [],
  onDataSource,
}: ChatMarkdownProps) {
  const byId = new Map(citations.map((c) => [c.id, c]));
  const sourcesById = new Map(dataSources.map((s) => [s.id, s]));

  const components: Components = {
    a({ href, children }) {
      if (href?.startsWith(CITE_PREFIX)) {
        const citation = byId.get(Number(href.slice(CITE_PREFIX.length)));
        if (!citation) return <>{children}</>;
        return (
          <button
            type="button"
            onClick={() => onCite?.(citation)}
            className={REF_CLASS}
            aria-label={`Source ${citation.id}: ${citation.ticker} Q${citation.fiscalQuarter} FY${citation.fiscalYear}, ${citation.speaker}`}
          >
            {children}
          </button>
        );
      }
      if (href?.startsWith(DATA_PREFIX)) {
        const source = sourcesById.get(href.slice(DATA_PREFIX.length));
        if (!source) return <>{children}</>;
        return (
          <button
            type="button"
            onClick={() => onDataSource?.(source)}
            className={REF_CLASS}
            aria-label={`Market data ${source.id}: ${source.label}`}
          >
            {children}
          </button>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="font-medium text-primary underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
  };

  return (
    <div className="chat-markdown space-y-2 text-sm leading-relaxed [&_li]:ml-4 [&_ol]:list-decimal [&_table]:w-full [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_h3]:font-semibold [&_h4]:font-semibold [&_strong]:font-semibold">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {linkDataRefs(
          linkCitations(content, citations),
          dataSources.map((s) => s.id),
        )}
      </ReactMarkdown>
    </div>
  );
}
