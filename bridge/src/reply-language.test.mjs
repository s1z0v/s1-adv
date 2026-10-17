import assert from "node:assert/strict";
import { test } from "node:test";
import { requestedReplyLanguage, REPLY_LANGUAGE_POLICY } from "./reply-language.mjs";

test("English is the default for English and Russian requests", () => {
  for (const text of ["What time is it?", "Скажи, который час?", "Добавь часы на экран", "", null])
    assert.equal(requestedReplyLanguage(text), "English");
});
test("An explicit Russian reply or translation request is respected", () => {
  for (const text of ["Ответь, пожалуйста, по-русски", "Давай на русском", "Please reply in Russian", "Translate this to Russian"])
    assert.equal(requestedReplyLanguage(text), "Russian");
  for (const text of ["Don't reply in Russian", "Не отвечай на русском", "Ответь на английском"])
    assert.equal(requestedReplyLanguage(text), "English");
  assert.match(REPLY_LANGUAGE_POLICY, /Russian input alone/);
});
