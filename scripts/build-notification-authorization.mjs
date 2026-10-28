import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

if (process.platform === "darwin") {
  const include = [
    process.env.NODE_INCLUDE_DIR,
    path.resolve(path.dirname(process.execPath), "../include/node"),
    path.join(
      homedir(),
      "Library/Caches/node-gyp",
      process.versions.node,
      "include/node",
    ),
    "/opt/homebrew/include/node",
    "/usr/local/include/node",
  ].find(
    (directory) => directory && existsSync(path.join(directory, "node_api.h")),
  );
  if (!include)
    throw Error(
      "Install Node headers or set NODE_INCLUDE_DIR to build notification authorization.",
    );
  mkdirSync("dist-electron", { recursive: true });
  execFileSync(
    "clang++",
    [
      "-std=c++17",
      "-fobjc-arc",
      "-shared",
      "-undefined",
      "dynamic_lookup",
      "-mmacosx-version-min=12.0",
      "-framework",
      "UserNotifications",
      "-framework",
      "Foundation",
      "-I",
      include,
      "electron/notification-authorization.mm",
      "-o",
      "dist-electron/notification-authorization.node",
    ],
    { stdio: "inherit" },
  );
}
