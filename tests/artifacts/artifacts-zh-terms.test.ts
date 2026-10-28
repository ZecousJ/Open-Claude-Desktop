import test from "node:test";
import assert from "node:assert/strict";
import { currentLocale, formatText, setLocale, t, tc } from "../../src/i18n";

async function inChinese(run: () => void) {
  const previous = currentLocale();
  try {
    await setLocale("zh-CN");
    run();
  } finally {
    await setLocale(previous);
  }
}

test("the artifact page's home link is the app's 首页, not the phone's home screen", async () => {
  await inChinese(() => {
    assert.equal(tc("link", "Home"), "首页");
  });
  assert.equal(tc("link", "Home"), "Home");
});

test("the version menu's sentences are filled from their catalog entries", async () => {
  await inChinese(() => {
    assert.equal(formatText("Version {number}", { number: 3 }), "版本 3");
    assert.equal(
      formatText("Compare version {n} with current", { n: 2 }),
      "将版本 2 与当前版本比较",
    );
    assert.ok(
      formatText("Switch artifact version, currently version {version}", {
        version: 4,
      }).includes("4"),
    );
  });
  assert.equal(formatText("Version {number}", { number: 3 }), "Version 3");
});

test("a scheduled task's Active status is 已启用, apart from In progress (进行中)", async () => {
  await inChinese(() => {
    assert.equal(tc("task-status", "Active"), "已启用");
    assert.notEqual(tc("task-status", "Active"), t("In progress"));
  });
  assert.equal(tc("task-status", "Active"), "Active");
});

test("the once-schedule footnote is filled from its translated template", async () => {
  const key =
    "Runs once on {when}. Changing the frequency will replace this schedule.";
  await inChinese(() => {
    const text = formatText(key, { when: "10月21日 09:00" });
    assert.ok(text.includes("10月21日 09:00"));
    assert.ok(!text.startsWith("Runs once"));
  });
});

test("an added plugin's state is 已添加; the Added column stays 添加时间", async () => {
  await inChinese(() => {
    assert.equal(tc("state", "Added"), "已添加");
    assert.equal(t("Added"), "添加时间");
  });
  assert.equal(tc("state", "Added"), "Added");
});

test("the skills Discover empty line has its own translation", async () => {
  await inChinese(() => {
    assert.equal(t("No skills match your filters"), "没有符合筛选条件的技能");
  });
});

test("a device's Last seen is 最后在线; a finding's Last seen stays 最近发现", async () => {
  await inChinese(() => {
    assert.equal(tc("device", "Last seen"), "最后在线");
    assert.equal(t("Last seen"), "最近发现");
  });
  assert.equal(tc("device", "Last seen"), "Last seen");
});

test("the Reflect page's Written is 撰写于, not 文字 (text)", async () => {
  await inChinese(() => {
    assert.equal(t("Written"), "撰写于");
  });
});

test("the verification dialog's expiry sentences are translated and keep the minutes", async () => {
  await inChinese(() => {
    assert.equal(
      t("This code expired. Close this and try again to get a new one."),
      "此验证码已过期。请关闭后重试以获取新的验证码。",
    );
    assert.equal(
      formatText("The code expires in {minutes} minutes.", { minutes: 7 }),
      "验证码将在 7 分钟后过期。",
    );
    assert.notEqual(
      t("The code expires in 1 minute."),
      "The code expires in 1 minute.",
    );
  });
});

test("the editor's Background fill is 背景, not 后台 (background tasks)", async () => {
  await inChinese(() => {
    assert.equal(tc("fill", "Background"), "背景");
  });
  assert.equal(tc("fill", "Background"), "Background");
});
