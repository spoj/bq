import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

function cost(entries: SessionEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant") total += entry.message.usage.cost.total;
			if (entry.message.role === "toolResult" && entry.message.usage) {
				total += entry.message.usage.cost.total;
			}
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			total += entry.usage.cost.total;
		}
	}
	return total;
}

export default function (pi: ExtensionAPI) {
	const taskId = process.env.BQ_TASK_ID;
	if (!taskId) return;

	let initialCost = 0;
	pi.on("session_start", (_event, ctx) => {
		initialCost = cost(ctx.sessionManager.getEntries());
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const amount = cost(ctx.sessionManager.getEntries()) - initialCost;
		if (amount > 0) await pi.exec("bq", ["charge", taskId, amount.toString()]);
	});
}
