// T003 smoke helper — proves relative imports resolve under pi's extension loader.
// Throwaway: deleted when the real entry lands (T014).
import { appendFileSync } from "node:fs";

export function smoke(marker: string): void {
	appendFileSync(marker, `loaded pid=${process.pid}\n`);
	console.error("[pi-bridge] smoke: extension body ran");
}
