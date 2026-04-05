import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; // <--- UPGRADED FOR TOOLS
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
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
				const selectedModel = body.model || CONVERSATION_MODEL;

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				const tools = [
					{
						type: "function",
						function: {
							name: "generate_image",
							description: "Generate a visual image or art based on a detailed text description.",
							parameters: {
								type: "object",
								properties: {
									prompt: { type: "string", description: "A detailed description of the image to create." }
								},
								required: ["prompt"]
							}
						}
					}
				];

				// HIGH-AUTHORITY System Prompt
				let sysPrompt = "You are Jolene. When a user asks for an image, you MUST call the generate_image tool. " +
					"After calling the tool, use the returned R2 URL to show the image as ![Image](URL). " +
					"DO NOT use Imgur. DO NOT describe the image unless it fails.";

				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: "system", content: sysPrompt });

				// FIRST PASS: Using 70B for better tool reasoning
				const response = await this.env.AI.run(REASONING_MODEL, { 
					messages, 
					tools, 
					tool_choice: "auto", 
					stream: false 
				});

				let finalContent = "";

				if (response.tool_calls && response.tool_calls.length > 0) {
					const tc = response.tool_calls[0];
					const args = JSON.parse(tc.arguments);
					let toolOutput = "";
					
					if (tc.name === "generate_image") {
						try {
							console.log("TOOL_CALL: Generating image for prompt:", args.prompt);
							const imgBlob = await this.env.AI.run(IMAGE_MODEL, { prompt: args.prompt });
							const fileName = `generated/${crypto.randomUUID()}.png`;
							
							await this.env.DOCUMENTS.put(fileName, imgBlob, {
								httpMetadata: { contentType: "image/png" }
							});

							toolOutput = `${PUBLIC_R2_URL}/${fileName}`;
							console.log("SUCCESS: Asset created at", toolOutput);
						} catch (e) {
							console.error("TOOL_ERROR:", e);
							toolOutput = "Error: Image generation failed.";
						}
					}
					
					messages.push(response);
					messages.push({ role: "tool", name: tc.name, content: toolOutput, tool_call_id: tc.id });

					// FINAL PASS: Use conversation model for the summary
					const secondRun = await this.env.AI.run(CONVERSATION_MODEL, { messages });
					finalContent = secondRun.response || secondRun.choices?.[0]?.message?.content || "";
				} else {
					finalContent = response.response || response.choices?.[0]?.message?.content || "I didn't call the tool. Please try asking again specifically.";
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
