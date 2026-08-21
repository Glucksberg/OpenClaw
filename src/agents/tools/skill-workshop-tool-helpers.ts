import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  inspectSkillProposal,
  reviewSkillProposal,
  resolvePendingSkillProposal,
} from "../../skills/workshop/service.js";
import { PROPOSAL_DRAFT_FILE } from "../../skills/workshop/store-record.js";
import type {
  SkillProposalReadResult,
  SkillProposalRecord,
  SkillProposalStatus,
  SkillProposalSupportFileInput,
  SkillWorkshopProposalReviewCompletion,
} from "../../skills/workshop/types.js";
import { readPositiveIntegerParam, readToolStringParam, ToolInputError } from "./common.js";
import { formatProposalReviewResult } from "./skill-workshop-tool-presentation.js";

export function skillWorkshopAgentEventActor(agentId?: string) {
  return { type: "agent" as const, ...(agentId ? { id: agentId } : {}) };
}

export function proposalReviewPhase(
  completion: SkillWorkshopProposalReviewCompletion,
): "open" | "completing" | "completed" {
  return completion.phase ?? (completion.completed ? "completed" : "open");
}

export function beginProposalReviewMutation(
  completion: SkillWorkshopProposalReviewCompletion | undefined,
): (() => void) | undefined {
  if (!completion) {
    return undefined;
  }
  if (proposalReviewPhase(completion) !== "open") {
    throw new ToolInputError("this Skill Workshop review is already completing or complete");
  }
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const activeMutations = completion.activeMutations ?? new Set<Promise<void>>();
  completion.activeMutations = activeMutations;
  activeMutations.add(done);
  return () => {
    activeMutations.delete(done);
    release();
  };
}

export async function completeProposalReview(completion: SkillWorkshopProposalReviewCompletion) {
  const phase = proposalReviewPhase(completion);
  if (phase === "completed") {
    return completionResult();
  }
  if (phase === "completing") {
    throw new ToolInputError("this Skill Workshop review is already completing");
  }
  completion.phase = "completing";
  try {
    await Promise.all(Array.from(completion.activeMutations ?? []));
    await completion.complete();
    completion.completed = true;
    completion.phase = "completed";
    return completionResult();
  } catch (error) {
    completion.phase = "open";
    throw error;
  }
}

function completionResult() {
  return {
    content: [{ type: "text" as const, text: "Completed Skill Workshop review." }],
    details: { completed: true },
  };
}

export function proposalMutationText(action: string, record: SkillProposalRecord): string {
  return `${action} ${record.id} (${record.status}) for ${record.target.skillKey}.`;
}

export function actionResult(
  record: SkillProposalRecord,
  options: { contentText: string; targetSkillFile?: string },
) {
  return {
    content: [{ type: "text" as const, text: options.contentText }],
    details: {
      id: record.id,
      status: record.status,
      kind: record.kind,
      skillName: record.target.skillName,
      skillKey: record.target.skillKey,
      targetSkillFile: options.targetSkillFile ?? record.target.skillFile,
      scanState: record.scan.state,
      proposedVersion: record.proposedVersion,
      draftHash: record.draftHash,
    },
  };
}

export function proposalResult(
  proposal: SkillProposalReadResult,
  options: {
    contentText?: string;
    inspect?: {
      artifactPath: string;
      artifactSizeBytes: number;
      availableArtifacts: Array<{ path: string; sizeBytes: number }>;
      contentIncluded: boolean;
    };
  } = {},
) {
  return {
    content: options.contentText ? [{ type: "text" as const, text: options.contentText }] : [],
    details: {
      id: proposal.record.id,
      status: proposal.record.status,
      kind: proposal.record.kind,
      skillName: proposal.record.target.skillName,
      skillKey: proposal.record.target.skillKey,
      proposalFile: PROPOSAL_DRAFT_FILE,
      supportFileCount: proposal.record.supportFiles?.length ?? 0,
      targetSkillFile: proposal.record.target.skillFile,
      scanState: proposal.record.scan.state,
      proposedVersion: proposal.record.proposedVersion,
      draftHash: proposal.record.draftHash,
      revisionHash: proposal.revisionHash,
      ...(proposal.record.evaluation ? { evaluation: proposal.record.evaluation } : {}),
      ...(options.inspect ? { inspect: options.inspect } : {}),
    },
  };
}

