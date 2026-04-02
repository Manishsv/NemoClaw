// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import JSON5 from "json5";
import fs from "node:fs";
import path from "node:path";

export type StewardDecision = "allow" | "deny" | "needs_approval";

export interface ActionProposal {
  action: string;
  purpose: string;
  role?: string;
  context?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
}

export interface StewardAuthorizeResponse {
  decision: StewardDecision;
  rationale: string;
  audit_id: string;
}

export interface StewardExecuteResponse {
  audit_id: string;
  status: "executed";
  result: Record<string, unknown>;
}

/** Returned after operator approval chain: same proposal resumed via resume context. */
export type StewardApprovalCompleteResponse = StewardExecuteResponse & {
  governance_proposal_id: string;
  approval_request_id: string;
  resumed_action: string;
  resumed_purpose: string;
  resumed_parameters: Record<string, unknown>;
};

export interface StewardCandidate {
  id: string;
  label: string;
  type?: "diagnostic" | "remediation" | "administrative";
  proposal: ActionProposal;
}

export interface StewardCandidateEvaluation {
  id: string;
  label: string;
  decision: StewardDecision;
  rationale: string;
  audit_id: string;
  risk_tier: string;
}

export interface StewardEvaluateCandidatesResponse {
  evaluations: StewardCandidateEvaluation[];
  selection?: {
    selected_id?: string | null;
    selected_label?: string | null;
    decision?: StewardDecision | null;
    rationale: string;
    rule: string;
  };
}

export interface StewardError extends Error {
  status?: number;
  body?: unknown;
}

export function isStewardError(e: unknown): e is StewardError {
  return e instanceof Error && ("status" in e || "body" in e);
}

/** FastAPI 403 from `/action/execute` when runtime failed but governance allowed. */
export function parseStewardExecute403Detail(body: unknown): {
  audit_id?: string;
  decision?: string;
  rationale?: string;
  user_hint?: string;
  decision_record_id?: string;
  execution_record_id?: string;
  result?: Record<string, unknown>;
} | null {
  if (body === null || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const detail = root.detail;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return null;
  const d = detail as Record<string, unknown>;
  const result = d.result;
  return {
    audit_id: typeof d.audit_id === "string" ? d.audit_id : undefined,
    decision: typeof d.decision === "string" ? d.decision : undefined,
    rationale: typeof d.rationale === "string" ? d.rationale : undefined,
    user_hint: typeof d.user_hint === "string" ? d.user_hint : undefined,
    decision_record_id: typeof d.decision_record_id === "string" ? d.decision_record_id : undefined,
    execution_record_id:
      typeof d.execution_record_id === "string" ? d.execution_record_id : undefined,
    result:
      result !== null && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : undefined,
  };
}

function formatStewardBody(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  if (typeof body === "number" || typeof body === "boolean" || typeof body === "bigint")
    return String(body);
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return "(unprintable body)";
  }
}

/** Set from NemoClaw `openclaw.plugin.json` / host pluginConfig when `STEWARD_URL` is not visible to this process. */
let pluginStewardBaseUrl: string | null = null;

export function setPluginStewardBaseUrl(url: string | undefined | null): void {
  const t = (url ?? "").trim().replace(/\/+$/, "");
  pluginStewardBaseUrl = t || null;
}

/**
 * Writable override when openclaw.json is root-owned: first line must be an http(s) origin.
 * Checked paths (in order): STEWARD_URL_FILE, $OPENCLAW_STATE_DIR/steward-url,
 * /sandbox/.openclaw-data/steward-url, /sandbox/.openclaw/steward-url
 */
