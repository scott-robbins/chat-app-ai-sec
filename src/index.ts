import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const PUBLIC_R2_URL = "https://pub-20c45c92e45947c1bac6958b971f59a1.r2.dev";

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

				const tools = [
					{
						name: "generate_image",
						description: "Call this to create an image.",
						parameters: {
							type: "object",
							properties: { prompt: { type: "string" } },
							required: ["prompt"]
						}
					}
				];

				let sysPrompt = "You are Jolene. Use generate_image for visuals. Return ![Image](URL).";
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: "system", content: sysPrompt });

				// PASS 1
				const response = await this.env.AI.run(REASONING_MODEL, { 
					messages, 
					tools, 
					tool_choice: "generate_image", 
					stream: false 
				});

				let finalContent = "";

				if (response.tool_calls && response.tool_calls.length > 0) {
					const tc = response.tool_calls[0];
					let args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
					
					let toolOutput = "";
					try {
						const imgBlob = await this.env.AI.run(IMAGE_MODEL, { prompt: args.prompt });
						const fileName = `generated/${crypto.randomUUID()}.png`;
						await this.env.DOCUMENTS.put(fileName, imgBlob, { httpMetadata: { contentType: "image/png" } });
						toolOutput = `${PUBLIC_R2_URL}/${fileName}`;
						console.log("SUCCESS: URL Created ->", toolOutput);
					} catch (e) {
						toolOutput = "Error: Generation failed.";
					}
					
					// SCHEMA FIX: Clean the history of metadata before Pass 2
					const cleanHistory = messages.map(m => ({ role: m.role, content: m.content }));
					cleanHistory.push({
						role: "assistant",
						tool_calls: [{
							id: tc.id,
							type: "function",
							function: { name: tc.name, arguments: JSON.stringify(args) }
						}]
					});
					cleanHistory.push({ 
						role: "tool", 
						name: tc.name, 
						content: toolOutput, 
						tool_call_id: tc.id 
					});

					const secondRun = await this.env.AI.run(CONVERSATION_MODEL, { messages: cleanHistory });
					finalContent = secondRun.response || secondRun.choices?.[0]?.message?.content || "";
				} else {
					finalContent = response.response || "No image generated.";
				}

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
