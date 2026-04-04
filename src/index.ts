import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "default";

		// --- FETCH HISTORY FROM D1 ---
		if (url.pathname === "/api/history") {
			try {
				const { results } = await this.env.jolene_db.prepare(
					"SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
				).bind(sessionId).all();
				
				return new Response(JSON.stringify({ messages: results }), { 
					headers: { "Content-Type": "application/json" } 
				});
			} catch (e: any) {
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

				// --- ART GENERATION ---
				if (latestUserMessage.toLowerCase().startsWith("/imagine ")) {
					const prompt = latestUserMessage.slice(9);
					const img = await this.env.AI.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt });
					
					// Save the fact that an image was generated to history
					await this.env.jolene_db.prepare(
						"INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
					).bind(sessionId, "assistant", `[Generated Image: ${prompt}]`).run();

					return new Response(img, { 
						headers: { "Content-Type": "image/png", "x-prompt": encodeURIComponent(prompt) } 
					});
				}

				// --- TEXT CHAT WITH D1 STREAM SAVING ---
				const stream = await this.env.AI.run(DEFAULT_MODEL, { messages, stream: true });
				
				// We use a TransformStream to "spy" on the data so we can save the full response to D1
				const [outStream, saveStream] = stream.tee();

				// This background task gathers the stream and saves it once complete
				this.ctx.waitUntil((async () => {
					const reader = saveStream.getReader();
					const decoder = new TextDecoder();
					let fullAssistantText = "";
					
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
									fullAssistantText += json.response || json.choices?.[0]?.delta?.content || "";
								} catch (e) {}
							}
						}
					}
					
					// SAVE ASSISTANT RESPONSE TO D1
					if (fullAssistantText) {
						await this.env.jolene_db.prepare(
							"INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
						).bind(sessionId, "assistant", fullAssistantText).run();
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
