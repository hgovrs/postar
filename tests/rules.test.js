import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildPayload,
  buildTikTokSettings,
  captionLength,
  checkVideo,
  commercialLabel,
  countHashtags,
  countMentions,
  coverTargets,
  describePlatform,
  extensionOf,
  friendlyError,
  MB,
  parsePost,
  safeFilename,
  validateRequest,
} from "../rules.js";

const CREATOR = {
  creator: { nickname: "Hugo", canPostMore: true },
  privacyLevels: [{ value: "PUBLIC_TO_EVERYONE" }],
  postingLimits: { maxVideoDurationSec: 3600 },
};
const NOW = Date.parse("2026-09-24T20:00:00.000Z");

function request(overrides = {}) {
  return {
    caption: "Receita nova 🎉 #receita",
    instagramAccountId: "ig1",
    tiktokAccountId: "tt1",
    consent: true,
    instagram: { format: "reels", shareToFeed: true, madeWithAi: false },
    tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: false, allowStitch: false, draft: false },
    cover: { mode: "default", applyInstagram: true, applyTiktok: true },
    ...overrides,
  };
}

function goodVideo(overrides = {}) {
  return {
    ext: "mp4", sizeBytes: 20 * MB, durationS: 30, width: 1080, height: 1920,
    videoCodec: "h264", audioCodec: "aac", moovAtStart: true, faststartOk: null, ...overrides,
  };
}

describe("legenda", () => {
  test("conta caracteres, hashtags e menções como as redes", () => {
    assert.equal(captionLength("🎉"), 2);
    assert.equal(countHashtags("#a #b c#d &#x #ção ##e"), 4);
    assert.equal(countHashtags("#a#b"), 1);
    assert.equal(countMentions("@ana e @bob.silva mail@x.com"), 2);
  });
});

describe("checkVideo", () => {
  test("vídeo ideal não tem problemas", () => {
    assert.deepEqual(checkVideo(goodVideo(), { instagram: true, tiktok: true, tiktokMaxDurationS: 3600 }), []);
  });

  test("Stories: até 60 s e 100 MB", () => {
    const issues = checkVideo(goodVideo({ durationS: 75, sizeBytes: 150 * MB }), { instagram: true, igFormat: "story", tiktok: false });
    assert.equal(issues.filter((i) => i.blocking).length, 2);
    assert.ok(issues.every((i) => i.platform === "Instagram Stories"));
  });

  test("Reels acima de 90 s só avisa; acima de 15 min bloqueia", () => {
    const warn = checkVideo(goodVideo({ durationS: 120 }), { instagram: true, tiktok: false });
    assert.equal(warn.length, 1);
    assert.equal(warn[0].blocking, false);
    assert.ok(checkVideo(goodVideo({ durationS: 16 * 60 }), { instagram: true, tiktok: false }).some((i) => i.blocking));
  });

  test("TikTok respeita o limite da conta e o máximo de 10 min da API", () => {
    assert.ok(checkVideo(goodVideo({ durationS: 200 }), { tiktok: true, tiktokMaxDurationS: 180 }).some((i) => i.blocking));
    const capped = checkVideo(goodVideo({ durationS: 700 }), { tiktok: true, tiktokMaxDurationS: 3600 });
    assert.match(capped[0].message, /10:00/);
  });

  test("formato, codecs e metadados", () => {
    const webm = checkVideo(goodVideo({ ext: "webm", videoCodec: "vp9", audioCodec: "opus" }), { instagram: true, tiktok: true });
    assert.ok(webm.some((i) => i.platform === "Instagram" && /WebM/.test(i.message)));
    assert.ok(!webm.some((i) => i.platform === "TikTok"));
    assert.ok(checkVideo(goodVideo({ ext: "avi" }), { tiktok: true }).some((i) => i.blocking));
    assert.ok(checkVideo(goodVideo({ videoCodec: "prores" }), { instagram: true }).some((i) => /prores/.test(i.message)));
    const moov = checkVideo(goodVideo({ moovAtStart: false, faststartOk: false }), { instagram: true });
    assert.equal(moov.length, 1);
    assert.equal(moov[0].blocking, false);
    assert.deepEqual(checkVideo(goodVideo({ moovAtStart: false, faststartOk: true }), { instagram: true }), []);
  });

  test("4K, taxa alta e proporção horizontal geram avisos, não bloqueios", () => {
    const issues = checkVideo(goodVideo({ width: 2160, height: 3840, sizeBytes: 300 * MB, durationS: 60 }), { instagram: true, tiktok: true });
    assert.ok(issues.length >= 2 && issues.every((i) => !i.blocking));
    const wide = checkVideo(goodVideo({ width: 1920, height: 1080 }), { tiktok: true });
    assert.equal(wide[0].blocking, false);
  });

  test("duração desconhecida só avisa", () => {
    const issues = checkVideo(goodVideo({ durationS: null }), { instagram: true });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].blocking, false);
  });
});

