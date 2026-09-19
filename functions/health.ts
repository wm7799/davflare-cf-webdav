// 健康检查端点（GET/HEAD /health）：供可用性探针、反向代理与 uptime 监控使用。
// 无鉴权；仅暴露探活结果，不做任何业务读写。R2 探活用 list({ limit: 1 })，
// 空桶同样返回 200，不依赖具体对象存在。
interface HealthEnv {
  BUCKET?: R2Bucket;
}

const HEALTH_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export const onRequest: PagesFunction<HealthEnv> = async (context) => {
  const method = context.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { ...HEALTH_HEADERS, Allow: "GET, HEAD" },
    });
  }

  const body = (status: "ok" | "error", detail?: string) =>
    JSON.stringify(detail ? { status, detail } : { status });

  const isHead = method === "HEAD";
  try {
    if (!context.env.BUCKET) {
      throw new Error("R2 bucket binding is not configured");
    }
    await context.env.BUCKET.list({ limit: 1 });
    return new Response(isHead ? null : body("ok"), {
      status: 200,
      headers: HEALTH_HEADERS,
    });
  } catch (error) {
    // 只回错误类名，避免把账号/绑定等内部细节泄给匿名探针。
    const detail = error instanceof Error ? error.name : "UnknownError";
    return new Response(isHead ? null : body("error", detail), {
      status: 503,
      headers: HEALTH_HEADERS,
    });
  }
};
