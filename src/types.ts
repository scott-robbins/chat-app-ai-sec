import { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
	AI: Ai;
	ASSETS: { fetch: (request: Request) => Promise<Response> };
	VECTORIZE: VectorizeIndex;
	CHAT_SESSION: DurableObjectNamespace;
	
	// Changed from CHAT_CONFIG to SETTINGS to match wrangler.jsonc and index.ts
	SETTINGS: KVNamespace; 

	// R2 Bucket binding
	DOCUMENTS: R2Bucket;

	// Added the D1 binding so TypeScript doesn't complain
	jolene_db: D1Database; 
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
