// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler for the /nemoclaw slash command (chat interface).
 */

import type { PluginCommandContext, PluginCommandResult, OpenClawPluginApi } from "../index.js";
import { loadState } from "../blueprint/state.js";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
} from "../onboard/config.js";
import JSON5 from "json5";

import {
  stewardAuthorize,
  stewardCompleteApprovalFromAuthorizeAuditId,
  stewardEvaluateCandidates,
  stewardExecute,
  stewardGetAudit,
  stewardGetDecisionRecord,
  stewardGetExecutionRecord,
  isStewardError,
  parseStewardExecute403Detail,
  stewardResolvedBaseUrl,
} from "../steward/client.js";
import {
  popTrailingPolicyFlags,
  renderGovernanceTechnical,
  renderMutateBusiness,
  renderMutateExecutionTechnical,
  renderPolicyGetBusiness,
  renderPolicyGetOperator,
  shortenOneLine,
  policyOpHighRisk,
} from "./policy-render.js";
import {
  renderAuditRecord,
  renderDecisionRecord,
  renderExecutionRecord,
} from "./records-render.js";

export async function handleSlashCommand(
  ctx: PluginCommandContext,
  api: OpenClawPluginApi,
): Promise<PluginCommandResult> {
  const subcommand = ctx.args?.trim().split(/\s+/)[0] ?? "";

  switch (subcommand) {
    case "status":
      return slashStatus();
    case "eject":
      return slashEject();
    case "onboard":
      return slashOnboard();
    case "policy":
      return await slashPolicy(ctx, api);
    case "approval":
      return await slashApproval(ctx, api);
    case "records":
      return await slashRecords(ctx, api);
    case "request":
      return await slashRequest(ctx, api);
    default:
      return slashHelp();
  }
}

function slashHelp(): PluginCommandResult {
  return {
    text: [
      "**NemoClaw**",
      "",
      "Usage: `/nemoclaw <subcommand>`",
      "",
      "Subcommands:",
      "  `status`  - Show sandbox, blueprint, and inference state",
      "  `eject`   - Show rollback instructions",
      "  `onboard` - Show onboarding status and instructions",
      "  `policy`   - Govern OpenShell draft policy (via Steward)",
      "  `approval` - Operator: complete Steward approval from an authorize audit id",
      "  `records`  - Operator: inspect Steward audit / decision / execution records",
      "  `request`  - Turn a natural-language request into governed actions",
      "",
      "For full management use the NemoClaw CLI:",
      "  `nemoclaw <name> status`",
      "  `nemoclaw <name> connect`",
      "  `nemoclaw <name> logs`",
      "  `nemoclaw <name> destroy`",
    ].join("\n"),
  };
}

