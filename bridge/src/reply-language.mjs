export const REPLY_LANGUAGE_POLICY = "Reply in English by default, regardless of the language of the input or earlier conversation. Use Russian or another language only when the user explicitly requests that response language. Russian input alone is not a request to switch languages. Preserve names, quoted text, transcription and requested translations in their original or requested language.";

export function requestedReplyLanguage(text) {
  const value = String(text || "");
  if (/(?:do not|don't|never)\s+(?:answer|reply|respond|speak|write)[^.!?]{0,40}russian/iu.test(value) ||
      /не\s+(?:отвечай|говори|пиши)[^.!?]{0,40}(?:по[- ]русски|на русском)/iu.test(value)) return "English";
  const explicit = /(?:answer|reply|respond|speak|write|translate)[^.!?]{0,60}(?:in|into|to)\s+russian/iu.test(value) ||
      /(?:ответь|отвечай|говори|скажи|напиши|пиши|переведи|давай|можно)[^.!?]{0,60}(?:по[- ]русски|на русском)/iu.test(value);
  return explicit ? "Russian" : "English";
}
