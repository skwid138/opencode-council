/**
 * Council Review Tool Plugin
 *
 * Exposes council_review(prompt), which runs the same review prompt through a
 * configured set of reviewers in parallel, then asks an aggregator to
 * structurally aggregate the results.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tool, type Plugin, type PluginOptions } from "@opencode-ai/plugin";

const COUNCILLOR_TIMEOUT_MS = 180_000;
const COUNCILLOR_RETRY_TIMEOUT_MS = 90_000;
const AGGREGATOR_TIMEOUT_MS = 60_000;
const HARD_CAP_MS = 360_000;

type TimeoutConfig = {
  councillor_ms: number;
  councillor_retry_ms: number;
  aggregator_ms: number;
  hard_cap_ms: number;
};

type ModelConfig = {
  providerID: string;
  modelID: string;
};

type CouncilConfig = {
  reviewer: string;
  aggregator: string;
  models: ModelConfig[];
  aggregator_model: ModelConfig | null;
  timeouts: TimeoutConfig;
};

type PermissionRuleset = Array<{
  permission: string;
  pattern: string;
  action: "allow" | "deny";
}>;

type CouncillorSuccess = {
  model: ModelConfig;
  response: string;
  attempts: number;
};

type CouncillorFailure = {
  model: ModelConfig;
  error: string;
};

const AGGREGATOR_TOOLS = {
  "chrome-devtools": false,
  context7: false,
  exa: false,
  figma: false,
  read: false,
  write: false,
  edit: false,
  bash: false,
  glob: false,
  grep: false,
  list: false,
  task: false,
  question: false,
  todowrite: false,
  webfetch: false,
  websearch: false,
  skill: false,
  compress: false,
  vision: false,
  council_review: false,
};

function extractLatestAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const assistantMessages = messages
    .filter(
      (msg): msg is Record<string, unknown> =>
        typeof msg === "object" && msg !== null,
    )
    .filter((msg) => {
      const info = msg.info as Record<string, unknown> | undefined;
      return info?.role === "assistant";
    })
    .sort((a, b) => {
      const aTime = (a.info as Record<string, unknown>)?.time as
        | Record<string, number>
        | undefined;
      const bTime = (b.info as Record<string, unknown>)?.time as
        | Record<string, number>
        | undefined;
      return (bTime?.created ?? 0) - (aTime?.created ?? 0);
    });

  const lastMessage = assistantMessages[0];
  if (!lastMessage) return null;

  const parts = lastMessage.parts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts)) return null;

  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function isModelConfig(value: unknown): value is ModelConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.providerID === "string" &&
    candidate.providerID.trim().length > 0 &&
    typeof candidate.modelID === "string" &&
    candidate.modelID.trim().length > 0
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catchAllDenyRuleset(): PermissionRuleset {
  return [{ permission: "bash", pattern: "*", action: "deny" }];
}

function buildPermissionRuleset(directory: string | undefined): PermissionRuleset {
  try {
    const configPath = path.join(directory || process.cwd(), "opencode.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    const permission = isPlainObject(config) ? config.permission : undefined;
    const bash = isPlainObject(permission) ? permission.bash : undefined;

    if (!isPlainObject(bash)) return catchAllDenyRuleset();

    const ruleset: PermissionRuleset = Object.entries(bash)
      .filter(
        (entry): entry is [string, "allow" | "deny"] =>
          entry[1] === "allow" || entry[1] === "deny",
      )
      .map(([pattern, action]) => ({ permission: "bash", pattern, action }));

    return [...ruleset, ...catchAllDenyRuleset()];
  } catch {
    return catchAllDenyRuleset();
  }
}

function readTimeoutMs(
  source: Record<string, unknown>,
  key: keyof TimeoutConfig,
  fallback: number,
): number {
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(HARD_CAP_MS, Math.max(1, Math.round(raw)));
}

export function validateCouncilConfig(raw: unknown): CouncilConfig {
  const source = isPlainObject(raw)
    ? isPlainObject(raw.council)
      ? raw.council
      : raw
    : {};

  if (
    typeof source.reviewer !== "string" ||
    source.reviewer.trim().length === 0
  ) {
    throw new Error("council.reviewer is required");
  }

  if (
    typeof source.aggregator !== "string" ||
    source.aggregator.trim().length === 0
  ) {
    throw new Error("council.aggregator is required");
  }

  if (!Array.isArray(source.models)) {
    throw new Error("council.models is required");
  }

  const models = source.models.filter(isModelConfig);
  if (models.length < 2) {
    throw new Error("council.models must include at least 2 valid model entries");
  }

  const aggregatorModel = isModelConfig(source.aggregator_model)
    ? source.aggregator_model
    : null;

  const timeoutSource = isPlainObject(source.timeouts) ? source.timeouts : {};

  return {
    reviewer: source.reviewer,
    aggregator: source.aggregator,
    models,
    aggregator_model: aggregatorModel,
    timeouts: {
      councillor_ms: readTimeoutMs(
        timeoutSource,
        "councillor_ms",
        COUNCILLOR_TIMEOUT_MS,
      ),
      councillor_retry_ms: readTimeoutMs(
        timeoutSource,
        "councillor_retry_ms",
        COUNCILLOR_RETRY_TIMEOUT_MS,
      ),
      aggregator_ms: readTimeoutMs(
        timeoutSource,
        "aggregator_ms",
        AGGREGATOR_TIMEOUT_MS,
      ),
      hard_cap_ms: readTimeoutMs(timeoutSource, "hard_cap_ms", HARD_CAP_MS),
    },
  };
}

function modelLabel(model: ModelConfig): string {
  return `${model.providerID}/${model.modelID}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(`${label} timed out after ${formatSeconds(timeoutMs)}`),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildAggregatorPrompt(input: {
  originalPrompt: string;
  successes: CouncillorSuccess[];
  failures: CouncillorFailure[];
}): string {
  const successfulResponses = input.successes
    .map(
      (success, index) => `## Reviewer ${index + 1}: ${modelLabel(success.model)}

Attempts: ${success.attempts}

${success.response}`,
    )
    .join("\n\n---\n\n");

  const failures =
    input.failures.length > 0
      ? input.failures
          .map(
            (failure) =>
              `- ${modelLabel(failure.model)}: ${failure.error || "failed"}`,
          )
          .join("\n")
      : "- none";

  return `You are aggregating multiple reviewer responses to one review prompt.

Do structural aggregation only. Do not issue your own verdict.

# Original review prompt

${input.originalPrompt}

# Participation summary supplied by council_review

Responded:
${input.successes.map((success) => `- ${modelLabel(success.model)} (${success.attempts} attempt${success.attempts === 1 ? "" : "s"})`).join("\n")}

Failed or timed out:
${failures}

# Reviewer responses

${successfulResponses}`;
}

function formatFailureSummary(failures: CouncillorFailure[]): string {
  if (failures.length === 0) return "none";
  return failures
    .map((failure) => `- ${modelLabel(failure.model)}: ${failure.error}`)
    .join("\n");
}

const CouncilToolPlugin: Plugin = async (ctx, options?: PluginOptions) => {
  const councilConfig = validateCouncilConfig(options);

  async function parentDirectory(sessionID: string): Promise<string> {
    const parentSession = await ctx.client.session
      .get({ path: { id: sessionID } })
      .catch(() => null);
    return parentSession?.data?.directory ?? ctx.directory;
  }

  async function createChildSession(
    parentSessionID: string,
    title: string,
  ): Promise<string> {
    const createResult = await ctx.client.session.create({
      body: {
        parentID: parentSessionID,
        permission: buildPermissionRuleset(ctx.directory),
        title,
      },
      query: { directory: await parentDirectory(parentSessionID) },
    } as Parameters<typeof ctx.client.session.create>[0]) as {
      data?: { id?: string };
      error?: unknown;
    };

    if (createResult.error) {
      throw new Error(`failed to create child session: ${createResult.error}`);
    }

    const sessionID = createResult.data?.id;
    if (!sessionID) {
      throw new Error("failed to create child session: missing session id");
    }

    return sessionID;
  }

  async function promptAndExtract(input: {
    sessionID: string;
    agent: string;
    prompt: string;
    model?: ModelConfig;
    tools?: Record<string, boolean>;
  }): Promise<string> {
    const body: Record<string, unknown> = {
      agent: input.agent,
      parts: [{ type: "text", text: input.prompt }],
    };

    if (input.model) body.model = input.model;
    if (input.tools) body.tools = input.tools;

    const promptResult = await ctx.client.session.prompt({
      path: { id: input.sessionID },
      body,
    } as Parameters<typeof ctx.client.session.prompt>[0]) as { error?: unknown };

    if (promptResult.error) {
      throw new Error(`prompt failed: ${JSON.stringify(promptResult.error)}`);
    }

    const messagesResult = await ctx.client.session.messages({
      path: { id: input.sessionID },
    }) as { data?: unknown; error?: unknown };

    if (messagesResult.error) {
      throw new Error(`failed to get messages: ${messagesResult.error}`);
    }

    const responseText = extractLatestAssistantText(messagesResult.data);
    if (!responseText) {
      throw new Error("empty response");
    }

    return responseText;
  }

  async function runCouncillorAttempt(input: {
    parentSessionID: string;
    prompt: string;
    model: ModelConfig;
    timeoutMs: number;
    attempt: number;
  }): Promise<string> {
    const label = modelLabel(input.model);
    return await raceWithTimeout(
      (async () => {
        let sessionID: string | undefined;
        try {
          sessionID = await createChildSession(
            input.parentSessionID,
            `council: ${label} attempt ${input.attempt}`,
          );

          return await promptAndExtract({
            sessionID,
            agent: councilConfig.reviewer,
            model: input.model,
            prompt: input.prompt,
          });
        } finally {
          // Known limitation: indefinite hangs never reach finally; server-side session TTL is the fallback.
          if (sessionID) {
            await ctx.client.session
              .abort({ path: { id: sessionID } })
              .catch(() => {});
          }
        }
      })(),
      input.timeoutMs,
      `${label} attempt ${input.attempt}`,
    );
  }

  async function runCouncillor(input: {
    parentSessionID: string;
    prompt: string;
    model: ModelConfig;
  }): Promise<CouncillorSuccess> {
    try {
      const response = await runCouncillorAttempt({
        ...input,
        timeoutMs: councilConfig.timeouts.councillor_ms,
        attempt: 1,
      });
      return { model: input.model, response, attempts: 1 };
    } catch (firstError) {
      try {
        const response = await runCouncillorAttempt({
          ...input,
          timeoutMs: councilConfig.timeouts.councillor_retry_ms,
          attempt: 2,
        });
        return { model: input.model, response, attempts: 2 };
      } catch (retryError) {
        throw new Error(
          `first attempt failed: ${errorMessage(firstError)}; retry failed: ${errorMessage(retryError)}`,
        );
      }
    }
  }

  async function synthesizeWithAggregator(input: {
    parentSessionID: string;
    originalPrompt: string;
    successes: CouncillorSuccess[];
    failures: CouncillorFailure[];
  }): Promise<string> {
    return await raceWithTimeout(
      (async () => {
        let sessionID: string | undefined;
        try {
          sessionID = await createChildSession(
            input.parentSessionID,
            "council: aggregator synthesis",
          );

          return await promptAndExtract({
            sessionID,
            agent: councilConfig.aggregator,
            model: councilConfig.aggregator_model ?? undefined,
            tools: AGGREGATOR_TOOLS,
            prompt: buildAggregatorPrompt(input),
          });
        } finally {
          // Known limitation: indefinite hangs never reach finally; server-side session TTL is the fallback.
          if (sessionID) {
            await ctx.client.session
              .abort({ path: { id: sessionID } })
              .catch(() => {});
          }
        }
      })(),
      councilConfig.timeouts.aggregator_ms,
      "aggregator synthesis",
    );
  }

  async function runCouncilReview(
    prompt: string,
    parentSessionID: string,
  ): Promise<string> {
    const councillorPromises = councilConfig.models.map((model) =>
      runCouncillor({ parentSessionID, prompt, model }),
    );

    const settledResults = await Promise.allSettled(councillorPromises);
    const successes: CouncillorSuccess[] = [];
    const failures: CouncillorFailure[] = [];

    settledResults.forEach((result, index) => {
      const model = councilConfig.models[index];
      if (result.status === "fulfilled") {
        successes.push(result.value);
      } else {
        failures.push({ model, error: errorMessage(result.reason) });
      }
    });

    if (successes.length < 2) {
      return `Error: council_review received fewer than 2 successful councillor responses (${successes.length}/${councilConfig.models.length}). caller should fall back to a single reviewer.

Successful councillors:
${successes.length === 0 ? "none" : successes.map((success) => `- ${modelLabel(success.model)} (${success.attempts} attempt${success.attempts === 1 ? "" : "s"})`).join("\n")}

Failed councillors:
${formatFailureSummary(failures)}`;
    }

    return await synthesizeWithAggregator({
      parentSessionID,
      originalPrompt: prompt,
      successes,
      failures,
    });
  }

  return {
    tool: {
      council_review: tool({
        description: `Fan out a review prompt to the configured council of reviewers in parallel, then ask an aggregator to structurally aggregate the responses.

Use when you need adversarial review from multiple models. The tool returns the aggregator's synthesis when at least two councillors respond. If fewer than two respond, it returns an error string so the caller can fall back to a single reviewer.`,
        args: {
          prompt: tool.schema
            .string()
            .describe("The complete review prompt to send to each councillor"),
        },
        async execute(args, toolContext) {
          const prompt = args.prompt.trim();
          if (!prompt) return "Error: Must provide a non-empty prompt";

          try {
            return await raceWithTimeout(
              runCouncilReview(prompt, toolContext.sessionID),
              councilConfig.timeouts.hard_cap_ms,
              "council_review",
            );
          } catch (error) {
            return `Error: council_review failed: ${errorMessage(error)}`;
          }
        },
      }),
    },
  };
};

export { CouncilToolPlugin };

export default { server: CouncilToolPlugin };
