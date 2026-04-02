// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  renderAuditRecord,
  renderDecisionRecord,
  renderExecutionRecord,
} from "./records-render.js";

describe("commands/records-render", () => {
  it("renders audit record summary with operator hints", () => {
    const out = renderAuditRecord({
      id: "a1",
      kind: "authorize",
      decision: "needs_approval",
      rationale: "Approval requirements not satisfied.",
      governance_proposal_id: "gp1",
      decision_record_id: "dr1",
      execution_record_id: null,
      proposal: { action: "openshell.draft_policy.approve_all", purpose: "p" },
      operator_hints: { nemoclaw_approval_complete: "/nemoclaw approval complete a1" },
    });
    expect(out).toContain("Steward audit");
    expect(out).toContain("a1");
    expect(out).toContain("needs_approval");
    expect(out).toContain("gp1");
    expect(out).toContain("dr1");
    expect(out).toContain("nemoclaw_approval_complete");
  });

  it("handles missing fields gracefully", () => {
    const out = renderAuditRecord({ id: "a2", proposal: { action: "x", purpose: "y" } });
    expect(out).toContain("Steward audit");
    expect(out).toContain("a2");
  });

  it("renders decision record", () => {
    const out = renderDecisionRecord({
      id: "dr1",
      decision: "deny",
      rationale: "no",
      governance_proposal_id: "gp1",
      content_proposal_id: "cp1",
    });
    expect(out).toContain("Decision record");
    expect(out).toContain("dr1");
    expect(out).toContain("deny");
    expect(out).toContain("gp1");
    expect(out).toContain("cp1");
  });

  it("renders execution record and includes message only when scalar", () => {
    const out1 = renderExecutionRecord({
      id: "er1",
      ok: true,
      governance_decision_was_allow: true,
      decision_record_id: "dr1",
      governance_proposal_id: "gp1",
      result: { message: "hi" },
    });
    expect(out1).toContain("Execution record");
    expect(out1).toContain("Runtime message: hi");

    const out2 = renderExecutionRecord({
      id: "er2",
      ok: false,
      governance_decision_was_allow: true,
      decision_record_id: "dr1",
      governance_proposal_id: "gp1",
      result: { message: { nested: true } },
    });
    expect(out2).toContain("Execution record");
    expect(out2).not.toContain("Runtime message:");
  });
});
