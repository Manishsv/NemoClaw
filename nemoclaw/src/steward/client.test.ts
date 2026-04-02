// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseActionProposalFromAudit,
  parseGovernanceProposalIdFromAudit,
  setPluginStewardBaseUrl,
  stewardCompleteApprovalAndExecute,
  stewardCompleteApprovalFromAuthorizeAuditId,
  stewardGetDecisionRecord,
  stewardResolvedBaseUrl,
} from "./client.js";

function urlToString(u: unknown): string {
  if (typeof u === "string") return u;
  if (u instanceof URL) return u.toString();
  if (u && typeof u === "object" && "url" in u) {
    const v = (u as { url?: unknown }).url;
    if (typeof v === "string") return v;
  }
  return "(unknown-url)";
}

describe("parseGovernanceProposalIdFromAudit", () => {
  it("reads top-level governance_proposal_id", () => {
    expect(parseGovernanceProposalIdFromAudit({ governance_proposal_id: "gp-1" })).toBe("gp-1");
  });

  it("reads nested payload.audit.governance_proposal_id", () => {
    expect(
      parseGovernanceProposalIdFromAudit({
        payload: { audit: { governance_proposal_id: "gp-2" } },
      }),
    ).toBe("gp-2");
  });

  it("prefers top-level over nested", () => {
    expect(
      parseGovernanceProposalIdFromAudit({
        governance_proposal_id: "top",
        payload: { audit: { governance_proposal_id: "nested" } },
      }),
    ).toBe("top");
  });

  it("returns null when missing", () => {
    expect(parseGovernanceProposalIdFromAudit({})).toBeNull();
    expect(parseGovernanceProposalIdFromAudit(null)).toBeNull();
  });
});

describe("parseActionProposalFromAudit", () => {
  it("extracts action proposal from audit body", () => {
    const p = parseActionProposalFromAudit({
      proposal: {
        action: "openshell.draft_policy.get",
        purpose: "read",
        role: "operator",
        context: { a: 1 },
        parameters: { sandbox_name: "s" },
      },
    });
    expect(p).toEqual({
      action: "openshell.draft_policy.get",
      purpose: "read",
      role: "operator",
      context: { a: 1 },
      parameters: { sandbox_name: "s" },
    });
  });

  it("returns null without proposal", () => {
    expect(parseActionProposalFromAudit({ governance_proposal_id: "x" })).toBeNull();
  });
});

describe("stewardCompleteApprovalAndExecute", () => {
  beforeEach(() => {
    process.env.STEWARD_URL = "http://steward.test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.STEWARD_URL;
  });

  it("chains GET audit, POST approval-requests, POST decision, POST execute with resume context", async () => {
    const base = {
      action: "openshell.draft_policy.approve",
      purpose: "t",
      role: "agent",
      parameters: { sandbox_name: "s", chunk_id: "c" },
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ governance_proposal_id: "gp-u1", payload: { audit: {} } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ar-1",
          state: "requested",
          governance_proposal_id: "gp-u1",
          decision_record_id: "dr-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ar-1",
          state: "approved",
          governance_proposal_id: "gp-u1",
          decision_record_id: "dr-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ audit_id: "ex-1", status: "executed", result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const out = await stewardCompleteApprovalAndExecute(base, "audit-auth-1", "operator");

    expect(out.audit_id).toBe("ex-1");
    expect(out.governance_proposal_id).toBe("gp-u1");
    expect(out.approval_request_id).toBe("ar-1");
    expect(out.resumed_action).toBe("openshell.draft_policy.approve");
    expect(out.resumed_purpose).toBe("t");
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    const urls = fetchSpy.mock.calls.map((c) => urlToString(c[0]));
    expect(urls[0]).toContain("steward.test/audit/");
    expect(urls[1]).toContain("steward.test/approval-requests");
    expect(urls[2]).toContain("steward.test/approval-requests/ar-1/decision");
    expect(urls[3]).toContain("steward.test/action/execute");

    const execInit = fetchSpy.mock.calls[3][1] as RequestInit;
    const execBody = JSON.parse(execInit.body as string) as {
      proposal: { context?: Record<string, unknown> };
    };
    expect(execBody.proposal.context?.steward_resume_proposal_id).toBe("gp-u1");
    expect(execBody.proposal.context?.approval_request_id).toBe("ar-1");
  });

  it("stewardCompleteApprovalFromAuthorizeAuditId uses one GET audit and three POSTs", async () => {
    const auditBody = {
      governance_proposal_id: "gp-x",
      proposal: {
        action: "openshell.draft_policy.clear",
        purpose: "t",
        role: "agent",
        context: {},
        parameters: { sandbox_name: "s" },
      },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify(auditBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ar-2",
            state: "requested",
            governance_proposal_id: "gp-x",
            decision_record_id: "dr-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ar-2",
            state: "approved",
            governance_proposal_id: "gp-x",
            decision_record_id: "dr-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ audit_id: "ex-2", status: "executed", result: { ok: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const out = await stewardCompleteApprovalFromAuthorizeAuditId("audit-only", "op");
    expect(out.audit_id).toBe("ex-2");
    expect(out.governance_proposal_id).toBe("gp-x");
    expect(out.approval_request_id).toBe("ar-2");
    expect(out.resumed_action).toBe("openshell.draft_policy.clear");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const execBody = JSON.parse((fetchSpy.mock.calls[3][1] as RequestInit).body as string) as {
      proposal: { action: string; parameters: Record<string, unknown> };
    };
    expect(execBody.proposal.action).toBe("openshell.draft_policy.clear");
    expect(execBody.proposal.parameters.sandbox_name).toBe("s");
  });
});

describe("steward-url file (read-only openclaw.json workaround)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.STEWARD_URL;
    delete process.env.STEWARD_URL_FILE;
    setPluginStewardBaseUrl(null);
  });

  it("uses STEWARD_URL_FILE when env STEWARD_URL and plugin URL unset", async () => {
    delete process.env.STEWARD_URL;
    setPluginStewardBaseUrl(null);
    const f = path.join(os.tmpdir(), `steward-url-${String(Date.now())}.txt`);
    fs.writeFileSync(f, "http://from-file.test:8010\n", "utf8");
    process.env.STEWARD_URL_FILE = f;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "dr-f",
          created_at: "2026-01-01T00:00:00Z",
          governance_proposal_id: "g",
          content_proposal_id: "c",
          decision: "allow",
          rationale: "",
          plan_snapshot: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await stewardGetDecisionRecord("dr-f");
    expect(urlToString(fetchSpy.mock.calls[0][0])).toContain("from-file.test:8010");
    fs.unlinkSync(f);
  });
});

