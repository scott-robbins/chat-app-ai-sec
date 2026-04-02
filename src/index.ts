import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// =====================================================================
// 1. THE MAIN WORKER ROUTER
// =====================================================================
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// ==========================================
		// KV: SET SYSTEM PROMPT ROUTE
		// ==========================================
		if (url.pathname === "/api/set-prompt") {
			// Get the 'text' parameter from the URL (e.g. ?text=You are a pirate)
			const newPrompt = url.searchParams.get("text");
			
			if (newPrompt) {
				// Save it to KV!
				await env.CHAT_CONFIG.put("system_prompt", newPrompt);
				return new Response(`Success! The bot's personality is now: "${newPrompt}"`, { status: 200 });
			}
			
			return new Response("Please provide a prompt. Example: your-url.com/api/set-prompt?text=You are a grumpy cat.", { status: 400 });
		}

		if (url.pathname === "/api/seed") {
			try {
				const companyKnowledge = [
					"The secret Wi-Fi password for the guest lobby is 'OrangeFlamingo2026'.",
					"Project Nebula is a highly confidential, AI-powered coffee machine."
				];
				const embeddings = await env.AI.run(EMBEDDING_MODEL, { text: companyKnowledge });
				const vectorsToInsert = companyKnowledge.map((text, index) => ({
					id: `knowledge-doc-${index}`,
					values: embeddings.data[index],
					metadata: { text: text }
				}));
				await env.VECTORIZE.insert(vectorsToInsert);
				return new Response("Multiple secrets successfully injected into Vectorize!", { status: 200 });
			} catch (error: any) {
				return new Response("Error seeding database: " + error.message, { status: 500 });
			}
		}

		if (url.pathname === "/api/chat" || url.pathname === "/api/history") {
			const sessionId = request.headers.get("x-session-id");
			if (!sessionId) return new Response("Missing Session ID", { status: 400 });

			const id = env.CHAT_SESSION.idFromName(sessionId);
			const stub = env.CHAT_SESSION.get(id);
			return stub.fetch(request);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// =====================================================================
// 2. THE DURABLE OBJECT CLASS
// =====================================================================
export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/history" && request.method === "GET") {
			const savedMessages = await this.ctx.storage.get<ChatMessage[]>("messages") || [];
			return new Response(JSON.stringify({ messages: savedMessages }), {
				headers: { "Content-Type": "application/json" }
			});
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };
				await this.ctx.storage.put("messages", messages);

				// ==========================================
				// KV: GET SYSTEM PROMPT
				// ==========================================
				// Ask KV for the prompt. If it's empty, use the default string.
				let baseSystemPrompt = await this.env.CHAT_CONFIG.get("system_prompt");
				if (!baseSystemPrompt) {
					baseSystemPrompt = "You are a helpful, friendly assistant. Provide concise and accurate responses.";
				}

				// Vectorize RAG Logic (Injecting context into our KV prompt)
				const latestMessage = messages[messages.length - 1]?.content || "";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestMessage] });
				
				const searchResults = await this.env.VECTORIZE.query(queryVector.data[0], {
					topK: 1, returnMetadata: "all"
				});

				let dynamicSystemPrompt = baseSystemPrompt;
				if (searchResults.matches.length > 0 && searchResults.matches[0].score > 0.5) {
					const foundContext = searchResults.matches[0].metadata?.text;
					dynamicSystemPrompt += `\n\nUse this internal context to answer the user: ${foundContext}`;
				}

				const sysIdx = messages.findIndex((msg) => msg.role === "system");
				if (sysIdx === -1) {
					messages.unshift({ role: "system", content: dynamicSystemPrompt });
				} else {
					messages[sysIdx].content = dynamicSystemPrompt;
				}

				// ==========================================
				// RUN AI MODEL WITH GATEWAY ROUTING
				// ==========================================
				const stream = await this.env.AI.run(
					MODEL_ID, 
					{
						messages, 
						max_tokens: 1024, 
						stream: true,
					},
					{
						// Route the request through your AI Gateway
						gateway: {
							id: "ai-sec-gateway", // Updated to match your exact dashboard ID!
							skipCache: false,       // Set to false to enable caching
							cacheTtl: 3600,         // Cache identical requests for 1 hour
						}
					}
				);

				return new Response(stream, {
					headers: {
						"content-type": "text/event-stream; charset=utf-8",
						"cache-control": "no-cache",
						connection: "keep-alive",
					},
				});
			} catch (error) {
				return new Response(JSON.stringify({ error: "Failed to process request" }), { status: 500 });
			}
		}

		return new Response("Method not allowed", { status: 405 });
	}
}
