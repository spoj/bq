import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const manifest = process.env.BQ_PI_MANIFEST;
	if (!manifest) return;

	pi.on("session_start", (_event, ctx) => {
		const path = ctx.sessionManager.getSessionFile();
		if (!path) return;
		const entryIds = ctx.sessionManager.getEntries().map((entry) => entry.id);
		appendFileSync(manifest, `${JSON.stringify({ path, entryIds })}\n`);
	});
}
