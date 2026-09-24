import { analyzeMp4, faststart } from "./mp4.js?v=2";
import { uploadWithProgress, ZernioApi } from "./api.js?v=2";
import {
  CAPTION_MAX,
  CONTENT_TYPES,
  IG_MAX_HASHTAGS,
  PLATFORM_NAMES,
  PRIVACY_LABELS,
  buildPayload,
  captionLength,
  checkVideo,
  commercialLabel,
  countHashtags,
  coverTargets,
  describePlatform,
  extensionOf,
  formatDuration,
  formatSize,
  friendlyError,
  parsePost,
  safeFilename,
  statusLabel,
  validateRequest,
} from "./rules.js?v=2";

const KEY_STORAGE = "postar.zernioKey";
const LAST_POST_STORAGE = "postar.lastPost";
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;
const LAST_POST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INTERACTIONS = [["allow_comment", "tt-comment"], ["allow_duet", "tt-duet"], ["allow_stitch", "tt-stitch"]];
const NOT_CONNECTED = {
  instagram: "Nenhuma conta conectada. Toque em Conectar (a conta precisa ser Profissional).",
  tiktok: "Nenhuma conta conectada. Toque em Conectar.",
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  api: null,
  profileId: null,
  accounts: { instagram: [], tiktok: [] },
  creator: null,
  creatorFor: null,
  creatorAllows: {},
  tiktokLane: null,
  file: null,
  previewUrl: null,
  meta: null,
  uploadBlob: null,
  uploaded: null,
  videoIssues: [],
  coverBlob: null,
  coverObjectUrl: null,
  coverUploaded: null,
  busy: false,
  lastResult: null,
  lastDraft: false,
  pollToken: 0,
  wakeLock: null,
};

// ---------------------------------------------------------------- utilidades de tela

function setText(id, text) {
  $(id).textContent = text;
}

function setDisabled(id, disabled) {
  $(id).disabled = disabled;
}

function listItem(text, className, url = null) {
  const item = document.createElement("li");
  if (className) item.className = className;
  item.append(document.createTextNode(text));
  if (url && /^https:\/\//i.test(url)) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = url;
    item.append(document.createTextNode(" "), link);
  }
  return item;
}

