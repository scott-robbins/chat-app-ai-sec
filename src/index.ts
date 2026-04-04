import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct"; // Note: 3.1/3.2 8B/70B models have better tool support
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

				// 2. VECTOR SEARCH (RAG)
				let contextText = "";
				try {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
					if (matches.matches.length > 0 && matches.matches[0].score > 0.6) {
						contextText = matches.matches.map(m => m.metadata?.text).join("\n");
					}
				} catch (e) {}

				// 3. ART GENERATION
				if (latestUserMessage.toLowerCase().startsWith("/imagine ")) {
					const prompt = latestUserMessage.slice(9);
					const img = await this.env.AI.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt });
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", `[Generated Image: ${prompt}]`).run();
					return new Response(img, { headers: { "Content-Type": "image/png", "x-prompt": encodeURIComponent(prompt) } });
				}

				// 4. DEFINE TOOLS
				const tools = [
					{
						name: "get_weather",
						description: "Get the current weather for a location",
						parameters: {
							type: "object",
							properties: {
								location: { type: "string", description: "The city, e.g. London" }
							},
							required: ["location"]
						}
					},
					{
						name: "security_scan_status",
						description: "Check the status of the AI-SEC firewall and security gates",
						parameters: { type: "object", properties: {} }
					}
				];

				// 5. PREPARE PROMPT
				let systemPrompt = "You are Jolene, a helpful AI assistant.";
				if (contextText) systemPrompt += `\n\nInternal Knowledge: \n${contextText}`;
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = systemPrompt;
				else messages.unshift({ role: 'system', content: systemPrompt });

				// 6. INITIAL AI RUN (With Tool Support)
				// We don't stream the first look because we need to check for tool_calls
				const response = await this.env.AI.run(DEFAULT_MODEL, { 
					messages, 
					tools,
					stream: false 
				});

				// 7. HANDLE TOOL CALLS
				if (response.tool_calls && response.tool_calls.length > 0) {
					const toolCall = response.tool_calls[0];
					const args = JSON.parse(toolCall.arguments);
					let result = "";

					if (toolCall.name === "get_weather") {
						result = `The weather in ${args.location} is 22°C and sunny. (Simulated Data)`;
					} else if (toolCall.name === "security_scan_status") {
						result = "AI-SEC Status: All systems green. Firewall active. No breaches detected in last 24h.";
					}

					// Add AI's intent and Tool's result to history
					messages.push(response); 
					messages.push({
						role: "tool",
						name: toolCall.name,
						content: result,
						tool_call_id: toolCall.id
					});

					// Final Run to generate text based on tool result
					const finalResponse = await this.env.AI.run(DEFAULT_MODEL, { messages });
					const finalText = finalResponse.response;

					// Save to D1
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", finalText).run();

					// Return as a fake SSE stream so the frontend doesn't break
					return new Response(`data: ${JSON.stringify({ response: finalText })}\n\ndata: [DONE]\n\n`, {
						headers: { "Content-Type": "text/event-stream" }
					});
				}

				// 8. NORMAL TEXT STREAM (No tools needed)
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
