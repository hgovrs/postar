import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { uploadWithProgress, ZernioApi, ZernioError } from "../api.js";

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, ...init, headers: { ...init.headers } });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new SyntaxError("sem JSON");
        return next.body;
      },
    };
  };
  return { impl, calls };
}

describe("ZernioApi", () => {
  test("envia Bearer, sem x-request-id, e lê as contas", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { accounts: [{ _id: "a" }] } }]);
    const api = new ZernioApi("sk_test", { fetchImpl: impl });
    assert.deepEqual(await api.listAccounts(), [{ _id: "a" }]);
    assert.equal(calls[0].url, "https://zernio.com/api/v1/accounts");
    assert.equal(calls[0].headers.Authorization, "Bearer sk_test");
    assert.equal(calls[0].headers["x-request-id"], undefined);
  });

  test("POST envia JSON e parâmetros de consulta", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { uploadUrl: "https://up", publicUrl: "https://pub" } },
      { status: 200, body: { authUrl: "https://auth" } },
    ]);
    const api = new ZernioApi("sk_test", { fetchImpl: impl });
    await api.presign("a.mp4", "video/mp4", 10);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].body), { filename: "a.mp4", contentType: "video/mp4", size: 10 });
    assert.equal(await api.connectUrl("tiktok", "p1", "https://site/"), "https://auth");
    const url = new URL(calls[1].url);
    assert.equal(url.pathname, "/api/v1/connect/tiktok");
    assert.equal(url.searchParams.get("profileId"), "p1");
    assert.equal(url.searchParams.get("redirect_url"), "https://site/");
  });

  test("erros viram ZernioError com status e código", async () => {
    const { impl } = fakeFetch([{ status: 409, body: { error: "dup", code: "duplicate" } }, { status: 502 }]);
    const api = new ZernioApi("sk_test", { fetchImpl: impl });
    await assert.rejects(api.createPost({}), (error) => error instanceof ZernioError && error.status === 409 && error.code === "duplicate" && !error.transient);
    await assert.rejects(api.getPost("p"), (error) => error.message === "HTTP 502" && error.transient);
  });

  test("falha de rede e tempo esgotado viram status null", async () => {
    const { impl } = fakeFetch([new TypeError("Failed to fetch")]);
    const api = new ZernioApi("sk_test", { fetchImpl: impl });
    await assert.rejects(api.listProfiles(), (error) => error.status === null && error.transient);

    const slow = new ZernioApi("sk_test", {
      timeoutMs: 20,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    });
    await assert.rejects(slow.listProfiles(), /demorou demais/);
  });

  test("encontra o post pela URL da mídia", async () => {
    const { impl } = fakeFetch([{ status: 200, body: { posts: [
      { _id: "a", mediaItems: [{ url: "https://m/1.mp4" }] },
      { _id: "b", mediaItems: [{ url: "https://m/2.mp4" }] },
    ] } }]);
    const api = new ZernioApi("sk_test", { fetchImpl: impl });
    assert.equal((await api.findPostByMediaUrl("https://m/2.mp4"))._id, "b");
  });
});

describe("uploadWithProgress", () => {
  function fakeXhr(status, { fail = false } = {}) {
    const xhr = {
      headers: {},
      upload: {},
      open(method, url) { Object.assign(xhr, { method, url }); },
      setRequestHeader(name, value) { xhr.headers[name] = value; },
      send(body) {
        xhr.body = body;
        queueMicrotask(() => {
          if (fail) return xhr.onerror();
          xhr.upload.onprogress?.({ lengthComputable: true, loaded: body.size, total: body.size });
          xhr.status = status;
          xhr.onload();
        });
      },
    };
    return xhr;
  }

  test("envia com Content-Type e informa o progresso", async () => {
    const xhr = fakeXhr(200);
    const progress = [];
    const blob = new Blob(["abc"]);
    await uploadWithProgress("https://up", blob, "video/mp4", (loaded, total) => progress.push([loaded, total]), { createXhr: () => xhr });
    assert.equal(xhr.method, "PUT");
    assert.equal(xhr.headers["Content-Type"], "video/mp4");
    assert.equal(xhr.body, blob);
    assert.deepEqual(progress, [[3, 3]]);
  });

  test("rejeita erros HTTP e de rede", async () => {
    await assert.rejects(uploadWithProgress("https://up", new Blob(["a"]), "video/mp4", null, { createXhr: () => fakeXhr(403) }), (e) => e.status === 403);
    await assert.rejects(uploadWithProgress("https://up", new Blob(["a"]), "video/mp4", null, { createXhr: () => fakeXhr(0, { fail: true }) }), (e) => e.status === null);
  });
});
