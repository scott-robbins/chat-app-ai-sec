import { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
	AI: Ai;
	ASSETS: { fetch: (request: Request) => Promise<Response> };
	VECTORIZE: VectorizeIndex;
	CHAT_SESSION: DurableObjectNamespace;
	
	// Add our new KV Namespace binding!
	CHAT_CONFIG: KVNamespace;

	// Add our new R2 Bucket binding!
	DOCUMENTS: R2Bucket;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
