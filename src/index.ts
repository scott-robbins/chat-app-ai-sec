import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
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

				// Log user message to D1
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				// 1. RAG: Search Vectorize for context
				let contextText = "";
				try {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
					if (matches.matches.length > 0) {
						contextText = matches.matches.map(m => m.metadata?.text).join("\n");
					}
				} catch (e) { console.error("RAG Error:", e); }

				// 2. STRICTOR System Prompt logic
				let sysPrompt = "You are Jolene. You have access to a generate_image tool. " +
					"CRITICAL: Only use generate_image if the user explicitly asks to 'generate', 'create', 'draw', or 'paint' an image. " +
					"If the user is asking a question about codes, data, or facts, DO NOT use the tool. Answer using the provided context.";
				
				if (contextText) sysPrompt += `\n\nContext for this session:\n${contextText}`;
				
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: "system", content: sysPrompt });

				const tools = [{
					name: "generate_image",
					description: "Generate a visual image based on a prompt.",
					parameters: {
						type: "object",
						properties: { prompt: { type: "string" } },
						required: ["prompt"]
					}
				}];

				// 3. PASS 1: Using 70B with 'auto' so it can choose NOT to draw
				const response = await this.env.AI.run(REASONING_MODEL, { 
					messages, 
					tools, 
					tool_choice: "auto", 
					stream: false 
				});

				let finalContent = "";

				if (response.tool_calls && response.tool_calls.length > 0) {
					const tc = response.tool_calls[0];
					let args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
					
					if (tc.name === "generate_image") {
						try {
							const imgBlob = await this.env.AI.run(IMAGE_MODEL, { prompt: args.prompt });
							const fileName = `generated/${crypto.randomUUID()}.png`;
							await this.env.DOCUMENTS.put(fileName, imgBlob, { httpMetadata: { contentType: "image/png" } });
							const imageUrl = `${PUBLIC_R2_URL}/${fileName}`;
							finalContent = `I've generated that image for you!\n\n![Generated Image](${imageUrl})`;
						} catch (e) {
							finalContent = "I tried to generate that image but something went wrong.";
						}
					}
				} else {
					// 4. PASS 2: If no tool was called, answer using context
					const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages });
					finalContent = chatRun.response || chatRun.choices?.[0]?.message?.content || "I couldn't find an answer for that.";
				}

				// Log assistant response to D1
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", finalContent).run();

				return new Response(`data: ${JSON.stringify({ response: finalContent })}\n\ndata: [DONE]\n\n`, {
					headers: { "Content-Type": "text/event-stream" }
				});

			} catch (e: any) {
				return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`, {
					headers: { "Content-Type": "text/event-stream" }
				});
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
