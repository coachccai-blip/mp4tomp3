/* Studio Audio — conversion MP4→MP3 et nettoyage audio, 100 % dans le navigateur. */
(() => {
"use strict";

const MAX_FILES = 30;

/* ============================ Utilitaires ============================ */

function humanSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " Ko";
  return (bytes / (1024 * 1024)).toFixed(1) + " Mo";
}
function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}
function baseName(name) { return name.replace(/\.[^.]+$/, ""); }
function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function zipAndDownload(entries, zipName, nameOf, blobOf) {
  const zip = new JSZip();
  const used = new Set();
  for (const e of entries) {
    let name = nameOf(e);
    let i = 1;
    while (used.has(name)) name = name.replace(/(\.[^.]+)$/, ` (${i++})$1`);
    used.add(name);
    zip.file(name, blobOf(e));
  }
  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload(blob, zipName);
}

/* ============================ Moteur ffmpeg partagé ============================ */

let ffmpegPromise = null;
let ffmpegRef = null;

async function getFFmpeg(onStatus) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      if (onStatus) onStatus("Chargement du moteur audio (une seule fois)…");
      const { FFmpeg } = FFmpegWASM;
      const ff = new FFmpeg();
      await ff.load({
        coreURL: new URL("vendor/ffmpeg-core.js", location.href).href,
        wasmURL: new URL("vendor/ffmpeg-core.wasm", location.href).href,
      });
      try {
        const { fetchFile } = FFmpegUtil;
        await ff.writeFile("bd.rnnn", await fetchFile(new URL("vendor/models/bd.rnnn", location.href).href));
      } catch (err) {
        console.warn("Modèle RNNoise indisponible :", err);
      }
      ffmpegRef = ff;
      return ff;
    })().catch(err => { ffmpegPromise = null; throw err; });
  }
  return ffmpegPromise;
}

/* Tue le worker ffmpeg (annulation) ; il sera rechargé au prochain besoin. */
function killFFmpeg() {
  try { if (ffmpegRef) ffmpegRef.terminate(); } catch (_) {}
  ffmpegRef = null;
  ffmpegPromise = null;
}

/* Exécute ffmpeg en capturant les logs (et la progression si demandée). */
async function runFF(ff, args, opts = {}) {
  const logs = [];
  const logCb = ({ message }) => logs.push(message);
  ff.on("log", logCb);
  if (opts.onProgress) ff.on("progress", opts.onProgress);
  try {
    const code = await ff.exec(args);
    return { code, logs };
  } finally {
    ff.off("log", logCb);
    if (opts.onProgress) ff.off("progress", opts.onProgress);
  }
}

/* Lit la fréquence, les canaux et la durée d'un fichier déjà écrit dans MEMFS. */
async function probeInput(ff, inName) {
  const { logs } = await runFF(ff, ["-i", inName]); // sort en erreur : normal, on ne lit que les logs
  const text = logs.join("\n");
  const rate = (text.match(/(\d+) Hz/) || [])[1];
  const dur = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const duration = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]) : NaN;
  const hasAudio = /Audio:/.test(text);
  return { rate: rate ? +rate : 48000, duration, hasAudio };
}

/* ============================ Onglets ============================ */

const tabs = [
  { btn: document.getElementById("tabbtn-convert"), panel: document.getElementById("tab-convert"), hash: "#conversion" },
  { btn: document.getElementById("tabbtn-clean"), panel: document.getElementById("tab-clean"), hash: "#nettoyage" },
];
function selectTab(idx) {
  tabs.forEach((t, i) => {
    t.btn.setAttribute("aria-selected", String(i === idx));
    t.panel.hidden = i !== idx;
  });
  history.replaceState(null, "", tabs[idx].hash);
}
tabs.forEach((t, i) => t.btn.addEventListener("click", () => selectTab(i)));
if (location.hash === "#nettoyage") selectTab(1);

/* ============================ Onglet 1 : MP4 → MP3 ============================ */

