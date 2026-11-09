import assert from "node:assert/strict";
import test from "node:test";
import { selectLanguage, t, type MessageKey } from "./i18n.ts";

const keys = [
  "session.notify.pinned",
  "session.action.next",
  "notify.waitManage",
  "resource.openFailed",
  "mcp.openFailed",
] as const satisfies readonly MessageKey[];

test("Chinese locales select zh and everything else selects en", () => {
  for (const lang of ["zh", "zh_CN", "zh-CN", "zh_CN.UTF-8", "zh_TW.UTF-8", "zh.UTF-8", "chinese"]) {
    assert.equal(selectLanguage({ LANG: lang }), "zh", lang);
  }
  for (const lang of [undefined, "", "C", "C.UTF-8", "POSIX", "en", "en_US.UTF-8", "en-GB", "fr_FR.UTF-8"]) {
    assert.equal(selectLanguage({ LANG: lang }), "en", String(lang));
  }
});

test("LC_ALL beats LC_MESSAGES and LANG, and a zh message locale beats LANG", () => {
  assert.equal(selectLanguage({ LC_ALL: "en_US.UTF-8", LC_MESSAGES: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8" }), "en");
  assert.equal(selectLanguage({ LC_ALL: "C", LANG: "zh_CN.UTF-8" }), "en");
  assert.equal(selectLanguage({ LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }), "zh");
  assert.equal(selectLanguage({ LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(selectLanguage({}), "en");
});

test("PI_UI_LANG and PI_UI_LANGUAGE override the locale", () => {
  assert.equal(selectLanguage({ PI_UI_LANG: "zh", LANG: "en_US.UTF-8" }), "zh");
  assert.equal(selectLanguage({ PI_UI_LANG: "en", LANG: "zh_CN.UTF-8", LC_ALL: "zh_TW.UTF-8" }), "en");
  assert.equal(selectLanguage({ PI_UI_LANGUAGE: "zh-CN", LANG: "en_US.UTF-8" }), "zh");
  assert.equal(selectLanguage({ PI_UI_LANG: "fr", LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(selectLanguage({ PI_UI_LANG: "   ", LANG: "en_US.UTF-8" }), "en");
});

test("t returns the catalog for the requested language and fills placeholders", () => {
  const zhEnv = { PI_UI_LANG: "zh", LANG: "en_US.UTF-8" };
  const enEnv = { PI_UI_LANG: "en", LANG: "zh_CN.UTF-8" };
  for (const key of keys) {
    assert.notEqual(t(key, undefined, zhEnv), t(key, undefined, enEnv), key);
  }
  assert.equal(t("session.notify.pinned", undefined, enEnv), "Session pinned");
  assert.equal(t("session.notify.pinned", undefined, zhEnv), "会话已置顶");
  assert.equal(
    t("resource.openFailed", { error: "picker down" }, enEnv),
    "Failed to open resource: picker down",
  );
  assert.equal(
    t("mcp.openFailed", { error: "status down" }, zhEnv),
    "打开 MCP 状态失败：status down",
  );
  assert.equal(t("notify.missingId", { unused: "x" }, enEnv), "Missing session id");
  assert.equal(t("session.title", { shown: 2, total: 9, page: 1, pages: 2 }, enEnv), "Sessions · 2/9 · 1/2");
});
