/**
 * functions/health.ts 直测：探活成功 200、绑定缺失/R2 异常 503、方法白名单、
 * 安全与缓存响应头。
 */
import { onRequest } from "../../../functions/health";
import { InMemoryBucket, makeContext } from "../testInMemoryBucket";

const HOST = "http://drive.example.com";

function call(method: string, env: object) {
  return onRequest(makeContext(new Request(`${HOST}/health`, { method }), env));
}

describe("health endpoint", () => {
  test("GET returns 200 ok when R2 responds", async () => {
    const env = { BUCKET: new InMemoryBucket().asBucket() };
    const response = await call("GET", env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("HEAD returns same headers without body", async () => {
    const env = { BUCKET: new InMemoryBucket().asBucket() };
    const response = await call("HEAD", env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test("non GET/HEAD methods are rejected with 405 + Allow", async () => {
    const env = { BUCKET: new InMemoryBucket().asBucket() };
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await call(method, env);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
    }
  });

  test("missing BUCKET binding is 503 without internal details", async () => {
    const response = await call("GET", {});
    expect(response.status).toBe(503);
    const payload = (await response.json()) as { status: string; detail: string };
    expect(payload.status).toBe("error");
    expect(payload.detail).toBe("Error");
  });

  test("R2 failure is 503 with error class only", async () => {
    const failingBucket = {
      list: async () => {
        throw new TypeError("boom");
      },
    } as unknown as R2Bucket;
    const response = await call("GET", { BUCKET: failingBucket });
    expect(response.status).toBe(503);
    const payload = (await response.json()) as { status: string; detail: string };
    expect(payload.status).toBe("error");
    expect(payload.detail).toBe("TypeError");
  });
});
