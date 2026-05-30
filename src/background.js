"use strict";

const LOGIN_URL = "https://laracasts.com/login";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  runMessage(message, sender)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function runMessage(message) {
  if (!message || !message.type) {
    throw new Error("Missing message type.");
  }

  if (message.type === "OPEN_LOGIN") {
    await chrome.tabs.create({ url: LOGIN_URL });
    return {};
  }

  if (message.type === "FETCH_TEXT") {
    return fetchText(message.url, message.options || {});
  }

  if (message.type === "TRANSLATE") {
    return translate(message.texts || []);
  }

  if (message.type === "CHAT") {
    return chat(message.messages || []);
  }

  throw new Error(`Unknown message type: ${message.type}`);
}

// Conversa com a OpenAI usando a transcrição já embutida nas mensagens.
async function chat(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Mensagens vazias.");
  }

  const { settings } = await chrome.storage.local.get("settings");
  const apiKey = settings && settings.apiKey;
  if (!apiKey) {
    throw new Error("Configure sua OpenAI API key no popup da extensão.");
  }

  const model = (settings && settings.model) || "gpt-4o-mini";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, temperature: 0.4, messages })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const msg = data && data.error && data.error.message;
    throw new Error(msg || `OpenAI respondeu HTTP ${response.status}.`);
  }

  return { reply: data.choices[0].message.content };
}

// Traduz uma lista de linhas de legenda usando a API da OpenAI.
// A chave e as preferências ficam no chrome.storage (não trafegam pela página).
async function translate(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { translations: [] };
  }

  const { settings } = await chrome.storage.local.get("settings");
  const apiKey = settings && settings.apiKey;
  if (!apiKey) {
    throw new Error("Configure sua OpenAI API key no popup da extensão.");
  }

  const model = (settings && settings.model) || "gpt-4o-mini";
  const target = (settings && settings.targetLang) || "Portuguese";

  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You translate video subtitles into ${target} for a language learner. ` +
          `You receive a JSON object {"lines": string[]}. Translate each line naturally, ` +
          `keeping the exact same order and count. Return ONLY a JSON object ` +
          `{"translations": string[]} with one translation per input line. Do not add notes.`
      },
      { role: "user", content: JSON.stringify({ lines: texts }) }
    ]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const msg = data && data.error && data.error.message;
    throw new Error(msg || `OpenAI respondeu HTTP ${response.status}.`);
  }

  let parsed = {};
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch (error) {
    throw new Error("Resposta da OpenAI em formato inesperado.");
  }

  return { translations: Array.isArray(parsed.translations) ? parsed.translations : [] };
}

async function fetchText(url, options) {
  if (!url || !/^https:\/\/[a-z0-9.-]+\//i.test(url)) {
    throw new Error("Only HTTPS URLs can be fetched.");
  }

  const response = await fetch(url, {
    method: "GET",
    credentials: options.credentials || "include",
    headers: normalizeHeaders(options.headers),
    redirect: "follow"
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}.`);
  }

  return {
    contentType: response.headers.get("content-type") || "",
    status: response.status,
    text,
    url: response.url
  };
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object") {
    return {};
  }

  const allowed = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "accept" || lowerKey === "content-type") {
      allowed[key] = value;
    }
  }

  return allowed;
}
