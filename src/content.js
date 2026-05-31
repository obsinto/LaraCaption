"use strict";

(() => {
  // Evita injeção duplicada do script
  if (window.__laracastsSubtitleViewerLoaded) return;
  window.__laracastsSubtitleViewerLoaded = true;

  // Escuta as mensagens enviadas pelo popup.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "TOGGLE_OVERLAY") {
      const on = Overlay.toggle();
      sendResponse({ status: on ? "on" : "off" });
    } else if (message.type === "TOGGLE_CHAT") {
      const on = Chat.toggle();
      sendResponse({ status: on ? "on" : "off" });
    } else if (message.type === "DOWNLOAD_SRT") {
      startIntercepting();
      sendResponse({ status: "intercepting" });
    }
    return true;
  });

  // ===================================================================
  //  Ponte com o script de página (inject.js, world: MAIN)
  // ===================================================================
  //
  // O inject.js roda no mundo principal e cuida de ativar a faixa de
  // legenda (para o hls.js carregar) e de montar a transcrição. Aqui
  // mandamos comandos e recebemos respostas por window.postMessage.
  const pageBridge = {
    seq: 0,
    pending: new Map(),

    init() {
      window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "lsv-inject") return;
        if (data.id && this.pending.has(data.id)) {
          const resolve = this.pending.get(data.id);
          this.pending.delete(data.id);
          resolve(data);
        }
      });
    },

    send(cmd, extra) {
      window.postMessage({ source: "lsv-content", cmd, ...(extra || {}) }, "*");
    },

    request(cmd, timeout = 30000) {
      const id = "lsv-" + ++this.seq;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            resolve({ ok: false, error: "Tempo esgotado ao falar com a página." });
          }
        }, timeout);
        this.pending.set(id, (data) => {
          clearTimeout(timer);
          resolve(data);
        });
        window.postMessage({ source: "lsv-content", cmd, id }, "*");
      });
    }
  };
  pageBridge.init();

  // ===================================================================
  //  Overlay de legenda sincronizada com o tempo do vídeo
  // ===================================================================
  //
  // O player do Laracasts é um <mux-player> (web component, mesma origem).
  // O <video> real fica dentro do shadow DOM e já carrega a faixa de
  // legenda (text track) de forma segmentada conforme o vídeo avança.
  //
  // Em vez de baixar o .vtt, lemos as `activeCues` dessa faixa: o próprio
  // navegador cuida do tempo, então a sincronia é perfeita. Colocamos a
  // faixa em modo "hidden" para o player não desenhar a legenda nativa
  // (evita legenda duplicada) e renderizamos nosso próprio overlay.
  const Overlay = {
    on: false,
    root: null, // container "popover" (top layer) que segura overlay + botão
    el: null,
    replayButton: null,
    style: null,
    settings: { mode: "original", targetLang: "Portuguese" },
    cache: new Map(), // texto original -> tradução
    pending: new Set(), // textos em tradução no momento
    lastError: "",
    storageBound: false,
    originals: [], // linhas da legenda atual (vêm do inject.js)
    canReplay: false,
    msgHandler: null,
    fullscreenHandler: null,
    shadowFullscreenRoot: null,
    repositionHandler: null,
    pointerGuard: null,
    placeTimer: null,
    replayFlashTimer: null,
    rootRect: "", // última geometria aplicada (evita reflow à toa)
    replayRect: null, // retângulo do botão em coords de viewport (hit-test)
    replayHover: false,

    toggle() {
      if (this.on) {
        this.disable();
        return false;
      }
      this.enable();
      return true;
    },

    enable() {
      this.on = true;
      this.ensureStyle();
      this.ensureEl();

      // Carrega as preferências (chave/idioma/modo) salvas pelo popup
      chrome.storage.local.get("settings").then(({ settings }) => {
        if (settings) this.settings = settings;
        this.render();
        pageBridge.send("CONFIG", { autoPause: !!this.settings.autoPause });
      });

      // Atualiza ao vivo quando o usuário muda as preferências no popup
      if (!this.storageBound) {
        this.storageBound = true;
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes.settings) return;
          const previous = this.settings || {};
          this.settings = changes.settings.newValue || {};
          // Trocou o idioma de destino -> as traduções em cache não valem mais
          if (this.settings.targetLang !== previous.targetLang) {
            this.cache.clear();
            this.pending.clear();
          }
          this.lastError = "";
          this.render();
          pageBridge.send("CONFIG", { autoPause: !!this.settings.autoPause });
          if (this.settings.mode && this.settings.mode !== "original") {
            this.requestTranslations([...this.originals]);
          }
        });
      }

      // Recebe as cues vindas do inject.js (mundo principal), onde o
      // cuechange/activeCues atualizam de forma confiável.
      if (!this.msgHandler) {
        this.msgHandler = (event) => {
          if (event.source !== window) return;
          const data = event.data;
          if (!data || data.source !== "lsv-inject" || data.type !== "CUES") return;
          this.onCues(data);
        };
        window.addEventListener("message", this.msgHandler);
      }
      if (!this.fullscreenHandler) {
        this.fullscreenHandler = () => this.onFullscreenChange();
        document.addEventListener("fullscreenchange", this.fullscreenHandler);
      }
      // Em fullscreen o Chromium não roteia clique para popovers da top layer
      // quando o elemento fullscreen está numa shadow tree (caso do mux-player).
      // Então capturamos o clique no document e fazemos hit-test pela posição
      // do botão: o vídeo recebe o clique, ele sobe até aqui em capture, e nós
      // o tratamos como clique no botão (engolindo para o player não reagir).
      if (!this.pointerGuard) {
        this.pointerGuard = (event) => this.onDocumentPointer(event);
        for (const type of ["pointerdown", "pointerup", "mousedown", "click", "pointermove"]) {
          document.addEventListener(type, this.pointerGuard, true);
        }
      }

      // Pede ao script de página para ativar a faixa de legenda — só assim
      // o hls.js carrega as cues sem precisar clicar no CC.
      pageBridge.send("ACTIVATE");

      // O overlay vive na top layer (popover em document.body) e nunca entra
      // no shadow DOM do player. Aqui só mantemos sua geometria alinhada ao
      // player (scroll/resize/troca de episódio na SPA).
      this.reposition();
      if (!this.repositionHandler) {
        this.repositionHandler = () => this.reposition();
        window.addEventListener("scroll", this.repositionHandler, true);
        window.addEventListener("resize", this.repositionHandler);
      }
      if (!this.placeTimer) {
        this.placeTimer = setInterval(() => this.reposition(), 1000);
      }
      console.log("📝 Legenda na tela: ATIVADA");
    },

    disable() {
      this.on = false;
      pageBridge.send("DEACTIVATE");
      if (this.msgHandler) {
        window.removeEventListener("message", this.msgHandler);
        this.msgHandler = null;
      }
      if (this.fullscreenHandler) {
        document.removeEventListener("fullscreenchange", this.fullscreenHandler);
        if (this.shadowFullscreenRoot) {
          this.shadowFullscreenRoot.removeEventListener("fullscreenchange", this.fullscreenHandler);
          this.shadowFullscreenRoot = null;
        }
        this.fullscreenHandler = null;
      }
      if (this.repositionHandler) {
        window.removeEventListener("scroll", this.repositionHandler, true);
        window.removeEventListener("resize", this.repositionHandler);
        this.repositionHandler = null;
      }
      if (this.pointerGuard) {
        for (const type of ["pointerdown", "pointerup", "mousedown", "click", "pointermove"]) {
          document.removeEventListener(type, this.pointerGuard, true);
        }
        this.pointerGuard = null;
      }
      if (this.placeTimer) {
        clearInterval(this.placeTimer);
        this.placeTimer = null;
      }
      for (const node of [this.root, this.replayButton]) {
        if (!node) continue;
        try {
          if (node.matches(":popover-open")) node.hidePopover();
        } catch (_) {}
        node.remove();
      }
      this.root = null;
      this.el = null;
      this.replayButton = null;
      this.rootRect = "";
      this.replayRect = null;
      this.replayHover = false;
      if (this.replayFlashTimer) {
        clearTimeout(this.replayFlashTimer);
        this.replayFlashTimer = null;
      }
      this.originals = [];
      this.canReplay = false;
      console.log("📝 Legenda na tela: DESATIVADA");
    },

    // Recebe a legenda atual (+ próximas) do inject.js. O modo estudo
    // (pausa no fim da frase) é tratado pelo inject.js, que conhece o
    // currentTime e o endTime de cada cue.
    onCues(data) {
      this.originals = Array.isArray(data.lines) ? data.lines : [];
      this.canReplay = !!data.canReplay;
      this.reposition();
      this.render();
      this.renderReplayButton();

      const mode = (this.settings && this.settings.mode) || "original";
      if (mode !== "original") {
        const ahead = Array.isArray(data.ahead) ? data.ahead : [];
        this.requestTranslations([...this.originals, ...ahead]);
      }
    },

    render() {
      if (!this.el) return;

      const mode = (this.settings && this.settings.mode) || "original";
      const scale = (this.settings && this.settings.fontSize) || "1";
      this.el.style.setProperty("--lsv-scale", scale);

      this.el.textContent = "";

      if (!this.originals.length && !this.lastError) {
        this.el.style.display = "none";
        return;
      }

      for (const original of this.originals) {
        if (mode === "original") {
          this.addLine(original, "lsv-orig");
          continue;
        }

        const translated = this.cache.get(original);

        if (mode === "translated") {
          // Enquanto a tradução não chega, mostra o original como fallback
          this.addLine(translated || original, translated ? "lsv-trans" : "lsv-orig");
        } else {
          // Modo dupla: original em cima, tradução embaixo
          this.addLine(original, "lsv-orig");
          if (translated) this.addLine(translated, "lsv-trans");
        }
      }

      if (this.lastError) {
        this.addLine("⚠ " + this.lastError, "lsv-err");
      }

      this.el.style.display = "flex";
    },

    renderReplayButton() {
      if (!this.replayButton) return;
      this.replayButton.disabled = !this.canReplay;
      this.replayButton.classList.toggle("lsv-replay-ready", this.canReplay);
      this.replayButton.title = this.canReplay
        ? "Repetir última frase"
        : "Aguardando a primeira frase";
    },

    replayLastPhrase() {
      if (!this.canReplay || !this.replayButton) return;

      pageBridge.send("REPLAY_LAST");
      this.replayButton.classList.remove("lsv-replay-hit");
      // Reinicia a animacao mesmo em cliques consecutivos.
      void this.replayButton.offsetWidth;
      this.replayButton.classList.add("lsv-replay-hit");

      if (this.replayFlashTimer) clearTimeout(this.replayFlashTimer);
      this.replayFlashTimer = setTimeout(() => {
        if (this.replayButton) this.replayButton.classList.remove("lsv-replay-hit");
        this.replayFlashTimer = null;
      }, 360);
    },

    // Hit-test do ponteiro pela posição do botão, no nível do document
    // (capture). Necessário porque em fullscreen o ponteiro vai para o vídeo
    // (elemento fullscreen na shadow tree), não para o nosso popover — então
    // nem o clique nem o :hover nativo chegam ao botão, mas o evento sobe aqui.
    onDocumentPointer(event) {
      if (!this.on || !this.replayButton) return;
      const hidden = this.replayButton.style.opacity === "0";
      const inside = !hidden && this.pointInReplay(event);

      // Movimento: só atualiza o estado de hover (nunca engole o evento, senão
      // quebraria os controles/hover do próprio player).
      if (event.type === "pointermove") {
        this.setReplayHover(inside);
        return;
      }

      if (hidden || !inside) return;
      if (event.button !== undefined && event.button !== 0) return; // só primário

      // Dentro do botão: engole o evento para o player não reagir (play/pause).
      event.stopImmediatePropagation();
      if (event.type === "click") {
        event.preventDefault();
        this.replayLastPhrase();
      }
    },

    pointInReplay(event) {
      const r = this.replayRect;
      if (!r) return false;
      const x = event.clientX;
      const y = event.clientY;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    },

    setReplayHover(on) {
      if (this.replayHover === on) return;
      this.replayHover = on;
      if (this.replayButton) this.replayButton.classList.toggle("lsv-replay-hover", on);
    },

    // Traduz um lote de linhas (atual + prefetch) via background/OpenAI.
    requestTranslations(texts) {
      const batch = [];
      for (const text of texts) {
        if (!text || this.cache.has(text) || this.pending.has(text)) continue;
        batch.push(text);
        if (batch.length >= 40) break;
      }
      if (!batch.length) return;

      for (const text of batch) this.pending.add(text);

      chrome.runtime.sendMessage({ type: "TRANSLATE", texts: batch }, (response) => {
        for (const text of batch) this.pending.delete(text);

        if (response && response.ok && Array.isArray(response.translations)) {
          batch.forEach((text, i) => {
            if (response.translations[i]) this.cache.set(text, response.translations[i]);
          });
          this.lastError = "";
        } else {
          this.lastError = (response && response.error) || "Falha ao traduzir.";
          console.warn("❌ Tradução:", this.lastError);
        }
        if (this.on) this.render();
      });
    },

    addLine(text, className) {
      const div = document.createElement("div");
      div.className = "lsv-line " + className;
      div.textContent = text;
      this.el.appendChild(div);
    },

    // Alinha legenda (rodapé central) e botão (rodapé direito) à caixa do
    // player. Fora de fullscreen a caixa é o getBoundingClientRect do
    // <mux-player>; em fullscreen é a viewport (o elemento fullscreen é
    // desenhado em tamanho de tela na top layer, não na caixa do host).
    reposition() {
      if (!this.root) return;
      const player = document.querySelector("mux-player");
      if (!player) {
        this.root.style.opacity = "0";
        if (this.replayButton) this.replayButton.style.opacity = "0";
        this.rootRect = "";
        this.replayRect = null;
        return;
      }
      this.ensureFullscreenListener(player);

      const fullscreen = !!this.deepFullscreenElement();
      let bx, by, bw, bh;
      if (fullscreen) {
        bx = 0;
        by = 0;
        bw = window.innerWidth;
        bh = window.innerHeight;
      } else {
        const r = player.getBoundingClientRect();
        if (!r.width || !r.height) {
          this.root.style.opacity = "0";
          if (this.replayButton) this.replayButton.style.opacity = "0";
          this.rootRect = "";
          this.replayRect = null;
          return;
        }
        bx = r.left;
        by = r.top;
        bw = r.width;
        bh = r.height;
      }

      const key = (fullscreen ? "fs:" : "") + [bx, by, bw, bh].map(Math.round).join(",");
      if (key !== this.rootRect) {
        this.rootRect = key;

        // Legenda: âncora no centro inferior; o translate(-50%,-100%) do CSS
        // assenta a base-central exatamente nesse ponto.
        const subBottom = Math.max(bh * 0.09, fullscreen ? 64 : 0);
        this.root.style.left = bx + bw / 2 + "px";
        this.root.style.top = by + bh - subBottom + "px";
        this.root.style.maxWidth = Math.round(bw * 0.92) + "px";

        // Botão: canto inferior direito. Posiciono pelo canto sup-esq (sem
        // transform) para não conflitar com os transforms de hover/clique.
        if (this.replayButton) {
          const size = bw < 700 ? 40 : 44;
          const rightPad = Math.max(fullscreen ? 16 : 14, bw * (fullscreen ? 0.026 : 0.022));
          const btnBottom = Math.max(bh * (fullscreen ? 0.16 : 0.18), fullscreen ? 96 : 0);
          const left = bx + bw - rightPad - size;
          const top = by + bh - btnBottom - size;
          this.replayButton.style.left = left + "px";
          this.replayButton.style.top = top + "px";
          this.replayRect = { left, top, right: left + size, bottom: top + size };
        }
      }
      this.root.style.opacity = "1";
      if (this.replayButton) this.replayButton.style.opacity = "";
    },

    // Mostra/re-mostra os popovers na top layer. Re-mostrar ao ENTRAR em
    // fullscreen é essencial: a top layer pinta na ordem de entrada, então o
    // elemento que entrou em fullscreen por último ficaria por cima dos nossos
    // — re-mostrar joga legenda e botão de volta para o topo.
    showLayers() {
      for (const node of [this.root, this.replayButton]) {
        if (!node || !node.isConnected || typeof node.showPopover !== "function") continue;
        try {
          if (node.matches(":popover-open")) node.hidePopover();
          node.showPopover();
        } catch (_) {
          // Estado inesperado da Popover API: ignora (degrada para camada fixa).
        }
      }
    },

    onFullscreenChange() {
      if (this.replayButton) this.replayButton.blur();
      const fullscreen = !!this.deepFullscreenElement();
      // Ao entrar, sobe legenda e botão acima do elemento fullscreen recém
      // promovido. Ao sair, NÃO mexemos na top layer nem em nenhum nó do shadow
      // DOM do player — só reposicionamos (era esse "mexer durante a transição"
      // que travava a aba).
      if (fullscreen) this.showLayers();
      this.reposition();
      requestAnimationFrame(() => this.reposition());
    },

    ensureFullscreenListener(player) {
      if (!player.shadowRoot || this.shadowFullscreenRoot === player.shadowRoot) return;
      if (this.shadowFullscreenRoot && this.fullscreenHandler) {
        this.shadowFullscreenRoot.removeEventListener("fullscreenchange", this.fullscreenHandler);
      }
      this.shadowFullscreenRoot = player.shadowRoot;
      if (this.fullscreenHandler) {
        this.shadowFullscreenRoot.addEventListener("fullscreenchange", this.fullscreenHandler);
      }
    },

    deepFullscreenElement() {
      let element = document.fullscreenElement;
      while (element && element.shadowRoot && element.shadowRoot.fullscreenElement) {
        element = element.shadowRoot.fullscreenElement;
      }
      return element;
    },

    ensureEl() {
      // Cada peça é um POPOVER próprio (top layer) em document.body. A legenda
      // não recebe clique, então é passthrough (pointer-events:none). O botão
      // precisa receber clique mesmo por cima do vídeo em fullscreen — por isso
      // é um popover SEPARADO com pointer-events:auto. (Botão como filho de um
      // container passthrough fica inclicável sobre a top layer do fullscreen.)
      if (!this.root) {
        const root = document.createElement("div");
        root.id = "lsv-root";
        // popover="manual": entra na top layer (acima do conteúdo fullscreen)
        // e NÃO fecha com Esc/clique, então o Esc só sai do fullscreen.
        this.applyPopover(root);
        this.root = root;
      }

      if (!this.el) {
        const el = document.createElement("div");
        el.id = "lsv-overlay";
        el.style.display = "none";
        this.el = el;
      }

      if (!this.replayButton) {
        const replay = document.createElement("button");
        replay.id = "lsv-replay";
        replay.type = "button";
        replay.textContent = "↺";
        replay.disabled = true;
        replay.setAttribute("aria-label", "Repetir última frase");
        replay.title = "Aguardando a primeira frase";
        this.applyPopover(replay);
        // O clique é tratado por onDocumentPointer (capture no document), que
        // funciona tanto em janela quanto em fullscreen.
        this.replayButton = replay;
      }

      if (this.el.parentNode !== this.root) this.root.appendChild(this.el);
      if (!this.root.isConnected) document.body.appendChild(this.root);
      if (!this.replayButton.isConnected) document.body.appendChild(this.replayButton);
      this.showLayers();
    },

    // Marca o elemento como popover manual (top layer). Sem suporte à Popover
    // API vira camada fixa comum (funciona fora de fullscreen).
    applyPopover(node) {
      node.setAttribute("popover", "manual");
      if (typeof node.showPopover !== "function") node.removeAttribute("popover");
    },

    ensureStyle() {
      if (this.style) return;
      const style = document.createElement("style");
      style.id = "lsv-style";
      style.textContent = `
        #lsv-root {
          --lsv-scale: 1;
          position: fixed;
          inset: auto;
          width: max-content;
          max-width: 92vw;
          margin: 0;
          padding: 0;
          border: 0;
          background: transparent;
          overflow: visible;
          pointer-events: none;
          /* left/top vêm via JS (centro inferior do player); este transform
             assenta a base-central exatamente nesse ponto. */
          transform: translate(-50%, -100%);
          opacity: 0;
          transition: opacity 120ms ease;
        }
        #lsv-overlay {
          display: none;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          pointer-events: none;
          text-align: center;
        }
        #lsv-overlay .lsv-line {
          background: rgba(0, 0, 0, 0.78);
          color: #fff;
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          font-weight: 600;
          font-size: calc(clamp(16px, 2.4vw, 30px) * var(--lsv-scale));
          line-height: 1.35;
          padding: 0.08em 0.42em;
          border-radius: 4px;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
          white-space: pre-wrap;
        }
        #lsv-overlay .lsv-trans {
          color: #ffc24d;
          font-size: calc(clamp(15px, 2.1vw, 26px) * var(--lsv-scale));
        }
        #lsv-overlay .lsv-err {
          background: rgba(120, 20, 20, 0.85);
          color: #ffd6d6;
          font-size: 13px;
          font-weight: 500;
        }
        #lsv-replay {
          position: fixed;
          inset: auto;
          margin: 0;
          /* left/top vêm via JS (canto inferior direito do player). */
          width: 44px;
          height: 44px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(255, 194, 77, 0.55);
          border-radius: 50%;
          background: rgba(8, 12, 18, 0.78);
          color: #ffc24d;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.36);
          cursor: pointer;
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          font-size: 24px;
          font-weight: 800;
          line-height: 1;
          z-index: 2147483001;
          opacity: 0.42;
          pointer-events: auto;
          transition: transform 140ms ease, opacity 140ms ease, background 140ms ease,
            border-color 140ms ease, box-shadow 140ms ease;
        }
        #lsv-replay.lsv-replay-ready {
          opacity: 1;
        }
        #lsv-replay:hover:not(:disabled),
        #lsv-replay.lsv-replay-hover:not(:disabled),
        #lsv-replay:focus-visible:not(:disabled) {
          background: rgba(12, 18, 27, 0.92);
          border-color: rgba(255, 194, 77, 0.95);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.46), 0 0 0 3px rgba(255, 194, 77, 0.18);
          outline: none;
          transform: translateY(-1px);
        }
        #lsv-replay:active:not(:disabled) {
          transform: translateY(0) scale(0.96);
        }
        #lsv-replay:disabled {
          cursor: default;
        }
        #lsv-replay.lsv-replay-hit {
          animation: lsv-replay-pop 360ms ease;
        }
        @keyframes lsv-replay-pop {
          0% { transform: scale(0.95); }
          55% { transform: scale(1.12); }
          100% { transform: scale(1); }
        }
        @media (max-width: 700px) {
          #lsv-replay {
            width: 40px;
            height: 40px;
            font-size: 22px;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          #lsv-replay {
            transition: none;
          }
          #lsv-replay.lsv-replay-hit {
            animation: none;
          }
        }
      `;
      (document.head || document.documentElement).appendChild(style);
      this.style = style;
    }
  };

  // ===================================================================
  //  Chat com IA sobre o vídeo (usa a transcrição completa como contexto)
  // ===================================================================
  //
  // A legenda do Laracasts é entregue em segmentos .vtt listados num
  // playlist `subtitles.m3u8`. Pegamos a URL desse playlist nas entradas
  // de performance, o background baixa todos os segmentos e monta a
  // transcrição completa. Essa transcrição vai como contexto (system
  // message) em cada conversa com a OpenAI.
  const Chat = {
    panel: null,
    messagesEl: null,
    inputEl: null,
    statusEl: null,
    style: null,
    transcript: "",
    videoTitle: "",
    targetLang: "Portuguese",
    history: [],
    building: false,
    ready: false,
    builtForTitle: "",

    toggle() {
      const open = this.panel && this.panel.style.display === "flex";
      if (open) {
        this.close();
        return false;
      }
      this.open();
      return true;
    },

    open() {
      this.ensureStyle();
      this.ensurePanel();
      this.panel.style.display = "flex";
      this.inputEl.focus();

      chrome.storage.local.get("settings").then(({ settings }) => {
        if (settings && settings.targetLang) this.targetLang = settings.targetLang;
      });

      // Recarrega a transcrição se mudou de episódio (navegação SPA)
      const title = document.title;
      if (this.builtForTitle && this.builtForTitle !== title) {
        this.ready = false;
        this.history = [];
        if (this.messagesEl) this.messagesEl.textContent = "";
      }
      if (!this.ready && !this.building) this.buildTranscript();
    },

    close() {
      if (this.panel) this.panel.style.display = "none";
    },

    buildTranscript() {
      this.building = true;
      this.setStatus("Carregando transcrição do vídeo…");

      // O inject.js (mundo principal) ativa a legenda e baixa os segmentos.
      pageBridge.request("BUILD_TRANSCRIPT").then((response) => {
        this.building = false;
        if (response && response.ok && response.transcript) {
          this.transcript = response.transcript;
          this.videoTitle = document.title.replace(/\s+-\s+Laracasts.*$/i, "").trim();
          this.builtForTitle = document.title;
          this.ready = true;
          this.setStatus(`Pronto — transcrição com ${response.words} palavras. Pergunte algo!`);
        } else {
          this.setStatus(
            "Erro ao montar a transcrição: " + ((response && response.error) || "desconhecido"),
            true
          );
        }
      });
    },

    send() {
      const text = this.inputEl.value.trim();
      if (!text) return;
      if (!this.ready) {
        this.setStatus("Espere a transcrição carregar…", true);
        return;
      }

      this.inputEl.value = "";
      this.addMessage("user", text);
      this.history.push({ role: "user", content: text });

      const bubble = this.addMessage("assistant", "…");
      const messages = this.buildMessages();

      chrome.runtime.sendMessage({ type: "CHAT", messages }, (response) => {
        if (response && response.ok && response.reply) {
          bubble.textContent = response.reply;
          this.history.push({ role: "assistant", content: response.reply });
        } else {
          bubble.textContent = "⚠ " + ((response && response.error) || "Erro ao responder.");
          bubble.classList.add("lsv-chat-err");
        }
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      });
    },

    buildMessages() {
      const system = {
        role: "system",
        content:
          `You are an English tutor helping a student who is learning English by watching a ` +
          `Laracasts lesson titled "${this.videoTitle}". Use the transcript below as the source ` +
          `of truth about the video. Answer in ${this.targetLang} unless the student writes in ` +
          `English. Help them understand the content, explain vocabulary, grammar and idioms with ` +
          `examples, and answer questions about what was said. Be concise.\n\nTRANSCRIPT:\n` +
          this.transcript
      };
      return [system, ...this.history.slice(-12)];
    },

    addMessage(role, text) {
      const row = document.createElement("div");
      row.className = "lsv-chat-msg lsv-chat-" + role;
      const bubble = document.createElement("div");
      bubble.className = "lsv-chat-bubble";
      bubble.textContent = text;
      row.appendChild(bubble);
      this.messagesEl.appendChild(row);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      return bubble;
    },

    setStatus(message, isError = false) {
      if (!this.statusEl) return;
      this.statusEl.textContent = message;
      this.statusEl.classList.toggle("lsv-chat-err", isError);
    },

    ensurePanel() {
      if (this.panel) return;

      const panel = document.createElement("div");
      panel.id = "lsv-chat";

      const header = document.createElement("div");
      header.className = "lsv-chat-header";
      const title = document.createElement("span");
      title.textContent = "Chat about this video";
      const closeBtn = document.createElement("button");
      closeBtn.className = "lsv-chat-close";
      closeBtn.type = "button";
      closeBtn.textContent = "✕";
      closeBtn.addEventListener("click", () => this.close());
      header.appendChild(title);
      header.appendChild(closeBtn);

      const status = document.createElement("div");
      status.className = "lsv-chat-status";
      this.statusEl = status;

      const messages = document.createElement("div");
      messages.className = "lsv-chat-messages";
      this.messagesEl = messages;

      const form = document.createElement("form");
      form.className = "lsv-chat-input";
      const input = document.createElement("textarea");
      input.rows = 2;
      input.placeholder = "Ask about the video, a word, a phrase…";
      this.inputEl = input;
      const sendBtn = document.createElement("button");
      sendBtn.type = "submit";
      sendBtn.textContent = "Send";

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        this.send();
      });
      // Enter envia, Shift+Enter quebra linha
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.send();
        }
      });

      form.appendChild(input);
      form.appendChild(sendBtn);

      panel.appendChild(header);
      panel.appendChild(status);
      panel.appendChild(messages);
      panel.appendChild(form);
      document.body.appendChild(panel);
      this.panel = panel;
    },

    ensureStyle() {
      if (this.style) return;
      const style = document.createElement("style");
      style.id = "lsv-chat-style";
      style.textContent = `
        #lsv-chat {
          position: fixed;
          top: 0;
          right: 0;
          width: 380px;
          max-width: 92vw;
          height: 100vh;
          display: none;
          flex-direction: column;
          background: #0b1524;
          color: #e7edf5;
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          box-shadow: -8px 0 30px rgba(0, 0, 0, 0.5);
          z-index: 2147483600;
        }
        #lsv-chat .lsv-chat-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px;
          font-weight: 700;
          font-size: 15px;
          background: #162136;
          color: #ffac00;
          border-bottom: 1px solid #26344c;
        }
        #lsv-chat .lsv-chat-close {
          background: transparent;
          border: 0;
          color: #8a95a8;
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
          padding: 4px;
        }
        #lsv-chat .lsv-chat-close:hover {
          color: #ffac00;
        }
        #lsv-chat .lsv-chat-status {
          padding: 8px 16px;
          font-size: 12px;
          color: #8a95a8;
          border-bottom: 1px solid #1c2942;
        }
        #lsv-chat .lsv-chat-status.lsv-chat-err {
          color: #ff8a8a;
        }
        #lsv-chat .lsv-chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        #lsv-chat .lsv-chat-msg {
          display: flex;
        }
        #lsv-chat .lsv-chat-user {
          justify-content: flex-end;
        }
        #lsv-chat .lsv-chat-bubble {
          max-width: 85%;
          padding: 9px 12px;
          border-radius: 12px;
          font-size: 14px;
          line-height: 1.45;
          white-space: pre-wrap;
          word-wrap: break-word;
        }
        #lsv-chat .lsv-chat-user .lsv-chat-bubble {
          background: #00a1ff;
          color: #051018;
          border-bottom-right-radius: 3px;
        }
        #lsv-chat .lsv-chat-assistant .lsv-chat-bubble {
          background: #162136;
          color: #e7edf5;
          border-bottom-left-radius: 3px;
        }
        #lsv-chat .lsv-chat-bubble.lsv-chat-err {
          background: #5a1d1d;
          color: #ffd6d6;
        }
        #lsv-chat .lsv-chat-input {
          display: flex;
          gap: 8px;
          padding: 12px 16px;
          border-top: 1px solid #1c2942;
        }
        #lsv-chat .lsv-chat-input textarea {
          flex: 1;
          resize: none;
          background: #162136;
          border: 1px solid #26344c;
          border-radius: 8px;
          color: #e7edf5;
          font-family: inherit;
          font-size: 14px;
          padding: 8px 10px;
        }
        #lsv-chat .lsv-chat-input textarea:focus {
          outline: none;
          border-color: #00a1ff;
        }
        #lsv-chat .lsv-chat-input button {
          background: #ffac00;
          border: 0;
          border-radius: 8px;
          color: #14202e;
          cursor: pointer;
          font-weight: 700;
          padding: 0 16px;
        }
        #lsv-chat .lsv-chat-input button:hover {
          background: #ffbb2e;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
      this.style = style;
    }
  };

  // ===================================================================
  //  Download da legenda em .srt (recurso original, mantido)
  // ===================================================================
  function startIntercepting() {
    if (window.__vttObserver) {
      alert("A extensão já está aguardando. Dê play no vídeo e ative a legenda (CC).");
      return;
    }

    console.log("🕵️‍♂️ Aguardando a requisição do arquivo .vtt...");
    alert("Pronto! Agora dê play no vídeo e ative a legenda (CC) no player.");

    window.__vttObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();

      for (let i = 0; i < entries.length; i++) {
        const url = entries[i].name;

        if (url.includes(".vtt")) {
          console.log("✅ URL da legenda capturada:", url);

          window.__vttObserver.disconnect();
          window.__vttObserver = null;

          chrome.runtime.sendMessage(
            { type: "FETCH_TEXT", url: url, options: {} },
            (response) => {
              if (response && response.ok && response.text) {
                processAndDownloadSrt(response.text);
              } else {
                console.error("❌ Erro ao baixar a legenda via background:", response?.error);
                alert("Erro ao baixar a legenda. Verifique o console.");
              }
            }
          );

          break;
        }
      }
    });

    window.__vttObserver.observe({ entryTypes: ["resource"] });
  }

  function processAndDownloadSrt(vttText) {
    console.log("🔄 Convertendo de VTT para SRT...");

    let srtText = vttText.replace(/^WEBVTT.*\n\n/m, "");
    srtText = srtText.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, "$1,$2");
    srtText = srtText.replace(/(^|\n)(\d{2}:\d{2})\.(\d{3})/g, "$1 00:$2,$3");

    let rawTitle = document.title.replace(/\s+-\s+Laracasts.*$/i, "");
    let fileName = rawTitle.replace(/[^a-z0-9]/gi, "_").toLowerCase() + ".srt";

    const blob = new Blob([srtText], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    console.log(`🎉 Sucesso! Arquivo salvo como: ${fileName}`);
  }

  // ===================================================================
  //  Lembra a última aula assistida (para o botão "Continue watching")
  // ===================================================================
  //
  // Salva a URL da aula atual sempre que estamos numa página de episódio.
  // O Laracasts é uma SPA, então a URL muda sem recarregar — checamos
  // periodicamente além da carga inicial. Ao reabrir a aula, o próprio
  // Laracasts retoma o vídeo na posição onde você parou.
  const LessonTracker = {
    last: "",

    start() {
      this.capture();
      setInterval(() => this.capture(), 2000);
    },

    capture() {
      const match = location.pathname.match(/^\/series\/[^/]+\/episodes\/\d+/);
      if (!match) return;
      const url = location.origin + match[0];
      if (url === this.last) return;
      this.last = url;
      chrome.storage.local.set({ lastLesson: url });
    }
  };

  LessonTracker.start();
})();
