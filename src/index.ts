import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/history") {
			const saved = await this.ctx.storage.get<ChatMessage[]>("messages") || [];
			return new Response(JSON.stringify({ messages: saved }), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const messages = body.messages || [];
				const latest = messages[messages.length - 1]?.content || "";

				// --- ART GENERATION ---
				if (latest.toLowerCase().startsWith("/imagine ")) {
					const prompt = latest.slice(9);
					const img = await this.env.AI.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt });
					return new Response(img, { 
						headers: { "Content-Type": "image/png", "x-prompt": encodeURIComponent(prompt) } 
					});
				}

				// --- TEXT CHAT ---
				await this.ctx.storage.put("messages", messages);
				const stream = await this.env.AI.run(DEFAULT_MODEL, { messages, stream: true });
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });

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