describe("validateRequest", () => {
  test("pedido completo é válido", () => {
    assert.deepEqual(validateRequest(request(), CREATOR), []);
  });

  test("exige privacidade, consentimento e divulgação completa", () => {
    const problems = validateRequest(request({
      consent: false,
      tiktok: { privacyLevel: null, discloseCommercial: true },
    }), CREATOR).join(" | ");
    assert.match(problems, /quem pode ver/);
    assert.match(problems, /marca de terceiros/);
    assert.match(problems, /autoriza/);
  });

  test("rascunho dispensa privacidade", () => {
    assert.deepEqual(validateRequest(request({ tiktok: { draft: true } }), CREATOR), []);
  });

  test("capa por imagem exige a imagem, a menos que não se aplique", () => {
    const cover = { mode: "image", hasImage: false, applyInstagram: true, applyTiktok: false };
    assert.ok(validateRequest(request({ cover }), CREATOR).some((p) => /imagem da capa/.test(p)));
    const storyOnly = request({ cover, tiktokAccountId: null, instagram: { format: "story" } });
    assert.deepEqual(validateRequest(storyOnly, null), []);
  });

  test("hashtags só contam para Reels", () => {
    const caption = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    assert.ok(validateRequest(request({ caption, tiktokAccountId: null }), null).some((p) => /30 hashtags/.test(p)));
    assert.deepEqual(validateRequest(request({ caption, tiktokAccountId: null, instagram: { format: "story" } }), null), []);
  });

  test("regras da conta do TikTok", () => {
    assert.ok(validateRequest(request({ tiktok: { privacyLevel: "SELF_ONLY" } }), CREATOR).some((p) => /não está disponível/.test(p)));
    const blocked = { ...CREATOR, creator: { canPostMore: false } };
    assert.ok(validateRequest(request(), blocked).some((p) => /não aceita novas/.test(p)));
    assert.ok(validateRequest(request(), null).some((p) => /Aguarde/.test(p)));
  });
});

describe("buildPayload", () => {
  const media = { videoUrl: "https://media.zernio.com/temp/v.mp4", coverUrl: "https://media.zernio.com/temp/c.jpg" };

  test("Reels + TikTok, agendado para daqui a 30 s", () => {
    const payload = buildPayload(request(), media, { nowMs: NOW });
    assert.deepEqual(payload, {
      mediaItems: [{ type: "video", url: media.videoUrl }],
      platforms: [
        { platform: "instagram", accountId: "ig1", platformSpecificData: { shareToFeed: true } },
        { platform: "tiktok", accountId: "tt1" },
      ],
      scheduledFor: "2026-09-24T20:00:30.000Z",
      content: "Receita nova 🎉 #receita",
      tiktokSettings: {
        privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true, allow_duet: false, allow_stitch: false,
        content_preview_confirmed: true, express_consent_given: true, video_made_with_ai: false, commercialContentType: "none",
      },
    });
  });

  test("Stories não recebem capa nem shareToFeed", () => {
    const payload = buildPayload(request({
      tiktokAccountId: null,
      instagram: { format: "story", shareToFeed: true, madeWithAi: true },
      cover: { mode: "frame", frameMs: 1500, applyInstagram: true },
    }), media, { nowMs: NOW });
    assert.deepEqual(payload.platforms[0].platformSpecificData, { contentType: "story", isAiGenerated: true });
    assert.equal(payload.tiktokSettings, undefined);
  });

  test("capa por quadro vai para thumbOffset e video_cover_timestamp_ms", () => {
    const payload = buildPayload(request({ cover: { mode: "frame", frameMs: 2345.6, applyInstagram: true, applyTiktok: true } }), media, { nowMs: NOW });
    assert.equal(payload.platforms[0].platformSpecificData.thumbOffset, 2346);
    assert.equal(payload.tiktokSettings.video_cover_timestamp_ms, 2346);
  });

  test("capa por imagem vai para instagramThumbnail e video_cover_image_url", () => {
    const payload = buildPayload(request({ cover: { mode: "image", hasImage: true, applyInstagram: true, applyTiktok: false } }), media, { nowMs: NOW });
    assert.equal(payload.platforms[0].platformSpecificData.instagramThumbnail, media.coverUrl);
    assert.equal(payload.tiktokSettings.video_cover_image_url, undefined);
    assert.deepEqual(coverTargets(request({ cover: { mode: "image", applyTiktok: true } })), { instagram: true, tiktok: true });
  });

  test("legenda vazia não envia content", () => {
    assert.equal(buildPayload(request({ caption: "  " }), media, { nowMs: NOW }).content, undefined);
  });
});

