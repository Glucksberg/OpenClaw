import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "./control-ui-contract.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

describe("handleControlUiHttpRequest", () => {
  async function withControlUiRoot<T>(params: {
    indexHtml?: string;
    fn: (tmp: string) => Promise<T>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), params.indexHtml ?? "<html></html>\n");
      return await params.fn(tmp);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  function parseBootstrapPayload(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
      basePath: string;
      assistantName: string;
      assistantAvatar: string;
      assistantAgentId: string;
    };
  }

  it("sets security headers for Control UI responses", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, setHeader } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/", method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
          },
        );
        expect(handled).toBe(true);
        expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
        const csp = setHeader.mock.calls.find((call) => call[0] === "Content-Security-Policy")?.[1];
        expect(typeof csp).toBe("string");
        expect(String(csp)).toContain("frame-ancestors 'none'");
        expect(String(csp)).toContain("script-src 'self'");
        expect(String(csp)).not.toContain("script-src 'self' 'unsafe-inline'");
      },
    });
  });

  it("does not inject inline scripts into index.html", async () => {
    const html = "<html><head></head><body>Hello</body></html>\n";
    await withControlUiRoot({
      indexHtml: html,
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/", method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "</script><script>alert(1)//", avatar: "evil.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        expect(end).toHaveBeenCalledWith(html);
      },
    });
  });

  it("serves bootstrap config JSON", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "</script><script>alert(1)//", avatar: "</script>.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("");
        expect(parsed.assistantName).toBe("</script><script>alert(1)//");
        expect(parsed.assistantAvatar).toBe("/avatar/main");
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });

  it("serves bootstrap config JSON under basePath", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: `/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, method: "GET" } as IncomingMessage,
          res,
          {
            basePath: "/openclaw",
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "Ops", avatar: "ops.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("/openclaw");
        expect(parsed.assistantName).toBe("Ops");
        expect(parsed.assistantAvatar).toBe("/openclaw/avatar/main");
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });
});

// ---------------------------------------------------------------------------
// handleControlUiHttpRequest – SPA fallback vs /api/* routes
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

function mockRes2(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
} {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _body: "",
    set statusCode(v: number) {
      this._status = v;
    },
    get statusCode() {
      return this._status;
    },
    setHeader(k: string, v: string) {
      this._headers[k.toLowerCase()] = v;
    },
    end(body?: string | Buffer) {
      if (body != null) this._body = typeof body === "string" ? body : body.toString("utf8");
    },
  } as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _body: string;
  };
  return res;
}

describe("handleControlUiHttpRequest – /api/ exclusion", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-cui-test-"));
    fsSync.writeFileSync(path.join(tmpDir, "index.html"), "<html><body>SPA</body></html>", "utf8");
  });

  afterAll(() => {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  const rootState = () => ({ kind: "resolved" as const, path: tmpDir });

  it("serves SPA fallback for normal unknown routes", () => {
    const req = mockReq("GET", "/some/page");
    const res = mockRes2();
    const handled = handleControlUiHttpRequest(req, res, { root: rootState() });
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._headers["content-type"]).toContain("text/html");
    expect(res._body).toContain("SPA");
  });

  it("returns JSON 404 for /api/ routes instead of SPA fallback", () => {
    const req = mockReq("GET", "/api/some-endpoint");
    const res = mockRes2();
    const handled = handleControlUiHttpRequest(req, res, { root: rootState() });
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
    expect(res._headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res._body)).toEqual({ error: "Not found" });
  });

  it("returns JSON 404 for /api (no trailing slash)", () => {
    const req = mockReq("GET", "/api");
    const res = mockRes2();
    const handled = handleControlUiHttpRequest(req, res, { root: rootState() });
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ error: "Not found" });
  });

  it("returns JSON 404 for /api/ routes under a basePath", () => {
    const req = mockReq("GET", "/ui/api/foo");
    const res = mockRes2();
    const handled = handleControlUiHttpRequest(req, res, {
      basePath: "/ui",
      root: rootState(),
    });
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
    expect(res._headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res._body)).toEqual({ error: "Not found" });
  });
});
