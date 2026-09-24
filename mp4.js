// Leitura de MP4/MOV (ISO-BMFF) no navegador e "faststart": move o átomo moov
// para antes do mdat sem recodificar (equivalente a ffmpeg -movflags +faststart).

const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_BOXES = 10000;
const PATCH_CONTAINERS = new Set(["trak", "mdia", "minf", "stbl"]);

const VIDEO_CODECS = {
  avc1: "h264", avc3: "h264", hvc1: "hevc", hev1: "hevc", vp08: "vp8", vp09: "vp9", av01: "av1",
  mp4v: "mpeg4", ap4h: "prores", ap4x: "prores", apch: "prores", apcn: "prores", apcs: "prores", apco: "prores",
};
const AUDIO_CODECS = {
  mp4a: "aac", "ac-3": "ac3", "ec-3": "eac3", Opus: "opus", alac: "alac", lpcm: "pcm", sowt: "pcm", twos: "pcm",
  ".mp3": "mp3",
};

function fourcc(view, pos) {
  return String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
}

async function readTopLevelBoxes(blob) {
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= blob.size && boxes.length < MAX_BOXES) {
    const buffer = await blob.slice(offset, Math.min(offset + 16, blob.size)).arrayBuffer();
    const view = new DataView(buffer);
    let size = view.getUint32(0);
    const type = fourcc(view, 4);
    let header = 8;
    if (size === 1) {
      if (buffer.byteLength < 16) break;
      size = Number(view.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = blob.size - offset;
    }
    if (!/^[\x20-\x7e]{4}$/.test(type) || size < header || offset + size > blob.size) break;
    boxes.push({ type, offset, size, header });
    offset += size;
  }
  return { boxes, complete: offset === blob.size };
}

function* childBoxes(view, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = fourcc(view, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type, start: pos, body: pos + header, end: pos + size };
    pos += size;
  }
}

function findChild(view, box, type) {
  for (const child of childBoxes(view, box.body, box.end)) {
    if (child.type === type) return child;
  }
  return null;
}

function readMvhdDuration(view, box) {
  const version = view.getUint8(box.body);
  const p = box.body + 4;
  const timescale = version === 1 ? view.getUint32(p + 16) : view.getUint32(p + 8);
  const duration = version === 1 ? Number(view.getBigUint64(p + 20)) : view.getUint32(p + 12);
  return timescale ? duration / timescale : null;
}

function readTrack(view, trak) {
  const track = { handler: null, fourcc: null, codec: null, width: null, height: null, rotation: 0, encrypted: false };
  const tkhd = findChild(view, trak, "tkhd");
  if (tkhd) {
    const matrix = tkhd.body + (view.getUint8(tkhd.body) === 1 ? 52 : 40);
    const a = view.getInt32(matrix) / 65536;
    const b = view.getInt32(matrix + 4) / 65536;
    const degrees = Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90;
    track.rotation = ((degrees % 360) + 360) % 360;
    track.width = view.getUint32(matrix + 36) >>> 16;
    track.height = view.getUint32(matrix + 40) >>> 16;
  }
  const mdia = findChild(view, trak, "mdia");
  if (!mdia) return track;
  const hdlr = findChild(view, mdia, "hdlr");
  if (hdlr) track.handler = fourcc(view, hdlr.body + 8);
  const minf = findChild(view, mdia, "minf");
  const stbl = minf && findChild(view, minf, "stbl");
  if (!stbl) return track;
  track.encrypted = Boolean(findChild(view, stbl, "saio"));
  const stsd = findChild(view, stbl, "stsd");
  if (stsd && view.getUint32(stsd.body + 4) > 0) {
    track.fourcc = fourcc(view, stsd.body + 12);
    const known = track.handler === "soun" ? AUDIO_CODECS : VIDEO_CODECS;
    track.codec = known[track.fourcc] || track.fourcc.trim().toLowerCase();
  }
  return track;
}

function parseMoov(view, header) {
  const info = { durationS: null, video: null, audio: null, compressed: false, encrypted: false };
  for (const child of childBoxes(view, header, view.byteLength)) {
    if (child.type === "cmov") info.compressed = true;
    else if (child.type === "mvhd") info.durationS = readMvhdDuration(view, child);
    else if (child.type === "trak") {
      const track = readTrack(view, child);
      info.encrypted ||= track.encrypted;
      if (track.handler === "vide" && !info.video) info.video = track;
      else if (track.handler === "soun" && !info.audio) info.audio = track;
    }
  }
  return info;
}

