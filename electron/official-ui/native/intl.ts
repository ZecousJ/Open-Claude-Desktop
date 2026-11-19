import type { NativeHost } from "./host";
import {
  officialLocale,
  officialLocaleMessages,
  requireOfficialLocale,
} from "../locale";
import { sessionAccountScope } from "./session-account-scope";

/** The hybrid desktop shell requires {locale,messages} and a two-argument event. */
export function registerDesktopIntl(host: NativeHost) {
  const { ctx } = host;
  const account = sessionAccountScope(ctx, () => {});
  let emitted: string | undefined;
  const initial = () => {
    account.sync();
    const locale = officialLocale(ctx);
    return { locale, messages: officialLocaleMessages(ctx.root, locale) };
  };
  const changed = () => {
    account.sync();
    const locale = officialLocale(ctx);
    if (locale !== emitted) {
      const messages = officialLocaleMessages(ctx.root, locale);
      emitted = locale;
      host.emit("DesktopIntl", "localeChanged", locale, messages);
    }
  };
  host.on("DesktopIntl.getInitialLocale", initial);
  host.on("DesktopIntl.requestLocaleChange", (raw: unknown) =>
    account.run(() => {
      requireOfficialLocale(ctx.root, raw);
      // Each page calls this from its bootstrap effect. An old window's delayed
      // bootstrap must not overwrite the language just saved in another window.
      // The profile endpoint owns persistence; the hybrid shell mirrors it.
      changed();
    }),
  );
  return ctx.onEvent((event) => {
    if (event.type === "settings") changed();
  });
}
