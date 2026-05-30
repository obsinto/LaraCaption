# LaraCaption

> Subtitles, AI translation and an AI chat tutor for [Laracasts](https://laracasts.com) — built to help you learn English while you learn to code.

LaraCaption overlays the lesson's subtitle right on top of the video, can translate it on the fly (dual or single language), lets you study phrase by phrase, and gives you an AI chat that already knows the **entire** lesson transcript so you can ask anything about it.

> ⚠️ **Unofficial project.** LaraCaption is an independent extension and is **not affiliated with, endorsed by, or connected to Laracasts**. "Laracasts" is a trademark of its respective owner. You need an active Laracasts account to use it.

---

## ✨ Features

- **📝 Subtitle on the video** — shows the lesson caption synced to the playback time, right over the player. No need to click the player's `CC` button.
- **🌎 AI translation** — translates the subtitle using the OpenAI API. Choose your target language (default: Portuguese).
- **🇬🇧🇧🇷 Subtitle modes:**
  - **Original** — English only.
  - **Translated** — your language only.
  - **Dual** — English on top, translation below (great for learning).
- **🧠 Chat about the video** — a side panel where you can ask anything about the lesson. The AI receives the **full transcript** as context, so it can summarize, explain vocabulary/grammar, build a quiz, etc.
- **⏸️ Study mode** — pauses automatically at each subtitle so you can read and absorb one phrase at a time.
- **🔠 Subtitle size** — small / medium / large / extra large.
- **⬇️ Download subtitle** — export the caption as an `.srt` file.

---

## 🚀 Install (local / unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the `chrome-extension` folder.

The LaraCaption icon will appear in your toolbar.

---

## 🔑 Setup (OpenAI API key)

Translation and chat use the **OpenAI API**, which is **paid and separate** from a ChatGPT subscription.

1. Create a key at [platform.openai.com](https://platform.openai.com/api-keys) and make sure your account has **billing/credits** enabled.
2. Open a Laracasts lesson, click the LaraCaption icon, and paste your key in **OpenAI API key**.
3. Pick your **Translate to** language, **Subtitle mode** and **Model**.

Settings are saved automatically. With `gpt-4o-mini` the cost is just a few cents per lesson.

> The subtitle overlay itself works **without** a key — you only need one for translation and chat.

---

## 📖 Usage

1. Open a lesson, e.g. `https://laracasts.com/series/.../episodes/1`.
2. Click the LaraCaption icon and choose:
   - **Show subtitle on video** — overlay turns on; press play and it follows the video.
   - **Chat about this video** — opens the chat panel; wait for *"transcript ready"* and ask away (in English or your language).
   - **Download subtitle (.srt)** — saves the caption file.
3. Change the mode/size/study-mode anytime — it updates live.

---

## 🔒 Privacy

- Your **OpenAI API key** is stored only in your browser (`chrome.storage.local`). It is sent **only to the OpenAI API** when translating or chatting.
- LaraCaption does **not** store your Laracasts credentials. Use **Login on Laracasts** to sign in on the official site in the same Chrome profile.
- Subtitle/transcript text is sent to OpenAI **only** when you enable translation or use the chat.

---

## 🛠️ How it works

Laracasts plays lessons through a [Mux](https://mux.com) `<mux-player>` web component whose captions are delivered as **segmented WebVTT** (an HLS `subtitles.m3u8` playlist of `.vtt` chunks).

- A **page-world script** (`inject.js`, injected with `world: "MAIN"`) runs in the same context as the player's `hls.js`. It activates the subtitle track and — because this player does **not** fire `cuechange`/populate `activeCues` reliably — it computes the current caption itself from `video.currentTime` against the loaded cues, polling a few times per second.
- It also assembles the **full transcript** by downloading every `.vtt` segment listed in the playlist.
- The **content script** (`content.js`, isolated world) renders the overlay, manages settings, and talks to the page script via `postMessage`.
- The **service worker** (`background.js`) makes the OpenAI calls (translation + chat) and keeps the API key out of the page.

---

## 📁 Project structure

```
chrome-extension/
├── manifest.json        # MV3 manifest (content scripts, permissions)
└── src/
    ├── inject.js        # MAIN-world: subtitle activation, cue timing, transcript
    ├── content.js       # isolated world: overlay UI, settings, chat panel
    ├── background.js    # service worker: OpenAI (translate + chat)
    ├── popup.html/js/css# toolbar popup (settings + actions)
```

---

## ⚠️ Notes & limitations

- Requires being **logged in on Laracasts** in the same Chrome profile.
- The overlay is anchored to the player on the page; in real **fullscreen** it may not appear.
- Translation/chat require a valid OpenAI key **with credits** (errors are shown in a red bar / chat status).

---

## 📄 License

Released under the MIT License. Not affiliated with Laracasts or OpenAI.
