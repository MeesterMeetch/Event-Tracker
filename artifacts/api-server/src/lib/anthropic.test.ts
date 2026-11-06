import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalysisConfigError, createMessage } from "./anthropic";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("createMessage", () => {
  it("sends Opus 5.5 at medium effort with the system and user turns", async () => {
    fetchMock.mockResolvedValue(ok({ content: [{ type: "text", text: "{}" }] }));

    await createMessage("SYS", "USER");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("test-key");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.system).toBe("SYS");
    expect(body.messages).toEqual([{ role: "user", content: "USER" }]);
  });

  it("returns only text blocks, skipping thinking", async () => {
    fetchMock.mockResolvedValue(
      ok({ content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: '{"a":1}' }] }),
    );

    expect(await createMessage("s", "u")).toBe('{"a":1}');
  });

  it("throws a config error without calling the API when the key is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    await expect(createMessage("s", "u")).rejects.toBeInstanceOf(AnalysisConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a rejected key as a config error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "invalid x-api-key" });

    await expect(createMessage("s", "u")).rejects.toBeInstanceOf(AnalysisConfigError);
  });

  it("surfaces other API failures with the status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 529, text: async () => "overloaded" });

    await expect(createMessage("s", "u")).rejects.toThrow(/529.*overloaded/);
  });
});
