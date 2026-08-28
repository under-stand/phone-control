import http from "node:http";

export function requestJson({ host = "127.0.0.1", port, path, token, body = null, method = "GET", timeoutMs = 350 }) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host,
      port,
      path,
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(new Error("Phone Control response exceeded 1 MiB"));
        else chunks.push(chunk);
      });
      response.once("end", () => {
        let parsed = null;
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          parsed = text ? JSON.parse(text) : null;
        } catch {
          reject(new Error("Phone Control returned invalid JSON"));
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve({ statusCode: response.statusCode, body: parsed });
        else reject(Object.assign(new Error(parsed?.error || `Phone Control returned HTTP ${response.statusCode}`), { statusCode: response.statusCode }));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Phone Control hook delivery timed out")));
    request.once("error", reject);
    request.end(payload || undefined);
  });
}

export async function postJson(options) {
  const result = await requestJson({ ...options, method: "POST" });
  return result.statusCode;
}
