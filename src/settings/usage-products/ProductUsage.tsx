import { useEffect, useState } from "react";
import type {
  ProductUsage as ProductUsageData,
  UsageProduct,
} from "../../../shared/usage-api";
import { currentLocale, formatText, t } from "../../i18n";

/** The original's product names. */
const productLabels: Record<UsageProduct, string> = {
  code: "Claudex Code",
  cowork: "Cowork",
  chat: "Chats",
  other: "Other",
};

/** Each product's share of the range's spend, largest first; none without spend. */
export function productRows(totals: ProductUsageData["totals"]) {
  const entries = Object.entries(totals).filter(
    (entry): entry is [UsageProduct, number] => (entry[1] ?? 0) > 0,
  );
  const total = entries.reduce((sum, [, cost]) => sum + cost, 0);
  if (!total) return [];
  return entries
    .map(([key, cost]) => ({
      key,
      label: productLabels[key],
      percent: (cost / total) * 100,
    }))
    .sort((a, b) => b.percent - a.percent);
}

/**
 * This week's usage by product: one bar row per Claudex surface with its share
 * of the last seven days' spend.
 */
export function ProductUsage() {
  const [usage, setUsage] = useState<ProductUsageData | null>();
  useEffect(() => {
    let active = true;
    void window.desktop
      .usageProducts("7")
      .then((value) => active && setUsage(value))
      .catch(() => active && setUsage(null));
    return () => {
      active = false;
    };
  }, []);
  const rows = usage ? productRows(usage.totals) : [];
  if (!rows.length) return null;
  return (
    <div className="usage-products" data-setting="This week’s usage by product">
      <h3>{t("This week’s usage by product")}</h3>
      {rows.map((row) => {
        const percent = Math.round(row.percent);
        const text = new Intl.NumberFormat(currentLocale(), {
          style: "percent",
          maximumFractionDigits: 0,
        }).format(row.percent / 100);
        return (
          <div className="usage-row" key={row.key}>
            <div className="usage-row-text">
              <div className="usage-row-label">{t(row.label)}</div>
            </div>
            <div
              className={`usage-bar${percent > 0 ? " used" : ""}`}
              role="progressbar"
              aria-label={t(row.label)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={formatText("{percent}%", {
                percent: percent.toLocaleString(currentLocale()),
              })}
            >
              <span style={{ width: `${Math.min(100, row.percent)}%` }} />
            </div>
            <span className="usage-row-percent">{text}</span>
          </div>
        );
      })}
    </div>
  );
}
