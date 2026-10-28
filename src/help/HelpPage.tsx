import { useEffect } from "react";
import { helpUrl } from "../../shared/help-links";
import { DEFAULT_TRUSTED_DOMAINS } from "../../shared/cloud-network-domains";
import { locales } from "../../shared/locales";
import { setLocale, useLocale, useT } from "../i18n";
import { parseWebRoute } from "../web/routes";
import { helpArticles } from "./articles";
import "./help.css";

export function HelpPage() {
  const t = useT();
  const locale = useLocale();
  const route = parseWebRoute(location.pathname, location.search);
  const slug = route.kind === "help" ? route.slug : undefined;
  const article = helpArticles.find((entry) => entry.slug === slug);
  const title = article
    ? t(article.title)
    : t(slug ? "Page not found" : "Claudex Help");
  useEffect(() => {
    document.title = `${title} - Claudex`;
  }, [title]);
  return (
    <div className="help-page">
      <header className="help-header">
        <a href={helpUrl()}>{t("Claudex Help")}</a>
        <label>
          {t("Language")}
          <select
            value={locale}
            onChange={(event) => void setLocale(event.target.value)}
          >
            {locales.map((language) => (
              <option key={language.id} value={language.id}>
                {language.native}
              </option>
            ))}
          </select>
        </label>
      </header>
      <main className="help-content">
        <h1>{title}</h1>
        {article ? (
          <article>
            <p>{t(article.body)}</p>
            {article.slug === "cloud-environments" && (
              <ul>
                {DEFAULT_TRUSTED_DOMAINS.map((domain) => (
                  <li key={domain}>
                    <code>{domain}</code>
                  </li>
                ))}
              </ul>
            )}
            {article.slug === "files-and-code" && (
              <p>
                <a href={helpUrl("cloud-environments")}>
                  {t("Cloud environment domains")}
                </a>
              </p>
            )}
            {article.slug === "support" && (
              <p>
                <a href="/login">{t("Sign in")}</a>
              </p>
            )}
          </article>
        ) : (
          !slug && (
            <nav aria-label={t("Claudex Help")}>
              <ul>
                {helpArticles.map((entry) => (
                  <li key={entry.slug}>
                    <a href={helpUrl(entry.slug)}>{t(entry.title)}</a>
                  </li>
                ))}
              </ul>
            </nav>
          )
        )}
      </main>
    </div>
  );
}
