// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared rendering for governed /nemoclaw policy commands.
 * Business mode stays plain-language; details/audit/raw are explicit opt-ins.
 */

import type { StewardAuthorizeResponse, StewardExecuteResponse } from "../steward/client.js";

export type PolicyDisplayFlags = {
  details: boolean;
  rawJson: boolean;
  showAudit: boolean;
};

const TRAILING_FLAG_GROUPS: Array<{ keys: string[]; field: keyof PolicyDisplayFlags }> = [
  { keys: ["--audit", "audit"], field: "showAudit" },
  { keys: ["--json", "raw", "-j"], field: "rawJson" },
  { keys: ["--details", "details", "--operator", "operator"], field: "details" },
];

/** Strip recognized flags from the end of the token list (safe for edit JSON that is one blob). */
export function popTrailingPolicyFlags(tokens: string[]): {
  rest: string[];
  flags: PolicyDisplayFlags;
} {
  const rest = [...tokens];
  const flags: PolicyDisplayFlags = { details: false, rawJson: false, showAudit: false };
  let changed = true;
  while (changed && rest.length) {
    changed = false;
    const last = (rest[rest.length - 1] ?? "").toLowerCase();
    for (const g of TRAILING_FLAG_GROUPS) {
      if (g.keys.includes(last)) {
        flags[g.field] = true;
        rest.pop();
        changed = true;
        break;
      }
    }
  }
  return { rest, flags };
}

export type DraftChunkStatus = "approved" | "pending" | "rejected" | "unknown";

export function normalizeChunkStatus(value: unknown): DraftChunkStatus {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  if (s === "approved") return "approved";
  if (s === "rejected") return "rejected";
  if (s === "pending" || s === "proposed" || s === "needs_approval") return "pending";
  return "unknown";
}

export function shortenOneLine(value: unknown, maxLen: number): string {
  const s = typeof value === "string" ? value : "";
  const one = s.replace(/\s+/g, " ").trim();
  if (!one) return "";
  return one.length > maxLen ? `${one.slice(0, Math.max(0, maxLen - 1))}…` : one;
}

function chunkEnablementSummary(chunk: Record<string, unknown>): string[] {
  const proposed = chunk.proposed_rule as Record<string, unknown> | undefined;
  const ruleNameRaw = chunk.rule_name ?? proposed?.name ?? "(unnamed)";
  const ruleName = typeof ruleNameRaw === "string" ? ruleNameRaw : "(unnamed)";
  const endpoints = Array.isArray(proposed?.endpoints)
    ? (proposed.endpoints as Record<string, unknown>[])
    : [];
  const binaries = Array.isArray(proposed?.binaries)
    ? (proposed.binaries as Record<string, unknown>[])
    : [];

  const binaryPaths = binaries
    .map((b) => (typeof b.path === "string" ? b.path : null))
    .filter(Boolean) as string[];
  const binaryLabel = binaryPaths.length
    ? binaryPaths.length === 1
      ? (binaryPaths[0] ?? "a program")
      : `${binaryPaths[0] ?? "a program"} (+${String(binaryPaths.length - 1)} more)`
    : "a program";

  const items: string[] = [];
  for (const ep of endpoints) {
    const host = typeof ep.host === "string" ? ep.host : null;
    const port = typeof ep.port === "number" ? ep.port : null;
    if (!host || port === null) continue;
    items.push(`${binaryLabel} can connect to ${host}:${String(port)}`);
  }

  if (!items.length) return [`${ruleName} (details unavailable)`];
  return items;
}

function overallStatusFromCounts(total: number, pending: number, rejected: number): string {
  if (total === 0) return "Overall status: no draft access requests.";
  if (pending > 0) return `Overall status: attention needed (${String(pending)} pending).`;
  if (rejected > 0) return `Overall status: stable (${String(rejected)} rejected, none pending).`;
  return "Overall status: all current requests are approved.";
}

