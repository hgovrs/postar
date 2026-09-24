// Cliente da API da Zernio para o navegador.
// O header x-request-id não é enviado: o CORS da Zernio não o permite.

export const BASE_URL = "https://zernio.com/api/v1";
const TRANSIENT = new Set([500, 502, 503, 504]);

export class ZernioError extends Error {
  constructor(message, { status = null, code = null, payload = null } = {}) {
    super(message);
    this.name = "ZernioError";
    this.status = status;
    this.code = code;
    this.payload = payload || {};
  }

  get transient() {
    return this.status === null || TRANSIENT.has(this.status);
  }

  static fromResponse(status, data) {
    const message = typeof data?.error === "string" && data.error ? data.error : `HTTP ${status}`;
    return new ZernioError(message, { status, code: data?.code ?? null, payload: data });
  }
}

export class ZernioApi {
  constructor(apiKey, { baseUrl = BASE_URL, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 60_000 } = {}) {
    if (!apiKey) throw new Error("apiKey é obrigatório");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { query, body, timeoutMs } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    init.signal = controller.signal;
    let response;
    let data = {};
    try {
      response = await this.fetchImpl(url.toString(), init);
      data = await response.json().catch(() => ({}));
    } catch (error) {
      const message = error?.name === "AbortError" ? "a Zernio demorou demais para responder" : "falha de conexão";
      throw new ZernioError(message, { status: null });
    } finally {
      clearTimeout(timer);
    }
    if (!data || typeof data !== "object") data = {};
    if (!response.ok) throw ZernioError.fromResponse(response.status, data);
    return { status: response.status, data };
  }

  async listProfiles() {
    return (await this.request("GET", "/profiles")).data.profiles || [];
  }

  async listAccounts() {
    return (await this.request("GET", "/accounts")).data.accounts || [];
  }

  async tiktokCreatorInfo(accountId) {
    return (await this.request("GET", `/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info`, { query: { mediaType: "video" } })).data;
  }

  async accountHealth(accountId) {
    return (await this.request("GET", `/accounts/${encodeURIComponent(accountId)}/health`)).data;
  }

  async connectUrl(platform, profileId, redirectUrl) {
    const { data } = await this.request("GET", `/connect/${platform}`, { query: { profileId, redirect_url: redirectUrl } });
    if (!data.authUrl) throw new ZernioError("a Zernio não retornou o link de autorização");
    return data.authUrl;
  }

  async presign(filename, contentType, size) {
    const { data } = await this.request("POST", "/media/presign", { body: { filename, contentType, size } });
    if (!data.uploadUrl || !data.publicUrl) throw new ZernioError("resposta inválida ao pedir o link de envio");
    return data;
  }

  async createPost(payload) {
    return this.request("POST", "/posts", { body: payload, timeoutMs: 120_000 });
  }

  async getPost(postId) {
    const { data } = await this.request("GET", `/posts/${encodeURIComponent(postId)}`);
    return data.post || data;
  }

  async retryPost(postId) {
    return this.request("POST", `/posts/${encodeURIComponent(postId)}/retry`, { timeoutMs: 300_000 });
  }

  /** Procura um post recente que use esta mídia (para recuperar após queda de conexão). */
  async findPostByMediaUrl(mediaUrl) {
    const { data } = await this.request("GET", "/posts", { query: { limit: 10 } });
    return (data.posts || []).find((post) => (post.mediaItems || []).some((item) => item.url === mediaUrl)) || null;
  }
}

/** PUT do arquivo na URL pré-assinada, com progresso (fetch não informa progresso de envio). */
export function uploadWithProgress(url, blob, contentType, onProgress, { createXhr = () => new XMLHttpRequest() } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = createXhr();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ZernioError(`o armazenamento recusou o arquivo (HTTP ${xhr.status})`, { status: xhr.status }));
    };
    xhr.onerror = () => reject(new ZernioError("falha de rede ao enviar o arquivo", { status: null }));
    xhr.onabort = () => reject(new ZernioError("envio cancelado", { status: null }));
    xhr.send(blob);
  });
}
