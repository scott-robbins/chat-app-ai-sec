import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";

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
				const selectedModel = body.model || DEFAULT_MODEL;

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				let contextText = "";
				try {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 1, returnMetadata: "all" });
					if (matches.matches.length > 0 && matches.matches[0].score > 0.6) {
						contextText = matches.matches[0].metadata?.text;
					}
				} catch (e) {}

				const tools = [
					{
						type: "function",
						function: {
							name: "get_weather",
							description: "Get current weather for a specific location",
							parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] }
						}
					},
					{
						type: "function",
						function: {
							name: "sec_status",
							description: "Check the status of the security systems",
							parameters: { type: "object", properties: {} }
						}
					},
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

				let sysPrompt = "You are Jolene, a warm and helpful AI Agent. Give natural responses. If you use the generate_image tool, tell the user you are working on their creation.";
				if (contextText) sysPrompt += ` Context: ${contextText}`;
				
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: "system", content: sysPrompt });

				const response = await this.env.AI.run(selectedModel, { messages, tools, stream: false });

				let finalContent = "";

				if (response.tool_calls && response.tool_calls.length > 0) {
					const tc = response.tool_calls[0];
					const args = JSON.parse(tc.arguments);
					
					let toolOutput = "";
					if (tc.name === "generate_image") {
						// 1. Generate the Image
						const imgBlob = await this.env.AI.run(IMAGE_MODEL, { prompt: args.prompt });
						
						// 2. Save to R2
						const fileName = `generated/${crypto.randomUUID()}.png`;
						await this.env.ASSETS_BUCKET.put(fileName, imgBlob, {
							httpMetadata: { contentType: "image/png" }
						});

						// 3. Create a Data URL for immediate display (or R2 Public URL if configured)
						// For simplicity in this step, we'll send the image back to the UI as a signal
						const base64 = btoa(String.fromCharCode(...new Uint8Array(imgBlob)));
						toolOutput = `IMAGE_RESULT:data:image/png;base64,${base64}`;
					} 
					else if (tc.name === "get_weather") {
						toolOutput = `72°F in ${args.location}`;
					} else if (tc.name === "sec_status") {
						toolOutput = "Systems Green.";
					}
					
					messages.push(response);
					messages.push({ role: "tool", name: tc.name, content: toolOutput, tool_call_id: tc.id });

					const secondRun = await this.env.AI.run(selectedModel, { messages });
					finalContent = secondRun.response || secondRun.choices?.[0]?.message?.content || "";
				} else {
					finalContent = response.response || response.choices?.[0]?.message?.content || "";
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