function showMessage(content, type = "error") {
  const box = $("message");
  box.className = `message${type === "info" ? " info" : ""}`;
  if (Array.isArray(content)) {
    const title = document.createElement("strong");
    title.textContent = "Revise antes de publicar:";
    const list = document.createElement("ul");
    list.append(...content.map((text) => listItem(text)));
    box.replaceChildren(title, list);
  } else {
    box.textContent = content;
  }
  box.hidden = false;
  if (type !== "info") box.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideMessage() {
  $("message").hidden = true;
}

function log(text, url = null, className = null) {
  $("log").append(listItem(text, className, url));
}

function clearLog() {
  $("log").replaceChildren();
  for (const id of ["retry-btn", "refresh-btn", "new-btn"]) $(id).hidden = true;
}

function setProgress(percent, label) {
  $("progress-box").hidden = false;
  const bar = $("progress");
  if (percent === null) bar.removeAttribute("value");
  else bar.value = percent;
  if (label !== undefined) setText("progress-label", label);
}

function hideProgress() {
  $("progress-box").hidden = true;
}

function setStatus(platform, text) {
  const node = $(platform === "instagram" ? "ig-status" : "tt-status");
  node.textContent = text;
  node.hidden = !text;
}

async function keepScreenOn(on) {
  try {
    if (on && "wakeLock" in navigator) state.wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch {
    state.wakeLock = null;
  }
}

// ---------------------------------------------------------------- leitura do formulário

function igFormat() {
  return document.querySelector('input[name="ig-format"]:checked')?.value || "reels";
}

function coverMode() {
  return document.querySelector('input[name="cover-mode"]:checked')?.value || "default";
}

function selectedAccount(platform) {
  const select = $(platform === "instagram" ? "ig-account" : "tt-account");
  return state.accounts[platform][select.selectedIndex] || null;
}

function platformActive(platform) {
  const checkbox = $(platform === "instagram" ? "ig-enabled" : "tt-enabled");
  return checkbox.checked && Boolean(selectedAccount(platform));
}

function tiktokMaxDuration() {
  const value = state.creator?.postingLimits?.maxVideoDurationSec;
  return typeof value === "number" && value > 0 ? value : null;
}

function allows(key) {
  return state.creatorAllows[key] !== false;
}

function buildRequest() {
  const instagram = platformActive("instagram") ? selectedAccount("instagram") : null;
  const tiktok = platformActive("tiktok") ? selectedAccount("tiktok") : null;
  return {
    caption: $("caption").value,
    instagramAccountId: instagram?._id || null,
    tiktokAccountId: tiktok?._id || null,
    consent: $("consent").checked,
    instagram: { format: igFormat(), shareToFeed: $("ig-feed").checked, madeWithAi: $("ig-ai").checked },
    tiktok: {
      privacyLevel: $("tt-privacy").value || null,
      allowComment: $("tt-comment").checked && allows("allow_comment"),
      allowDuet: $("tt-duet").checked && allows("allow_duet"),
      allowStitch: $("tt-stitch").checked && allows("allow_stitch"),
      draft: $("tt-draft").checked,
      discloseCommercial: $("tt-commercial").checked,
      yourBrand: $("tt-brand").checked,
      brandedContent: $("tt-branded").checked,
      madeWithAi: $("tt-ai").checked,
    },
    cover: {
      mode: coverMode(),
      frameMs: Math.round(Number($("cover-range").value) * 1000),
      hasImage: Boolean(state.coverBlob),
      applyInstagram: $("cover-ig").checked,
      applyTiktok: $("cover-tt").checked,
    },
  };
}

// ---------------------------------------------------------------- chave e contas

function readKeyFromHash() {
  if (!location.hash) return null;
  const key = new URLSearchParams(location.hash.slice(1)).get("k");
  history.replaceState(null, "", location.pathname + location.search);
  return key && /^[A-Za-z0-9_]{20,200}$/.test(key) ? key : null;
}

function showSetup(message) {
  $("app").hidden = true;
  $("settings").hidden = true;
  $("settings-btn").hidden = true;
  $("setup").hidden = false;
  if (message) showMessage(message);
}

function start(key) {
  state.api = new ZernioApi(key);
  $("setup").hidden = true;
  $("app").hidden = false;
  $("settings-btn").hidden = false;
  setText("key-status", `Chave configurada: ${key.slice(0, 7)}…${key.slice(-4)}`);
  updateState();
  loadAccounts();
  resumeLastPost();
}

function invalidKey() {
  localStorage.removeItem(KEY_STORAGE);
  state.api = null;
  showSetup("A Zernio recusou a chave salva. Configure este aparelho de novo.");
}

async function loadAccounts() {
  setStatus("instagram", "Carregando contas…");
  setStatus("tiktok", "Carregando contas…");
  try {
    const [profiles, accounts] = await Promise.all([state.api.listProfiles(), state.api.listAccounts()]);
    const profile = profiles.find((item) => item.isDefault) || profiles[0];
    state.profileId = profile?._id || null;
    for (const platform of ["instagram", "tiktok"]) {
      const prefix = platform === "instagram" ? "ig" : "tt";
      const found = accounts.filter((account) => account.platform === platform && account.isActive !== false);
      state.accounts[platform] = found;
      const select = $(`${prefix}-account`);
      select.replaceChildren(...found.map((account, index) => new Option(`@${account.username || account.displayName || account._id}`, String(index))));
      select.hidden = found.length === 0;
      setText(`${prefix}-connect`, found.length ? "Reconectar" : "Conectar");
      const expired = found.some((account) => account.needsReconnection);
      setStatus(platform, !found.length ? NOT_CONNECTED[platform] : expired ? "⚠ A conexão expirou: toque em Reconectar." : "");
    }
    await loadTikTokInfo();
  } catch (error) {
    if (error.status === 401) return invalidKey();
    setStatus("instagram", "Não foi possível carregar as contas.");
    setStatus("tiktok", "Não foi possível carregar as contas.");
    showMessage(friendlyError(error));
  }
  onPlatformsChanged();
}

function resetPrivacy() {
  const placeholder = new Option("Selecione…", "", true, true);
  placeholder.disabled = true;
  $("tt-privacy").replaceChildren(placeholder);
}

async function loadTikTokInfo() {
  const account = selectedAccount("tiktok");
  state.creator = null;
  state.tiktokLane = null;
  state.creatorAllows = {};
  state.creatorFor = account?._id || null;
  resetPrivacy();
  updateState();
  if (!account) return;
  const accountId = account._id;
  setStatus("tiktok", "Consultando a conta no TikTok…");
  try {
    const [info, health] = await Promise.all([
      state.api.tiktokCreatorInfo(accountId),
      state.api.accountHealth(accountId).catch(() => null),
    ]);
    if (state.creatorFor !== accountId) return;
    state.creator = info;
    state.tiktokLane = health?.integrationLane || null;
    const creator = info.creator || {};
    const blocked = creator.canPostMore === false ? " — ⚠ o TikTok não aceita novas publicações agora" : "";
    setStatus("tiktok", `Publicando como: ${creator.nickname || "?"}${blocked}`);
    const select = $("tt-privacy");
    for (const level of info.privacyLevels || []) {
      if (level.value) select.append(new Option(PRIVACY_LABELS[level.value] || level.label || level.value, level.value));
    }
    const settings = info.postingLimits?.interactionSettings || {};
    for (const [key, id] of INTERACTIONS) {
      state.creatorAllows[key] = settings[key]?.enabled !== false;
      $(id).checked = false;
    }
    $("tt-privacy-note").hidden = state.tiktokLane === "developer";
  } catch (error) {
    if (state.creatorFor !== accountId) return;
    if (error.status === 401) return invalidKey();
    setStatus("tiktok", `Não foi possível consultar a conta do TikTok: ${friendlyError(error)}`);
  }
  onPlatformsChanged();
}

async function connect(platform) {
  if (!state.profileId) {
    showMessage("As contas ainda não carregaram. Tente de novo em instantes.");
    return;
  }
  const note = platform === "instagram" ? "A conta precisa ser Profissional (Comercial ou Criador)." : "Aceite todas as permissões pedidas pelo TikTok.";
  if (!window.confirm(`Você vai para a página do ${PLATFORM_NAMES[platform]} para autorizar a Zernio. ${note}\n\nDepois de autorizar, você volta para cá.`)) return;
  try {
    location.href = await state.api.connectUrl(platform, state.profileId, location.origin + location.pathname);
  } catch (error) {
    showMessage(friendlyError(error));
  }
}

// ---------------------------------------------------------------- vídeo

function loadPreview(video, url) {
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onError);
      resolve(value);
    };
    const onMeta = () => finish({
      duration: Number.isFinite(video.duration) ? video.duration : null,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
    });
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), 10_000);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onError);
    video.hidden = false;
    video.src = `${url}#t=0.1`;
    video.load();
  });
}