/** Default business view for policy get. */
export function renderPolicyGetBusiness(
  execResult: unknown,
  sandboxName: string,
  auth: StewardAuthorizeResponse,
): string {
  const root = (execResult ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(root.steps) ? (root.steps as Record<string, unknown>[]) : [];
  const step0 = steps[0] ?? {};
  const draftVersion = typeof step0.draft_version === "number" ? step0.draft_version : null;
  const chunks = Array.isArray(step0.chunks) ? (step0.chunks as Record<string, unknown>[]) : [];

  const counts: Record<DraftChunkStatus, number> = {
    approved: 0,
    pending: 0,
    rejected: 0,
    unknown: 0,
  };
  const approved: Record<string, unknown>[] = [];
  const pending: Record<string, unknown>[] = [];

  for (const c of chunks) {
    const status = normalizeChunkStatus(c.status);
    counts[status] += 1;
    if (status === "approved") approved.push(c);
    if (status === "pending") pending.push(c);
  }

  const actionNeeded =
    pending.length > 0
      ? `Action needed: review and approve ${String(pending.length)} pending access request(s). Next: ask an operator to approve in OpenShell or use \`/nemoclaw policy approve <sandbox> <id>\` after \`--details\` shows ids.`
      : "Action needed: none right now.";

  const governanceLine =
    auth.decision === "allow"
      ? "Governance: your organization’s policy service allowed this read."
      : "Governance: Steward evaluated this request.";

  const governanceRationale = shortenOneLine(auth.rationale, 160);

  const enabled: string[] = [];
  for (const c of approved.slice(0, 5)) enabled.push(...chunkEnablementSummary(c).slice(0, 2));
  const enabledLine =
    enabled.length > 0
      ? ["What network access is approved today:", ...enabled.map((s) => `- ${s}`)].join("\n")
      : "What network access is approved today: nothing listed in the draft.";

  const pendingHints: string[] = [];
  for (const c of pending.slice(0, 5)) pendingHints.push(...chunkEnablementSummary(c).slice(0, 2));
  const pendingLine =
    pendingHints.length > 0
      ? ["Waiting for approval:", ...pendingHints.map((s) => `- ${s}`)].join("\n")
      : null;

  const statusLine = overallStatusFromCounts(chunks.length, counts.pending, counts.rejected);

  return [
    "**Network access review**",
    "",
    `Sandbox: ${sandboxName}`,
    statusLine,
    draftVersion === null ? "Draft version: (unknown)" : `Draft version: ${String(draftVersion)}`,
    `Counts: ${String(chunks.length)} total — approved ${String(counts.approved)}, pending ${String(counts.pending)}, rejected ${String(counts.rejected)}`,
    "",
    actionNeeded,
    "",
    enabledLine,
    pendingLine ? "\n" + pendingLine : null,
    "",
    governanceLine,
    governanceRationale ? `Note: ${governanceRationale}` : null,
    "",
    "Tip: add `details` or `--details` for operator view; `audit` for correlation ids; `raw` or `--json` for full payload.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Operator/details view for policy get. */
export function renderPolicyGetOperator(execResult: unknown, sandboxName: string): string {
  const root = (execResult ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(root.steps) ? (root.steps as Record<string, unknown>[]) : [];
  const step0 = steps[0] ?? {};
  const draftVersion = typeof step0.draft_version === "number" ? step0.draft_version : null;
  const chunks = Array.isArray(step0.chunks) ? (step0.chunks as Record<string, unknown>[]) : [];

  const counts: Record<DraftChunkStatus, number> = {
    approved: 0,
    pending: 0,
    rejected: 0,
    unknown: 0,
  };

  const lines: string[] = [];
  for (const c of chunks) {
    const status = normalizeChunkStatus(c.status);
    counts[status] += 1;
  }

  lines.push(
    "**Draft policy (details)**",
    "",
    `Sandbox: ${sandboxName}`,
    draftVersion === null ? "Draft version: (unknown)" : `Draft version: ${String(draftVersion)}`,
    `Chunks: ${String(chunks.length)} (approved: ${String(counts.approved)}, pending: ${String(counts.pending)}, rejected: ${String(counts.rejected)})`,
  );

  if (chunks.length) lines.push("", "**Chunks**");
  for (const c of chunks) {
    const ruleNameRaw =
      c.rule_name ?? (c.proposed_rule as Record<string, unknown> | undefined)?.name ?? "(unnamed)";
    const ruleName = typeof ruleNameRaw === "string" ? ruleNameRaw : "(unnamed)";
    const status = normalizeChunkStatus(c.status);
    const rationale = shortenOneLine(c.rationale, 140);
    const id = c.id;

    lines.push(`- ${ruleName} [${status}]`);
    if (rationale) lines.push(`  - ${rationale}`);
    if (typeof id === "string" && id) lines.push(`  - id: ${id}`);
  }

  return lines.join("\n");
}

/** Technical block for operator mode after authorize (mutate commands). */
export function renderGovernanceTechnical(
  decision: "allow" | "deny" | "needs_approval",
  rationale: string,
  auditId: string,
): string {
  const title =
    decision === "allow"
      ? "**Allowed (governance)**"
      : decision === "deny"
        ? "**Denied (governance)**"
        : "**Approval required (governance)**";
  return [
    title,
    "",
    `Decision: ${decision}`,
    `Rationale: ${rationale}`,
    `Authorize audit: ${auditId}`,
  ].join("\n");
}

/** Business-friendly outcome for mutate commands (non-get). */
export function renderMutateBusiness(args: {
  op: string;
  sandboxName: string;
  decision: "allow" | "deny" | "needs_approval";
  rationale: string;
  highRisk: boolean;
  executed: boolean;
  /** Present when decision is needs_approval: authorize-time audit id for `/nemoclaw approval complete`. */
  authorizeAuditId?: string;
}): string {
  const r = shortenOneLine(args.rationale, 220);
  if (args.decision === "deny") {
    return [
      "**Access change blocked**",
      "",
      `Sandbox: ${args.sandboxName}`,
      "",
      "Outcome: not applied.",
      r ? `Why: ${r}` : null,
      "",
      "Next step: review policy with an operator or try again after fixing the request.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (args.decision === "needs_approval") {
    const handle = args.authorizeAuditId?.trim()
      ? `Operator handle (authorize audit): \`${args.authorizeAuditId.trim()}\``
      : null;
    const nextCmd = args.authorizeAuditId?.trim()
      ? `  \`/nemoclaw approval complete ${args.authorizeAuditId.trim()}\``
      : "  `/nemoclaw approval complete <authorize-audit-id>` (use **audit** or **details** on this command to show the id)";
    return [
      "**Approval required**",
      "",
      `Status: Governance needs an operator approval before this change can run.`,
      `Sandbox: ${args.sandboxName}`,
      "",
      "Outcome: not applied yet — waiting for approval.",
      r ? `Why: ${r}` : null,
      "",
      handle,
      "",
      "Next step (operator):",
      nextCmd,
      "",
      "Note: Steward keeps audits **in memory** — if **`uvicorn` restarted** (e.g. **`--reload`** saved a file) or **`STEWARD_URL`** points at a different instance, **`approval complete`** will get **404**. Re-run this policy command on the **same** running Steward, then complete approval **before** restarting Steward.",
      "",
      "Records: after completion, use `/nemoclaw records audit <id>` if you need decision vs execution detail.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  // allow
  if (!args.executed) {
    return [
      "**Allowed**",
      "",
      `Sandbox: ${args.sandboxName}`,
      "",
      "Outcome: authorized, but execution did not complete (unexpected).",
      r ? `Note: ${r}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const verb =
    args.op === "approve" || args.op === "approve_all" || args.op === "approve-all"
      ? "Approval applied."
      : args.op === "reject"
        ? "Rejection recorded."
        : args.op === "edit"
          ? "Draft rule updated."
          : args.op === "clear"
            ? "Draft policy cleared."
            : "Change applied.";

  const lines = [
    "**Access change completed**",
    "",
    `Sandbox: ${args.sandboxName}`,
    "",
    `Outcome: ${verb}`,
    r ? `Note: ${r}` : null,
  ];
  if (args.highRisk) {
    lines.push(
      "",
      "**High-impact change:** this action can broadly affect network access. Confirm with your team if that was intended.",
    );
  }
  lines.push("", "Next step: run `/nemoclaw policy get <sandbox>` to review the draft.");
  return lines.filter(Boolean).join("\n");
}

export function renderMutateExecutionTechnical(
  exec: StewardExecuteResponse,
  showAudit: boolean,
): string {
  const body = JSON.stringify(exec.result, null, 2);
  if (!showAudit) {
    return ["**Runtime result**", "", body].join("\n");
  }
  return ["**Runtime result**", "", `Execute audit: ${exec.audit_id}`, "", body].join("\n");
}

export function policyOpHighRisk(op: string): boolean {
  return op === "approve_all" || op === "approve-all" || op === "clear";
}
