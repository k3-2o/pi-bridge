// A minimal exportable tool for pi-bridge.
//
// The contract is the same one pi's SDK tools follow (createReadTool and
// friends): the module exports a factory; the bridge calls it once at mount;
// the returned object must have a string `name` and an async `execute`.
// `parameters` is optional but gives you schema-validated args for free.

export function createGreetTool() {
	return {
		name: "greet",
		parameters: {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		},
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `hello, ${params.name}` }],
			};
		},
	};
}
