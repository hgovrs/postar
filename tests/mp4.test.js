import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, openAsBlob, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { analyzeMp4, faststart, patchChunkOffsets } from "../mp4.js";

const FFMPEG = process.env.FFMPEG_PATH;
const work = mkdtempSync(join(tmpdir(), "mp4-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

function fullBox(type, payload) {
  return box(type, Buffer.alloc(4), payload);
}

function offsetsTable(type, values) {
  const wide = type === "co64";
  const payload = Buffer.alloc(4 + values.length * (wide ? 8 : 4));
  payload.writeUInt32BE(values.length);
  values.forEach((value, i) => {
    if (wide) payload.writeBigUInt64BE(BigInt(value), 4 + i * 8);
    else payload.writeUInt32BE(value, 4 + i * 4);
  });
  return fullBox(type, payload);
}

function moovWith(table) {
  return box("moov", box("trak", box("mdia", box("minf", box("stbl", table)))));
}

function ffmpeg(...args) {
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

function packetHashes(path) {
  return spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0", "-c", "copy", "-f", "framemd5", "-"], {
    encoding: "utf8",
  }).stdout.split("\n").filter((line) => line && !line.startsWith("#"));
}

async function writeBlob(blob, path) {
  writeFileSync(path, Buffer.from(await blob.arrayBuffer()));
}

describe("patchChunkOffsets", () => {
  test("atualiza stco e co64 dentro de trak/mdia/minf/stbl", () => {
    for (const type of ["stco", "co64"]) {
      const moov = moovWith(offsetsTable(type, [100, 5000, 2 ** 20]));
      const view = new DataView(moov.buffer.slice(moov.byteOffset, moov.byteOffset + moov.length));
      assert.equal(patchChunkOffsets(view, 8, (offset) => offset + 1000), true);
      const buf = Buffer.from(view.buffer);
      const first = buf.indexOf(type) + 12;
      const read = (i) => (type === "co64" ? Number(buf.readBigUInt64BE(first + i * 8)) : buf.readUInt32BE(first + i * 4));
      assert.deepEqual([read(0), read(1), read(2)], [1100, 6000, 2 ** 20 + 1000]);
    }
  });

  test("recusa estouro de 32 bits no stco", () => {
    const moov = moovWith(offsetsTable("stco", [0xffffff00]));
    const view = new DataView(moov.buffer.slice(moov.byteOffset, moov.byteOffset + moov.length));
    assert.equal(patchChunkOffsets(view, 8, (offset) => offset + 0x1000), false);
  });

  test("recusa tabela truncada", () => {
    const table = offsetsTable("stco", [1, 2]);
    table.writeUInt32BE(50, 12);
    const moov = moovWith(table);
    const view = new DataView(moov.buffer.slice(moov.byteOffset, moov.byteOffset + moov.length));
    assert.equal(patchChunkOffsets(view, 8, (offset) => offset + 1), false);
  });
});

describe("faststart com caixas sintéticas", () => {
  test("move o moov para depois do ftyp e corrige os offsets", async () => {
    const ftyp = box("ftyp", Buffer.from("isom0000"));
    const mdat = box("mdat", Buffer.from("ABCDEFGH"));
    const originalOffset = ftyp.length + 8;
    const moov = moovWith(offsetsTable("stco", [originalOffset]));
    const blob = new Blob([ftyp, mdat, moov]);
    const analysis = await analyzeMp4(blob);
    assert.equal(analysis.moovAtStart, false);

    const fixed = Buffer.from(await (await faststart(blob, analysis)).arrayBuffer());
    assert.equal(fixed.length, blob.size);
    assert.equal(fixed.subarray(ftyp.length + 4, ftyp.length + 8).toString("latin1"), "moov");
    const patched = fixed.readUInt32BE(fixed.indexOf("stco") + 12);
    assert.equal(patched, originalOffset + moov.length);
    assert.equal(fixed.subarray(patched, patched + 8).toString("latin1"), "ABCDEFGH");
    assert.equal((await analyzeMp4(new Blob([fixed]))).moovAtStart, true);
  });

  test("devolve o próprio arquivo quando já está otimizado", async () => {
    const blob = new Blob([box("ftyp", Buffer.from("isom0000")), moovWith(offsetsTable("stco", [40])), box("mdat")]);
    const analysis = await analyzeMp4(blob);
    assert.equal(await faststart(blob, analysis), blob);
  });

  test("não mexe em arquivos fragmentados, truncados ou sem mdat", async () => {
    const ftyp = box("ftyp", Buffer.from("isom0000"));
    const fragmented = new Blob([ftyp, box("mdat"), box("moof"), moovWith(offsetsTable("stco", [1]))]);
    assert.equal(await faststart(fragmented, await analyzeMp4(fragmented)), null);
    const truncated = new Blob([ftyp, box("mdat", Buffer.alloc(16)).subarray(0, 12)]);
    assert.equal(await faststart(truncated, await analyzeMp4(truncated)), null);
    const noMdat = new Blob([ftyp, moovWith(offsetsTable("stco", [1]))]);
    assert.equal(await faststart(noMdat, await analyzeMp4(noMdat)), null);
  });

  test("não reconhece WebM como MP4", async () => {
    const webm = new Blob([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7])]);
    const analysis = await analyzeMp4(webm);
    assert.equal(analysis.isMp4, false);
    assert.equal(analysis.moovAtStart, null);
  });
});

