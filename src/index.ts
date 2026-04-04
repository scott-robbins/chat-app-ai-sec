import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/history" && request.method === "GET") {
			const savedMessages = await this.ctx.storage.get<ChatMessage[]>("messages") || [];
			return new Response(JSON.stringify({ messages: savedMessages }), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = (await request.json()) as { messages: ChatMessage[], image?: string };
				const { messages = [], image } = body;
				const latestUserMessage = messages[messages.length - 1]?.content || "";

				// --- ART GENERATION: DIRECT BINARY STREAM ---
				if (latestUserMessage.toLowerCase().startsWith("/imagine ")) {
					const prompt = latestUserMessage.slice(9);
					// Stable Diffusion is very reliable for this direct stream method
					const imageResponse = await this.env.AI.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt });
					
					// We return the raw binary data. No btoa, no strings, no crashes.
					return new Response(imageResponse, { 
						headers: { 
							"Content-Type": "image/png",
							"x-jolene-prompt": encodeURIComponent(prompt) // Hide the prompt in a header
						} 
					});
				}

				// --- STANDARD CHAT LOGIC ---
				await this.ctx.storage.put("messages", messages);
				let activeModel = await this.env.CHAT_CONFIG.get("active_model") || DEFAULT_MODEL;
				let sysPrompt = await this.env.CHAT_CONFIG.get("system_prompt") || "You are a helpful assistant.";

				const sysIdx = messages.findIndex((msg) => msg.role === "system");
				if (sysIdx === -1) messages.unshift({ role: "system", content: sysPrompt });
				else messages[sysIdx].content = sysPrompt;

				const aiPayload: any = { messages, max_tokens: 1024, stream: true };
				const stream = await this.env.AI.run(activeModel, aiPayload);
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });

			} catch (error: any) {
				return new Response(JSON.stringify({ error: error.message }), { status: 500 });
			}
		}
		return new Response("Not allowed", { status: 405 });
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
		
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