(() => {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const fileList = document.getElementById("fileList");
  const convertBtn = document.getElementById("convertBtn");
  const zipBtn = document.getElementById("zipBtn");
  const clearBtn = document.getElementById("clearBtn");
  const qualitySelect = document.getElementById("quality");
  const statusEl = document.getElementById("status");

  let queue = [];
  let converting = false;

  const setStatus = msg => { statusEl.textContent = msg; };
  const mp3Name = name => baseName(name) + ".mp3";

  function refreshButtons() {
    const hasFiles = queue.length > 0;
    const hasPending = queue.some(e => e.status === "waiting" || e.status === "error");
    const doneCount = queue.filter(e => e.status === "done").length;
    convertBtn.disabled = converting || !hasPending;
    clearBtn.disabled = converting || !hasFiles;
    zipBtn.disabled = converting || doneCount === 0;
    zipBtn.textContent = doneCount > 0 ? `Tout télécharger (ZIP) — ${doneCount}` : "Tout télécharger (ZIP)";
  }

  function setBadge(entry, status, label) {
    entry.status = status;
    const badge = entry.li.querySelector(".badge");
    badge.className = "badge " + status;
    badge.textContent = label;
  }

  function addFiles(files) {
    if (converting) return;
    const videos = [...files].filter(f => /\.(mp4|m4v|mov)$/i.test(f.name) || f.type.startsWith("video/"));
    const skipped = files.length - videos.length;
    const room = MAX_FILES - queue.length;
    const accepted = videos.slice(0, room);

    for (const file of accepted) {
      const li = document.createElement("li");
      li.className = "file-item";
      li.innerHTML = `
        <div class="file-name" title="${file.name}">${file.name}</div>
        <div class="file-actions">
          <span class="badge waiting">En attente</span>
          <button class="btn-success dl-btn" style="display:none">Télécharger</button>
          <button class="btn-ghost rm-btn" aria-label="Retirer ${file.name}">✕</button>
        </div>
        <div class="file-meta">${humanSize(file.size)} → ${mp3Name(file.name)}</div>
        <div class="progress"><div></div></div>`;
      const entry = { file, status: "waiting", mp3Blob: null, li };
      li.querySelector(".rm-btn").addEventListener("click", () => {
        if (converting) return;
        queue = queue.filter(e => e !== entry);
        li.remove();
        refreshButtons();
        setStatus(queue.length ? `${queue.length}/${MAX_FILES} fichier(s) dans la liste.` : "");
      });
      li.querySelector(".dl-btn").addEventListener("click", () => {
        if (entry.mp3Blob) triggerDownload(entry.mp3Blob, mp3Name(entry.file.name));
      });
      fileList.appendChild(li);
      queue.push(entry);
    }

    let msg = `${queue.length}/${MAX_FILES} fichier(s) dans la liste.`;
    if (videos.length > room) msg += ` ${videos.length - room} fichier(s) refusé(s) : limite de ${MAX_FILES} par lot atteinte.`;
    if (skipped > 0) msg += ` ${skipped} fichier(s) ignoré(s) (pas des vidéos).`;
    setStatus(msg);
    refreshButtons();
  }

  async function convertAll() {
    if (converting) return;
    converting = true;
    refreshButtons();
    fileInput.disabled = true;

    try {
      const ff = await getFFmpeg(setStatus);
      const { fetchFile } = FFmpegUtil;
      const quality = qualitySelect.value;
      const pending = queue.filter(e => e.status === "waiting" || e.status === "error");
      let done = 0;

      for (const entry of pending) {
        const progressBar = entry.li.querySelector(".progress");
        const progressFill = progressBar.querySelector("div");
        setBadge(entry, "converting", "Conversion…");
        progressBar.classList.add("active");
        setStatus(`Conversion ${done + 1}/${pending.length} : ${entry.file.name}`);

        const onProgress = ({ progress }) => {
          progressFill.style.width = Math.min(100, Math.round(progress * 100)) + "%";
        };

        const inName = "in_" + Date.now() + ".mp4";
        const outName = "out_" + Date.now() + ".mp3";
        try {
          await ff.writeFile(inName, await fetchFile(entry.file));
          const { code } = await runFF(ff, [
            "-i", inName, "-vn", "-acodec", "libmp3lame", "-q:a", quality, outName,
          ], { onProgress });
          if (code !== 0) throw new Error("ffmpeg a retourné le code " + code);
          const data = await ff.readFile(outName);
          entry.mp3Blob = new Blob([data.buffer], { type: "audio/mpeg" });
          setBadge(entry, "done", "Terminé ✓");
          entry.li.querySelector(".dl-btn").style.display = "";
          entry.li.querySelector(".file-meta").textContent =
            `${humanSize(entry.file.size)} → ${mp3Name(entry.file.name)} (${humanSize(entry.mp3Blob.size)})`;
          done++;
        } catch (err) {
          console.error("Erreur de conversion pour", entry.file.name, err);
          setBadge(entry, "error", "Erreur — réessayer");
        } finally {
          progressBar.classList.remove("active");
          progressFill.style.width = "0%";
          try { await ff.deleteFile(inName); } catch (_) {}
          try { await ff.deleteFile(outName); } catch (_) {}
        }
      }

      const errors = pending.length - done;
      setStatus(
        `Terminé : ${done} fichier(s) converti(s)` +
        (errors ? `, ${errors} en erreur (cliquez sur « Convertir » pour réessayer).` : ".")
      );
    } catch (err) {
      console.error(err);
      setStatus("Erreur : impossible de charger le moteur de conversion. Servez l'application via un serveur web (voir README) puis rechargez la page.");
    } finally {
      converting = false;
      fileInput.disabled = false;
      refreshButtons();
    }
  }

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", e => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    addFiles([...e.dataTransfer.files]);
  });
  fileInput.addEventListener("change", () => { addFiles([...fileInput.files]); fileInput.value = ""; });
  convertBtn.addEventListener("click", convertAll);
  zipBtn.addEventListener("click", async () => {
    const done = queue.filter(e => e.status === "done" && e.mp3Blob);
    if (!done.length) return;
    setStatus("Création du ZIP…");
    await zipAndDownload(done, "conversion_mp3.zip", e => mp3Name(e.file.name), e => e.mp3Blob);
    setStatus(`ZIP téléchargé : ${done.length} fichier(s) MP3.`);
  });
  clearBtn.addEventListener("click", () => {
    if (converting) return;
    queue = [];
    fileList.innerHTML = "";
    setStatus("");
    refreshButtons();
  });
})();

/* ============================ Onglet 2 : Nettoyage audio ============================ */

