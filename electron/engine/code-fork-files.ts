import fs from "node:fs";
import path from "node:path";
import type { Turn } from "../../shared/types";

export function copyCodeForkScreenshots(
  root: string,
  source: string,
  child: string,
  turns: Turn[],
) {
  const screenshots = path.join(root, "computer-use", "screenshots");
  const destination = path.join(screenshots, child);
  const ids = new Set(
    [
      ...JSON.stringify(turns).matchAll(
        /claudex-screenshot:\/\/([a-f0-9-]{36})/gi,
      ),
    ].map((match) => match[1]),
  );
  const remove = () => fs.rmSync(destination, { recursive: true, force: true });
  try {
    for (const id of ids) {
      const file = path.join(screenshots, source, id + ".jpg");
      if (!fs.existsSync(file)) continue;
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      fs.copyFileSync(
        file,
        path.join(destination, id + ".jpg"),
        fs.constants.COPYFILE_EXCL,
      );
    }
    return remove;
  } catch (error) {
    remove();
    throw error;
  }
}
