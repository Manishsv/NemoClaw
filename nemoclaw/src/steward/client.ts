// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import JSON5 from "json5";
import fs from "node:fs";

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

function stewardBaseUrl(): string {
  const env = (process.env.STEWARD_URL || "").trim();
  if (env) return env.replace(/\/+$/, "");

  // OpenClaw may sanitize env vars for extensions. Default to the host bridge
  // when running inside the OpenShell sandbox environment.
  const looksLikeOpenShellSandbox =
    process.platform === "linux" &&
    (fs.existsSync("/sandbox/.openclaw-data") || fs.existsSync("/sandbox/.openclaw"));
  const fallback = looksLikeOpenShellSandbox
    ? "http://host.openshell.internal:8000"
    : "http://127.0.0.1:8000";
  return fallback.replace(/\/+$/, "");
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

async function postJson(path: string, body: unknown): Promise<unknown> {
  const url = `${stewardBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = new Error(
      `Steward is unreachable (${url}). Governed policy actions are blocked until it is available.`,
    ) as StewardError;
    err.cause = e;
    throw err;
  }

  const text = await res.text();
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