(() => {
  const dropzone = document.getElementById("dropzoneClean");
  const fileInput = document.getElementById("fileInputClean");
  const fileList = document.getElementById("clFileList");
  const cleanBtn = document.getElementById("clCleanBtn");
  const cancelBtn = document.getElementById("clCancelBtn");
  const zipBtn = document.getElementById("clZipBtn");
  const clearBtn = document.getElementById("clClearBtn");
  const statusEl = document.getElementById("clStatus");
  const presetSel = document.getElementById("clPreset");
  const reductionWrap = document.getElementById("clReductionWrap");
  const reductionInput = document.getElementById("clReduction");
  const reductionOut = document.getElementById("clReductionOut");
  const intensityInput = document.getElementById("clIntensity");
  const intensityOut = document.getElementById("clIntensityOut");
  const gainInput = document.getElementById("clGain");
  const gainOut = document.getElementById("clGainOut");
  const normSel = document.getElementById("clNorm");
  const formatSel = document.getElementById("clFormat");
  const trimCheck = document.getElementById("clTrim");
  const elEnable = document.getElementById("elEnable");
  const elKey = document.getElementById("elKey");

  let queue = [];
  let processing = false;
  let cancelRequested = false;
  let audioCtx = null;
  let currentPlayer = null; // un seul lecteur A/B actif à la fois

  try { elKey.value = localStorage.getItem("elevenlabs_api_key") || ""; } catch (_) {}
  elKey.addEventListener("change", () => {
    try { localStorage.setItem("elevenlabs_api_key", elKey.value.trim()); } catch (_) {}
  });

  const PRESET_INTENSITY = { profil: 100, leger: 60, standard: 85, fort: 100, voix: 100 };
  presetSel.addEventListener("change", () => {
    intensityInput.value = PRESET_INTENSITY[presetSel.value];
    intensityInput.dispatchEvent(new Event("input"));
    refreshNoiseUI();
  });
  intensityInput.addEventListener("input", () => { intensityOut.textContent = intensityInput.value + " %"; });
  reductionInput.addEventListener("input", () => { reductionOut.textContent = reductionInput.value + " dB"; });
  gainInput.addEventListener("input", () => {
    gainOut.textContent = (gainInput.value > 0 ? "+" : "") + gainInput.value + " dB";
  });

  const setStatus = msg => { statusEl.textContent = msg; };

  const AUDIO_RE = /\.(wav|mp3|m4a|aac|ogg|oga|flac|webm|mp4|m4v|mov|wma|opus)$/i;
  function outName(entry, format) {
    const ext = format === "mp3" ? "mp3" : "wav";
    return baseName(entry.file.name) + "_nettoye." + ext;
  }

  function refreshButtons() {
    const hasFiles = queue.length > 0;
    const hasPending = queue.some(e => e.status === "waiting" || e.status === "error");
    const doneCount = queue.filter(e => e.status === "done").length;
    cleanBtn.disabled = processing || !hasPending;
    clearBtn.disabled = processing || !hasFiles;
    zipBtn.disabled = processing || doneCount === 0;
    cancelBtn.hidden = !processing;
    zipBtn.textContent = doneCount > 0 ? `Tout télécharger (ZIP) — ${doneCount}` : "Tout télécharger (ZIP)";
  }

  function setBadge(entry, status, label) {
    entry.status = status;
    const badge = entry.li.querySelector(".badge");
    badge.className = "badge " + status;
    badge.textContent = label;
  }

  function releaseEntry(entry) {
    if (entry.player) entry.player.destroy();
    if (entry.origUrl) URL.revokeObjectURL(entry.origUrl);
    if (entry.cleanUrl) URL.revokeObjectURL(entry.cleanUrl);
  }

  function addFiles(files) {
    if (processing) return;
    const audios = [...files].filter(f =>
      AUDIO_RE.test(f.name) || f.type.startsWith("audio/") || f.type.startsWith("video/")
    );
    const skipped = files.length - audios.length;
    const room = MAX_FILES - queue.length;
    const accepted = audios.slice(0, room);

    for (const file of accepted) {
      const li = document.createElement("li");
      li.className = "file-item";
      li.innerHTML = `
        <div class="file-name" title="${file.name}">${file.name}</div>
        <div class="file-actions">
          <span class="badge waiting">En attente</span>
          <button class="btn-success dl-btn" style="display:none">Télécharger</button>
          <button class="btn-ghost rm-btn" aria-label="Retirer ${file.name}">✕</button>
        </div>
        <div class="file-meta">${humanSize(file.size)}</div>
        <div class="progress"><div></div></div>
        <canvas class="wave" hidden aria-label="Forme d'onde avant/après"></canvas>
        <div class="noise-hint file-meta" hidden></div>
        <div class="ab-player" hidden>
          <button class="btn-ghost play-btn" aria-label="Lecture / pause">▶</button>
          <button class="btn-primary ab-btn" aria-pressed="true" title="Basculer entre l'original et la version nettoyée">Nettoyé</button>
          <input type="range" class="seek" value="0" min="0" max="1000" aria-label="Position de lecture">
          <span class="time">0:00 / 0:00</span>
        </div>
        <div class="levels file-meta"></div>`;
      const entry = {
        file, status: "waiting", cleanBlob: null, li, player: null,
        origUrl: null, cleanUrl: null, peakBefore: null,
        peaksBefore: null, peaksAfter: null, duration: null,
        noiseSel: null, decodeFailed: false,
      };
      li.querySelector(".rm-btn").addEventListener("click", () => {
        if (processing) return;
        releaseEntry(entry);
        queue = queue.filter(e => e !== entry);
        li.remove();
        refreshButtons();
        setStatus(queue.length ? `${queue.length}/${MAX_FILES} fichier(s) dans la liste.` : "");
      });
      li.querySelector(".dl-btn").addEventListener("click", () => {
        if (entry.cleanBlob) triggerDownload(entry.cleanBlob, entry.cleanName);
      });
      fileList.appendChild(li);
      queue.push(entry);
      attachWaveSelection(entry);
      analyzeEntry(entry); // asynchrone : forme d'onde + détection de la zone de bruit
    }

    let msg = `${queue.length}/${MAX_FILES} fichier(s) dans la liste.`;
    if (audios.length > room) msg += ` ${audios.length - room} fichier(s) refusé(s) : limite de ${MAX_FILES} par lot atteinte.`;
    if (skipped > 0) msg += ` ${skipped} fichier(s) ignoré(s) (format non reconnu).`;
    setStatus(msg);
    refreshButtons();
  }

  /* ---------- Construction de la chaîne de filtres ---------- */

  function denoiseFilter(preset) {
    switch (preset) {
      case "leger": return "afftdn=nr=9:nf=-30:tn=1";
      case "fort": return "afftdn=nr=24:nf=-20:tn=1";
      case "voix": return "highpass=f=75,aresample=48000,arnndn=m=bd.rnnn";
      default: return "afftdn=nr=12:nf=-25:tn=1"; // standard
    }
  }

  /* Sous-graphe « méthode Audacity » : la zone de bruit sélectionnée est préfixée
     au fichier, afftdn la mesure comme profil (sample_noise), l'applique à tout
     le fichier, puis le préfixe est coupé — la durée d'origine est conservée. */
  function profileCore(sel, reduction, inNoise, inFull, out) {
    const L = sel.end - sel.start;
    return `[${inNoise}]atrim=start=${sel.start.toFixed(3)}:end=${sel.end.toFixed(3)},asetpts=PTS-STARTPTS[np];` +
           `[${inFull}]asetpts=PTS-STARTPTS[fl];` +
           `[np][fl]concat=n=2:v=0:a=1,` +
           `asendcmd=c=0 afftdn@nz sample_noise start,` +
           `asendcmd=c=${Math.max(0.01, L - 0.05).toFixed(3)} afftdn@nz sample_noise stop,` +
           `afftdn@nz=nr=${reduction}:nf=-30,` +
           `atrim=start=${L.toFixed(3)},asetpts=PTS-STARTPTS[${out}]`;
  }

  /* Chaîne avant normalisation : débruitage + mélange dry/wet + gain. */
  function buildPreChain(settings, entry) {
    const w = settings.skipDenoise ? 0 : settings.intensity / 100;
    let graph;
    if (settings.preset === "profil" && !settings.skipDenoise && w > 0) {
      const sel = entry._sel;
      if (w >= 1) {
        graph = `[0:a]asplit=2[np0][fl0];` + profileCore(sel, settings.reduction, "np0", "fl0", "dn");
      } else {
        const dry = (1 - w).toFixed(3), wet = w.toFixed(3);
        graph = `[0:a]asplit=3[cd0][np0][fl0];[cd0]volume=${dry}[cd];` +
                profileCore(sel, settings.reduction, "np0", "fl0", "w0") +
                `;[w0]volume=${wet}[cw];[cd][cw]amix=inputs=2:duration=first:normalize=0[dn]`;
      }
    } else if (w >= 1) {
      graph = `[0:a]${denoiseFilter(settings.preset)}[dn]`;
    } else if (w <= 0) {
      graph = `[0:a]anull[dn]`;
    } else {
      const dry = (1 - w).toFixed(3), wet = w.toFixed(3);
      graph = `[0:a]asplit=2[cd0][cw0];` +
              `[cd0]volume=${dry}[cd];` +
              `[cw0]${denoiseFilter(settings.preset)},volume=${wet}[cw];` +
              `[cd][cw]amix=inputs=2:duration=first:normalize=0[dn]`;
    }
    const post = [];
    if (settings.gain !== 0) post.push(`volume=${settings.gain}dB`);
    return { graph, post };
  }

  /* Borne la zone de bruit aux limites réelles du fichier. */
  function clampNoiseSel(sel, duration) {
    const dur = isFinite(duration) && duration > 0 ? duration : 3600;
    let start = sel ? sel.start : 0;
    let end = sel ? sel.end : 0.75;
    start = Math.max(0, Math.min(start, dur - 0.15));
    end = Math.max(start + 0.1, Math.min(end, dur - 0.02));
    if (end - start > dur * 0.9) end = start + dur * 0.9;
    return { start, end };
  }

  /* Filtres de fin de chaîne : retour à la fréquence d'origine, limiteur, mesure, trim. */
  function tailFilters(settings, rate) {
    const tail = [`aresample=${rate}`, "alimiter=limit=0.891251:level=false", "volumedetect"];
    if (settings.trim) {
      tail.push("silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.2:stop_periods=1:stop_threshold=-45dB:stop_silence=0.2");
    }
    return tail;
  }

  function encodeArgs(format) {
    if (format === "wav16") return ["-c:a", "pcm_s16le"];
    if (format === "wav24") return ["-c:a", "pcm_s24le"];
    return ["-c:a", "libmp3lame", "-q:a", "2"];
  }

  function parseMaxVolume(logs) {
    const m = logs.join("\n").match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    return m ? parseFloat(m[1]) : null;
  }
  function parseLoudnormJson(logs) {
    const text = logs.join("\n");
    const start = text.lastIndexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
  }

  /* ---------- Mode ElevenLabs ---------- */

  async function elevenLabsIsolate(file, key) {
    const form = new FormData();
    form.append("audio", file, file.name);
    let resp;
    try {
      resp = await fetch("https://api.elevenlabs.io/v1/audio-isolation", {
        method: "POST",
        headers: { "xi-api-key": key },
        body: form,
      });
    } catch (err) {
      throw new Error("Appel ElevenLabs impossible depuis le navigateur (réseau ou CORS). Utilisez le moteur local.");
    }
    if (resp.status === 401) throw new Error("Clé API ElevenLabs invalide ou expirée.");
    if (!resp.ok) throw new Error(`ElevenLabs a répondu ${resp.status}. Vérifiez votre crédit et réessayez.`);
    return await resp.blob();
  }

  /* ---------- Traitement d'un fichier ---------- */

  async function processOne(entry, settings, indexLabel) {
    const ff = await getFFmpeg(setStatus);
    const { fetchFile } = FFmpegUtil;
    const progressBar = entry.li.querySelector(".progress");
    const progressFill = progressBar.querySelector("div");
    progressBar.classList.add("active");

    const id = Date.now() + "_" + Math.floor(Math.random() * 1e6);
    const ext = (entry.file.name.match(/\.([^.]+)$/) || [, "dat"])[1].toLowerCase();
    const inName = `cin_${id}.${ext}`;
    const outExt = settings.format === "mp3" ? "mp3" : "wav";
    const outFile = `cout_${id}.${outExt}`;

    const setPhase = (label, indeterminate) => {
      setBadge(entry, "converting", label);
      progressBar.classList.toggle("indeterminate", !!indeterminate);
      if (indeterminate) progressFill.style.width = "30%";
    };
    const onProgress = ({ progress }) => {
      progressFill.style.width = Math.min(100, Math.round(progress * 100)) + "%";
    };

    try {
      let inputBlob = entry.file;
      if (settings.elevenlabs) {
        setPhase("Isolation ElevenLabs…", true);
        setStatus(`${indexLabel} : envoi à ElevenLabs — ${entry.file.name}`);
        inputBlob = await elevenLabsIsolate(entry.file, settings.elKey);
        if (cancelRequested) throw new Error("Annulé");
      }

      await ff.writeFile(inName, await fetchFile(inputBlob));
      const meta = await probeInput(ff, inName);
      if (!meta.hasAudio) throw new Error("Aucune piste audio détectée dans ce fichier.");

      entry.lufsTarget = null;
      entry.peakAfter = null;
      if (settings.preset === "profil" && !settings.skipDenoise) {
        entry._sel = clampNoiseSel(entry.noiseSel, meta.duration);
      }
      const pre = buildPreChain(settings, entry);
      const preStr = pre.post.length ? "," + pre.post.join(",") : "";
      const tail = tailFilters(settings, meta.rate).join(",");
      let normStr = "";

      if (settings.norm === "peak" || settings.norm === "lufs16" || settings.norm === "lufs14") {
        // Passe 1 : mesure sur la chaîne pré-normalisation
        setPhase("Analyse (passe 1/2)…", true);
        setStatus(`${indexLabel} : analyse — ${entry.file.name}`);
        const target = settings.norm === "lufs14" ? -14 : -16;
        const measureFilter = settings.norm === "peak"
          ? "volumedetect"
          : `loudnorm=I=${target}:TP=-1.0:LRA=11:print_format=json`;
        const g1 = `${pre.graph};[dn]anull${preStr},${measureFilter}[out]`;
        const r1 = await runFF(ff, ["-i", inName, "-filter_complex", g1, "-map", "[out]", "-f", "null", "-"]);
        if (cancelRequested) throw new Error("Annulé");
        if (r1.code !== 0) throw new Error("Échec de l'analyse (code " + r1.code + ")");

        if (settings.norm === "peak") {
          const maxVol = parseMaxVolume(r1.logs);
          const adj = maxVol === null ? 0 : Math.max(-60, Math.min(60, -1 - maxVol));
          normStr = `,volume=${adj.toFixed(2)}dB`;
        } else {
          const j = parseLoudnormJson(r1.logs);
          if (!j) throw new Error("Mesure de sonie illisible.");
          normStr = `,loudnorm=I=${target}:TP=-1.0:LRA=11` +
            `:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}` +
            `:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
          entry.lufsTarget = target;
        }
      }

      // Passe finale : chaîne complète + encodage
      setPhase(normStr ? "Nettoyage (passe 2/2)…" : "Nettoyage…", false);
      setStatus(`${indexLabel} : nettoyage — ${entry.file.name}`);
      const g2 = `${pre.graph};[dn]anull${preStr}${normStr},${tail}[out]`;
      const r2 = await runFF(ff,
        ["-i", inName, "-filter_complex", g2, "-map", "[out]", ...encodeArgs(settings.format), outFile],
        { onProgress });
      if (cancelRequested) throw new Error("Annulé");
      if (r2.code !== 0) throw new Error("Échec du traitement (code " + r2.code + ")");

      const data = await ff.readFile(outFile);
      entry.cleanBlob = new Blob([data.buffer], { type: settings.format === "mp3" ? "audio/mpeg" : "audio/wav" });
      entry.cleanName = outName(entry, settings.format);
      entry.peakAfter = parseMaxVolume(r2.logs);

      setBadge(entry, "done", "Terminé ✓");
      entry.li.querySelector(".dl-btn").style.display = "";
      entry.li.querySelector(".file-meta").textContent =
        `${humanSize(entry.file.size)} → ${entry.cleanName} (${humanSize(entry.cleanBlob.size)})`;

      const levels = [];
      if (entry.peakBefore !== null && isFinite(entry.peakBefore)) levels.push(`Crête avant : ${entry.peakBefore.toFixed(1)} dB`);
      if (entry.peakAfter !== null) levels.push(`Crête après : ${entry.peakAfter.toFixed(1)} dB`);
      if (entry.lufsTarget) levels.push(`Sonie cible : ${entry.lufsTarget} LUFS`);
      entry.li.querySelector(".levels").textContent = levels.join(" · ");

      setupABPlayer(entry);
      analyzeClean(entry); // asynchrone : superpose la forme d'onde nettoyée
      return true;
    } finally {
      progressBar.classList.remove("active", "indeterminate");
      progressFill.style.width = "0%";
      try { await ff.deleteFile(inName); } catch (_) {}
      try { await ff.deleteFile(outFile); } catch (_) {}
    }
  }

  async function processAll() {
    if (processing) return;
    processing = true;
    cancelRequested = false;
    refreshButtons();
    fileInput.disabled = true;

    const settings = {
      preset: presetSel.value,
      reduction: +reductionInput.value,
      intensity: +intensityInput.value,
      gain: +gainInput.value,
      norm: normSel.value,
      format: formatSel.value,
      trim: trimCheck.checked,
      elevenlabs: elEnable.checked,
      elKey: elKey.value.trim(),
      skipDenoise: elEnable.checked, // l'API fait déjà l'isolation
    };
    if (settings.elevenlabs && !settings.elKey) {
      setStatus("Mode ElevenLabs activé mais aucune clé API fournie. Saisissez votre clé ou désactivez ce mode.");
      processing = false;
      fileInput.disabled = false;
      refreshButtons();
      return;
    }

    let done = 0, failed = 0;
    try {
      const pending = queue.filter(e => e.status === "waiting" || e.status === "error");
      for (let i = 0; i < pending.length; i++) {
        if (cancelRequested) break;
        const entry = pending[i];
        try {
          await processOne(entry, settings, `Fichier ${i + 1}/${pending.length}`);
          done++;
        } catch (err) {
          console.error("Erreur de nettoyage pour", entry.file.name, err);
          const cancelled = cancelRequested || /Annulé/.test(String(err && err.message));
          setBadge(entry, "error", cancelled ? "Annulé" : "Erreur — réessayer");
          if (!cancelled) {
            failed++;
            entry.li.querySelector(".levels").textContent = String(err && err.message || err);
          }
          if (cancelRequested) break;
        }
      }
      if (cancelRequested) {
        setStatus(`Traitement annulé. ${done} fichier(s) terminé(s) avant l'annulation.`);
      } else {
        setStatus(`Terminé : ${done} fichier(s) nettoyé(s)` +
          (failed ? `, ${failed} en erreur (détail sous chaque fichier ; cliquez sur « Nettoyer » pour réessayer).` : ".") +
          (done ? " Écoutez le résultat avec le bouton Original/Nettoyé." : ""));
      }
    } catch (err) {
      console.error(err);
      setStatus("Erreur : impossible de charger le moteur audio. Servez l'application via un serveur web (voir README) puis rechargez la page.");
    } finally {
      processing = false;
      fileInput.disabled = false;
      refreshButtons();
    }
  }

  function cancelProcessing() {
    if (!processing) return;
    cancelRequested = true;
    setStatus("Annulation en cours…");
    killFFmpeg(); // interrompt l'exec en cours ; le moteur sera rechargé au besoin
  }

  /* ---------- Lecteur A/B ---------- */

  function setupABPlayer(entry) {
    if (entry.player) entry.player.destroy();
    if (entry.origUrl) URL.revokeObjectURL(entry.origUrl);
    if (entry.cleanUrl) URL.revokeObjectURL(entry.cleanUrl);
    entry.origUrl = URL.createObjectURL(entry.file);
    entry.cleanUrl = URL.createObjectURL(entry.cleanBlob);

    const wrap = entry.li.querySelector(".ab-player");
    const playBtn = wrap.querySelector(".play-btn");
    const abBtn = wrap.querySelector(".ab-btn");
    const seek = wrap.querySelector(".seek");
    const timeEl = wrap.querySelector(".time");
    wrap.hidden = false;

    const orig = new Audio(entry.origUrl);
    const clean = new Audio(entry.cleanUrl);
    orig.preload = clean.preload = "auto";
    let useClean = true;
    let origPlayable = true;
    orig.muted = true;
    orig.addEventListener("error", () => { origPlayable = false; });

    const active = () => (useClean || !origPlayable ? clean : orig);
    const inactive = () => (useClean || !origPlayable ? orig : clean);

    function updateTime() {
      const a = active();
      timeEl.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration || 0)}`;
      if (a.duration) seek.value = Math.round((a.currentTime / a.duration) * 1000);
    }

    let raf = null;
    function tick() {
      updateTime();
      // resynchronise doucement la piste inactive
      const a = active(), b = inactive();
      if (origPlayable && Math.abs(a.currentTime - b.currentTime) > 0.15) b.currentTime = a.currentTime;
      raf = requestAnimationFrame(tick);
    }

    const player = {
      playing: false,
      async play() {
        if (currentPlayer && currentPlayer !== player) currentPlayer.pause();
        currentPlayer = player;
        clean.muted = !useClean && origPlayable;
        orig.muted = useClean || !origPlayable;
        try { await clean.play(); } catch (_) {}
        if (origPlayable) { try { await orig.play(); } catch (_) { origPlayable = false; } }
        player.playing = true;
        playBtn.textContent = "⏸";
        if (!raf) tick();
      },
      pause() {
        clean.pause(); orig.pause();
        player.playing = false;
        playBtn.textContent = "▶";
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        updateTime();
      },
      destroy() {
        player.pause();
        clean.src = ""; orig.src = "";
        if (currentPlayer === player) currentPlayer = null;
      },
    };
    entry.player = player;

    playBtn.addEventListener("click", () => (player.playing ? player.pause() : player.play()));
    abBtn.addEventListener("click", () => {
      if (!origPlayable) {
        abBtn.textContent = "Original indisponible";
        setTimeout(() => { abBtn.textContent = "Nettoyé"; }, 1500);
        return;
      }
      useClean = !useClean;
      abBtn.textContent = useClean ? "Nettoyé" : "Original";
      abBtn.setAttribute("aria-pressed", String(useClean));
      abBtn.classList.toggle("btn-primary", useClean);
      abBtn.classList.toggle("btn-ghost", !useClean);
      // bascule instantanée : les deux pistes jouent en parallèle, on ne fait qu'échanger le muet
      clean.muted = !useClean;
      orig.muted = useClean;
    });
    seek.addEventListener("input", () => {
      const a = active();
      if (!a.duration) return;
      const t = (seek.value / 1000) * a.duration;
      clean.currentTime = t;
      if (origPlayable) orig.currentTime = t;
      updateTime();
    });
    clean.addEventListener("ended", () => player.pause());
    clean.addEventListener("loadedmetadata", updateTime);
    updateTime();
  }

  /* ---------- Formes d'onde, zone de bruit et sélection ---------- */

  const WAVE_MAX_BYTES = 80 * 1024 * 1024;
  const BUCKETS = 400;

  const fmtSec = v => v.toFixed(2).replace(".", ",") + " s";

  async function decodeBlob(blob) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    return buf;
  }

  function computePeaks(channel, buckets) {
    const per = Math.max(1, Math.floor(channel.length / buckets));
    const peaks = new Float32Array(buckets);
    for (let b = 0; b < buckets; b++) {
      let max = 0;
      const start = b * per, end = Math.min(channel.length, start + per);
      for (let i = start; i < end; i += 4) {
        const v = Math.abs(channel[i]);
        if (v > max) max = v;
      }
      peaks[b] = max;
    }
    return peaks;
  }

  /* Fenêtre la plus silencieuse du fichier : proposée comme zone de bruit. */
  function autoDetectNoise(channel, rate, duration) {
    const win = Math.min(1, Math.max(0.3, duration * 0.1));
    const winN = Math.floor(win * rate);
    const stepN = Math.max(1, Math.floor(0.05 * rate));
    const dec = 8; // sous-échantillonnage pour la vitesse
    let best = Infinity, bestI = 0;
    for (let start = 0; start + winN <= channel.length; start += stepN) {
      let sum = 0, n = 0;
      for (let i = start; i < start + winN; i += dec) { const v = channel[i]; sum += v * v; n++; }
      const e = sum / Math.max(1, n);
      if (e < best) { best = e; bestI = start; }
    }
    return { start: bestI / rate, end: bestI / rate + win, auto: true };
  }

  /* Décode le fichier dès son ajout : forme d'onde + zone de bruit proposée. */
  async function analyzeEntry(entry) {
    if (entry.file.size > WAVE_MAX_BYTES) {
      entry.decodeFailed = true;
      entry.noiseSel = { start: 0, end: 0.75, auto: true, fallback: true };
      updateNoiseHint(entry);
      return;
    }
    try {
      const buf = await decodeBlob(entry.file);
      const ch = buf.getChannelData(0);
      entry.duration = buf.duration;
      entry.peaksBefore = computePeaks(ch, BUCKETS);
      let peak = 0; for (const v of entry.peaksBefore) if (v > peak) peak = v;
      entry.peakBefore = peak > 0 ? 20 * Math.log10(peak) : null;
      entry.noiseSel = autoDetectNoise(ch, buf.sampleRate, buf.duration);
    } catch (err) {
      console.warn("Décodage impossible pour", entry.file.name, err);
      entry.decodeFailed = true;
      entry.noiseSel = { start: 0, end: 0.75, auto: true, fallback: true };
    }
    drawWave(entry);
    updateNoiseHint(entry);
  }

  /* Après nettoyage : superpose la forme d'onde de la version nettoyée. */
  async function analyzeClean(entry) {
    if (!entry.cleanBlob || entry.cleanBlob.size > WAVE_MAX_BYTES) return;
    try {
      const buf = await decodeBlob(entry.cleanBlob);
      entry.peaksAfter = computePeaks(buf.getChannelData(0), BUCKETS);
      drawWave(entry);
    } catch (err) {
      console.warn("Forme d'onde nettoyée indisponible pour", entry.file.name, err);
    }
  }

  function drawWave(entry) {
    const canvas = entry.li.querySelector("canvas.wave");
    if (!entry.peaksBefore) { canvas.hidden = true; return; }
    const selectable = presetSel.value === "profil";
    canvas.hidden = false;
    canvas.classList.toggle("selectable", selectable && !processing);
    const css = getComputedStyle(document.documentElement);
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 600, H = 52;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const mid = H / 2;
    const drawSeries = (peaks, color, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      const bw = W / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const h = Math.max(1, peaks[i] * (H - 4));
        ctx.fillRect(i * bw, mid - h / 2, Math.max(1, bw - 0.5), h);
      }
      ctx.globalAlpha = 1;
    };
    drawSeries(entry.peaksBefore, css.getPropertyValue("--wave-before").trim() || "#4a5178", 0.9);
    if (entry.peaksAfter) drawSeries(entry.peaksAfter, css.getPropertyValue("--wave-after").trim() || "#8b96ff", 0.85);
    // surbrillance de la zone de bruit sélectionnée (mode profil uniquement)
    if (selectable && entry.noiseSel && entry.duration && !entry.noiseSel.fallback) {
      const accent = css.getPropertyValue("--accent").trim() || "#6c7bff";
      const x1 = (entry.noiseSel.start / entry.duration) * W;
      const x2 = (entry.noiseSel.end / entry.duration) * W;
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = accent;
      ctx.fillRect(x1, 0, Math.max(2, x2 - x1), H);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x1, 0, 1.5, H);
      ctx.fillRect(x2 - 1.5, 0, 1.5, H);
      ctx.globalAlpha = 1;
    }
  }

  function updateNoiseHint(entry) {
    const hint = entry.li.querySelector(".noise-hint");
    if (presetSel.value !== "profil") { hint.hidden = true; return; }
    hint.hidden = false;
    if (!entry.noiseSel) {
      hint.textContent = "Analyse de la forme d'onde…";
    } else if (entry.noiseSel.fallback) {
      hint.textContent = "Aperçu indisponible pour ce fichier : les 0,75 premières secondes serviront de profil de bruit.";
    } else {
      hint.textContent = `Zone de bruit analysée : ${fmtSec(entry.noiseSel.start)} → ${fmtSec(entry.noiseSel.end)}` +
        (entry.noiseSel.auto ? " (détectée automatiquement — glissez sur la forme d'onde pour l'ajuster)" : "");
    }
  }

  /* Sélection de la zone de bruit à la souris / au doigt sur la forme d'onde. */
  function attachWaveSelection(entry) {
    const canvas = entry.li.querySelector("canvas.wave");
    let dragStart = null;
    const frac = e => {
      const r = canvas.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    canvas.addEventListener("pointerdown", e => {
      if (presetSel.value !== "profil" || processing || !entry.duration || entry.decodeFailed) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      dragStart = frac(e) * entry.duration;
      entry.noiseSel = { start: dragStart, end: dragStart, auto: false };
      drawWave(entry);
    });
    canvas.addEventListener("pointermove", e => {
      if (dragStart === null) return;
      const t = frac(e) * entry.duration;
      entry.noiseSel = { start: Math.min(dragStart, t), end: Math.max(dragStart, t), auto: false };
      drawWave(entry);
      updateNoiseHint(entry);
    });
    canvas.addEventListener("pointerup", e => {
      if (dragStart === null) return;
      const t = frac(e) * entry.duration;
      let start = Math.min(dragStart, t), end = Math.max(dragStart, t);
      dragStart = null;
      if (end - start < 0.1) { // simple clic : fenêtre de 0,5 s centrée
        start = Math.max(0, (start + end) / 2 - 0.25);
        end = Math.min(entry.duration, start + 0.5);
      }
      entry.noiseSel = { start, end, auto: false };
      drawWave(entry);
      updateNoiseHint(entry);
    });
  }

  /* Rafraîchit surbrillances et indications quand le préréglage change. */
  function refreshNoiseUI() {
    reductionWrap.style.display = presetSel.value === "profil" ? "" : "none";
    queue.forEach(e => { drawWave(e); updateNoiseHint(e); });
  }
  refreshNoiseUI();

  /* ---------- Écouteurs ---------- */

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", e => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    addFiles([...e.dataTransfer.files]);
  });
  fileInput.addEventListener("change", () => { addFiles([...fileInput.files]); fileInput.value = ""; });
  cleanBtn.addEventListener("click", processAll);
  cancelBtn.addEventListener("click", cancelProcessing);
  zipBtn.addEventListener("click", async () => {
    const done = queue.filter(e => e.status === "done" && e.cleanBlob);
    if (!done.length) return;
    setStatus("Création du ZIP…");
    await zipAndDownload(done, "audio_nettoye.zip", e => e.cleanName, e => e.cleanBlob);
    setStatus(`ZIP téléchargé : ${done.length} fichier(s).`);
  });
  clearBtn.addEventListener("click", () => {
    if (processing) return;
    queue.forEach(releaseEntry);
    queue = [];
    fileList.innerHTML = "";
    setStatus("");
    refreshButtons();
  });
})();

/* ============================ Hors-ligne (service worker) ============================ */

if ("serviceWorker" in navigator &&
    (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))) {
  navigator.serviceWorker.register("sw.js").catch(err => console.warn("Service worker :", err));
}

})();
