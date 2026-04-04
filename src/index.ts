import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "default";

		if (url.pathname === "/api/history") {
			try {
				const { results } = await this.env.jolene_db.prepare(
					"SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
				).bind(sessionId).all();
				return new Response(JSON.stringify({ messages: results }), { headers: { "Content-Type": "application/json" } });
			} catch (e) {
				return new Response(JSON.stringify({ messages: [] }), { headers: { "Content-Type": "application/json" } });
			}
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";

				// 1. SAVE USER MESSAGE TO D1
				await this.env.jolene_db.prepare(
					"INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
				).bind(sessionId, "user", latestUserMessage).run();

				// 2. VECTOR SEARCH (The "Memorized Files" Logic)
				let contextText = "";
				try {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
					
					if (matches.matches.length > 0 && matches.matches[0].score > 0.6) {
						contextText = matches.matches.map(m => m.metadata?.text).join("\n");
					}
				} catch (vectorError) {
					console.error("Vector search failed:", vectorError);
				}

				// --- ART GENERATION ---
				if (latestUserMessage.toLowerCase().startsWith("/imagine ")) {
					const prompt = latestUserMessage.slice(9);
					const img = await this.env.AI.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt });
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", `[Generated Image: ${prompt}]`).run();
					return new Response(img, { headers: { "Content-Type": "image/png", "x-prompt": encodeURIComponent(prompt) } });
				}

				// --- PREPARE AI PROMPT WITH CONTEXT ---
				let systemPrompt = "You are Jolene, a helpful AI assistant.";
				if (contextText) {
					systemPrompt += `\n\nUse the following internal knowledge to help answer the user. If the answer isn't there, rely on your general knowledge: \n${contextText}`;
				}

				// Update or add system message
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = systemPrompt;
				else messages.unshift({ role: 'system', content: systemPrompt });

				// --- TEXT CHAT STREAM ---
				const stream = await this.env.AI.run(DEFAULT_MODEL, { messages, stream: true });
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
									fullText += json.response || json.choices?.[0]?.delta?.content || "";
								} catch (e) {}
							}
						}
					}
					if (fullText) {
						await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
							.bind(sessionId, "assistant", fullText).run();
					}
				})());

				return new Response(outStream, { headers: { "Content-Type": "text/event-stream" } });

			} catch (e: any) {
				return new Response(JSON.stringify({ error: e.message }), { status: 500 });
			}
		}
		return new Response("Not allowed", { status: 405 });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
		const sessionId = request.headers.get("x-session-id");
		if (!sessionId) return new Response("Missing Session ID", { status: 400 });
		const id = env.CHAT_SESSION.idFromName(sessionId);
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
