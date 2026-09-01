// The classic way to give pi a tool: defineTool(), then register the product in
// code (customTools: [myTool] in the SDK, or pi.registerTool() in an extension).
//
// pi-bridge mounts the SAME kind of tool from the YAML manifest instead: the
// module exports a factory, the bridge calls it once at mount, and the result
// is indistinguishable from a registered tool in the catalog.
//
// Mount:
//   - from: "~/my-tools/greet-tool.ts"   # or ./greet-tool.ts relative to the manifest
//     factory: createGreetTool

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function createGreetTool() {
	return defineTool({
		name: "greet",
		description: "Greet someone by name",
		parameters: Type.Object({
			name: Type.String({ description: "Who to greet" }),
		}),
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: `hello, ${params.name}` }],
			details: {},
		}),
	});
}
