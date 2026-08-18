/**
 * Tripletex API Client
 * Handles authentication and HTTP requests to the Tripletex REST API.
 */

const PROD_BASE = "https://tripletex.no/v2";
const TEST_BASE = "https://api-test.tripletex.tech/v2";

interface SessionToken {
  token: string;
  /** Epoch ms when we stop reusing this token and create a new one. */
  expiresAtMs: number;
}

/** Session lifetime for the JWT flow. Tripletex lets us pick; 12h is plenty. */
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;
/** Renew a little early so a long request never runs past the expiry. */
const RENEW_MARGIN_MS = 60 * 1000;

export class TripletexApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodyText: string
  ) {
    super(message);
    this.name = "TripletexApiError";
  }
}

export class TripletexClient {
  private refreshToken: string;
  private consumerToken: string;
  private employeeToken: string;
  private ttlSeconds: number;
  private baseUrl: string;
  private session: SessionToken | null = null;

  constructor() {
    // Two ways to authenticate, see
    // https://developer.tripletex.no/docs/documentation/authentication-and-tokens/
    //
    //   1. Internal integration (one company / company group): a user-admin
    //      creates a JWT under Selskap -> API-tokens in Tripletex. No consumer
    //      token, and no application to Tripletex. This is the simple path.
    //   2. Commercial integration (many customers): consumer token from
    //      Tripletex + an employee token created by each end customer.
    const refresh =
      process.env.TRIPLETEX_JWT || process.env.TRIPLETEX_REFRESH_TOKEN || "";
    const consumer = process.env.TRIPLETEX_CONSUMER_TOKEN || "";
    const employee = process.env.TRIPLETEX_EMPLOYEE_TOKEN || "";
    if (!refresh && !employee) {
      throw new Error(
        "Missing Tripletex credentials. Set TRIPLETEX_JWT (internal integration: " +
          "Selskap -> API-tokens in Tripletex), or TRIPLETEX_CONSUMER_TOKEN + " +
          "TRIPLETEX_EMPLOYEE_TOKEN (commercial integration)."
      );
    }
    this.refreshToken = refresh;
    this.consumerToken = consumer;
    this.employeeToken = employee;
    this.ttlSeconds =
      Number(process.env.TRIPLETEX_SESSION_TTL_SECONDS) || DEFAULT_TTL_SECONDS;
    this.baseUrl =
      process.env.TRIPLETEX_ENV === "test" ? TEST_BASE : PROD_BASE;
  }

  private async createSession(): Promise<void> {
    this.session = this.refreshToken
      ? await this.createSessionFromJwt()
      : await this.createSessionFromTokenPair();
  }

  /** Internal integration: exchange the JWT secret for a session token. */
  private async createSessionFromJwt(): Promise<SessionToken> {
    const res = await fetch(
      `${this.baseUrl}/token/session/:createFromRefreshToken`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshToken: this.refreshToken,
          ttlSeconds: this.ttlSeconds,
        }),
      }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new TripletexApiError(
        `Session create from JWT failed (${res.status})`,
        res.status,
        text
      );
    }
    // Tripletex wraps most responses in { value: ... }; accept both shapes.
    let parsed: { value?: { token?: string }; token?: string };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new TripletexApiError(
        "Session create from JWT returned non-JSON",
        res.status,
        text
      );
    }
    const token = parsed.value?.token ?? parsed.token;
    if (!token) {
      throw new TripletexApiError(
        "Session create from JWT returned no token",
        res.status,
        text
      );
    }
    return {
      token,
      expiresAtMs: Date.now() + this.ttlSeconds * 1000 - RENEW_MARGIN_MS,
    };
  }

  /** Commercial integration: consumer token + employee token. */
  private async createSessionFromTokenPair(): Promise<SessionToken> {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const expDate = tomorrow.toISOString().split("T")[0];

    const url = `${this.baseUrl}/token/session/:create?consumerToken=${encodeURIComponent(this.consumerToken)}&employeeToken=${encodeURIComponent(this.employeeToken)}&expirationDate=${expDate}`;

    const res = await fetch(url, { method: "PUT" });
    if (!res.ok) {
      const text = await res.text();
      throw new TripletexApiError(
        `Session create failed (${res.status})`,
        res.status,
        text
      );
    }
    const data = (await res.json()) as { value: { token: string } };
    // These tokens expire at midnight CET on expirationDate, so treat the start
    // of that date as the cutoff — the 401 retry covers the remaining slack.
    return {
      token: data.value.token,
      expiresAtMs: new Date(`${expDate}T00:00:00`).getTime(),
    };
  }

  private async ensureSession(): Promise<string> {
    if (!this.session || this.session.expiresAtMs <= Date.now()) {
      await this.createSession();
    }
    return this.session!.token;
  }

  private authHeader(sessionToken: string): string {
    return "Basic " + Buffer.from(`0:${sessionToken}`).toString("base64");
  }

  async request(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown,
    isRetry = false
  ): Promise<unknown> {
    const token = await this.ensureSession();
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader(token),
      "Content-Type": "application/json",
    };

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && !isRetry) {
      this.session = null;
      return this.request(method, path, params, body, true);
    }

    const text = await res.text();

    if (!res.ok) {
      throw new TripletexApiError(
        `Tripletex ${method} ${path} (${res.status})`,
        res.status,
        text
      );
    }

    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async get(path: string, params?: Record<string, string>) {
    return this.request("GET", path, params);
  }

  async post(path: string, body: unknown, params?: Record<string, string>) {
    return this.request("POST", path, params, body);
  }

  async put(path: string, body: unknown, params?: Record<string, string>) {
    return this.request("PUT", path, params, body);
  }

  async delete(path: string, params?: Record<string, string>) {
    return this.request("DELETE", path, params);
  }
}
