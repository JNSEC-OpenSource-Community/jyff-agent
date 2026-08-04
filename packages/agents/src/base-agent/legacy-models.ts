import type { AgentOptions } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	type Model,
	type Models,
	type AssistantMessageEventStream as PiAssistantMessageEventStream,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

function failureMessage(
	model: Model<Api>,
	error: unknown,
	aborted: boolean,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/** Adapt the former low-level Agent stream contract without duplicating Pi's model registry. */
function adaptStream(
	streamFn: AgentOptions["streamFn"],
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): PiAssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			const source = await streamFn(model, context, options);
			for await (const event of source) output.push(event);
			output.end(await source.result());
		} catch (error) {
			const message = failureMessage(
				model,
				error,
				options?.signal?.aborted === true,
			);
			output.push({
				type: "error",
				reason: message.stopReason === "aborted" ? "aborted" : "error",
				error: message,
			});
			output.end(message);
		}
	})();
	return output;
}

/**
 * Compatibility bridge for callers that still create Pi's old `AgentOptions`.
 * New agents should receive a shared `Models` registry directly.
 */
export function modelsFromAgentOptions(
	options: AgentOptions,
	model: Model<Api>,
): Models {
	const models = createModels();
	const stream = (
		candidate: Model<Api>,
		context: Context,
		streamOptions?: SimpleStreamOptions,
	) => adaptStream(options.streamFn, candidate, context, streamOptions);
	models.setProvider(
		createProvider({
			id: model.provider,
			name: model.provider,
			models: [model],
			auth: {
				apiKey: {
					name: `${model.provider} compatibility auth`,
					resolve: async () => ({
						auth: { apiKey: await options.getApiKey?.(model.provider) },
						source: "legacy AgentOptions",
					}),
				},
			},
			api: { stream, streamSimple: stream },
		}),
	);
	return models;
}
