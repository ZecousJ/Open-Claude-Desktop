import { formatText } from "../../i18n";

/**
 * A count with its noun, the count in bold: "<b>3</b> agents", in the
 * order the language uses ("{count} agents" is a catalog sentence).
 */
export function BoldCount({
  template,
  count,
}: {
  template: string;
  count: number | string;
}) {
  const [before, after = ""] = formatText(template).split("{count}");
  return (
    <>
      {before}
      <b>{count}</b>
      {after}
    </>
  );
}