export function readLifecycleProposalIdParam(params: Record<string, unknown>): string {
  return readToolStringParam(params, "proposal_id", {
    required: true,
    label: "proposal_id",
  });
}

export async function readProposalForInspect(
  params: Record<string, unknown>,
  workspaceDir: string,
  env?: NodeJS.ProcessEnv,
  agentId?: string,
): Promise<SkillProposalReadResult> {
  const proposalId = await resolveProposalIdForRead(params, workspaceDir, env, agentId);
  const proposal = await inspectSkillProposal(proposalId, { agentId, workspaceDir, env });
  if (!proposal) {
    throw new ToolInputError(`Skill proposal not found: ${proposalId}`);
  }
  return proposal;
}

async function resolveProposalIdForRead(
  params: Record<string, unknown>,
  workspaceDir: string,
  env?: NodeJS.ProcessEnv,
  agentId?: string,
): Promise<string> {
  const proposalId = readToolStringParam(params, "proposal_id", { label: "proposal_id" });
  if (proposalId) {
    return proposalId;
  }
  const resolved = await resolvePendingSkillProposal({
    name: readToolStringParam(params, "name", { required: true }),
    workspaceDir,
    env,
    agentId,
  });
  return resolved.record.id;
}

function readReviewPageParam(params: Record<string, unknown>): number {
  return readPositiveIntegerParam(params, "page") ?? 1;
}

export async function executeSkillWorkshopReview(
  params: Record<string, unknown>,
  options: {
    workspaceDir: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    agentId?: string;
  },
) {
  const page = readReviewPageParam(params);
  const proposalId = readToolStringParam(params, "proposal_id", { label: "proposal_id" });
  if (page > 1 && !proposalId) {
    throw new ToolInputError("proposal_id required for review pages after page 1");
  }
  const expectedRevisionHash = readToolStringParam(params, "expected_revision_hash");
  if (page > 1 && !expectedRevisionHash) {
    throw new ToolInputError("expected_revision_hash required for review pages after page 1");
  }
  const review = await reviewSkillProposal({
    ...options,
    proposalId:
      proposalId ??
      (await resolveProposalIdForRead(params, options.workspaceDir, options.env, options.agentId)),
  });
  if (expectedRevisionHash && expectedRevisionHash !== review.revisionHash) {
    throw new ToolInputError(
      `Skill proposal changed after review (expected ${expectedRevisionHash}, current ${review.revisionHash}). Restart at page 1.`,
    );
  }
  return formatProposalReviewResult(review, page);
}

export function readProposalStatusParam(
  params: Record<string, unknown>,
  statuses: readonly SkillProposalStatus[],
): SkillProposalStatus | undefined {
  const status = readToolStringParam(params, "status");
  if (!status) {
    return undefined;
  }
  if (!(statuses as readonly string[]).includes(status)) {
    throw new ToolInputError(`status must be one of ${statuses.join(", ")}`);
  }
  return status as SkillProposalStatus;
}

export function readListLimitParam(params: Record<string, unknown>): number {
  return readPositiveIntegerParam(params, "limit") ?? 20;
}

export function readSupportFilesParam(
  params: Record<string, unknown>,
): SkillProposalSupportFileInput[] | undefined {
  const raw = params.support_files;
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new ToolInputError("support_files must be an array");
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ToolInputError(`support_files[${index}] must be an object`);
    }
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || !file.path.trim()) {
      throw new ToolInputError(`support_files[${index}].path required`);
    }
    if (typeof file.content !== "string") {
      throw new ToolInputError(`support_files[${index}].content required`);
    }
    return { path: file.path, content: file.content };
  });
}