describe("com ffmpeg de verdade", { skip: !FFMPEG && "defina FFMPEG_PATH" }, () => {
  const cases = [
    ["mp4 com áudio", "a.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]],
    ["mov (QuickTime)", "b.mov", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "mov"]],
  ];
  for (const [label, name, codecArgs] of cases) {
    test(`faststart preserva todos os pacotes: ${label}`, async () => {
      const source = join(work, name);
      ffmpeg("-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "3", ...codecArgs, "-shortest", source);
      const blob = await openAsBlob(source);
      const analysis = await analyzeMp4(blob);
      assert.equal(analysis.moovAtStart, false);
      assert.equal(analysis.video.codec, "h264");
      assert.equal(analysis.audio.codec, "aac");
      assert.deepEqual([analysis.displayWidth, analysis.displayHeight], [360, 640]);
      assert.ok(Math.abs(analysis.durationS - 3) < 0.1, `duração ${analysis.durationS}`);

      const output = join(work, `fixed-${name}`);
      await writeBlob(await faststart(blob, analysis), output);
      const fixed = await analyzeMp4(await openAsBlob(output));
      assert.equal(fixed.moovAtStart, true);
      const decode = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-i", output, "-f", "null", "-"], { encoding: "utf8" });
      assert.equal(decode.status, 0);
      assert.equal(decode.stderr.trim(), "");
      assert.deepEqual(packetHashes(output), packetHashes(source));
    });
  }

  test("lê a rotação e troca largura/altura para exibição", async () => {
    const wide = join(work, "wide.mp4");
    const rotated = join(work, "rotated.mp4");
    ffmpeg("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", wide);
    ffmpeg("-display_rotation", "90", "-i", wide, "-c", "copy", rotated);
    const analysis = await analyzeMp4(await openAsBlob(rotated));
    assert.ok([90, 270].includes(analysis.video.rotation), `rotação ${analysis.video.rotation}`);
    assert.deepEqual([analysis.displayWidth, analysis.displayHeight], [360, 640]);
    assert.equal(analysis.audio, null);
  });

  test("identifica HEVC com tag hvc1", async (t) => {
    const source = join(work, "hevc.mp4");
    try {
      ffmpeg("-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30", "-t", "3", "-c:v", "libx265", "-tag:v", "hvc1",
        "-x265-params", "log-level=error", source);
    } catch {
      t.skip("ffmpeg sem libx265");
      return;
    }
    assert.equal((await analyzeMp4(await openAsBlob(source))).video.codec, "hevc");
  });
});
