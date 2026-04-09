/**
 * Tripletex API Client
 * Handles authentication and HTTP requests to the Tripletex REST API.
 */

const PROD_BASE = "https://tripletex.no/v2";
const TEST_BASE = "https://api-test.tripletex.tech/v2";

interface SessionToken {
  token: string;
  expiresAt: string;
}

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
  private consumerToken: string;
  private employeeToken: string;
  private baseUrl: string;
  private session: SessionToken | null = null;

  constructor() {
    const consumer = process.env.TRIPLETEX_CONSUMER_TOKEN;
    const employee = process.env.TRIPLETEX_EMPLOYEE_TOKEN;
    if (!consumer || !employee) {
      throw new Error(
        "Missing TRIPLETEX_CONSUMER_TOKEN or TRIPLETEX_EMPLOYEE_TOKEN env vars"
      );
    }
    this.consumerToken = consumer;
    this.employeeToken = employee;
    this.baseUrl =
      process.env.TRIPLETEX_ENV === "test" ? TEST_BASE : PROD_BASE;
  }

  private async createSession(): Promise<void> {
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
    this.session = {
      token: data.value.token,
      expiresAt: expDate,
    };
  }

  private async ensureSession(): Promise<string> {
    const now = new Date().toISOString().split("T")[0];
    if (!this.session || this.session.expiresAt <= now) {
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