function videoSummary(meta) {
  const parts = [];
  if (meta.durationS) parts.push(formatDuration(meta.durationS));
  if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`);
  parts.push(formatSize(meta.sizeBytes));
  const codecs = [meta.videoCodec, meta.audioCodec].filter(Boolean).join(" + ");
  if (codecs) parts.push(codecs);
  return parts.join(" • ");
}

async function onVideoChosen(file) {
  if (!file) return;
  state.file = file;
  state.meta = null;
  state.uploadBlob = null;
  state.uploaded = null;
  state.videoIssues = [];
  $("video-issues").replaceChildren();
  setText("video-info", "Analisando o vídeo…");
  updateState();
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  const fromElement = loadPreview($("video-preview"), state.previewUrl);
  const ext = extensionOf(file.name, file.type);
  const analysis = ext === "webm" ? null : await analyzeMp4(file).catch(() => null);
  const elementMeta = await fromElement;
  if (state.file !== file) return;

  const meta = {
    ext,
    sizeBytes: file.size,
    durationS: analysis?.durationS || elementMeta?.duration || null,
    width: analysis?.displayWidth || elementMeta?.width || null,
    height: analysis?.displayHeight || elementMeta?.height || null,
    videoCodec: analysis?.video?.codec || null,
    audioCodec: analysis?.audio?.codec || null,
    moovAtStart: analysis?.moovAtStart ?? null,
    faststartOk: null,
  };
  let blob = file;
  if (analysis && analysis.moovAtStart === false) {
    const fixed = await faststart(file, analysis).catch(() => null);
    meta.faststartOk = Boolean(fixed);
    if (fixed) blob = fixed;
  }
  if (state.file !== file) return;
  state.meta = meta;
  state.uploadBlob = blob;
  setText("video-info", videoSummary(meta));
  const range = $("cover-range");
  range.max = String(Math.max(0, Math.floor((meta.durationS || 0) * 10) / 10));
  range.value = "0";
  setText("cover-time", formatDuration(0));
  onPlatformsChanged();
  if (coverMode() === "frame") seekCover();
}

function recheckVideo() {
  const list = $("video-issues");
  if (!state.meta) {
    list.replaceChildren();
    state.videoIssues = [];
    return state.videoIssues;
  }
  const instagram = platformActive("instagram");
  const tiktok = platformActive("tiktok");
  const issues = checkVideo(state.meta, { instagram, igFormat: igFormat(), tiktok, tiktokMaxDurationS: tiktokMaxDuration() });
  const items = issues.map((issue) => listItem(`${issue.blocking ? "⛔" : "⚠"} ${issue.platform}: ${issue.message}`, issue.blocking ? "block" : "warn"));
  if (instagram && state.meta.faststartOk) items.push(listItem("✔ Arquivo reorganizado para o Instagram, sem perda de qualidade.", "ok"));
  if ((instagram || tiktok) && !issues.some((issue) => issue.blocking)) items.push(listItem("✔ Vídeo compatível com as redes escolhidas.", "ok"));
  list.replaceChildren(...items);
  state.videoIssues = issues;
  return issues;
}

function updateCaptionCount() {
  const text = $("caption").value;
  const length = captionLength(text);
  const hashtags = countHashtags(text);
  const counter = $("caption-count");
  counter.textContent = `${length}/${CAPTION_MAX} caracteres • ${hashtags} hashtags`;
  counter.classList.toggle("error-text", length > CAPTION_MAX || hashtags > IG_MAX_HASHTAGS);
}

// ---------------------------------------------------------------- capa

async function seekCover() {
  const video = $("video-preview");
  const seconds = Number($("cover-range").value);
  setText("cover-time", formatDuration(seconds));
  if (!state.previewUrl) return;
  if (video.readyState < 2) {
    try {
      await video.play();
    } catch {
      // sem permissão para tocar: o quadro aparece quando houver dados
    }
  }
  video.pause();
  if (Math.abs(video.currentTime - seconds) < 0.01) drawCover();
  else video.currentTime = seconds;
}

function drawCover() {
  if (coverMode() !== "frame") return;
  const video = $("video-preview");
  const canvas = $("cover-canvas");
  if (video.readyState < 2 || !video.videoWidth) return;
  const target = canvas.width / canvas.height;
  let sw = video.videoWidth;
  let sh = video.videoHeight;
  if (sw / sh > target) sw = sh * target;
  else sh = sw / target;
  const sx = (video.videoWidth - sw) / 2;
  const sy = (video.videoHeight - sh) / 2;
  canvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("imagem ilegível"));
    };
    image.src = url;
  });
}

/** Converte a imagem para JPEG (lado maior até 1920 px); resolve HEIC do iPhone e PNG com transparência. */
async function toJpeg(file, maxSide = 1920) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    source = await loadImage(file);
  }
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) throw new Error("não foi possível converter a imagem");
  return blob;
}

async function onCoverImageChosen(file) {
  if (!file) return;
  try {
    const blob = await toJpeg(file);
    state.coverBlob = blob;
    state.coverUploaded = null;
    if (state.coverObjectUrl) URL.revokeObjectURL(state.coverObjectUrl);
    state.coverObjectUrl = URL.createObjectURL(blob);
    $("cover-img").src = state.coverObjectUrl;
  } catch {
    showMessage("Não deu para ler esta imagem. Use uma foto em JPG ou PNG.");
  }
  updateState();
}

// ---------------------------------------------------------------- estado dos controles

function onPlatformsChanged() {
  recheckVideo();
  updateState();
}

function updateState() {
  const idle = !state.busy;
  const hasInstagram = state.accounts.instagram.length > 0;
  const hasTiktok = state.accounts.tiktok.length > 0;
  const instagramOn = platformActive("instagram");
  const tiktokOn = platformActive("tiktok");
  const story = igFormat() === "story";

  setDisabled("ig-enabled", !idle || !hasInstagram);
  setDisabled("ig-account", !idle || !hasInstagram);
  setDisabled("ig-connect", !idle);
  for (const input of document.querySelectorAll('input[name="ig-format"]')) input.disabled = !idle || !instagramOn;
  setDisabled("ig-feed", !idle || !instagramOn || story);
  setDisabled("ig-ai", !idle || !instagramOn);
  $("ig-reels-options").hidden = story;
  $("ig-story-note").hidden = !story;

  setDisabled("tt-enabled", !idle || !hasTiktok);
  setDisabled("tt-account", !idle || !hasTiktok);
  setDisabled("tt-connect", !idle);
  const tiktokReady = idle && tiktokOn && Boolean(state.creator);
  const direct = tiktokReady && !$("tt-draft").checked;
  setDisabled("tt-privacy", !direct);
  for (const [key, id] of INTERACTIONS) {
    if (!allows(key)) $(id).checked = false;
    setDisabled(id, !direct || !allows(key));
  }
  setDisabled("tt-draft", !tiktokReady);
  setDisabled("tt-commercial", !direct);
  const commercial = direct && $("tt-commercial").checked;
  $("tt-commercial-options").hidden = !commercial;
  const privateChosen = $("tt-privacy").value === "SELF_ONLY";
  if (privateChosen) $("tt-branded").checked = false;
  setDisabled("tt-brand", !commercial);
  setDisabled("tt-branded", !commercial || privateChosen);
  for (const option of $("tt-privacy").options) {
    if (option.value === "SELF_ONLY") option.disabled = commercial && $("tt-branded").checked;
  }
  const tiktokOptions = { discloseCommercial: commercial, yourBrand: $("tt-brand").checked, brandedContent: $("tt-branded").checked };
  const brandedNote = privateChosen && commercial ? " Conteúdo de marca não pode ser privado." : "";
  setText("tt-commercial-note", commercial ? commercialLabel(tiktokOptions) + brandedNote : "");
  setDisabled("tt-ai", !direct);

  const mode = coverMode();
  const coverForInstagram = instagramOn && !story;
  $("cover-card").hidden = !(state.meta && (coverForInstagram || tiktokOn));
  for (const input of document.querySelectorAll('input[name="cover-mode"]')) input.disabled = !idle;
  $("cover-frame-box").hidden = mode !== "frame";
  $("cover-image-box").hidden = mode !== "image";
  $("cover-canvas").hidden = mode !== "frame";
  $("cover-img").hidden = mode !== "image" || !state.coverBlob;
  $("cover-targets").hidden = mode === "default";
  setDisabled("cover-range", !idle);
  setDisabled("cover-input", !idle);
  setDisabled("cover-ig", !idle || !coverForInstagram);
  setDisabled("cover-tt", !idle || !tiktokOn);
  const notes = [];
  if (mode !== "default" && instagramOn && story) notes.push("Stories não têm capa.");
  if (mode === "image" && tiktokOn && $("cover-tt").checked && state.tiktokLane === "developer") {
    notes.push("Nesta conta do TikTok a imagem entra como primeiro quadro do vídeo.");
  }
  setText("cover-note", notes.join(" "));

  setDisabled("video-input", !idle);
  setDisabled("caption", !idle);
  setDisabled("consent", !idle);
  const ready = idle && Boolean(state.meta) && $("consent").checked && (instagramOn || tiktokOn);
  setDisabled("publish-btn", !ready);
  $("retry-btn").hidden = !(state.lastResult?.canRetry);
  setDisabled("retry-btn", !idle);
  setDisabled("refresh-btn", !idle);
  setDisabled("new-btn", !idle);
}

// ---------------------------------------------------------------- publicação

async function uploadBlob(blob, filename, contentType, label) {
  const presigned = await state.api.presign(filename, contentType, blob.size);
  for (let attempt = 1; ; attempt++) {
    try {
      setProgress(0, `${label}… 0%`);
      await uploadWithProgress(presigned.uploadUrl, blob, contentType, (loaded, total) => {
        const percent = Math.floor((loaded / total) * 100);
        setProgress(percent, `${label}… ${percent}%`);
      });
      return presigned.publicUrl;
    } catch (error) {
      if (attempt >= 2 || !error.transient) throw error;
      await sleep(2000);
    }
  }
}

async function uploadVideo() {
  const key = `${state.file.name}|${state.file.size}|${state.file.lastModified}`;
  if (state.uploaded?.key === key) {
    log("Reaproveitando o vídeo já enviado.");
    return state.uploaded.url;
  }
  const ext = state.meta.ext === "m4v" ? "mp4" : state.meta.ext;
  log(`Enviando o vídeo (${formatSize(state.uploadBlob.size)}). Mantenha esta tela aberta até o envio terminar.`);
  const url = await uploadBlob(state.uploadBlob, safeFilename(state.file.name, ext), CONTENT_TYPES[state.meta.ext], "Enviando vídeo");
  state.uploaded = { key, url };
  return url;
}

async function uploadCover() {
  if (state.coverUploaded?.blob === state.coverBlob) return state.coverUploaded.url;
  const url = await uploadBlob(state.coverBlob, "capa.jpg", "image/jpeg", "Enviando capa");
  state.coverUploaded = { blob: state.coverBlob, url };
  return url;
}

async function createPost(makePayload, videoUrl) {
  try {
    const { data } = await state.api.createPost(makePayload());
    if (!data.post?._id) throw new Error("a Zernio não devolveu a publicação criada");
    return data.post;
  } catch (error) {
    if (error.status !== null) throw error;
    log("Conexão instável; conferindo se a publicação foi criada…");
    await sleep(3000);
    const found = await state.api.findPostByMediaUrl(videoUrl).catch(() => null);
    if (found) return found;
    const { data } = await state.api.createPost(makePayload());
    return data.post;
  }
}

function saveLastPost(postId, draft) {
  localStorage.setItem(LAST_POST_STORAGE, JSON.stringify({ id: postId, draft, at: Date.now() }));
}

async function waitForPost(postId, { maxMs = POLL_TIMEOUT_MS, label = "Publicando…" } = {}) {
  const token = ++state.pollToken;
  const deadline = Date.now() + maxMs;
  let result = null;
  setProgress(null, `${label} O Instagram e o TikTok processam o vídeo, o que pode levar alguns minutos.`);
  while (true) {
    if (token !== state.pollToken) return { result, cancelled: true };
    try {
      result = parsePost(await state.api.getPost(postId));
      if (token !== state.pollToken) return { result, cancelled: true };
      if (result.terminal) return { result, cancelled: false };
      const summary = result.platforms.map((item) => `${item.name}: ${statusLabel(item.status)}`).join(" • ");
      if (summary) setProgress(null, `${label} ${summary}`);
    } catch (error) {
      if (!error.transient) throw error;
    }
    if (Date.now() >= deadline) return { result, cancelled: false };
    await sleep(POLL_INTERVAL_MS);
  }
}

function showResult(result, { announce = true } = {}) {
  state.lastResult = result;
  if (!result) {
    log("A Zernio não respondeu a tempo. Toque em 'Atualizar status' daqui a pouco.");
  } else {
    for (const item of result.platforms) {
      const line = describePlatform(item, { draftRequested: state.lastDraft });
      log(`${line.icon} ${line.text}`, line.url, item.status === "failed" ? "error" : null);
    }
    const tiktokPublished = result.platforms.some((item) => item.platform === "tiktok" && item.status === "published" && !item.isDraft && !state.lastDraft);
    if (tiktokPublished) log("No TikTok, pode levar alguns minutos até o vídeo aparecer no perfil.");
    if (!result.terminal) log("A publicação continua em andamento na Zernio. Toque em 'Atualizar status' daqui a pouco.");
    if (announce && result.status === "published") showMessage("Publicação concluída!", "info");
    else if (announce && result.canRetry) showMessage("Alguma rede falhou. Veja os detalhes em Publicar.");
  }
  $("refresh-btn").hidden = !result?.postId;
  $("new-btn").hidden = false;
  updateState();
  $("log").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function confirmText(req) {
  const names = [req.instagramAccountId && "Instagram", req.tiktokAccountId && "TikTok"].filter(Boolean);
  const lines = [`Publicar agora no ${names.join(" e no ")}?`, ""];
  if (req.instagramAccountId) {
    const where = req.instagram.format === "story" ? "Stories" : req.instagram.shareToFeed ? "Reels + feed" : "só na aba Reels";
    lines.push(`Instagram ${$("ig-account").selectedOptions[0]?.text || ""}: ${where}`);
  }
  if (req.tiktokAccountId) {
    const how = req.tiktok.draft ? "rascunho (você finaliza no app)" : PRIVACY_LABELS[req.tiktok.privacyLevel] || req.tiktok.privacyLevel;
    lines.push(`TikTok ${$("tt-account").selectedOptions[0]?.text || ""}: ${how}`);
  }
  return lines.join("\n");
}

async function publish() {
  if (state.busy || !state.meta) return;
  const req = buildRequest();
  const problems = [
    ...recheckVideo().filter((issue) => issue.blocking).map((issue) => `${issue.platform}: ${issue.message}`),
    ...validateRequest(req, req.tiktokAccountId ? state.creator : null),
  ];
  if (problems.length) {
    showMessage(problems);
    return;
  }
  if (!window.confirm(confirmText(req))) return;
  hideMessage();
  clearLog();
  state.busy = true;
  state.lastResult = null;
  state.lastDraft = Boolean(req.tiktokAccountId && req.tiktok.draft);
  updateState();
  await keepScreenOn(true);
  try {
    const videoUrl = await uploadVideo();
    const targets = coverTargets(req);
    const coverUrl = req.cover.mode === "image" && (targets.instagram || targets.tiktok) ? await uploadCover() : null;
    setProgress(null, "Criando a publicação…");
    const post = await createPost(() => buildPayload(req, { videoUrl, coverUrl }), videoUrl);
    saveLastPost(post._id, state.lastDraft);
    log("Publicação criada. Ela continua na Zernio mesmo se você sair desta tela.");
    showResult((await waitForPost(post._id)).result);
  } catch (error) {
    if (error.status === 401) {
      invalidKey();
      return;
    }
    log(`Erro: ${friendlyError(error)}`, null, "error");
    showMessage(friendlyError(error));
  } finally {
    state.busy = false;
    hideProgress();
    await keepScreenOn(false);
    updateState();
  }
}

async function retryFailed() {
  const postId = state.lastResult?.postId;
  if (!postId || state.busy) return;
  state.busy = true;
  clearLog();
  updateState();
  try {
    log("Tentando de novo nas redes que falharam…");
    setProgress(null, "Tentando de novo…");
    try {
      await state.api.retryPost(postId);
    } catch (error) {
      if (error.status !== null) throw error;
    }
    showResult((await waitForPost(postId, { label: "Tentando de novo…" })).result);
  } catch (error) {
    log(`Erro: ${friendlyError(error)}`, null, "error");
  } finally {
    state.busy = false;
    hideProgress();
    updateState();
  }
}

/** Consulta o status sem travar o formulário; é cancelada se uma nova publicação começar. */
async function checkStatus(postId, { header = null, maxMs = 3 * 60 * 1000 } = {}) {
  try {
    const { result, cancelled } = await waitForPost(postId, { maxMs, label: "Atualizando o status…" });
    if (cancelled || state.busy) return;
    hideProgress();
    clearLog();
    if (header) log(header);
    showResult(result, { announce: false });
  } catch (error) {
    if (state.busy) return;
    hideProgress();
    log(`Não foi possível consultar o status: ${friendlyError(error)}`, null, "error");
  }
}

async function resumeLastPost() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LAST_POST_STORAGE) || "null");
  } catch {
    saved = null;
  }
  if (!saved?.id || Date.now() - saved.at > LAST_POST_MAX_AGE_MS || state.busy) return;
  state.lastDraft = Boolean(saved.draft);
  await checkStatus(saved.id, { header: `Última publicação (${new Date(saved.at).toLocaleString("pt-BR")}):` });
}

function newPost() {
  state.file = null;
  state.meta = null;
  state.uploadBlob = null;
  state.uploaded = null;
  state.videoIssues = [];
  state.lastResult = null;
  state.coverBlob = null;
  state.coverUploaded = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  if (state.coverObjectUrl) URL.revokeObjectURL(state.coverObjectUrl);
  state.previewUrl = null;
  state.coverObjectUrl = null;
  const video = $("video-preview");
  video.removeAttribute("src");
  video.load();
  video.hidden = true;
  $("video-input").value = "";
  $("cover-input").value = "";
  $("cover-img").removeAttribute("src");
  $("caption").value = "";
  $("consent").checked = false;
  setText("video-info", "Nenhum vídeo escolhido.");
  updateCaptionCount();
  hideMessage();
  clearLog();
  onPlatformsChanged();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------- eventos

function bindEvents() {
  $("key-save").addEventListener("click", () => {
    const key = $("key-input").value.trim();
    if (!/^[A-Za-z0-9_]{20,200}$/.test(key)) {
      showMessage("Cole a chave completa da API (começa com sk_).");
      return;
    }
    localStorage.setItem(KEY_STORAGE, key);
    $("key-input").value = "";
    hideMessage();
    start(key);
  });
  $("settings-btn").addEventListener("click", () => {
    $("settings").hidden = !$("settings").hidden;
  });
  $("accounts-refresh").addEventListener("click", () => loadAccounts());
  $("key-forget").addEventListener("click", () => {
    if (!window.confirm("Esquecer a chave neste aparelho? Você vai precisar configurar de novo.")) return;
    localStorage.removeItem(KEY_STORAGE);
    localStorage.removeItem(LAST_POST_STORAGE);
    location.reload();
  });

  $("video-input").addEventListener("change", (event) => onVideoChosen(event.target.files?.[0]));
  $("caption").addEventListener("input", updateCaptionCount);
  $("ig-connect").addEventListener("click", () => connect("instagram"));
  $("tt-connect").addEventListener("click", () => connect("tiktok"));
  $("tt-account").addEventListener("change", () => loadTikTokInfo());
  for (const id of ["ig-enabled", "ig-account", "tt-enabled"]) $(id).addEventListener("change", onPlatformsChanged);
  for (const input of document.querySelectorAll('input[name="ig-format"]')) input.addEventListener("change", onPlatformsChanged);
  for (const id of ["tt-privacy", "tt-draft", "tt-commercial", "tt-brand", "tt-branded", "consent", "cover-ig", "cover-tt"]) {
    $(id).addEventListener("change", updateState);
  }
  for (const input of document.querySelectorAll('input[name="cover-mode"]')) {
    input.addEventListener("change", () => {
      updateState();
      if (coverMode() === "frame") seekCover();
    });
  }
  $("cover-range").addEventListener("input", seekCover);
  $("video-preview").addEventListener("seeked", drawCover);
  $("video-preview").addEventListener("loadeddata", drawCover);
  $("cover-input").addEventListener("change", (event) => onCoverImageChosen(event.target.files?.[0]));
  $("publish-btn").addEventListener("click", publish);
  $("retry-btn").addEventListener("click", retryFailed);
  $("refresh-btn").addEventListener("click", () => {
    if (state.lastResult?.postId && !state.busy) checkStatus(state.lastResult.postId);
  });
  $("new-btn").addEventListener("click", newPost);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.lastResult?.postId && !state.lastResult.terminal && !state.busy) {
      checkStatus(state.lastResult.postId);
    }
  });
  window.addEventListener("hashchange", () => {
    const key = readKeyFromHash();
    if (!key || state.busy) return;
    localStorage.setItem(KEY_STORAGE, key);
    start(key);
    showMessage("Pronto! Este aparelho está configurado.", "info");
  });
}

function init() {
  bindEvents();
  const hashKey = readKeyFromHash();
  if (hashKey) localStorage.setItem(KEY_STORAGE, hashKey);
  const query = new URLSearchParams(location.search);
  const connected = query.get("connected");
  const connectError = query.get("error");
  if (location.search) history.replaceState(null, "", location.pathname);
  const key = localStorage.getItem(KEY_STORAGE);
  if (!key) {
    showSetup();
    return;
  }
  start(key);
  if (hashKey) showMessage("Pronto! Este aparelho está configurado.", "info");
  if (connected) showMessage(`${PLATFORM_NAMES[connected] || connected} conectado!`, "info");
  if (connectError) showMessage(`Não foi possível conectar a conta (${connectError}). Tente de novo.`);
}

init();
