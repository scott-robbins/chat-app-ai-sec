import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "default";

		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare(
				"SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
			).bind(sessionId).all();
			return new Response(JSON.stringify({ messages: results }), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				// RAG / Vector Search
				let contextText = "";
				try {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 1, returnMetadata: "all" });
					if (matches.matches.length > 0 && matches.matches[0].score > 0.6) {
						contextText = matches.matches[0].metadata?.text;
					}
				} catch (e) {}

				const tools = [
					{ name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { location: { type: "string" } } } },
					{ name: "sec_status", description: "Check security", parameters: { type: "object", properties: {} } }
				];

				let sysPrompt = "You are Jolene. Be concise.";
				if (contextText) sysPrompt += ` Knowledge: ${contextText}`;
				messages.unshift({ role: "system", content: sysPrompt });

				// Speed fix: Use stream: true by default for everything
				const stream = await this.env.AI.run(DEFAULT_MODEL, { messages, tools, stream: true });
				
				// Standard stream handling
				const [outStream, saveStream] = stream.tee();
				this.ctx.waitUntil((async () => {
					const reader = saveStream.getReader();
					const decoder = new TextDecoder();
					let fullText = "";
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						const chunk = decoder.decode(value);
						const lines = chunk.split("\n");
						for (const line of lines) {
							if (line.startsWith("data: ")) {
								const data = line.slice(6).trim();
								if (data === "[DONE]") break;
								try {
									const json = JSON.parse(data);
									fullText += json.response || "";
								} catch (e) {}
							}
						}
					}
					if (fullText) await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", fullText).run();
				})());

				return new Response(outStream, { headers: { "Content-Type": "text/event-stream" } });
			} catch (e: any) {
				return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
			}
		}
		return new Response("Not allowed", { status: 405 });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
