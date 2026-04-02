import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const SYSTEM_PROMPT = "You are a helpful, friendly assistant. Provide concise and accurate responses.";

// =====================================================================
// 1. THE MAIN WORKER ROUTER
// =====================================================================
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle frontend assets
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// Handle Vectorize Seeding (unchanged)
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

		// Route Chat Requests to the Durable Object
		if (url.pathname === "/api/chat" || url.pathname === "/api/history") {
			// Extract the Session ID sent by the frontend
			const sessionId = request.headers.get("x-session-id");
			if (!sessionId) {
				return new Response("Missing Session ID", { status: 400 });
			}

			// Find the specific Durable Object for this session and forward the request to it
			const id = env.CHAT_SESSION.idFromName(sessionId);
			const stub = env.CHAT_SESSION.get(id);
			return stub.fetch(request);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// =====================================================================
// 2. THE DURABLE OBJECT CLASS (This is what Cloudflare couldn't find!)
// =====================================================================
export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// GET /api/history: Return saved messages when the user reloads the page
		if (url.pathname === "/api/history" && request.method === "GET") {
			const savedMessages = await this.ctx.storage.get<ChatMessage[]>("messages") || [];
			return new Response(JSON.stringify({ messages: savedMessages }), {
				headers: { "Content-Type": "application/json" }
			});
		}

		// POST /api/chat: Handle new messages, save them, and run the AI
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };
				
				// Save the updated history to the Durable Object's permanent storage
				await this.ctx.storage.put("messages", messages);

				// Vectorize RAG Logic
				const latestMessage = messages[messages.length - 1]?.content || "";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestMessage] });
				
				const searchResults = await this.env.VECTORIZE.query(queryVector.data[0], {
					topK: 1, returnMetadata: "all"
				});

				let dynamicSystemPrompt = SYSTEM_PROMPT;
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

				// Run the AI Model
				const stream = await this.env.AI.run(MODEL_ID, {
					messages, max_tokens: 1024, stream: true,
				});

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
