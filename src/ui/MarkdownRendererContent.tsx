import ReactMarkdown from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import type { MarkdownRendererProps } from "./MarkdownRenderer";

const presets = {
  reply: [remarkGfm, remarkCjkFriendly],
  gfm: [remarkGfm],
};

export default function MarkdownRendererContent({
  preset,
  remarkPlugins,
  ...props
}: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      {...props}
      remarkPlugins={
        preset ? [...presets[preset], ...(remarkPlugins ?? [])] : remarkPlugins
      }
    />
  );
}
