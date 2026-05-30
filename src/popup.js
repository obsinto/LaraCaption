"use strict";

const statusEl = document.getElementById("status");
const overlayButton = document.getElementById("overlay");
const chatButton = document.getElementById("chat");
const downloadButton = document.getElementById("download");
const continueButton = document.getElementById("continue");

const apiKeyEl = document.getElementById("apiKey");
const targetLangEl = document.getElementById("targetLang");
const modeEl = document.getElementById("mode");
const modelEl = document.getElementById("model");
const fontSizeEl = document.getElementById("fontSize");
const autoPauseEl = document.getElementById("autoPause");
const settingsBox = document.getElementById("settingsBox");

const DEFAULT_SETTINGS = {
  apiKey: "",
  targetLang: "Português",
  mode: "original",
  model: "gpt-4o-mini",
  fontSize: "1",
  autoPause: false
};

document.addEventListener("DOMContentLoaded", loadSettings);

[apiKeyEl, targetLangEl, modeEl, modelEl, fontSizeEl, autoPauseEl].forEach((el) => {
  el.addEventListener("change", saveSettings);
});

overlayButton.addEventListener("click", toggleOverlay);
chatButton.addEventListener("click", openChat);
downloadButton.addEventListener("click", downloadSrt);
continueButton.addEventListener("click", continueWatching);

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  apiKeyEl.value = merged.apiKey;
  targetLangEl.value = merged.targetLang;
  modeEl.value = merged.mode;
  modelEl.value = merged.model;
  fontSizeEl.value = merged.fontSize;
  autoPauseEl.checked = merged.autoPause;

  // Abre o painel de configurações só no primeiro uso (sem API key).
  if (settingsBox) settingsBox.open = !merged.apiKey;
}

async function saveSettings() {
  const settings = {
    apiKey: apiKeyEl.value.trim(),
    targetLang: targetLangEl.value.trim() || DEFAULT_SETTINGS.targetLang,
    mode: modeEl.value,
    model: modelEl.value,
    fontSize: fontSizeEl.value,
    autoPause: autoPauseEl.checked
  };
  await chrome.storage.local.set({ settings });
  setStatus("Settings saved.");
}

async function toggleOverlay() {
  setBusy(true);
  try {
    const tab = await activeTab();
    const response = await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_OVERLAY" });
    if (response && response.status === "on") {
      overlayButton.textContent = "Hide subtitle on video";
      setStatus("Subtitle is on. Press play — it follows the video.");
    } else {
      overlayButton.textContent = "Show subtitle on video";
      setStatus("Subtitle hidden.");
    }
  } catch (error) {
    setStatus("Open a Laracasts lesson tab first, then try again.", true);
  } finally {
    setBusy(false);
  }
}

async function openChat() {
  setBusy(true);
  try {
    const tab = await activeTab();
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_CHAT" });
    setStatus("Chat panel toggled on the page.");
    window.close();
  } catch (error) {
    setStatus("Open a Laracasts lesson tab first, then try again.", true);
  } finally {
    setBusy(false);
  }
}

async function downloadSrt() {
  setBusy(true);
  setStatus("Sending command to the active tab...");
  try {
    const tab = await activeTab();
    await chrome.tabs.sendMessage(tab.id, { type: "DOWNLOAD_SRT" });
    setStatus("Now play the video and enable CC to capture the file.");
  } catch (error) {
    setStatus("Open a Laracasts lesson tab first, then try again.", true);
  } finally {
    setBusy(false);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error("No active tab found.");
  }
  return tab;
}

async function continueWatching() {
  // Abre a última aula assistida (o Laracasts retoma a posição do vídeo);
  // se ainda não houver, vai para a lista oficial de "assistindo".
  const { lastLesson } = await chrome.storage.local.get("lastLesson");
  openUrl(lastLesson || "https://laracasts.com/series?watching=1");
}

async function openUrl(url) {
  await chrome.tabs.create({ url });
  window.close();
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setBusy(isBusy) {
  overlayButton.disabled = isBusy;
  chatButton.disabled = isBusy;
  downloadButton.disabled = isBusy;
  continueButton.disabled = isBusy;
}