/** Analisa o arquivo sem carregá-lo inteiro na memória (lê só os cabeçalhos e o moov). */
export async function analyzeMp4(blob) {
  const { boxes, complete } = await readTopLevelBoxes(blob);
  const types = boxes.map((box) => box.type);
  const moovIndex = types.indexOf("moov");
  const mdatIndex = types.indexOf("mdat");
  const result = {
    isMp4: moovIndex >= 0 || types.includes("ftyp"),
    complete,
    boxes,
    moovAtStart: moovIndex >= 0 && mdatIndex >= 0 ? moovIndex < mdatIndex : null,
    fragmented: types.includes("moof"),
    durationS: null,
    video: null,
    audio: null,
    compressed: false,
    encrypted: false,
    displayWidth: null,
    displayHeight: null,
  };
  const moov = boxes[moovIndex];
  if (moov && moov.size <= MAX_MOOV_BYTES) {
    const view = new DataView(await blob.slice(moov.offset, moov.offset + moov.size).arrayBuffer());
    try {
      Object.assign(result, parseMoov(view, moov.header));
    } catch {
      // moov malformado: mantém o que já foi lido
    }
  }
  if (result.video?.width && result.video?.height) {
    const rotated = result.video.rotation % 180 !== 0;
    result.displayWidth = rotated ? result.video.height : result.video.width;
    result.displayHeight = rotated ? result.video.width : result.video.height;
  }
  return result;
}

/** Soma o deslocamento às tabelas stco/co64 do moov (no próprio buffer). Retorna false se não for possível. */
export function patchChunkOffsets(view, header, mapOffset) {
  let ok = true;
  const visit = (start, end) => {
    for (const box of childBoxes(view, start, end)) {
      if (!ok) return;
      if (PATCH_CONTAINERS.has(box.type)) {
        visit(box.body, box.end);
        continue;
      }
      if (box.type !== "stco" && box.type !== "co64") continue;
      const wide = box.type === "co64";
      const count = view.getUint32(box.body + 4);
      const first = box.body + 8;
      if (first + count * (wide ? 8 : 4) > box.end) {
        ok = false;
        return;
      }
      for (let i = 0; i < count; i++) {
        if (wide) {
          const pos = first + i * 8;
          view.setBigUint64(pos, BigInt(mapOffset(Number(view.getBigUint64(pos)))));
        } else {
          const pos = first + i * 4;
          const value = mapOffset(view.getUint32(pos));
          if (value > 0xffffffff) {
            ok = false;
            return;
          }
          view.setUint32(pos, value);
        }
      }
    }
  };
  visit(header, view.byteLength);
  return ok;
}

/**
 * Devolve um Blob com o moov antes do mdat (o próprio arquivo se já estiver assim),
 * ou null quando o layout não permite o ajuste com segurança.
 */
export async function faststart(blob, analysis) {
  const { boxes } = analysis;
  const moovIndex = boxes.findIndex((box) => box.type === "moov");
  const mdatIndex = boxes.findIndex((box) => box.type === "mdat");
  if (moovIndex < 0 || mdatIndex < 0 || !analysis.complete) return null;
  if (moovIndex < mdatIndex) return blob;
  if (analysis.fragmented || analysis.compressed || analysis.encrypted) return null;
  const moov = boxes[moovIndex];
  if (moov.size > MAX_MOOV_BYTES) return null;
  const buffer = await blob.slice(moov.offset, moov.offset + moov.size).arrayBuffer();
  const insertAt = boxes[0].type === "ftyp" ? boxes[0].size : 0;
  const moved = (offset) => (offset >= insertAt && offset < moov.offset ? offset + moov.size : offset);
  if (!patchChunkOffsets(new DataView(buffer), moov.header, moved)) return null;
  return new Blob(
    [blob.slice(0, insertAt), buffer, blob.slice(insertAt, moov.offset), blob.slice(moov.offset + moov.size)],
    { type: blob.type },
  );
}
