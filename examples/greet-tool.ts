// pi's usual custom-tool flow exports nothing: you define the tool inline
// (defineTool) and hand it straight to customTools / pi.registerTool. The
// object lives inside your file and pi's session; there is nothing to import,
// so a manifest cannot reach it.
//
// The SDK built-ins are the exception everyone knows: createReadTool,
// createBashTool and friends ARE exported factories, which is exactly why a
// manifest can mount them by name.
//
// To use your own tool over pi-bridge, make it exportable the same way: keep
// the defineTool call and the typebox schema exactly as pi prescribes, and wrap
// it in an exported factory. One export is the whole difference.
//
// Mount:
//   - from: "~/my-tools/greet-tool.ts"   # or ./greet-tool.ts relative to the manifest
//     factory: createGreetTool

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
