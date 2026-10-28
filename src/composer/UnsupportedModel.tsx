import { formatText, useT } from "../i18n";
import { Button } from "../settings/controls";
import type { unsupportedModel } from "./unsupported-model";
import "./unsupported-model.css";

export function UnsupportedModel({
  notice,
  onSwitch,
}: {
  notice: NonNullable<ReturnType<typeof unsupportedModel>>;
  onSwitch: (providerId: string, model: string) => void;
}) {
  const t = useT();
  const fallback = notice.fallback;
  const name = fallback?.label ?? fallback?.name ?? "";
  return (
    <div
      className="unsupported-model"
      data-testid="cowork-model-not-found-card"
    >
      <div>{t("This model isn’t available")}</div>
      <p>
        {t("This deployment doesn’t support this model.")}{" "}
        {formatText(notice.hint, { model: name })}
      </p>
      {fallback && (
        <Button onClick={() => onSwitch(fallback.providerId, fallback.name)}>
          {formatText("Switch to {model}", { model: name })}
        </Button>
      )}
    </div>
  );
}
