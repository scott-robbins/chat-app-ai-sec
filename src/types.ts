/**
 * Type definitions for the LLM chat application.
 */
import { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
	AI: Ai;
	ASSETS: { fetch: (request: Request) => Promise<Response> };
	VECTORIZE: VectorizeIndex;
	
	// Our new Durable Object Binding
	CHAT_SESSION: DurableObjectNamespace;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
