const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

interface ApiError {
  error: string;
  code: string;
  details: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function fetchAPI<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE_URL}${path}`;

  const response = await fetch(url, {
    credentials: "include",
    headers: {
      // Only set Content-Type when there is a body — Fastify rejects
      // an 'application/json' content-type on bodyless requests (DELETE, GET).
      // FormData bodies must stay untouched so the browser can attach its
      // own multipart boundary.
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    let errorData: ApiError;
    try {
      errorData = (await response.json()) as ApiError;
    } catch {
      throw new ApiRequestError(
        "An unexpected error occurred",
        "UNKNOWN_ERROR",
        response.status,
      );
    }
    throw new ApiRequestError(
      errorData.error,
      errorData.code,
      response.status,
      errorData.details,
    );
  }

  // 204 No Content (and similar) have no body — skip JSON parsing.
  // Calling response.json() on an empty body throws a SyntaxError.
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
