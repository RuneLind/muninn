// Barrel for the benchmark runner. Concrete code lives in sibling modules
// (cell.ts, shakeout.ts, multi-pass.ts, scratch-bot.ts, audit.ts,
// prompt-variants.ts). Callers import from here so the public surface is
// stable across the codebase.

export {
  disallowedToolsForConnector,
  buildBenchmarkSpawnArgs,
  findLeakedSpans,
  auditCellForLeaks,
  failCellWithError,
} from "./audit.ts";

export {
  type McpStack,
  stackUsesSerena,
  stackUsesYggdrasil,
  findBot,
  applyTreatmentOverlay,
  buildBenchmarkSerenaInstanceName,
  prepareScratchBotDir,
} from "./scratch-bot.ts";

export {
  buildDefaultMessage,
  loadPromptVariant,
  promptVariantPath,
  defaultJudgePromptPath,
} from "./prompt-variants.ts";

export {
  type RunCellOptions,
  type RunCellResult,
  type SingleRunResult,
  defaultBudget,
  runCell,
} from "./cell.ts";

export {
  type RunShakeoutOptions,
  type RunShakeoutResult,
  runShakeout,
} from "./shakeout.ts";

export {
  type MultiPassSpec,
  type RunCellMultiPassOptions,
  type RunCellMultiPassResult,
  runCellMultiPass,
} from "./multi-pass.ts";
