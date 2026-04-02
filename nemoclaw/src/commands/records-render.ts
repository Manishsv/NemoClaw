// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shortenOneLine } from "./policy-render.js";

function str(o: unknown, key: string): string {
  if (o === null || typeof o !== "object") return "";
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function boolish(o: unknown, key: string): string {
  if (o === null || typeof o !== "object") return "";
  const v = (o as Record<string, unknown>)[key];
  if (typeof v === "boolean") return v ? "yes" : "no";
  return "";
}

/** Compact operator view of GET /audit/{id}. */
export function renderAuditRecord(audit: unknown): string {
  if (audit === null || typeof audit !== "object") {
    return "Invalid audit payload.";
  }
  const a = audit as Record<string, unknown>;
  const id = str(a, "id");
  const kind = str(a, "kind");
  const decision = str(a, "decision");
  const rationale = shortenOneLine(str(a, "rationale"), 200);
  const gp = str(a, "governance_proposal_id");
  const dr = str(a, "decision_record_id");
  const er = str(a, "execution_record_id");
  const hints = a.operator_hints;
  const hintLines: string[] = [];
  if (hints !== null && typeof hints === "object" && !Array.isArray(hints)) {
    for (const [k, v] of Object.entries(hints as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) hintLines.push(`- ${k}: ${v}`);
    }
  }
  const proposal = a.proposal;
  let action = "";
  let purpose = "";
  if (proposal !== null && typeof proposal === "object") {
    const p = proposal as Record<string, unknown>;
    action = typeof p.action === "string" ? p.action : "";
    purpose = shortenOneLine(typeof p.purpose === "string" ? p.purpose : "", 120);
  }
  return [
    "**Steward audit**",
    "",
    id ? `Id: \`${id}\`` : null,
    kind ? `Kind: ${kind}` : null,
    decision ? `Governance decision: ${decision}` : null,
    rationale ? `Rationale: ${rationale}` : null,
    action ? `Action: \`${action}\`` : null,
    purpose ? `Purpose: ${purpose}` : null,
    "",
    "**Linked records**",
    gp ? `- Governance proposal: \`${gp}\`` : "- Governance proposal: (none)",
    dr ? `- Decision record: \`${dr}\`` : "- Decision record: (none)",
    er ? `- Execution record: \`${er}\`` : "- Execution record: (none)",
    hintLines.length ? ["", "**Operator hints**", ...hintLines].join("\n") : null,
    "",
    "Inspect: `/nemoclaw records decision <id>` · `/nemoclaw records execution <id>`",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderDecisionRecord(rec: unknown): string {
  if (rec === null || typeof rec !== "object") {
    return "Invalid decision record payload.";
  }
  const r = rec as Record<string, unknown>;
  const id = str(r, "id");
  const decision = str(r, "decision");
  const rationale = shortenOneLine(str(r, "rationale"), 240);
  return [
    "**Decision record** (governance outcome only)",
    "",
    id ? `Id: \`${id}\`` : null,
    decision ? `Decision: ${decision}` : null,
    rationale ? `Rationale: ${rationale}` : null,
    str(r, "governance_proposal_id")
      ? `Governance proposal: \`${str(r, "governance_proposal_id")}\``
      : null,
    str(r, "content_proposal_id")
      ? `Content proposal id: \`${str(r, "content_proposal_id")}\``
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderExecutionRecord(rec: unknown): string {
  if (rec === null || typeof rec !== "object") {
    return "Invalid execution record payload.";
  }
  const r = rec as Record<string, unknown>;
  const id = str(r, "id");
  const ok = boolish(r, "ok");
  const govAllow = boolish(r, "governance_decision_was_allow");
  let msgRaw = "";
  if (typeof r.result === "object" && r.result !== null) {
    const m = (r.result as Record<string, unknown>).message;
    if (typeof m === "string") msgRaw = m;
    else if (typeof m === "number" || typeof m === "boolean" || typeof m === "bigint")
      msgRaw = String(m);
  }
  const msg = shortenOneLine(msgRaw, 160);
  return [
    "**Execution record** (runtime result)",
    "",
    id ? `Id: \`${id}\`` : null,
    ok ? `Runtime ok: ${ok}` : null,
    govAllow ? `Governance had allowed execute: ${govAllow}` : null,
    str(r, "decision_record_id") ? `Decision record: \`${str(r, "decision_record_id")}\`` : null,
    str(r, "governance_proposal_id")
      ? `Governance proposal: \`${str(r, "governance_proposal_id")}\``
      : null,
    msg ? `Runtime message: ${msg}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
