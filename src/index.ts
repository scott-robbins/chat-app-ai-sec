import { Env } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const PUBLIC_R2_URL = "https://pub-20c45c92e45947c1bac6958b971f59a1.r2.dev";
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
				let messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";

                // IMAGE LOGIC (With Gateway)
				if (latestUserMessage.toLowerCase().includes("draw") || latestUserMessage.toLowerCase().includes("generate")) {
					const imageResponse = await this.env.AI.run(IMAGE_MODEL, { prompt: latestUserMessage }, { gateway: { id: "ai-sec-gateway" } });
					const imageKey = `generated/${crypto.randomUUID()}.png`;
					const imageBuffer = await new Response(imageResponse).arrayBuffer();
					await this.env.DOCUMENTS.put(imageKey, imageBuffer, { httpMetadata: { contentType: "image/png" } });
					const assistantResponse = `Here is your image:\n\n![Generated Image](${PUBLIC_R2_URL}/${imageKey})`;
					return new Response(`data: ${JSON.stringify({ response: assistantResponse })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
				}

				// TEXT LOGIC (With Gateway)
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages }, { gateway: { id: "ai-sec-gateway" } });
				const finalContent = chatRun.response || "I'm not sure how to respond.";
				return new Response(`data: ${JSON.stringify({ response: finalContent })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });

			} catch (e: any) {
				return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`);
			}
		}
		return new Response("Not Found", { status: 404 });
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
