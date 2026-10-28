import fs from "node:fs";

const utf8 = /utf-?8/i;

/**
 * A UTF-8 locale for the shells Codex starts (the terminal and the agent's
 * commands). Claudex opened from the Finder or the Dock inherits no LANG,
 * so `ls` printed Chinese names as `?`; Terminal sets LANG from the
 * system's language, and so does this: zh_CN.UTF-8 on a Chinese Mac,
 * en_US.UTF-8 when that locale isn't installed, C.UTF-8 on Linux. A locale
 * the person set (LC_ALL, LC_CTYPE or a UTF-8 LANG) is kept as it is.
 */
export function withUtf8Locale(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  systemLocale: string = Intl.DateTimeFormat().resolvedOptions().locale,
  installed: (name: string) => boolean = (name) =>
    fs.existsSync(`/usr/share/locale/${name}`),
): NodeJS.ProcessEnv {
  if (platform === "win32") return env;
  if (env.LC_ALL || utf8.test(env.LC_CTYPE ?? "") || utf8.test(env.LANG ?? ""))
    return env;
  if (platform !== "darwin") return { ...env, LANG: "C.UTF-8" };
  const [language, region] = systemLocale.replace(/-/g, "_").split("_");
  const own = region ? `${language}_${region.toUpperCase()}.UTF-8` : "";
  return {
    ...env,
    LANG: own && installed(own) ? own : "en_US.UTF-8",
  };
}