describe("plugin stewardUrl (when STEWARD_URL not visible to plugin)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.STEWARD_URL;
    delete process.env.STEWARD_URL_FILE;
    setPluginStewardBaseUrl(null);
  });

  it("uses setPluginStewardBaseUrl when STEWARD_URL is unset", async () => {
    delete process.env.STEWARD_URL;
    setPluginStewardBaseUrl("http://plugin-steward.test");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "dr-p",
          created_at: "2026-01-01T00:00:00Z",
          governance_proposal_id: "g",
          content_proposal_id: "c",
          decision: "allow",
          rationale: "",
          plan_snapshot: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await stewardGetDecisionRecord("dr-p");
    expect(urlToString(fetchSpy.mock.calls[0][0])).toContain(
      "plugin-steward.test/decision-records/dr-p",
    );
  });

  it("prefers STEWARD_URL over plugin URL", async () => {
    process.env.STEWARD_URL = "http://env-steward.test";
    setPluginStewardBaseUrl("http://plugin-steward.test");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "dr-e",
          created_at: "2026-01-01T00:00:00Z",
          governance_proposal_id: "g",
          content_proposal_id: "c",
          decision: "allow",
          rationale: "",
          plan_snapshot: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await stewardGetDecisionRecord("dr-e");
    expect(urlToString(fetchSpy.mock.calls[0][0])).toContain(
      "env-steward.test/decision-records/dr-e",
    );
  });
});

describe("Steward HTTP retries", () => {
  beforeEach(() => {
    process.env.STEWARD_URL = "http://steward.test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.STEWARD_URL;
    setPluginStewardBaseUrl(null);
  });

  it("retries GET on transient fetch failure then succeeds", async () => {
    const body = {
      id: "dr1",
      created_at: "2026-01-01T00:00:00Z",
      governance_proposal_id: "gp",
      content_proposal_id: "cp",
      decision: "allow",
      rationale: "ok",
      plan_snapshot: {},
    };
    let n = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      n += 1;
      if (n < 2) return Promise.reject(new Error("ECONNRESET"));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    const out = await stewardGetDecisionRecord("dr1");
    expect((out as { id: string }).id).toBe("dr1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 fetch failures and includes underlying error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND host"));
    try {
      await stewardGetDecisionRecord("missing");
      expect.fail("expected throw");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/Steward is unreachable/);
      expect(msg).toMatch(/ENOTFOUND host/);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe("stewardResolvedBaseUrl fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.STEWARD_URL;
    delete process.env.STEWARD_URL_FILE;
    delete process.env.OPENCLAW_STATE_DIR;
    setPluginStewardBaseUrl(null);
  });

  it("falls back to :8010 on non-sandbox host", () => {
    expect(stewardResolvedBaseUrl()).toMatch(/:8010$/);
  });
});
