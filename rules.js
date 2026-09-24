// Regras das redes, validação e montagem do post para a API da Zernio (sem acesso ao DOM).

export const MB = 1024 * 1024;
export const CAPTION_MAX = 2200;
export const IG_MAX_HASHTAGS = 30;
export const IG_MAX_MENTIONS = 20;
export const SCHEDULE_LEAD_MS = 30_000;
export const TERMINAL_STATUSES = new Set(["published", "partial", "failed", "cancelled"]);

export const LIMITS = {
  minDurationS: 3,
  reelsMaxBytes: 300 * MB,
  reelsMaxDurationS: 15 * 60,
  reelsSafeDurationS: 90,
  storyMaxBytes: 100 * MB,
  storyMaxDurationS: 60,
  tiktokMaxBytes: 4 * 1024 * MB,
  tiktokApiMaxDurationS: 600,
  igMaxWidth: 1920,
  igMaxMbps: 25,
};

export const CONTENT_TYPES = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
const IG_VIDEO_CODECS = new Set(["h264", "hevc"]);
const TIKTOK_VIDEO_CODECS = new Set(["h264", "hevc", "vp8", "vp9"]);

export const PLATFORM_NAMES = { instagram: "Instagram", tiktok: "TikTok" };
export const PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: "Público (todos)",
  MUTUAL_FOLLOW_FRIENDS: "Amigos (seguidores mútuos)",
  FOLLOWER_OF_CREATOR: "Seguidores",
  SELF_ONLY: "Somente eu",
};
const STATUS_LABELS = {
  pending: "pendente",
  processing: "processando",
  uploading: "enviando",
  publishing: "publicando",
  scheduled: "na fila para publicar",
  cancelled: "cancelado",
};
const ERROR_HINTS = {
  auth_expired: "reconecte a conta",
  user_content: "o vídeo ou a legenda não atende às regras da rede",
  user_abuse: "limite de publicações da rede atingido; espere um pouco",
  platform_rate_limit: "a rede limitou temporariamente; a Zernio tenta de novo",
  quota_exhausted: "cota diária esgotada; volta após o reset da rede",
  account_issue: "verifique a configuração da conta (o Instagram precisa ser Profissional)",
  platform_rejected: "a rede recusou o conteúdo por política",
  platform_error: "instabilidade na rede; tente de novo mais tarde",
  system_error: "erro na Zernio; tente de novo",
};

const HASHTAG_RE = /(^|[^\p{L}\p{N}\p{M}_&])#[\p{L}\p{N}\p{M}_]+/gu;
const MENTION_RE = /(^|[^\p{L}\p{N}\p{M}_@])@[\p{L}\p{N}\p{M}_.]+/gu;

/** Tamanho como o Instagram e o TikTok contam (unidades UTF-16: emoji vale 2). */
export const captionLength = (text) => text.length;
export const countHashtags = (text) => (text.match(HASHTAG_RE) || []).length;
export const countMentions = (text) => (text.match(MENTION_RE) || []).length;

