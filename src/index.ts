/**
 * The public surface.
 *
 * A handful of names do the work: `runner` to define one, `choice` / `score` /
 * `noul` to ask, and `validate` / `toGraph` / `execute` / `resume` /
 * `calibrate` / `supervise` to prove, emit, run or keep it alive. Everything
 * else exported here is a type, or a seam someone will eventually need — `jev`
 * to configure the decider, `Decider` to replace it.
 */
export { runner, isRunner } from "./runner.ts";
export type { Runner } from "./runner.ts";

export {
  choice,
  score,
  noul,
  valueOf,
  confidenceOf,
  optionsOf,
  CHOICE_MAX_OPTIONS,
  SCORE_MIN_LEVELS,
  SCORE_MAX_LEVELS,
} from "./questions.ts";
export type {
  Answer,
  AnswerFor,
  AnswersFor,
  ChoiceAnswer,
  ChoiceQuestion,
  Description,
  Instructions,
  NoulAnswer,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
} from "./questions.ts";

export { jev, jevConfigFor, JevError, DEFAULT_BASE_URL, DEFAULT_MODEL, USD_PER_INPUT_TOKEN } from "./jev.ts";
export type { DecideOptions, Decider, Decision, JevConfig } from "./jev.ts";

export { catalog, forgetCatalog, modelOptions, openrouter, OpenRouterError, shortlist, OPENROUTER_URL, REASONING_EFFORTS } from "./openrouter.ts";
export type { Caller, CallerConfig, ModelCard, ModelFilter, ModelReply, ModelRequest, ReasoningEffort } from "./openrouter.ts";

export { execute, resume, DeciderAnswerError, HumanAnswerError, ResumeError, RunFailed, RunnerError, RUN_SCHEMA } from "./execute.ts";
export type {
  Human,
  HumanAnswer,
  HumanRequest,
  Paused,
  Pending,
  RunDoc,
  RunEvent,
  RunOptions,
  RunOutcome,
  RunStatus,
  RunStep,
  StepAnswer,
} from "./execute.ts";

export { calibrate, CalibrationError } from "./calibrate.ts";
export type { Calibration, CalibrateOptions, Case, CaseSet, GatePrice, Miss, QuestionReport } from "./calibrate.ts";

export { supervise, vitalsOf, recentText } from "./supervise.ts";
export type {
  Interrupted,
  Stimulus,
  SuperviseEvent,
  SuperviseOptions,
  SuperviseOutcome,
  SuperviseStatus,
  TickSummary,
  Verdict,
  Vitals,
} from "./supervise.ts";

export { toGraph, GRAPH_SCHEMA } from "./graph.ts";
export type { GraphDoc, GraphEdge, GraphNode, GraphQuestion } from "./graph.ts";

export { validate, warnings } from "./validate.ts";

export { findSkill, loadSkills, parseSkill, renderSkills, skillOptions, validateSkill } from "./skills.ts";
export type { Skill, SkillOptionsConfig, SkillScope, SkillSources } from "./skills.ts";

export {
  describeServer,
  DiscoveryError,
  isRunnable,
  missingEnv,
  preflight,
  requirements,
  searchAgents,
  searchServers,
  searchSkills,
  toAgentSpec,
  toServerSpec,
  ACP_REGISTRY_URL,
  MCP_REGISTRY_URL,
} from "./registry.ts";
export type { DiscoveryConfig, EnvVarSpec, Preflight, RegistryAgent, RegistryPackage, RegistryServer, SkillListing } from "./registry.ts";

export { connect, isRemote, McpError, pool, toolOptions } from "./mcp.ts";
export type { ConnectOptions, McpResult, McpServerSpec, McpSession, McpTool, RemoteServerSpec, StdioServerSpec } from "./mcp.ts";
export { envSecrets, fileTokenStore, login, loginStatus, logout } from "./mcp-auth.ts";
export type { McpAuth, McpAuthContext, OAuthConfig, SecretResolver, StoredLogin, TokenEndpointAuth, TokenStore } from "./mcp-auth.ts";

export { AgentError, delegate, describeAgent, promptFromReads, ACP_TOOL_KINDS, AGENT_PROTOCOLS } from "./agent.ts";
export type {
  A2aAgentSpec,
  AcpAgentSpec,
  AcpPermissions,
  AgentArtifact,
  AgentPermission,
  AgentReply,
  AgentRequest,
  AgentSpec,
  AgentToolCall,
  Delegate,
  McpAgentSpec,
} from "./agent.ts";
export { agentCard, chooseInterface, readCard, sendA2a, taskState, A2A_VERSION } from "./a2a.ts";
export type { AgentCard, AgentInterface } from "./a2a.ts";
export { clientCapabilities, decidePermission, forwardServer, promptAcp, ACP_VERSION } from "./acp.ts";

export { reporter, summarise, money } from "./report.ts";
export type { ReporterOptions } from "./report.ts";

export { branchHolds, imageKeys, isAgent, isHuman, isMcp, isModel, parseBranch, probeReads, producers, readsOf, writesOf } from "./spec.ts";
export type {
  AgentNode,
  Branch,
  CodeNode,
  DecideNode,
  Edge,
  Handler,
  HandlerContext,
  McpNode,
  ModelNode,
  NodeSpec,
  RunnerSpec,
  State,
  WorkNode,
} from "./spec.ts";

export { liveRuns, recordRun, stopRun, tracked } from "./live.ts";
export type { LiveRun, TrackedRunner, TrackOptions } from "./live.ts";
