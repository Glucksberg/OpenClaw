import { describe, expect, it } from "vitest";
import * as protocol from "./index.js";
import { ProtocolSchemas } from "./schema/protocol-schemas.js";

describe("Skill Workshop review protocol", () => {
  it("registers review schemas", () => {
    expect(ProtocolSchemas.SkillsProposalReviewParams).toBe(
      protocol.SkillsProposalReviewParamsSchema,
    );
    expect(ProtocolSchemas.SkillsProposalReviewResult).toBe(
      protocol.SkillsProposalReviewResultSchema,
    );
  });

  it.each([
    [{ proposalId: "proposal-1" }, true],
    [{ agentId: "main", proposalId: "proposal-1" }, true],
    [{}, false],
    [{ proposalId: "" }, false],
    [{ proposalId: "proposal-1", extra: true }, false],
  ] as const)("validates closed review params %#", (value, expected) => {
    expect(protocol.validateSkillsProposalReviewParams(value)).toBe(expected);
  });
});