export function formatDuration(seconds) {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatSize(bytes) {
  return bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(1)} GB` : `${(bytes / MB).toFixed(1)} MB`;
}

export function extensionOf(name, mimeType = "") {
  const match = /\.([a-z0-9]+)$/i.exec(name || "");
  if (match) return match[1].toLowerCase();
  return { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" }[mimeType] || "";
}

/** Nome ASCII seguro para a URL do arquivo (a Meta recomenda URLs só com ASCII). */
export function safeFilename(name, extension) {
  const stem = (name || "video").replace(/\.[^.]*$/, "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  const clean = stem.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "video";
  return `${clean}.${extension}`;
}

/**
 * Problemas do vídeo para as redes escolhidas.
 * meta: { ext, sizeBytes, durationS, width, height, videoCodec, audioCodec, moovAtStart, faststartOk }
 */
export function checkVideo(meta, { instagram, igFormat = "reels", tiktok, tiktokMaxDurationS = null }) {
  const issues = [];
  const add = (platform, message, blocking = true) => issues.push({ platform, message, blocking });
  if (!instagram && !tiktok) return issues;
  const story = igFormat === "story";
  const ig = story ? "Instagram Stories" : "Instagram Reels";

  if (!CONTENT_TYPES[meta.ext]) add("Geral", `formato ${meta.ext ? `.${meta.ext}` : "desconhecido"} não suportado; use MP4 ou MOV`);
  else if (instagram && meta.ext === "webm") add("Instagram", "não aceita WebM; use MP4 ou MOV");

  if (instagram) {
    const maxBytes = story ? LIMITS.storyMaxBytes : LIMITS.reelsMaxBytes;
    if (meta.sizeBytes > maxBytes) add(ig, `arquivo de ${formatSize(meta.sizeBytes)} passa do limite de ${formatSize(maxBytes)}`);
    if (meta.moovAtStart === false && !meta.faststartOk) {
      add("Instagram", "os metadados do arquivo estão no fim e não deu para reorganizar; o Instagram pode recusar", false);
    }
  }
  if (tiktok && meta.sizeBytes > LIMITS.tiktokMaxBytes) add("TikTok", `arquivo de ${formatSize(meta.sizeBytes)} passa do limite de 4 GB`);

  const duration = meta.durationS;
  if (!duration) {
    add("Geral", "não deu para ler a duração do vídeo", false);
  } else {
    if (duration < LIMITS.minDurationS) add("Geral", "o vídeo precisa ter pelo menos 3 segundos");
    if (instagram && story && duration > LIMITS.storyMaxDurationS) add(ig, "Stories aceitam vídeos de no máximo 60 segundos");
    if (instagram && !story) {
      if (duration > LIMITS.reelsMaxDurationS) add(ig, "Reels aceitam no máximo 15 minutos");
      else if (duration > LIMITS.reelsSafeDurationS) add(ig, "vídeos acima de 90 s podem ser recusados como Reels", false);
    }
    if (tiktok) {
      const limit = Math.min(tiktokMaxDurationS || LIMITS.tiktokApiMaxDurationS, LIMITS.tiktokApiMaxDurationS);
      if (duration > limit) add("TikTok", `sua conta aceita vídeos de até ${formatDuration(limit)}; corte o vídeo`);
    }
    if (instagram && meta.sizeBytes * 8 / duration / 1e6 > LIMITS.igMaxMbps) {
      add("Instagram", "vídeo com taxa acima de 25 Mbps (comum em 4K); o Instagram pode recusar", false);
    }
  }

  if (meta.videoCodec) {
    if (instagram && !IG_VIDEO_CODECS.has(meta.videoCodec)) add("Instagram", `codec de vídeo ${meta.videoCodec} não suportado (precisa ser H.264 ou HEVC)`);
    if (tiktok && !TIKTOK_VIDEO_CODECS.has(meta.videoCodec)) add("TikTok", `codec de vídeo ${meta.videoCodec} não suportado`);
  }
  if (instagram && meta.audioCodec && meta.audioCodec !== "aac") {
    add("Instagram", `áudio ${meta.audioCodec} não suportado (precisa ser AAC)`);
  }

  const { width, height } = meta;
  if (width && height) {
    if (instagram && width > LIMITS.igMaxWidth) add("Instagram", `largura de ${width} px acima de 1920 px (4K); o Instagram pode recusar`, false);
    if (tiktok && (Math.min(width, height) < 360 || Math.max(width, height) > 4096)) {
      add("TikTok", `resolução ${width}×${height} fora do intervalo de 360 a 4096 px`);
    }
    if (Math.abs(width / height - 9 / 16) > 0.02) {
      add("Geral", `proporção ${width}×${height} não é vertical 9:16; pode aparecer com bordas ou cortes`, false);
    }
  }
  return issues;
}

export function commercialLabel(tiktok) {
  if (!tiktok.discloseCommercial) return "";
  if (tiktok.brandedContent) return "Seu vídeo será rotulado como 'Parceria paga'.";
  if (tiktok.yourBrand) return "Seu vídeo será rotulado como 'Conteúdo promocional'.";
  return "Indique se o conteúdo promove você, uma marca de terceiros ou ambos.";
}

/** Se a capa escolhida se aplica a cada rede (Stories não têm capa). */
export function coverTargets(req) {
  const cover = req.cover || { mode: "default" };
  const active = cover.mode === "frame" || cover.mode === "image";
  return {
    instagram: active && Boolean(req.instagramAccountId) && req.instagram?.format !== "story" && cover.applyInstagram !== false,
    tiktok: active && Boolean(req.tiktokAccountId) && Boolean(cover.applyTiktok),
  };
}

/**
 * req: { caption, instagramAccountId, tiktokAccountId, consent,
 *        instagram: { format: "reels"|"story", shareToFeed, madeWithAi },
 *        tiktok: { privacyLevel, allowComment, allowDuet, allowStitch, draft, discloseCommercial, yourBrand, brandedContent, madeWithAi },
 *        cover: { mode: "default"|"frame"|"image", frameMs, hasImage, applyInstagram, applyTiktok } }
 */
export function validateRequest(req, creatorInfo = null) {
  const problems = [];
  if (!req.instagramAccountId && !req.tiktokAccountId) problems.push("Escolha pelo menos uma rede (Instagram ou TikTok).");
  const length = captionLength(req.caption);
  if (length > CAPTION_MAX) problems.push(`A legenda tem ${length} caracteres (máximo ${CAPTION_MAX}).`);
  if (req.instagramAccountId && req.instagram?.format !== "story") {
    if (countHashtags(req.caption) > IG_MAX_HASHTAGS) problems.push(`O Instagram aceita no máximo ${IG_MAX_HASHTAGS} hashtags.`);
    if (countMentions(req.caption) > IG_MAX_MENTIONS) problems.push(`O Instagram aceita no máximo ${IG_MAX_MENTIONS} menções (@).`);
  }
  const targets = coverTargets(req);
  if (req.cover?.mode === "image" && (targets.instagram || targets.tiktok) && !req.cover.hasImage) {
    problems.push("Escolha a imagem da capa (ou mude a capa para 'Padrão').");
  }
  if (req.tiktokAccountId) {
    const tiktok = req.tiktok;
    const allowed = new Set((creatorInfo?.privacyLevels || []).map((level) => level.value));
    if (!creatorInfo) problems.push("Aguarde carregar as informações da conta do TikTok (ou desmarque o TikTok).");
    if (!tiktok.draft) {
      if (!tiktok.privacyLevel) problems.push("Escolha quem pode ver o vídeo no TikTok.");
      else if (allowed.size && !allowed.has(tiktok.privacyLevel)) problems.push("A privacidade escolhida não está disponível para esta conta do TikTok.");
      if (tiktok.discloseCommercial && !(tiktok.yourBrand || tiktok.brandedContent)) {
        problems.push("TikTok: indique se o conteúdo promove você, uma marca de terceiros ou ambos.");
      }
      if (tiktok.discloseCommercial && tiktok.brandedContent && tiktok.privacyLevel === "SELF_ONLY") {
        problems.push("TikTok: conteúdo de marca não pode ter a privacidade 'Somente eu'.");
      }
    }
    if (creatorInfo?.creator?.canPostMore === false) problems.push("O TikTok não aceita novas publicações nesta conta agora. Tente mais tarde.");
  }
  if (!req.consent) problems.push("Marque a confirmação de que revisou o vídeo e autoriza a publicação.");
  return problems;
}

export function buildTikTokSettings(tiktok) {
  const direct = !tiktok.draft;
  const settings = {
    // Em rascunho o TikTok ignora estes campos: tudo é escolhido no app.
    privacy_level: tiktok.privacyLevel || "SELF_ONLY",
    allow_comment: direct && Boolean(tiktok.allowComment),
    allow_duet: direct && Boolean(tiktok.allowDuet),
    allow_stitch: direct && Boolean(tiktok.allowStitch),
    content_preview_confirmed: true,
    express_consent_given: true,
    video_made_with_ai: direct && Boolean(tiktok.madeWithAi),
    commercialContentType: "none",
  };
  if (direct && tiktok.discloseCommercial && tiktok.brandedContent) {
    settings.commercialContentType = "brand_content";
    if (tiktok.yourBrand) settings.isBrandOrganicPost = true;
  } else if (direct && tiktok.discloseCommercial && tiktok.yourBrand) {
    settings.commercialContentType = "brand_organic";
  }
  if (tiktok.draft) settings.draft = true;
  return settings;
}

/**
 * Monta o POST /v1/posts. A publicação é agendada para daqui a alguns segundos:
 * assim a Zernio publica em segundo plano mesmo que o celular bloqueie a tela.
 */
export function buildPayload(req, media, { nowMs = Date.now(), leadMs = SCHEDULE_LEAD_MS } = {}) {
  const cover = req.cover || { mode: "default" };
  const targets = coverTargets(req);
  const frameMs = cover.mode === "frame" ? Math.max(0, Math.round(cover.frameMs || 0)) : null;
  const imageUrl = cover.mode === "image" ? media.coverUrl || null : null;
  const platforms = [];
  if (req.instagramAccountId) {
    const data = {};
    if (req.instagram.format === "story") {
      data.contentType = "story";
    } else {
      data.shareToFeed = req.instagram.shareToFeed !== false;
      if (targets.instagram && imageUrl) data.instagramThumbnail = imageUrl;
      else if (targets.instagram && frameMs !== null) data.thumbOffset = frameMs;
    }
    if (req.instagram.madeWithAi) data.isAiGenerated = true;
    platforms.push({ platform: "instagram", accountId: req.instagramAccountId, platformSpecificData: data });
  }
  if (req.tiktokAccountId) platforms.push({ platform: "tiktok", accountId: req.tiktokAccountId });

  const payload = {
    mediaItems: [{ type: "video", url: media.videoUrl }],
    platforms,
    scheduledFor: new Date(nowMs + leadMs).toISOString(),
  };
  const caption = req.caption.trim();
  if (caption) payload.content = caption;
  if (req.tiktokAccountId) {
    const settings = buildTikTokSettings(req.tiktok);
    if (targets.tiktok && imageUrl) settings.video_cover_image_url = imageUrl;
    else if (targets.tiktok && frameMs !== null) settings.video_cover_timestamp_ms = frameMs;
    payload.tiktokSettings = settings;
  }
  return payload;
}

export function parsePost(post) {
  const platforms = (post?.platforms || []).map((entry) => ({
    platform: entry.platform || "?",
    name: PLATFORM_NAMES[entry.platform] || entry.platform || "?",
    status: entry.status || "desconhecido",
    url: entry.platformPostUrl || null,
    error: entry.errorMessage || null,
    errorCategory: entry.errorCategory || null,
    isDraft: Boolean(entry.platformSpecificData?.isDraft),
  }));
  const status = post?.status || "desconhecido";
  return {
    postId: post?._id || null,
    status,
    platforms,
    terminal: TERMINAL_STATUSES.has(status),
    canRetry: Boolean(post?._id) && (status === "failed" || status === "partial"),
  };
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

/** Linha de resumo de cada rede e, se houver, o link público. */
export function describePlatform(result, { draftRequested = false } = {}) {
  if (result.status === "published") {
    if (result.isDraft || (result.platform === "tiktok" && draftRequested)) {
      return { icon: "✅", text: `${result.name}: rascunho enviado. Abra o app do TikTok (notificação na caixa de entrada) para finalizar.`, url: null };
    }
    if (result.url) return { icon: "✅", text: `${result.name}: publicado`, url: result.url };
    return { icon: "✅", text: `${result.name}: publicado. O link aparece em alguns minutos.`, url: null };
  }
  if (result.status === "failed") {
    const hint = ERROR_HINTS[result.errorCategory];
    return { icon: "❌", text: `${result.name}: falhou — ${result.error || "motivo não informado"}${hint ? ` (${hint})` : ""}`, url: null };
  }
  return { icon: "⏳", text: `${result.name}: ${statusLabel(result.status)}`, url: null };
}

export function friendlyError(error) {
  const status = error?.status;
  if (status === 401) return "A Zernio recusou a chave da API. Configure a chave de novo (menu ⚙).";
  if (status === 402 && error.payload?.reason === "free_tier_exceeded") {
    return "O plano grátis da Zernio permite 2 contas e as duas já estão em uso. Para conectar ou trocar uma conta, use o painel da Zernio (zernio.com) ou adicione um cartão lá.";
  }
  if (status === 402) return `A Zernio exige um método de pagamento para esta ação: ${error.message}`;
  if (status === 403) return `A chave não tem permissão para esta ação: ${error.message}`;
  if (status === 409) return "Este mesmo conteúdo já foi publicado nesta conta nas últimas 24 h. Mude a legenda ou o vídeo.";
  if (status === 429) return "Muitas requisições em pouco tempo. Aguarde um minuto e tente de novo.";
  if (status === null) return `Sem conexão com a Zernio: ${error.message}`;
  if (status) return `A Zernio recusou o pedido (HTTP ${status}): ${error.message}`;
  return error?.message || String(error);
}
