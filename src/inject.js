"use strict";

// ===================================================================
//  Script de PÁGINA (world: MAIN) — roda no mesmo contexto do hls.js
// ===================================================================
//
// O content script normal roda num "mundo isolado" e, de lá, escrever
// o modo da faixa de legenda NÃO dispara o hls.js a carregar os
// segmentos (por isso era preciso clicar no CC manualmente). Este
// script roda no mundo principal da página, então:
//   1. Ativa a faixa de legenda de verdade (mode = "hidden") -> o
//      hls.js carrega o playlist e os segmentos .vtt automaticamente.
//   2. Monta a transcrição completa baixando os segmentos pela origem
//      da página (sem CORS).
// Ele se comunica com o content script via window.postMessage.

(() => {
  if (window.__lsvInjected) return;
  window.__lsvInjected = true;

  function findVideo(root, depth = 0) {
    if (!root || depth > 8) return null;
    const direct = root.querySelector && root.querySelector("video");
    if (direct) return direct;
    const scope = root.shadowRoot || root;
    const nodes = scope.querySelectorAll ? scope.querySelectorAll("*") : [];
    for (const el of nodes) {
      if (el.shadowRoot) {
        const found = findVideo(el.shadowRoot, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function getVideo() {
    const player = document.querySelector("mux-player");
    if (!player) return null;
    return findVideo(player.shadowRoot) || findVideo(player);
  }

  function getTrack() {
    const video = getVideo();
    if (!video) return null;
    return [...video.textTracks].find(
      (t) => t.kind === "subtitles" || t.kind === "captions"
    ) || null;
  }

  const norm = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

  let timer = null;
  let overlayOn = false;
  let lastEmit = null;
  let config = { autoPause: false };
  let pausedCueKey = null; // cue em que já pausamos (evita pausar 2x na mesma)

  // Margem antes do fim da cue. Pausamos um pouco antes do endTime para a
  // legenda da frase ATUAL continuar na tela no momento da pausa — assim o
  // que você vê é o que acabou de ouvir (melhor para shadowing/estudo).
  const PAUSE_LEAD = 0.3;

  // Mantém a faixa "hidden" (ativa, carrega cues, mas sem legenda nativa).
  function assertHidden() {
    const track = getTrack();
    if (track && track.mode !== "hidden") track.mode = "hidden";
  }

  // ATENÇÃO: este player NÃO dispara cuechange e nem popula activeCues de
  // forma confiável. Então calculamos a legenda atual nós mesmos, a partir
  // do video.currentTime contra track.cues (que carregam ao redor do
  // playhead). Enviamos também as próximas cues para pré-traduzir.
  function computeAndEmit() {
    const video = getVideo();
    const track = getTrack();
    if (!video || !track) return;

    const now = video.currentTime;
    const cues = track.cues ? [...track.cues] : [];

    const lines = [];
    for (const cue of cues) {
      if (cue.startTime <= now && cue.endTime >= now) {
        const text = norm(cue.text);
        if (text) lines.push(text);
      }
    }

    const ahead = [];
    for (const cue of cues) {
      if (cue.endTime < now) continue;
      const text = norm(cue.text);
      if (text) ahead.push(text);
      if (ahead.length >= 25) break;
    }

    const key = lines.join(" | ");
    if (key === lastEmit) return; // nada mudou
    lastEmit = key;
    window.postMessage({ source: "lsv-inject", type: "CUES", lines, ahead }, "*");
  }

  // Modo estudo: pausa perto do FIM da frase atual (com a legenda dela
  // ainda visível), uma vez por cue.
  function maybeAutoPause() {
    const video = getVideo();
    const track = getTrack();
    if (!video || !track || video.paused) return;

    const now = video.currentTime;
    const cues = track.cues ? [...track.cues] : [];

    let active = null;
    for (const cue of cues) {
      if (cue.startTime <= now && cue.endTime >= now && norm(cue.text)) active = cue;
    }
    if (!active) return;

    const key = active.startTime + "|" + norm(active.text);
    if (key === pausedCueKey) return; // já pausamos nesta frase

    if (active.endTime - now <= PAUSE_LEAD) {
      pausedCueKey = key;
      pauseMedia();
    }
  }

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => {
      assertHidden();
      if (!overlayOn) return;
      computeAndEmit();
      if (config.autoPause) maybeAutoPause();
    }, 200);
  }

  function startOverlay() {
    overlayOn = true;
    lastEmit = null;
    assertHidden();
    ensureTimer();
    computeAndEmit();
  }

  function stopOverlay() {
    overlayOn = false;
  }

  // Usado pelo chat: só garante a faixa ativa para carregar o playlist.
  function ensureSubtitleLoading() {
    assertHidden();
    ensureTimer();
  }

  function pauseMedia() {
    const player = document.querySelector("mux-player");
    const media = player && typeof player.pause === "function" ? player : getVideo();
    if (media && typeof media.pause === "function" && !media.paused) media.pause();
  }

  function findPlaylistUrl() {
    return (
      performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .find((u) => /subtitles\.m3u8/.test(u)) || null
    );
  }

  async function buildTranscript() {
    // Garante a faixa ativa para o player carregar o playlist
    ensureSubtitleLoading();

    let url = findPlaylistUrl();
    for (let i = 0; !url && i < 12; i++) {
      await new Promise((r) => setTimeout(r, 400));
      url = findPlaylistUrl();
    }
    if (!url) {
      throw new Error("Legenda não encontrada. Dê play no vídeo e tente de novo.");
    }

    const m3u8 = await (await fetch(url)).text();
    const segments = m3u8
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => new URL(l, url).href);

    if (!segments.length) {
      throw new Error("Playlist de legenda sem segmentos.");
    }

    const texts = await Promise.all(
      segments.map((u) =>
        fetch(u)
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => "")
      )
    );

    const lines = [];
    let last = "";
    for (const vtt of texts) {
      for (const raw of vtt.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (/^WEBVTT/.test(line)) continue;
        if (/^\d+$/.test(line)) continue;
        if (line.includes("-->")) continue;
        if (/^(NOTE|X-TIMESTAMP|STYLE|REGION)/.test(line)) continue;
        const clean = line.replace(/<[^>]+>/g, "").trim();
        if (!clean || clean === last) continue;
        lines.push(clean);
        last = clean;
      }
    }

    const transcript = lines.join(" ");
    if (!transcript) {
      throw new Error("Não consegui extrair texto da legenda.");
    }
    return { transcript, words: transcript.split(/\s+/).filter(Boolean).length };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "lsv-content") return;

    if (data.cmd === "ACTIVATE") {
      startOverlay();
    } else if (data.cmd === "DEACTIVATE") {
      stopOverlay();
    } else if (data.cmd === "CONFIG") {
      config.autoPause = !!data.autoPause;
      pausedCueKey = null;
    } else if (data.cmd === "BUILD_TRANSCRIPT") {
      try {
        const result = await buildTranscript();
        window.postMessage({ source: "lsv-inject", id: data.id, ok: true, ...result }, "*");
      } catch (error) {
        window.postMessage(
          { source: "lsv-inject", id: data.id, ok: false, error: error.message || String(error) },
          "*"
        );
      }
    }
  });
})();