function readStewardUrlFromFile(): string | null {
  const candidates: string[] = [];
  const explicit = (process.env.STEWARD_URL_FILE || "").trim();
  if (explicit) candidates.push(explicit);
  const stateDir = (process.env.OPENCLAW_STATE_DIR || "").trim();
  if (stateDir) {
    candidates.push(path.join(stateDir.replace(/\/+$/, ""), "steward-url"));
  }
  candidates.push("/sandbox/.openclaw-data/steward-url");
  candidates.push("/sandbox/.openclaw/steward-url");

  for (const p of candidates) {
    if (!p) continue;
    try {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
      const line = fs.readFileSync(p, "utf8").split(/\r?\n/u)[0]?.trim() ?? "";
      if (/^https?:\/\//iu.test(line)) return line.replace(/\/+$/, "");
    } catch {
      /* unreadable or race */
    }
  }
  return null;
}

function stewardBaseUrl(): string {
  const env = (process.env.STEWARD_URL || "").trim();
  if (env) return env.replace(/\/+$/, "");
  if (pluginStewardBaseUrl) return pluginStewardBaseUrl;
  const fromFile = readStewardUrlFromFile();
  if (fromFile) return fromFile;

  // OpenClaw may sanitize env vars for extensions. Default to the host bridge when
  // running inside the OpenShell sandbox. Use **8010** (not 8000): host port 8000 is
  // often Kong, vLLM, or other services; Steward is typically run on 8010+ instead.
  const looksLikeOpenShellSandbox =
    process.platform === "linux" &&
    (fs.existsSync("/sandbox/.openclaw-data") || fs.existsSync("/sandbox/.openclaw"));
  const fallback = looksLikeOpenShellSandbox
    ? "http://host.openshell.internal:8010"
    : "http://127.0.0.1:8010";
  return fallback.replace(/\/+$/, "");
}

/** Resolved Steward HTTP origin (for operator diagnostics in TUI). */
export function stewardResolvedBaseUrl(): string {
  return stewardBaseUrl();
}

const FETCH_RETRY_DELAYS_MS = [0, 150, 400];

function formatNetworkFailureMessage(
  url: string,
  cause: unknown,
  opts: { governanceContext?: boolean },
): string {
  let underlying = "";
  if (cause instanceof Error && cause.message) {
    underlying = ` Underlying error: ${cause.message}`;
  } else if (cause instanceof Error) {
    underlying = ` Underlying error: ${String(cause)}`;
  }
  const gov =
    opts.governanceContext === true
      ? " Governed policy actions are blocked until it is available."
      : "";
  const hint =
    " If an earlier step just succeeded, retry once — rapid sandbox→host calls sometimes fail transiently.";
  return `Steward is unreachable (${url}).${underlying}${gov}${hint}`;
}

/**
 * Fetch with small backoff retries (same URL). Helps transient ECONNRESET / DNS flakes
 * on host.openshell.internal when chaining audit → approval-requests → decision → execute.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  msgOpts: { governanceContext?: boolean } = {},
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < FETCH_RETRY_DELAYS_MS.length; i++) {
    const delay = FETCH_RETRY_DELAYS_MS[i];
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error(formatNetworkFailureMessage(url, lastErr, msgOpts)) as StewardError;
  err.cause = lastErr;
  throw err;
}

function parseAuthorizeResponse(data: unknown): StewardAuthorizeResponse {
  if (data === null || typeof data !== "object") {
    throw new Error(
      "Steward returned an incomplete response (authorize). Try again or check Steward logs.",
    );
  }
  const o = data as Record<string, unknown>;
  const decision = o.decision;
  if (decision !== "allow" && decision !== "deny" && decision !== "needs_approval") {
    throw new Error(
      "Steward authorize response was missing a valid decision. The service may need an update.",
    );
  }
  const rationale = typeof o.rationale === "string" ? o.rationale : "";
  const audit_id = typeof o.audit_id === "string" ? o.audit_id : "";
  if (!audit_id) {
    throw new Error(
      "Steward authorize response was missing an audit reference. Cannot correlate this request.",
    );
  }
  return {
    decision,
    rationale: rationale || "(no rationale provided)",
    audit_id,
  };
}

function parseExecuteResponse(data: unknown): StewardExecuteResponse {
  if (data === null || typeof data !== "object") {
    throw new Error(
      "Steward returned an incomplete response (execute). The change may not have been applied.",
    );
  }
  const o = data as Record<string, unknown>;
  const audit_id = typeof o.audit_id === "string" ? o.audit_id : "";
  if (!audit_id) {
    throw new Error("Steward execute response was missing an audit reference.");
  }
  if (o.status !== "executed") {
    throw new Error(
      "Steward execute response had an unexpected status. Try details mode or check Steward.",
    );
  }
  const result = o.result;
  if (result === null || typeof result !== "object") {
    throw new Error("Steward execute response was missing a result payload.");
  }
  return {
    audit_id,
    status: "executed",
    result: result as Record<string, unknown>,
  };
}

async function getJson(path: string): Promise<unknown> {
  const url = `${stewardBaseUrl()}${path}`;
  const res = await fetchWithRetry(url, { method: "GET" });
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    const err = new Error(
      formatNetworkFailureMessage(url, e, {}) + " Response body could not be read.",
    ) as StewardError;
    err.cause = e;
    throw err;
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON5.parse(text) : null;
  } catch {
    throw new Error(`Steward returned non-JSON (${String(res.status)}).`);
  }
  if (!res.ok) {
    const err = new Error(`Steward request failed (${String(res.status)})`) as StewardError;
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const url = `${stewardBaseUrl()}${path}`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    { governanceContext: true },
  );

  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    const err = new Error(
      formatNetworkFailureMessage(url, e, { governanceContext: true }) +
        " Response body could not be read.",
    ) as StewardError;
    err.cause = e;
    throw err;
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON5.parse(text) : null;
  } catch {
    throw new Error(
      `Steward returned non-JSON (${String(res.status)}). The governance service may be misconfigured.`,
    );
  }
  if (!res.ok) {
    const suffix = parsed ? `\n\n${formatStewardBody(parsed)}` : "";
    const err = new Error(
      `Steward request failed (${String(res.status)})${suffix}`,
    ) as StewardError;
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export async function stewardAuthorize(
  proposal: ActionProposal,
): Promise<StewardAuthorizeResponse> {
  const raw = await postJson("/action/authorize", { proposal });
  return parseAuthorizeResponse(raw);
}

/** Fetch a Steward audit record (includes governance_proposal_id in payload when present). */
export async function stewardGetAudit(auditId: string): Promise<unknown> {
  return getJson(`/audit/${encodeURIComponent(auditId)}`);
}

/**
 * Read storage id for GET /proposals/{id} / approval-requests from a Steward audit JSON body.
 * Prefers top-level `governance_proposal_id`, then `payload.audit.governance_proposal_id`.
 */
export function parseGovernanceProposalIdFromAudit(audit: unknown): string | null {
  if (audit === null || typeof audit !== "object") return null;
  const o = audit as Record<string, unknown>;
  const top = o.governance_proposal_id;
  if (typeof top === "string" && top.trim()) return top.trim();
  const payload = o.payload;
  if (payload !== null && typeof payload === "object") {
    const pl = payload as Record<string, unknown>;
    const inner = pl.audit;
    if (inner !== null && typeof inner === "object") {
      const g = (inner as Record<string, unknown>).governance_proposal_id;
      if (typeof g === "string" && g.trim()) return g.trim();
    }
  }
  return null;
}

/** First-class Steward v2: create or evaluate a persisted governance proposal. */
export async function stewardPostGovernanceProposal(body: {
  proposal: ActionProposal;
  submit?: boolean;
  evaluate?: boolean;
}): Promise<unknown> {
  return postJson("/proposals", body);
}

/** First-class Steward v2: fetch governance proposal row by storage id. */
export async function stewardGetGovernanceProposal(proposalId: string): Promise<unknown> {
  return getJson(`/proposals/${encodeURIComponent(proposalId)}`);
}

/** Rebuild ActionProposal from GET /audit/{id} body (authorize/simulate/execute audits). */
export function parseActionProposalFromAudit(audit: unknown): ActionProposal | null {
  if (audit === null || typeof audit !== "object") return null;
  const o = audit as Record<string, unknown>;
  const p = o.proposal;
  if (p === null || typeof p !== "object") return null;
  const pr = p as Record<string, unknown>;
  const action = pr.action;
  const purpose = pr.purpose;
  if (typeof action !== "string" || typeof purpose !== "string") return null;
  const ctx = pr.context;
  const params = pr.parameters;
  return {
    action,
    purpose,
    role: typeof pr.role === "string" ? pr.role : undefined,
    context:
      ctx !== null && typeof ctx === "object" && !Array.isArray(ctx)
        ? { ...(ctx as Record<string, unknown>) }
        : {},
    parameters:
      params !== null && typeof params === "object" && !Array.isArray(params)
        ? { ...(params as Record<string, unknown>) }
        : {},
  };
}

async function stewardRunApprovalChainAfterAudit(
  base: ActionProposal,
  audit: unknown,
  decidedBy?: string,
): Promise<StewardApprovalCompleteResponse> {
  const gp = parseGovernanceProposalIdFromAudit(audit);
  if (!gp) {
    throw new Error(
      "Audit is missing governance_proposal_id; cannot continue the approval workflow.",
    );
  }
  const ar = await stewardCreateApprovalRequest(gp);
  await stewardPostApprovalDecision(ar.id, "approved", decidedBy);
  const exec = await stewardExecuteWithGovernanceResume(base, {
    governanceProposalId: gp,
    approvalRequestId: ar.id,
  });
  return {
    ...exec,
    governance_proposal_id: gp,
    approval_request_id: ar.id,
    resumed_action: base.action,
    resumed_purpose: base.purpose,
    resumed_parameters: base.parameters ?? {},
  };
}

/**
 * Operator/tooling helper: after authorize returned needs_approval, run approval-request → approve → resumed execute.
 * Still uses `/action/execute` for compatibility; underneath Steward uses proposal + approval objects.
 */
export async function stewardCompleteApprovalAndExecute(
  base: ActionProposal,
  authAuditId: string,
  decidedBy?: string,
): Promise<StewardApprovalCompleteResponse> {
  const audit = await stewardGetAudit(authAuditId);
  return stewardRunApprovalChainAfterAudit(base, audit, decidedBy);
}

/**
 * Operator TUI/CLI: one Steward authorize `audit_id` → full approval → resumed execute (proposal read from audit).
 */
export async function stewardCompleteApprovalFromAuthorizeAuditId(
  authorizeAuditId: string,
  decidedBy?: string,
): Promise<StewardApprovalCompleteResponse> {
  const audit = await stewardGetAudit(authorizeAuditId);
  const base = parseActionProposalFromAudit(audit);
  if (!base) {
    throw new Error(
      "Authorize audit is missing proposal fields (action, purpose); cannot replay execution.",
    );
  }
  return stewardRunApprovalChainAfterAudit(base, audit, decidedBy);
}

export async function stewardGetDecisionRecord(recordId: string): Promise<unknown> {
  return getJson(`/decision-records/${encodeURIComponent(recordId)}`);
}

export async function stewardGetExecutionRecord(recordId: string): Promise<unknown> {
  return getJson(`/execution-records/${encodeURIComponent(recordId)}`);
}

export interface StewardApprovalRequest {
  id: string;
  state: string;
  governance_proposal_id: string;
  decision_record_id: string;
}

function parseApprovalRequest(data: unknown): StewardApprovalRequest {
  if (data === null || typeof data !== "object")
    throw new Error("Invalid approval request response.");
  const o = data as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const state = typeof o.state === "string" ? o.state : "";
  const governance_proposal_id =
    typeof o.governance_proposal_id === "string" ? o.governance_proposal_id : "";
  const decision_record_id = typeof o.decision_record_id === "string" ? o.decision_record_id : "";
  if (!id || !governance_proposal_id)
    throw new Error("Approval request missing id or governance_proposal_id.");
  return { id, state, governance_proposal_id, decision_record_id };
}

export async function stewardCreateApprovalRequest(
  governanceProposalId: string,
): Promise<StewardApprovalRequest> {
  const raw = await postJson("/approval-requests", {
    governance_proposal_id: governanceProposalId,
  });
  return parseApprovalRequest(raw);
}

export async function stewardPostApprovalDecision(
  approvalRequestId: string,
  decision: "approved" | "rejected",
  decidedBy?: string,
): Promise<StewardApprovalRequest> {
  const raw = await postJson(
    `/approval-requests/${encodeURIComponent(approvalRequestId)}/decision`,
    {
      decision,
      decided_by: decidedBy,
    },
  );
  return parseApprovalRequest(raw);
}

/**
 * Retry execute after an approved ApprovalRequest. Uses Steward v2 context keys;
 * proposal_id hashing ignores these keys so resume matches the original proposal.
 */
export async function stewardExecuteWithGovernanceResume(
  base: ActionProposal,
  resume: { governanceProposalId: string; approvalRequestId: string },
): Promise<StewardExecuteResponse> {
  const proposal: ActionProposal = {
    ...base,
    context: {
      ...(base.context ?? {}),
      steward_resume_proposal_id: resume.governanceProposalId,
      approval_request_id: resume.approvalRequestId,
    },
  };
  return stewardExecute(proposal);
}

export async function stewardExecute(proposal: ActionProposal): Promise<StewardExecuteResponse> {
  const raw = await postJson("/action/execute", { proposal });
  return parseExecuteResponse(raw);
}

export async function stewardEvaluateCandidates(
  candidates: StewardCandidate[],
): Promise<StewardEvaluateCandidatesResponse> {
  const raw = await postJson("/action/evaluate", { candidates });
  if (raw === null || typeof raw !== "object") {
    throw new Error("Steward returned an incomplete response (evaluate).");
  }
  const o = raw as Record<string, unknown>;
  const evals = o.evaluations;
  if (!Array.isArray(evals)) {
    throw new Error("Steward evaluate response was missing evaluations[].");
  }
  const selection = o.selection as StewardEvaluateCandidatesResponse["selection"];
  return { evaluations: evals as StewardCandidateEvaluation[], selection };
}
