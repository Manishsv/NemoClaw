// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginCommandContext, OpenClawPluginApi } from "../index.js";
import type { NemoClawState } from "../blueprint/state.js";
import type { NemoClawOnboardConfig } from "../onboard/config.js";

vi.mock("../blueprint/state.js", () => ({
  loadState: vi.fn(),
}));

vi.mock("../onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(),
  describeOnboardEndpoint: vi.fn(),
  describeOnboardProvider: vi.fn(),
}));

import { handleSlashCommand } from "./slash.js";
import { loadState } from "../blueprint/state.js";
import {
  loadOnboardConfig,
  describeOnboardEndpoint,
  describeOnboardProvider,
} from "../onboard/config.js";

const mockedLoadState = vi.mocked(loadState);
const mockedLoadOnboardConfig = vi.mocked(loadOnboardConfig);
const mockedDescribeOnboardEndpoint = vi.mocked(describeOnboardEndpoint);
const mockedDescribeOnboardProvider = vi.mocked(describeOnboardProvider);

function urlToString(u: unknown): string {
  if (typeof u === "string") return u;
  if (u instanceof URL) return u.toString();
  if (u && typeof u === "object" && "url" in u) {
    const v = (u as { url?: unknown }).url;
    if (typeof v === "string") return v;
  }
  return "(unknown-url)";
}

function makeCtx(args?: string): PluginCommandContext {
  return {
    channel: "test-channel",
    isAuthorizedSender: true,
    args,
    commandBody: `/nemoclaw${args ? ` ${args}` : ""}`,
    config: {},
  };
}

function makeApi(): OpenClawPluginApi {
  return {
    id: "nemoclaw",
    name: "NemoClaw",
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    registerService: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn(),
  };
}

function blankState(): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: new Date().toISOString(),
  };
}

