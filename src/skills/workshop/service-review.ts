import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import { prepareWorkspaceSkillMutation } from "../lifecycle/workspace-skill-write.js";
import { resolveAllowedSkillSymlinkTargetRealPaths } from "../loading/symlink-targets.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { readRequiredProposal } from "./service-query.js";
import { hashSkillProposalContent, SkillProposalIntegrityError } from "./store.js";
import type {
  SkillProposalReadResult,
  SkillProposalReviewResult,
  SkillProposalSupportFile,
} from "./types.js";

const MAX_SKILL_PROPOSAL_REVIEW_DIFF_BYTES = 512 * 1024;
const MAX_SKILL_PROPOSAL_REVIEW_EDIT_LENGTH = 20_000;
const MAX_SKILL_PROPOSAL_REVIEW_DIFF_MS = 250;

type SkillProposalReviewDiffFile = {
  oldFileName: string;
  newFileName: string;
  oldContent: string;
  newContent: string;
};

/** Returns the exact skill content for creates or a bounded live-target diff for updates. */
export async function reviewSkillProposal(input: {
  workspaceDir: string;
  agentId?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  proposalId: string;
}): Promise<SkillProposalReviewResult> {
  let read: SkillProposalReadResult;
  try {
    read = await readRequiredProposal(
      input.proposalId,
      input.workspaceDir,
      input.env,
      input.agentId,
    );
  } catch (error) {
    if (error instanceof SkillProposalIntegrityError) {
      return {
        record: error.record,
        revisionHash: error.revisionHash,
        mode: "unavailable",
        reason: "proposal-changed",
      };
    }
    throw error;
  }
  const { record, revisionHash, content } = read;
  if (hashSkillProposalContent(content) !== record.draftHash) {
    return { record, revisionHash, mode: "unavailable", reason: "proposal-changed" };
  }

  const supportFiles = read.supportFiles ?? [];
  const proposedContent = stripProposalFrontmatterForSkill(content);
  let mutation: Awaited<ReturnType<typeof prepareWorkspaceSkillMutation>>;
  try {
    mutation = await prepareWorkspaceSkillMutation({
      workspaceDir: input.workspaceDir,
      skillDir: record.target.skillDir,
      skillFile: record.target.skillFile,
      content: proposedContent,
      supportFiles,
      mode: record.kind,
      symlinkPolicy: resolveSkillWorkshopSymlinkPolicy(input.config),
    });
  } catch (error) {
    const reason = classifyReviewTargetError(record.kind, error);
    if (reason) {
      return { record, revisionHash, mode: "unavailable", reason };
    }
    throw error;
  }

  if (record.kind === "create") {
    return {
      record,
      revisionHash,
      mode: "full",
      content: proposedContent,
      supportFiles: supportFiles.map((file) => ({ path: file.path, content: file.content })),
    };
  }

  const currentContent = mutation.skillFile.previousContent;
  if (currentContent === null) {
    return { record, revisionHash, mode: "unavailable", reason: "target-missing" };
  }
  if (
    record.target.currentContentHash &&
    hashSkillProposalContent(currentContent) !== record.target.currentContentHash
  ) {
    return { record, revisionHash, mode: "unavailable", reason: "target-changed" };
  }

  const diffFiles: SkillProposalReviewDiffFile[] = [
    {
      oldFileName: "SKILL.md",
      newFileName: "SKILL.md",
      oldContent: currentContent,
      newContent: proposedContent,
    },
  ];
  for (const file of mutation.supportFiles) {
    const supportRecord = record.supportFiles?.find((entry) => entry.path === file.path);
    if (supportRecord && hasSupportTargetChanged(supportRecord, file.previousContent)) {
      return { record, revisionHash, mode: "unavailable", reason: "target-changed" };
    }
    diffFiles.push({
      oldFileName: file.previousContent === null ? "/dev/null" : file.path,
      newFileName: file.path,
      oldContent: file.previousContent ?? "",
      newContent: file.content,
    });
  }
  const diff = createReviewDiff(diffFiles);
  return diff === undefined
    ? { record, revisionHash, mode: "unavailable", reason: "diff-limit" }
    : { record, revisionHash, mode: "diff", diff };
}

function resolveSkillWorkshopSymlinkPolicy(config?: OpenClawConfig) {
  const workshopConfig = resolveSkillWorkshopConfig(config);
  return {
    allowWrites: workshopConfig.allowSymlinkTargetWrites,
    allowedTargetRealPaths: workshopConfig.allowSymlinkTargetWrites
      ? resolveAllowedSkillSymlinkTargetRealPaths(config)
      : [],
  };
}

function classifyReviewTargetError(
  kind: "create" | "update",
  error: unknown,
): "target-changed" | "target-missing" | undefined {
  if (error instanceof FsSafeError && error.category === "policy") {
    return error.code === "not-found" && kind === "update" ? "target-missing" : "target-changed";
  }
  if (!(error instanceof Error)) {
    return undefined;
  }
  if (kind === "update" && error.message.startsWith("Target skill is missing:")) {
    return "target-missing";
  }
  if (kind === "create" && error.message.startsWith("Target ")) {
    return "target-changed";
  }
  return undefined;
}

function createReviewDiff(files: readonly SkillProposalReviewDiffFile[]): string | undefined {
  const deadline = Date.now() + MAX_SKILL_PROPOSAL_REVIEW_DIFF_MS;
  const patches: string[] = [];
  let sizeBytes = 0;
  for (const file of files) {
    const timeout = deadline - Date.now();
    if (timeout <= 0) {
      return undefined;
    }
    const patch = createReviewPatch(file, timeout);
    if (patch === undefined) {
      return undefined;
    }
    if (!patch) {
      continue;
    }
    sizeBytes += Buffer.byteLength(patch, "utf8") + (patches.length > 0 ? 1 : 0);
    if (sizeBytes > MAX_SKILL_PROPOSAL_REVIEW_DIFF_BYTES) {
      return undefined;
    }
    patches.push(patch);
  }
  return patches.join("\n");
}

function createReviewPatch(file: SkillProposalReviewDiffFile, timeout: number): string | undefined {
  if (file.oldFileName === file.newFileName && file.oldContent === file.newContent) {
    return "";
  }
  return createTwoFilesPatch(
    file.oldFileName,
    file.newFileName,
    file.oldContent,
    file.newContent,
    undefined,
    undefined,
    {
      context: 4,
      headerOptions: FILE_HEADERS_ONLY,
      maxEditLength: MAX_SKILL_PROPOSAL_REVIEW_EDIT_LENGTH,
      timeout,
    },
  );
}

function hasSupportTargetChanged(
  file: SkillProposalSupportFile,
  currentContent: string | null,
): boolean {
  if (file.targetExisted === false) {
    return currentContent !== null;
  }
  if (file.targetExisted === true) {
    return (
      currentContent === null || hashSkillProposalContent(currentContent) !== file.targetContentHash
    );
  }
  return false;
}