describe("TikTok", () => {
  test("divulgação comercial", () => {
    const base = { privacyLevel: "PUBLIC_TO_EVERYONE", discloseCommercial: true };
    assert.equal(buildTikTokSettings({ ...base, yourBrand: true }).commercialContentType, "brand_organic");
    assert.equal(buildTikTokSettings({ ...base, brandedContent: true }).commercialContentType, "brand_content");
    const both = buildTikTokSettings({ ...base, yourBrand: true, brandedContent: true });
    assert.equal(both.commercialContentType, "brand_content");
    assert.equal(both.isBrandOrganicPost, true);
    assert.equal(buildTikTokSettings({ privacyLevel: "PUBLIC_TO_EVERYONE", yourBrand: true }).commercialContentType, "none");
    assert.match(commercialLabel({ discloseCommercial: true, yourBrand: true }), /Conteúdo promocional/);
    assert.match(commercialLabel({ discloseCommercial: true, brandedContent: true }), /Parceria paga/);
  });

  test("rascunho zera as opções do post direto", () => {
    const settings = buildTikTokSettings({ draft: true, allowComment: true, madeWithAi: true, discloseCommercial: true, yourBrand: true });
    assert.equal(settings.draft, true);
    assert.equal(settings.privacy_level, "SELF_ONLY");
    assert.equal(settings.allow_comment, false);
    assert.equal(settings.video_made_with_ai, false);
    assert.equal(settings.commercialContentType, "none");
  });
});

describe("resultado", () => {
  test("parsePost e describePlatform", () => {
    const result = parsePost({
      _id: "p1",
      status: "partial",
      platforms: [
        { platform: "instagram", status: "published", platformPostUrl: "https://www.instagram.com/reel/x/" },
        { platform: "tiktok", status: "failed", errorMessage: "boom", errorCategory: "auth_expired" },
      ],
    });
    assert.equal(result.canRetry, true);
    assert.equal(result.terminal, true);
    assert.deepEqual(describePlatform(result.platforms[0]), { icon: "✅", text: "Instagram: publicado", url: "https://www.instagram.com/reel/x/" });
    assert.equal(describePlatform(result.platforms[1]).text, "TikTok: falhou — boom (reconecte a conta)");
    const draft = describePlatform({ platform: "tiktok", name: "TikTok", status: "published" }, { draftRequested: true });
    assert.match(draft.text, /rascunho/);
    assert.equal(parsePost({ _id: "p", status: "scheduled", platforms: [] }).terminal, false);
  });

  test("mensagens de erro amigáveis", () => {
    assert.match(friendlyError({ status: 401, message: "x" }), /chave/);
    assert.match(friendlyError({ status: 402, message: "x", payload: { code: "PAYMENT_REQUIRED", reason: "free_tier_exceeded" } }), /2 contas/);
    assert.match(friendlyError({ status: 402, message: "pague", payload: {} }), /pagamento.*pague/);
    assert.match(friendlyError({ status: 409, message: "x" }), /24 h/);
    assert.match(friendlyError({ status: null, message: "falha de conexão" }), /Sem conexão/);
  });
});

describe("arquivos", () => {
  test("extensão e nome seguro", () => {
    assert.equal(extensionOf("IMG_1234.MOV"), "mov");
    assert.equal(extensionOf("sem-extensao", "video/mp4"), "mp4");
    assert.equal(safeFilename("Vídeo Final (1).MOV", "mov"), "Video-Final-1.mov");
    assert.equal(safeFilename("🎉.mp4", "mp4"), "video.mp4");
  });
});