describe("commands/slash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadState.mockReturnValue(blankState());
    mockedLoadOnboardConfig.mockReturnValue(null);
  });

  // -------------------------------------------------------------------------
  // help (default)
  // -------------------------------------------------------------------------

  describe("help", () => {
    it("returns help text for empty args", async () => {
      const result = await handleSlashCommand(makeCtx(), makeApi());
      expect(result.text).toContain("NemoClaw");
      expect(result.text).toContain("Subcommands:");
      expect(result.text).toContain("status");
      expect(result.text).toContain("eject");
      expect(result.text).toContain("onboard");
      expect(result.text).toContain("policy");
    });

    it("returns help text for unknown subcommand", async () => {
      const result = await handleSlashCommand(makeCtx("unknown"), makeApi());
      expect(result.text).toContain("Subcommands:");
    });
  });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  describe("status", () => {
    it("reports no operations when state is blank", async () => {
      const result = await handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("No operations performed yet");
    });

    it("reports state when last action exists", async () => {
      mockedLoadState.mockReturnValue({
        lastRunId: "run-123",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "test-sandbox",
        migrationSnapshot: null,
        hostBackupPath: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = await handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Last action: deploy");
      expect(result.text).toContain("Blueprint: 1.0.0");
      expect(result.text).toContain("Run ID: run-123");
      expect(result.text).toContain("Sandbox: test-sandbox");
    });

    it("includes rollback snapshot when present", async () => {
      mockedLoadState.mockReturnValue({
        lastRunId: "run-456",
        lastAction: "migrate",
        blueprintVersion: "2.0.0",
        sandboxName: "sb",
        migrationSnapshot: "/snapshots/snap-001",
        hostBackupPath: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = await handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Rollback snapshot: /snapshots/snap-001");
    });
  });

  // -------------------------------------------------------------------------
  // eject
  // -------------------------------------------------------------------------

  describe("eject", () => {
    it("reports nothing to eject when state is blank", async () => {
      const result = await handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("No NemoClaw deployment found");
    });

    it("reports manual rollback required when no snapshot exists", async () => {
      mockedLoadState.mockReturnValue({
        lastRunId: "run-1",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        migrationSnapshot: null,
        hostBackupPath: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = await handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("Manual rollback required");
    });

    it("shows eject instructions when migration snapshot exists", async () => {
      mockedLoadState.mockReturnValue({
        lastRunId: "run-1",
        lastAction: "migrate",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        migrationSnapshot: "/snapshots/snap-001",
        hostBackupPath: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = await handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("Eject from NemoClaw");
      expect(result.text).toContain("nemoclaw <name> destroy");
      expect(result.text).toContain("Snapshot: /snapshots/snap-001");
    });

    it("uses hostBackupPath when migrationSnapshot is absent", async () => {
      mockedLoadState.mockReturnValue({
        lastRunId: "run-1",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        migrationSnapshot: null,
        hostBackupPath: "/backups/backup-001",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = await handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("Snapshot: /backups/backup-001");
    });
  });

  // -------------------------------------------------------------------------
  // policy (integration-oriented scaffold)
  // -------------------------------------------------------------------------

  describe("policy", () => {
    function okJson(body: unknown): Response {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    function stewardAuth(decision: "allow" | "deny" | "needs_approval") {
      return okJson({
        decision,
        rationale: `rationale:${decision}`,
        audit_id: `audit-auth-${decision}`,
      });
    }

    function stewardExec(result: unknown) {
      return okJson({
        audit_id: "audit-exec-1",
        status: "executed",
        result,
      });
    }

    async function expectAuthorizeAction(args: string, expectedAction: string) {
      const calls: Array<{ url: string; body: unknown }> = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        const raw = typeof init?.body === "string" ? init.body : "";
        const body = raw ? (JSON.parse(raw) as unknown) : null;
        calls.push({ url: urlToString(url), body });
        return Promise.resolve(stewardAuth("deny"));
      });

      await handleSlashCommand(makeCtx(args), makeApi());
      expect(calls.length).toBe(1);
      const first = calls[0];
      expect(first.url).toContain("/action/authorize");
      const b = (first.body ?? {}) as Record<string, unknown>;
      const p = (b.proposal ?? {}) as Record<string, unknown>;
      expect(p.action).toBe(expectedAction);

      fetchSpy.mockRestore();
    }

    it("fails closed when Steward is unavailable", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await handleSlashCommand(makeCtx("policy get manz"), makeApi());
      expect(result.text).toContain("Policy blocked");
      expect(result.text).toMatch(/Steward is unreachable|fail-closed/i);

      fetchSpy.mockRestore();
    });

    it("surfaces Steward 403 body when execution fails", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
        const u = urlToString(url);
        if (u.includes("/action/authorize")) return Promise.resolve(stewardAuth("allow"));
        if (u.includes("/action/execute")) {
          return Promise.resolve(
            new Response(JSON.stringify({ audit_id: "audit-exec-denied", rationale: "nope" }), {
              status: 403,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        throw new Error("unexpected url");
      });

      const result = await handleSlashCommand(makeCtx("policy approve manz chunk-1"), makeApi());
      expect(result.text).toContain("Policy blocked");
      expect(result.text).toContain("Steward request failed (403)");
      expect(result.text).toContain("audit-exec-denied");

      fetchSpy.mockRestore();
    });

    it("wires approve through Steward authorize", async () => {
      await expectAuthorizeAction("policy approve manz chunk-1", "openshell.draft_policy.approve");
    });

    it("wires reject through Steward authorize", async () => {
      await expectAuthorizeAction(
        "policy reject manz chunk-1 because",
        "openshell.draft_policy.reject",
      );
    });

    it("wires edit through Steward authorize", async () => {
      await expectAuthorizeAction(
        'policy edit manz chunk-1 {"name":"r"}',
        "openshell.draft_policy.edit",
      );
    });

    it("wires approve_all through Steward authorize", async () => {
      await expectAuthorizeAction("policy approve_all manz", "openshell.draft_policy.approve_all");
    });

    it("wires approve-all through Steward authorize", async () => {
      await expectAuthorizeAction("policy approve-all manz", "openshell.draft_policy.approve_all");
    });

    it("wires clear through Steward authorize", async () => {
      await expectAuthorizeAction("policy clear manz", "openshell.draft_policy.clear");
    });

    it("surfaces deny decision clearly and does not execute", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(stewardAuth("deny"));

      const result = await handleSlashCommand(makeCtx("policy approve manz chunk-1"), makeApi());
      expect(result.text).toContain("Access change blocked");
      expect(result.text).toContain("not applied");
      expect(result.text).toContain("rationale:deny");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });

    it("surfaces needs_approval decision clearly and does not execute", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(stewardAuth("needs_approval"));

      const result = await handleSlashCommand(makeCtx("policy clear manz"), makeApi());
      expect(result.text).toContain("Approval required");
      expect(result.text).toContain("rationale:needs_approval");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });

    it("surfaces allow decision + execution audit + result for non-get", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(stewardAuth("allow"))
        .mockResolvedValueOnce(stewardExec({ ok: true, action: "approve" }));

      const result = await handleSlashCommand(makeCtx("policy approve manz chunk-1"), makeApi());
      expect(result.text).toContain("Access change completed");
      expect(result.text).toContain("Runtime reported success");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      fetchSpy.mockRestore();
    });

    it("surfaces allow decision + result payload for get", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(stewardAuth("allow"))
        .mockResolvedValueOnce(
          stewardExec({
            steps: [
              {
                ok: true,
                draft_version: 7,
                chunks: [{ id: "c1", status: "pending", rule_name: "r1", rationale: "why" }],
              },
            ],
          }),
        );

      const result = await handleSlashCommand(makeCtx("policy get manz"), makeApi());
      expect(result.text).toContain("Network access review");
      expect(result.text).toContain("Sandbox: manz");
      expect(result.text).toContain("Draft version: 7");
      expect(result.text).toContain("Action needed");
      expect(result.text).toContain("Waiting for approval");
      expect(result.text).toMatch(/allowed this read|policy service allowed/i);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      fetchSpy.mockRestore();
    });

    it("supports raw/json flag for get", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(stewardAuth("allow"))
        .mockResolvedValueOnce(
          stewardExec({ steps: [{ ok: true, draft_version: 1, chunks: [] }] }),
        );

      const result = await handleSlashCommand(makeCtx("policy get manz --json"), makeApi());
      expect(result.text).toContain('"steps"');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      fetchSpy.mockRestore();
    });

    it("supports operator flag for get", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(stewardAuth("allow"))
        .mockResolvedValueOnce(
          stewardExec({
            steps: [
              {
                ok: true,
                draft_version: 1,
                chunks: [{ id: "c1", status: "approved", rule_name: "r1", rationale: "why" }],
              },
            ],
          }),
        );

      const result = await handleSlashCommand(makeCtx("policy get manz --operator"), makeApi());
      expect(result.text).toContain("Draft policy (details)");
      expect(result.text).toContain("r1 [approved]");
      expect(result.text).toContain("id: c1");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      fetchSpy.mockRestore();
    });

    it("includes governance technical block when details is set on deny", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(stewardAuth("deny"));

      const result = await handleSlashCommand(
        makeCtx("policy approve manz chunk-1 details"),
        makeApi(),
      );
      expect(result.text).toContain("Access change blocked");
      expect(result.text).toContain("Decision: deny");
      expect(result.text).toContain("Authorize audit:");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });

    it("approve_all needs_approval does not execute", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(stewardAuth("needs_approval"));

      const result = await handleSlashCommand(makeCtx("policy approve_all manz"), makeApi());
      expect(result.text).toContain("Approval required");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // request (candidate evaluation scaffold)
  // -------------------------------------------------------------------------

  describe("request", () => {
    it("evaluates candidates, shows selection, and executes when allowed", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, _init) => {
        const u = urlToString(url);
        if (u.includes("/action/evaluate")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                evaluations: [
                  {
                    id: "approve-npm-registry",
                    label: "Allow Node to reach the npm registry (fix npm installs)",
                    decision: "allow",
                    rationale: "ok",
                    audit_id: "audit-eval-1",
                    risk_tier: "medium",
                  },
                  {
                    id: "get-draft",
                    label: "Check pending network rules (diagnostic)",
                    decision: "allow",
                    rationale: "ok",
                    audit_id: "audit-eval-2",
                    risk_tier: "low",
                  },
                ],
                selection: {
                  selected_id: "approve-npm-registry",
                  selected_label: "Allow Node to reach the npm registry (fix npm installs)",
                  decision: "allow",
                  rationale:
                    "Selected the lowest-risk allowed candidate that best advances the request.",
                  rule: "goal_aware_lowest_risk_allowed",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (u.includes("/action/execute")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                audit_id: "audit-exec-1",
                status: "executed",
                result: { ok: true },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        throw new Error(`unexpected url: ${u}`);
      });

      const result = await handleSlashCommand(
        makeCtx("request manz Please make npm installs work in this sandbox."),
        makeApi(),
      );
      expect(result.text).toContain("Outcome");
      expect(result.text).toContain("Fix applied.");
      expect(result.text).toContain(
        "Selected: Allow Node to reach the npm registry (fix npm installs)",
      );
      expect(result.text).toContain("Options considered:");
      expect(result.text).toContain("Why:");

      fetchSpy.mockRestore();
    });

    it("shows best needs_approval candidate when none allowed", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, _init) => {
        const u = urlToString(url);
        if (u.includes("/action/evaluate")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                evaluations: [
                  {
                    id: "approve-npm-registry",
                    label: "Allow Node to reach the npm registry (fix npm installs)",
                    decision: "needs_approval",
                    rationale: "Approval required by policy.",
                    audit_id: "audit-eval-1",
                    risk_tier: "medium",
                  },
                  {
                    id: "get-draft",
                    label: "Check pending network rules (diagnostic)",
                    decision: "deny",
                    rationale: "Denied.",
                    audit_id: "audit-eval-2",
                    risk_tier: "low",
                  },
                ],
                selection: {
                  selected_id: "approve-npm-registry",
                  selected_label: "Allow Node to reach the npm registry (fix npm installs)",
                  decision: "needs_approval",
                  rationale:
                    "No candidate was allowed; selected the lowest-risk candidate that best advances the request but requires approval.",
                  rule: "goal_aware_lowest_risk_needs_approval",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        throw new Error(`unexpected url: ${u}`);
      });

      const result = await handleSlashCommand(
        makeCtx("request manz Please make npm installs work in this sandbox."),
        makeApi(),
      );
      expect(result.text).toContain("Outcome");
      expect(result.text).toContain("Approval required before we can apply the requested fix.");
      expect(result.text).toContain(
        "Selected (pending approval): Allow Node to reach the npm registry (fix npm installs)",
      );
      expect(result.text).toContain("Next step: ask an operator to approve");

      fetchSpy.mockRestore();
    });

    it("diagnostic selection recommends a next action (no raw JSON)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
        const u = urlToString(url);
        if (u.includes("/action/evaluate")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                evaluations: [
                  {
                    id: "approve-npm-registry",
                    label: "Allow Node to reach the npm registry (fix npm installs)",
                    decision: "deny",
                    rationale: "denied",
                    audit_id: "audit-eval-1",
                    risk_tier: "medium",
                  },
                  {
                    id: "get-draft",
                    label: "Check pending network rules (diagnostic)",
                    decision: "allow",
                    rationale: "ok",
                    audit_id: "audit-eval-2",
                    risk_tier: "low",
                  },
                ],
                selection: {
                  selected_id: "get-draft",
                  selected_label: "Check pending network rules (diagnostic)",
                  decision: "allow",
                  rationale:
                    "Selected the lowest-risk allowed candidate that best advances the request.",
                  rule: "goal_aware_lowest_risk_allowed",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (u.includes("/action/execute")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                audit_id: "audit-exec-1",
                status: "executed",
                result: {
                  steps: [
                    {
                      chunks: [
                        {
                          id: "chunk-1",
                          status: "pending",
                          proposed_rule: {
                            endpoints: [{ host: "registry.npmjs.org", port: 443 }],
                            binaries: [{ path: "/usr/local/bin/node" }],
                          },
                        },
                      ],
                    },
                  ],
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        throw new Error(`unexpected url: ${u}`);
      });

      const result = await handleSlashCommand(
        makeCtx("request manz Please make npm installs work in this sandbox."),
        makeApi(),
      );
      expect(result.text).toContain("Outcome");
      expect(result.text).toContain("Diagnostics collected. A fix was not applied yet.");
      expect(result.text).toContain("Recommended next action");
      expect(result.text).toContain("/nemoclaw policy approve manz chunk-1");
      expect(result.text).not.toContain("{");

      fetchSpy.mockRestore();
    });

    it("git clone intent: prefers remediation when allowed", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
        const u = urlToString(url);
        if (u.includes("/action/evaluate")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                evaluations: [
                  {
                    id: "approve-github",
                    label: "Allow git to reach GitHub (fix git clone)",
                    decision: "allow",
                    rationale: "ok",
                    audit_id: "audit-eval-1",
                    risk_tier: "medium",
                  },
                  {
                    id: "get-draft",
                    label: "Check pending network rules (diagnostic)",
                    decision: "allow",
                    rationale: "ok",
                    audit_id: "audit-eval-2",
                    risk_tier: "low",
                  },
                ],
                selection: {
                  selected_id: "approve-github",
                  selected_label: "Allow git to reach GitHub (fix git clone)",
                  decision: "allow",
                  rationale:
                    "Selected the lowest-risk allowed candidate that best advances the request.",
                  rule: "goal_aware_lowest_risk_allowed",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (u.includes("/action/execute")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                audit_id: "audit-exec-1",
                status: "executed",
                result: { ok: true },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        throw new Error(`unexpected url: ${u}`);
      });

      const result = await handleSlashCommand(
        makeCtx("request manz Please make git clone work in this sandbox."),
        makeApi(),
      );
      expect(result.text).toContain("Outcome");
      expect(result.text).toContain("Fix applied.");
      expect(result.text).toContain("Selected: Allow git to reach GitHub (fix git clone)");

      fetchSpy.mockRestore();
    });

    it("git clone intent: diagnostic recommends running git clone", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
        const u = urlToString(url);
        if (u.includes("/action/evaluate")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                evaluations: [
                  {
                    id: "approve-github",
                    label: "Allow git to reach GitHub (fix git clone)",
                    decision: "deny",
                    rationale: "denied",
                    audit_id: "audit-eval-1",
                    risk_tier: "medium",
                  },
                  {
                    id: "get-draft",
                    label: "Check pending network rules (diagnostic)",
                    decision: "allow",
                    rationale: "ok",
                    audit_id: "audit-eval-2",
                    risk_tier: "low",
                  },
                ],
                selection: {
                  selected_id: "get-draft",
                  selected_label: "Check pending network rules (diagnostic)",
                  decision: "allow",
                  rationale:
                    "Selected the lowest-risk allowed candidate that best advances the request.",
                  rule: "goal_aware_lowest_risk_allowed",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (u.includes("/action/execute")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                audit_id: "audit-exec-1",
                status: "executed",
                result: { steps: [{ chunks: [] }] },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        throw new Error(`unexpected url: ${u}`);
      });

      const result = await handleSlashCommand(
        makeCtx("request manz Please make git clone work in this sandbox."),
        makeApi(),
      );
      expect(result.text).toContain("Outcome");
      expect(result.text).toContain("Diagnostics collected. A fix was not applied yet.");
      expect(result.text).toContain("Try running `git clone ...`");

      fetchSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // onboard
  // -------------------------------------------------------------------------

  describe("onboard", () => {
    it("shows setup instructions when no config exists", async () => {
      const result = await handleSlashCommand(makeCtx("onboard"), makeApi());
      expect(result.text).toContain("No configuration found");
      expect(result.text).toContain("nemoclaw onboard");
    });

    it("shows onboard status when config exists", async () => {
      const config = {
        endpointType: "build" as const,
        endpointUrl: "https://api.build.nvidia.com/v1",
        ncpPartner: null,
        model: "nvidia/nemotron-3-super-120b-a12b",
        profile: "default",
        credentialEnv: "NVIDIA_API_KEY",
        onboardedAt: "2026-03-01T00:00:00.000Z",
      };
      mockedLoadOnboardConfig.mockReturnValue(config);
      mockedDescribeOnboardEndpoint.mockReturnValue("build (https://api.build.nvidia.com/v1)");
      mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Endpoint API");
      const result = await handleSlashCommand(makeCtx("onboard"), makeApi());
      expect(result.text).toContain("NemoClaw Onboard Status");
      expect(result.text).toContain("NVIDIA Endpoint API");
      expect(result.text).toContain("nvidia/nemotron-3-super-120b-a12b");
      expect(result.text).toContain("NVIDIA_API_KEY");
    });

    it("includes NCP partner when set", async () => {
      const config: NemoClawOnboardConfig = {
        endpointType: "ncp",
        endpointUrl: "https://partner.example.com/v1",
        ncpPartner: "PartnerCo",
        model: "nvidia/nemotron-3-super-120b-a12b",
        profile: "default",
        credentialEnv: "NVIDIA_API_KEY",
        onboardedAt: "2026-03-01T00:00:00.000Z",
      };
      mockedLoadOnboardConfig.mockReturnValue(config);
      mockedDescribeOnboardEndpoint.mockReturnValue("ncp (https://partner.example.com/v1)");
      mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Cloud Partner");
      const result = await handleSlashCommand(makeCtx("onboard"), makeApi());
      expect(result.text).toContain("NCP Partner: PartnerCo");
    });
  });
});
