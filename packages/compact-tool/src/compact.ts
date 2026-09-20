import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const compactParameters = Type.Object({
	instructions: Type.Optional(
		Type.String({
			description: "Optional focus instructions for the summarizer",
		}),
	),
});
export type CompactParameters = Static<typeof compactParameters>;

export function registerCompactTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "compact",
		label: "Compact context",
		description:
			"Queue context compaction at a genuine task transition. Use this as the only tool call in its batch.",
		promptSnippet: "Queue compaction at a genuine task transition",
		promptGuidelines: [
			"Use compact only at a genuine task transition when reducing old context would help, and do not repeat it for the same boundary.",
			"Call compact as the only tool in its batch. Compaction preserves needed context; do not create a separate handoff summary.",
		],
		parameters: compactParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Compaction was not queued because the tool call was cancelled.",
						},
					],
					details: { status: "cancelled" as const },
					terminate: true,
				};
			}

			let settled = false;
			ctx.compact({
				...(params.instructions === undefined
					? {}
					: { customInstructions: params.instructions }),
				onComplete: () => {
					if (settled) return;
					settled = true;
					queueMicrotask(() => {
						if (ctx.isIdle() && !ctx.hasPendingMessages()) {
							pi.sendUserMessage("Compaction completed. Continue the task.");
						}
					});
				},
				onError: (error) => {
					if (settled) return;
					settled = true;
					if (ctx.hasUI)
						ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				},
			});

			return {
				content: [
					{
						type: "text" as const,
						text: "Manual compaction queued.",
					},
				],
				details: { status: "queued" as const },
				terminate: true,
			};
		},
	});
}