async function slashApproval(
  ctx: PluginCommandContext,
  api: OpenClawPluginApi,
): Promise<PluginCommandResult> {
  const rawTokens = (ctx.args ?? "").trim().split(/\s+/).filter(Boolean);
  const verb = rawTokens[1] ?? "";
  const auditId = (rawTokens[2] ?? "").trim();

  const usage = [
    "**NemoClaw approval (operator)**",
    "",
    "Complete Steward approval for a prior **authorize** audit that returned `needs_approval`:",
    "  `/nemoclaw approval complete <authorize-audit-id>`",
    "",
    "Inspect an audit record (same as **`/nemoclaw records audit`**):",
    "  `/nemoclaw approval audit <audit-id>`  or  `/nemoclaw records audit <audit-id>`",
    "",
    "Steward: GET `/audit/{id}` → POST `/approval-requests` → POST decision `approved` → POST `/action/execute` with resume context.",
    "",
    "Requires an **authorized operator** sender in your OpenClaw policy.",
  ].join("\n");

  if (verb === "audit") {
    if (!auditId) {
      return {
        text: [
          "**Audit inspection** uses **`records`**, not `approval` alone.",
          "",
          "  `/nemoclaw records audit <audit-id>`",
          "",
          "Or (operator alias): `/nemoclaw approval audit <audit-id>`",
          "",
          usage,
        ].join("\n"),
      };
    }
    if (!ctx.isAuthorizedSender) {
      return {
        text: [
          "**Operator only**",
          "",
          "Only authorized operators may run this command.",
          "",
          usage,
        ].join("\n"),
      };
    }
    try {
      const audit = await stewardGetAudit(auditId);
      return { text: renderAuditRecord(audit) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        text: ["**Records lookup failed**", "", msg, "", usage].join("\n"),
      };
    }
  }

  if (verb !== "complete" || !auditId) {
    return { text: usage };
  }

  if (!ctx.isAuthorizedSender) {
    return {
      text: [
        "**Operator only**",
        "",
        "Only authorized operators may run this command.",
        "",
        usage,
      ].join("\n"),
    };
  }

  const decidedBy = ctx.senderId ? `user:${ctx.senderId}` : "operator:tui";
  try {
    const out = await stewardCompleteApprovalFromAuthorizeAuditId(auditId, decidedBy);
    api.logger.info(`nemoclaw approval complete audit=${auditId} execute_audit=${out.audit_id}`);
    const sandbox =
      typeof out.resumed_parameters.sandbox_name === "string"
        ? out.resumed_parameters.sandbox_name
        : "(see action parameters)";
    const runtimeLine = summarizeRuntimeForBusiness(out.result);
    const ok = out.result.ok === true;
    return {
      text: [
        "**Approval completed and execution finished**",
        "",
        "**What was requested**",
        "- Action:",
        `  \`${out.resumed_action}\``,
        `- Purpose: ${shortenOneLine(out.resumed_purpose, 200) || "(none)"}`,
        `- Sandbox / target: ${sandbox}`,
        "",
        "**Governance**",
        `- Approved proposal (storage id): \`${out.governance_proposal_id}\``,
        `- Approval request used: \`${out.approval_request_id}\``,
        `- Authorize audit: \`${auditId}\``,
        "",
        "**Execution**",
        `- Execute audit: \`${out.audit_id}\``,
        `- Runtime: ${runtimeLine}`,
        `- Overall: ${ok ? "success" : "governance allowed after approval, but runtime reported failure"}`,
        "",
        "**Inspect records**",
        `- \`/nemoclaw records audit ${auditId}\` (authorize pass)`,
        `- \`/nemoclaw records audit ${out.audit_id}\` (execute pass)`,
      ].join("\n"),
    };
  } catch (e) {
    const parsed403 = isStewardError(e) ? parseStewardExecute403Detail(e.body) : null;
    if (parsed403?.decision === "allow" && parsed403.audit_id) {
      api.logger.warn(
        `nemoclaw approval complete runtime_failed authorize_audit=${auditId} execute_audit=${parsed403.audit_id}`,
      );
      const hint = parsed403.user_hint ? shortenOneLine(parsed403.user_hint, 220) : "";
      return {
        text: [
          "**Approval completed; execution failed (runtime)**",
          "",
          "Governance allowed this action after approval, but OpenShell or downstream execution did not succeed.",
          hint ? `Hint: ${hint}` : null,
          "",
          `Authorize audit: \`${auditId}\``,
          `Execute audit: \`${parsed403.audit_id}\``,
          parsed403.decision_record_id
            ? `Decision record: \`${parsed403.decision_record_id}\``
            : null,
          parsed403.execution_record_id
            ? `Execution record: \`${parsed403.execution_record_id}\``
            : null,
          "",
          "**Next step**",
          `- \`/nemoclaw records audit ${parsed403.audit_id}\``,
          parsed403.execution_record_id
            ? `- \`/nemoclaw records execution ${parsed403.execution_record_id}\``
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    if (isStewardError(e) && e.status === 404) {
      const base = stewardResolvedBaseUrl();
      api.logger.warn(`nemoclaw approval complete audit_not_found audit=${auditId} base=${base}`);
      return {
        text: [
          "**Cannot complete approval — Steward has no audit with this id**",
          "",
          `Tried \`GET /audit/${auditId}\` against **${base}** and got **404** (not found).`,
          "",
          "**Most likely:** Steward’s audit store is **in-memory**. A **process restart** clears it — including **`uvicorn --reload`** when Python files change. The authorize step and **`approval complete`** must hit the **same** Steward process **without** a restart in between.",
          "",
          "**What to do:** Run **`/nemoclaw policy approve-all manz`** (or your command) again, then **`/nemoclaw approval complete <new-audit-id>`** right away. For a stable dev loop, run Steward **without** `--reload`, or accept re-authorizing after each reload.",
          "",
          "**Also verify:** **`STEWARD_URL`** for NemoClaw matches the Steward you used for the policy command (e.g. `127.0.0.1` vs `host.openshell.internal` vs Docker).",
        ].join("\n"),
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    api.logger.warn(
      `nemoclaw approval complete failed audit=${auditId} err=${shortenOneLine(msg, 200)}`,
    );
    return {
      text: ["**Approval workflow failed**", "", msg].join("\n"),
    };
  }
}

async function slashRecords(
  ctx: PluginCommandContext,
  _api: OpenClawPluginApi,
): Promise<PluginCommandResult> {
  const rawTokens = (ctx.args ?? "").trim().split(/\s+/).filter(Boolean);
  const kind = (rawTokens[1] ?? "").toLowerCase();
  const id = (rawTokens[2] ?? "").trim();

  const usage = [
    "**NemoClaw records (operator)**",
    "",
    "Read Steward governance and execution records (no curl):",
    "  `/nemoclaw records audit <audit-id>`",
    "  `/nemoclaw records decision <decision-record-id>`",
    "  `/nemoclaw records execution <execution-record-id>`",
    "",
    "Requires an **authorized operator** sender.",
  ].join("\n");

  if (!kind || !id) {
    return { text: usage };
  }

  if (!ctx.isAuthorizedSender) {
    return {
      text: [
        "**Operator only**",
        "",
        "Only authorized operators may run this command.",
        "",
        usage,
      ].join("\n"),
    };
  }

  try {
    if (kind === "audit") {
      const audit = await stewardGetAudit(id);
      return { text: renderAuditRecord(audit) };
    }
    if (kind === "decision") {
      const rec = await stewardGetDecisionRecord(id);
      return { text: renderDecisionRecord(rec) };
    }
    if (kind === "execution") {
      const rec = await stewardGetExecutionRecord(id);
      return { text: renderExecutionRecord(rec) };
    }
    return { text: usage };
  } catch (e) {
    if (isStewardError(e) && e.status === 404 && kind === "audit") {
      const base = stewardResolvedBaseUrl();
      return {
        text: [
          "**Audit not found in Steward**",
          "",
          `Tried \`GET /audit/${id}\` against **${base}** and got **404**.`,
          "",
          "**Most likely:** Steward’s audit store is **in-memory**. If Steward restarted (including `uvicorn --reload`) after the audit id was created, the record is gone.",
          "",
          "**What to do:** re-run the original `/nemoclaw policy ...` to generate a new audit id, then immediately inspect it:",
          `- \`/nemoclaw records audit <new-audit-id>\``,
          "",
          "**Also verify:** you’re pointing at the same Steward instance (host/port) that produced the audit id.",
          "",
          usage,
        ].join("\n"),
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { text: ["**Records lookup failed**", "", msg, "", usage].join("\n") };
  }
}

async function slashRequest(
  ctx: PluginCommandContext,
  _api: OpenClawPluginApi,
): Promise<PluginCommandResult> {
  const rawTokens = (ctx.args ?? "").trim().split(/\s+/).slice(1); // drop "request"
  const { rest, flags } = popTrailingPolicyFlags(rawTokens);

  const sandboxName = rest[0] ?? "";
  const text = rest.slice(1).join(" ").trim();

  const usage = [
    "**NemoClaw Request (experimental)**",
    "",
    "Usage:",
    "  `/nemoclaw request <sandbox> <natural language request> [details] [audit]`",
    "",
    "Example:",
    "  `/nemoclaw request manz Please make npm installs work in this sandbox.`",
  ].join("\n");

  if (!sandboxName || !text) return { text: usage };

  const role = ctx.isAuthorizedSender ? "operator" : "agent";
  const baseContext = {
    requested_by: ctx.senderId ? `user:${ctx.senderId}` : "user:unknown",
    channel: ctx.channel,
    user_request: text,
  };

  const lower = text.toLowerCase();
  const isNpmIntent =
    lower.includes("npm") && (lower.includes("install") || lower.includes("installs"));
  const isGitCloneIntent =
    (lower.includes("git") && lower.includes("clone")) || lower.includes("git clone");

  // Narrow initial candidate set for the concrete npm scenario (and git-clone next scenario).
  const candidates = isNpmIntent
    ? [
        {
          id: "approve-npm-registry",
          label: "Allow Node to reach the npm registry (fix npm installs)",
          type: "remediation" as const,
          proposal: {
            action: "openshell.draft_policy.approve_matching",
            purpose: "Enable npm installs by allowing registry access for Node",
            role,
            context: baseContext,
            parameters: {
              sandbox_name: sandboxName,
              match: {
                host: "registry.npmjs.org",
                port: 443,
                binary_path: "/usr/local/bin/node",
              },
            },
          },
        },
        {
          id: "get-draft",
          label: "Check pending network rules (diagnostic)",
          type: "diagnostic" as const,
          proposal: {
            action: "openshell.draft_policy.get",
            purpose: "Inspect what network rules are pending/approved",
            role,
            context: baseContext,
            parameters: { sandbox_name: sandboxName },
          },
        },
        {
          id: "inspect-sandbox-mode",
          label: "Inspect sandbox mode (placeholder)",
          type: "diagnostic" as const,
          proposal: {
            action: "openshell.sandbox.inspect_mode",
            purpose: "Check sandbox mode and restrictions",
            role,
            context: baseContext,
            parameters: { sandbox_name: sandboxName },
          },
        },
        {
          id: "request-mode-patch",
          label: "Request sandbox mode patch (placeholder)",
          type: "administrative" as const,
          proposal: {
            action: "openshell.sandbox.request_mode_patch",
            purpose: "Request a sandbox configuration change",
            role,
            context: baseContext,
            parameters: { sandbox_name: sandboxName },
          },
        },
      ]
    : isGitCloneIntent
      ? [
          {
            id: "approve-github",
            label: "Allow git to reach GitHub (fix git clone)",
            type: "remediation" as const,
            proposal: {
              action: "openshell.draft_policy.approve_matching",
              purpose: "Enable git clone by allowing GitHub access for git",
              role,
              context: baseContext,
              parameters: {
                sandbox_name: sandboxName,
                match: { host: "github.com", port: 443, binary_path: "/usr/bin/git" },
              },
            },
          },
          {
            id: "approve-raw-githubusercontent",
            label: "Allow git to reach raw.githubusercontent.com (fix fetches)",
            type: "remediation" as const,
            proposal: {
              action: "openshell.draft_policy.approve_matching",
              purpose: "Enable git fetches that use raw.githubusercontent.com",
              role,
              context: baseContext,
              parameters: {
                sandbox_name: sandboxName,
                match: {
                  host: "raw.githubusercontent.com",
                  port: 443,
                  binary_path: "/usr/bin/git",
                },
              },
            },
          },
          {
            id: "get-draft",
            label: "Check pending network rules (diagnostic)",
            type: "diagnostic" as const,
            proposal: {
              action: "openshell.draft_policy.get",
              purpose: "Inspect what network rules are pending/approved",
              role,
              context: baseContext,
              parameters: { sandbox_name: sandboxName },
            },
          },
        ]
      : [
          {
            id: "get-draft",
            label: "Check pending network rules (diagnostic)",
            type: "diagnostic" as const,
            proposal: {
              action: "openshell.draft_policy.get",
              purpose: "Inspect what network rules are pending/approved",
              role,
              context: baseContext,
              parameters: { sandbox_name: sandboxName },
            },
          },
        ];

  let evals;
  try {
    evals = await stewardEvaluateCandidates(candidates);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      text: `**Request blocked**\n\nSteward could not evaluate candidates (fail-closed).\n\n${msg}`,
    };
  }

  const chosenId = evals.selection?.selected_id ?? null;
  const chosen = chosenId ? (evals.evaluations.find((e) => e.id === chosenId) ?? null) : null;
  const approvalRequired = evals.evaluations.find((ev) => ev.decision === "needs_approval") ?? null;

  if (!chosen) {
    const header = [
      "**Outcome**",
      "",
      "Request could not be applied.",
      "",
      `Sandbox: ${sandboxName}`,
    ];
    const understood = [`Request: ${text}`];
    const lines = evals.evaluations.map(
      (ev) => `- ${ev.label}: ${ev.decision} (risk=${ev.risk_tier})`,
    );
    const next = approvalRequired
      ? "\nNext step: an operator approval is required for the safest candidate."
      : "\nNext step: no allowed candidate exists; refine the request or add a Steward policy.";
    const why = evals.selection?.rationale ? `\nSelection: ${evals.selection.rationale}` : "";
    const audit =
      flags.details || flags.showAudit ? "\n\nDetails:\n" + JSON.stringify(evals, null, 2) : "";
    return {
      text:
        [...header, "", ...understood, "", "Evaluations:", ...lines].join("\n") +
        why +
        next +
        audit,
    };
  }

  const cand = candidates.find((c) => c.id === chosen.id) ?? null;
  if (!cand) {
    const base = [
      "**Outcome**",
      "",
      "Request blocked.",
      "",
      `Sandbox: ${sandboxName}`,
      "",
      `Request: ${text}`,
      "",
      "Selection referenced an unknown option id. This is a client/service mismatch.",
    ].join("\n");
    const details =
      flags.details || flags.showAudit ? "\n\nDetails:\n" + JSON.stringify(evals, null, 2) : "";
    return { text: base + details };
  }
  const considered = evals.evaluations
    .map((ev) => `- ${ev.label}: ${ev.decision} (risk=${ev.risk_tier})`)
    .join("\n");

  if (chosen.decision === "needs_approval") {
    const base = [
      "**Outcome**",
      "",
      "Approval required before we can apply the requested fix.",
      "",
      `Sandbox: ${sandboxName}`,
      "",
      `Request: ${text}`,
      "",
      "Options considered:",
      considered,
      "",
      `Selected (pending approval): ${chosen.label}`,
      `Why: ${evals.selection?.rationale ?? "(no selection rationale)"}`,
      shortenOneLine(chosen.rationale, 200)
        ? `Governance note: ${shortenOneLine(chosen.rationale, 200)}`
        : null,
      "",
      "Next step: ask an operator to approve this change, then retry the same request.",
    ]
      .filter(Boolean)
      .join("\n");
    const details =
      flags.details || flags.showAudit
        ? `\n\nCorrelation:\n- authorize audit: ${chosen.audit_id}`
        : "";
    return { text: base + details };
  }

  if (chosen.decision !== "allow") {
    const base = [
      "**Outcome**",
      "",
      "Request blocked (governance did not allow a safe next step).",
      "",
      `Sandbox: ${sandboxName}`,
      "",
      `Request: ${text}`,
      "",
      "Options considered:",
      considered,
      "",
      `Selected: ${chosen.label}`,
      `Decision: ${chosen.decision}`,
      shortenOneLine(chosen.rationale, 200)
        ? `Why: ${shortenOneLine(chosen.rationale, 200)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    const details =
      flags.details || flags.showAudit ? "\n\nDetails:\n" + JSON.stringify(evals, null, 2) : "";
    return { text: base + details };
  }

  if (cand.proposal.action === "openshell.draft_policy.get") {
    // Diagnostic action: execute, summarize, and recommend the next best step (if any).
    try {
      const exec = await stewardExecute(cand.proposal);
      const raw: unknown = exec.result;
      const root =
        raw && typeof raw === "object"
          ? (raw as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      const stepsVal: unknown = root.steps;
      const steps = Array.isArray(stepsVal) ? (stepsVal as unknown[]) : [];
      const step0 =
        steps[0] && typeof steps[0] === "object"
          ? (steps[0] as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      const chunksVal: unknown = step0.chunks;
      const chunks = Array.isArray(chunksVal) ? (chunksVal as unknown[]) : [];

      function findPendingRuleIdForIntent(): string {
        for (const c of chunks) {
          const chunk = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
          const statusRaw = chunk.status;
          const status = (typeof statusRaw === "string" ? statusRaw : "").toLowerCase();
          if (status !== "pending") continue;
          const pr = chunk.proposed_rule;
          const proposed = pr && typeof pr === "object" ? (pr as Record<string, unknown>) : {};
          const endpoints = Array.isArray(proposed.endpoints)
            ? (proposed.endpoints as Record<string, unknown>[])
            : [];
          const binaries = Array.isArray(proposed.binaries)
            ? (proposed.binaries as Record<string, unknown>[])
            : [];

          if (isNpmIntent) {
            const hasNode = binaries.some(
              (b) => typeof b.path === "string" && b.path === "/usr/local/bin/node",
            );
            const hasNpmHost = endpoints.some(
              (ep) =>
                typeof ep.host === "string" && ep.host === "registry.npmjs.org" && ep.port === 443,
            );
            if (!hasNode || !hasNpmHost) continue;
          } else if (isGitCloneIntent) {
            const hasGit = binaries.some(
              (b) => typeof b.path === "string" && b.path === "/usr/bin/git",
            );
            const hasGitHubHost = endpoints.some((ep) => {
              const host = typeof ep.host === "string" ? ep.host : "";
              return (
                (host === "github.com" || host === "raw.githubusercontent.com") && ep.port === 443
              );
            });
            if (!hasGit || !hasGitHubHost) continue;
          } else {
            continue;
          }

          const id = chunk.id;
          return typeof id === "string" ? id : "";
        }
        return "";
      }

      const pendingId = findPendingRuleIdForIntent();
      const next = pendingId
        ? [
            "**Recommended next action**",
            "",
            `Approve the pending rule: \`/nemoclaw policy approve ${sandboxName} ${pendingId}\``,
          ].join("\n")
        : [
            "**Recommended next action**",
            "",
            isGitCloneIntent
              ? "Try running `git clone ...` inside the sandbox to generate a pending rule, then re-run this command."
              : "Try running `npm install` inside the sandbox to generate a pending rule, then re-run this command.",
          ].join("\n");

      const base = [
        "**Outcome**",
        "",
        "Diagnostics collected. A fix was not applied yet.",
        "",
        `Sandbox: ${sandboxName}`,
        "",
        `Request: ${text}`,
        "",
        "Options considered:",
        considered,
        "",
        `Selected: ${chosen.label}`,
        `Why: ${evals.selection?.rationale ?? "(no selection rationale)"}`,
        "",
        "Summary:",
        `Pending rules observed: ${String(chunks.length)}`,
        "",
        next,
      ].join("\n");
      return { text: base };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { text: `**Request failed**\n\n${msg}` };
    }
  }

  // Execute chosen action via Steward
  try {
    const exec = await stewardExecute(cand.proposal);
    const base = [
      "**Outcome**",
      "",
      "Fix applied.",
      "",
      `Sandbox: ${sandboxName}`,
      "",
      `Request: ${text}`,
      "",
      `Selected: ${chosen.label}`,
      `Why: ${evals.selection?.rationale ?? "Selected by governance."}`,
      shortenOneLine(chosen.rationale, 200)
        ? `Governance note: ${shortenOneLine(chosen.rationale, 200)}`
        : null,
      "",
      "Options considered:",
      considered,
    ]
      .filter(Boolean)
      .join("\n");
    const details =
      flags.details || flags.showAudit
        ? `\n\nCorrelation:\n- authorize audit: ${chosen.audit_id}\n- execute audit: ${exec.audit_id}`
        : "";
    return { text: base + details };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: `**Request blocked**\n\n${msg}` };
  }
}

async function slashPolicy(
  ctx: PluginCommandContext,
  api: OpenClawPluginApi,
): Promise<PluginCommandResult> {
  const rawTokens = (ctx.args ?? "").trim().split(/\s+/).slice(1);
  const { rest, flags } = popTrailingPolicyFlags(rawTokens);

  const op = rest[0] ?? "";
  const usage = [
    "**NemoClaw Policy (Phase 1A)**",
    "",
    "Usage:",
    "  `/nemoclaw policy get <sandbox> [details] [audit] [raw|--json]`",
    "  `/nemoclaw policy approve <sandbox> <chunk_id> [details] [audit]`",
    "  `/nemoclaw policy reject <sandbox> <chunk_id> [reason...] [details] [audit]`",
    "  `/nemoclaw policy edit <sandbox> <chunk_id> <json> [details] [audit]`",
    "  `/nemoclaw policy approve_all <sandbox> [details] [audit]` (alias: `approve-all`)",
    "  `/nemoclaw policy clear <sandbox> [details] [audit]`",
    "",
    "Flags (trailing): `details` / `--details` — operator view; `audit` / `--audit` — correlation ids; `raw` / `--json` — full JSON (get only).",
  ].join("\n");

  if (!op) return { text: usage };

  const sandboxName = rest[1] ?? "";
  const chunkId = rest[2] ?? "";

  if (!sandboxName) return { text: usage };

  const baseProposal = {
    role: ctx.isAuthorizedSender ? "operator" : "agent",
    context: {
      requested_by: ctx.senderId ? `user:${ctx.senderId}` : "user:unknown",
      channel: ctx.channel,
    },
    parameters: { sandbox_name: sandboxName },
  } as const;

  let action = "";
  const parameters: Record<string, unknown> = { sandbox_name: sandboxName };

  if (op === "get") {
    action = "openshell.draft_policy.get";
  } else if (op === "approve") {
    if (!chunkId) return { text: usage };
    action = "openshell.draft_policy.approve";
    parameters["chunk_id"] = chunkId;
  } else if (op === "reject") {
    if (!chunkId) return { text: usage };
    action = "openshell.draft_policy.reject";
    parameters["chunk_id"] = chunkId;
    const reason = rest.slice(3).join(" ");
    if (reason) parameters["reason"] = reason;
  } else if (op === "edit") {
    if (!chunkId) return { text: usage };
    const json = rest.slice(3).join(" ").trim();
    if (!json) return { text: usage };
    action = "openshell.draft_policy.edit";
    parameters["chunk_id"] = chunkId;
    try {
      parameters["proposed_rule"] = JSON5.parse(json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { text: `Invalid rule JSON: ${msg}\n\n${usage}` };
    }
  } else if (op === "approve_all" || op === "approve-all") {
    action = "openshell.draft_policy.approve_all";
  } else if (op === "clear") {
    action = "openshell.draft_policy.clear";
  } else {
    return { text: usage };
  }

  const proposal = {
    action,
    purpose: `OpenShell draft policy: ${op}`,
    role: baseProposal.role,
    context: baseProposal.context,
    parameters,
  };

  const highRisk = policyOpHighRisk(op);
  const isGet = op === "get";

  let auth;
  try {
    auth = await stewardAuthorize(proposal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    api.logger.warn(
      `nemoclaw policy ${op} authorize_failed sandbox=${sandboxName} err=${shortenOneLine(msg, 200)}`,
    );
    const envHint =
      /Steward is unreachable|unreachable/i.test(msg) && /:80\d\d\//.test(msg)
        ? [
            "",
            "OpenClaw often does **not** pass `STEWARD_URL` into the NemoClaw plugin. If `openclaw.json` is read-only, create **`steward-url`** (one line: your Steward base URL) under **`$OPENCLAW_STATE_DIR`** or **`/sandbox/.openclaw-data/`**, e.g. `printf '%s\\n' 'http://host.openshell.internal:8010' > /sandbox/.openclaw-data/steward-url`, then retry. Or set **`plugins.config.nemoclaw.stewardUrl`** in config when you can edit it.",
          ].join("\n")
        : /Steward is unreachable/i.test(msg)
          ? [
              "",
              "If the URL looks wrong, set **`stewardUrl`** in the nemoclaw plugin config or ensure `STEWARD_URL` reaches this process.",
            ].join("\n")
          : "";
    return {
      text: [
        "**Policy blocked**",
        "",
        "Steward could not authorize this request (fail-closed).",
        "",
        msg,
        envHint,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (auth.decision === "deny" || auth.decision === "needs_approval") {
    if (isGet && !flags.showAudit && !flags.details) {
      const governanceLine =
        auth.decision === "deny"
          ? "Governance: this read was not allowed."
          : "Governance: an approver must allow this before you can view details.";
      const approvalBits =
        auth.decision === "needs_approval"
          ? [
              "",
              `Operator handle (authorize audit): \`${auth.audit_id}\``,
              "Next step (operator):",
              `  \`/nemoclaw approval complete ${auth.audit_id}\``,
              "",
              "Note: Steward audits are **in-memory** — **`uvicorn --reload`** or a restart clears them; use the **same** running Steward (and **`STEWARD_URL`**) for policy and **`approval complete`**, or re-run **`policy`** for a new id.",
            ]
          : [];
      return {
        text: [
          "**Network access review**",
          "",
          `Sandbox: ${sandboxName}`,
          "",
          governanceLine,
          shortenOneLine(auth.rationale, 200)
            ? `Note: ${shortenOneLine(auth.rationale, 200)}`
            : null,
          ...approvalBits,
          "",
          auth.decision === "deny"
            ? "Next step: contact an operator or adjust the request."
            : "Tip: add `details` or `audit` for full correlation ids.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    const technical = renderGovernanceTechnical(auth.decision, auth.rationale, auth.audit_id);
    const business = renderMutateBusiness({
      op,
      sandboxName,
      decision: auth.decision,
      rationale: auth.rationale,
      highRisk,
      executed: false,
      authorizeAuditId: auth.audit_id,
    });
    const text = flags.details ? `${business}\n\n---\n\n${technical}` : business;
    api.logger.info(
      `nemoclaw policy ${op} outcome=${auth.decision} sandbox=${sandboxName} authorize_audit=${auth.audit_id}`,
    );
    return { text };
  }

  try {
    const exec = await stewardExecute(proposal);
    api.logger.info(
      `nemoclaw policy ${op} outcome=allow sandbox=${sandboxName} authorize_audit=${auth.audit_id} execute_audit=${exec.audit_id}`,
    );

    if (isGet) {
      if (flags.rawJson && !flags.details) {
        const auditHdr = flags.showAudit
          ? `Authorize audit: ${auth.audit_id}\nExecute audit: ${exec.audit_id}\n\n`
          : "";
        return { text: `${auditHdr}${JSON.stringify(exec.result, null, 2)}` };
      }

      if (flags.details) {
        let out = renderGovernanceTechnical("allow", auth.rationale, auth.audit_id);
        if (flags.showAudit) out += `\nExecute audit: ${exec.audit_id}`;
        out += "\n\n**Draft details**\n\n" + renderPolicyGetOperator(exec.result, sandboxName);
        if (flags.rawJson) {
          out += "\n\n---\n\n**Raw JSON**\n\n" + JSON.stringify(exec.result, null, 2);
        }
        return { text: out.trim() };
      }

      let out = renderPolicyGetBusiness(exec.result, sandboxName, auth);
      if (flags.showAudit) {
        out += `\n\n**Correlation**\nAuthorize audit: ${auth.audit_id}\nExecute audit: ${exec.audit_id}`;
      }
      return { text: out };
    }

    // Mutate commands
    const business = renderMutateBusiness({
      op,
      sandboxName,
      decision: "allow",
      rationale: auth.rationale,
      highRisk,
      executed: true,
    });

    const execPart = flags.details
      ? renderMutateExecutionTechnical(exec, flags.showAudit)
      : summarizeRuntimeForBusiness(exec.result);

    const technical = flags.details
      ? `\n\n---\n\n${renderGovernanceTechnical("allow", auth.rationale, auth.audit_id)}`
      : "";

    const correlation =
      flags.showAudit && !flags.details
        ? `\n\n**Correlation:** authorize ${auth.audit_id} · execute ${exec.audit_id}`
        : flags.showAudit && flags.details
          ? `\n\n**Execute audit:** ${exec.audit_id}`
          : "";

    if (highRisk && !flags.details) {
      // Never silent for high-risk: always show explicit banner in business mode
      api.logger.warn(
        `nemoclaw policy ${op} high_risk_executed sandbox=${sandboxName} execute_audit=${exec.audit_id}`,
      );
    }

    return {
      text: `${business}${correlation}${technical}\n\n**Runtime**\n\n${execPart}`.trim(),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    api.logger.warn(
      `nemoclaw policy ${op} execute_failed sandbox=${sandboxName} authorize_audit=${auth.audit_id} err=${shortenOneLine(msg, 200)}`,
    );
    return {
      text: [
        "**Policy blocked**",
        "",
        "The request was allowed by governance, but applying it failed (runtime or Steward execute).",
        "",
        msg,
        "",
        "Next step: verify sandbox name and chunk id, Steward ↔ OpenShell connectivity, then retry with `details audit` if you need correlation ids.",
      ].join("\n"),
    };
  }
}

function summarizeRuntimeForBusiness(result: Record<string, unknown>): string {
  if (result.ok === true) return "Runtime reported success.";
  const msg = typeof result.message === "string" ? shortenOneLine(result.message, 160) : "";
  return msg || "Runtime finished; add `details` for the full response.";
}

function slashStatus(): PluginCommandResult {
  const state = loadState();

  if (!state.lastAction) {
    return {
      text: "**NemoClaw**: No operations performed yet. Run `nemoclaw onboard` to get started.",
    };
  }

  const lines = [
    "**NemoClaw Status**",
    "",
    `Last action: ${state.lastAction}`,
    `Blueprint: ${state.blueprintVersion ?? "unknown"}`,
    `Run ID: ${state.lastRunId ?? "none"}`,
    `Sandbox: ${state.sandboxName ?? "none"}`,
    `Updated: ${state.updatedAt}`,
  ];

  if (state.migrationSnapshot) {
    lines.push("", `Rollback snapshot: ${state.migrationSnapshot}`);
  }

  return { text: lines.join("\n") };
}

function slashOnboard(): PluginCommandResult {
  const config = loadOnboardConfig();
  if (config) {
    return {
      text: [
        "**NemoClaw Onboard Status**",
        "",
        `Endpoint: ${describeOnboardEndpoint(config)}`,
        `Provider: ${describeOnboardProvider(config)}`,
        config.ncpPartner ? `NCP Partner: ${config.ncpPartner}` : null,
        `Model: ${config.model}`,
        `Credential: $${config.credentialEnv}`,
        `Profile: ${config.profile}`,
        `Onboarded: ${config.onboardedAt}`,
        "",
        "To reconfigure, run: `nemoclaw onboard`",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  return {
    text: [
      "**NemoClaw Onboarding**",
      "",
      "No configuration found. Run the onboard command to set up inference:",
      "",
      "```",
      "nemoclaw onboard",
      "```",
    ].join("\n"),
  };
}

function slashEject(): PluginCommandResult {
  const state = loadState();

  if (!state.lastAction) {
    return { text: "No NemoClaw deployment found. Nothing to eject from." };
  }

  if (!state.migrationSnapshot && !state.hostBackupPath) {
    return {
      text: "No migration snapshot found. Manual rollback required.",
    };
  }

  return {
    text: [
      "**Eject from NemoClaw**",
      "",
      "To rollback to your host OpenClaw installation, run:",
      "",
      "```",
      "nemoclaw <name> destroy",
      "```",
      "",
      `Snapshot: ${state.migrationSnapshot ?? state.hostBackupPath ?? "none"}`,
    ].join("\n"),
  };
}
