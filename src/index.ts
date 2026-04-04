import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct"; 
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

				// 1. SAVE USER MESSAGE
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				// 2. VECTOR SEARCH (RAG)
				let contextText = "";
				try {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
					if (matches.matches.length > 0 && matches.matches[0].score > 0.5) {
						contextText = matches.matches.map(m => m.metadata?.text).join("\n");
					}
				} catch (e) { console.error("RAG Error"); }

				// 3. ART GENERATION
				if (latestUserMessage.toLowerCase().startsWith("/imagine ")) {
					const prompt = latestUserMessage.slice(9);
					const img = await this.env.AI.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt });
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", `[Image: ${prompt}]`).run();
					return new Response(img, { headers: { "Content-Type": "image/png", "x-prompt": encodeURIComponent(prompt) } });
				}

				// 4. TOOLS DEFINITION
				const tools = [
					{
						name: "get_weather",
						description: "Get current weather",
						parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] }
					},
					{
						name: "security_status",
						description: "Check AI-SEC firewall status",
						parameters: { type: "object", properties: {} }
					}
				];

				// 5. SYSTEM PROMPT
				let sysPrompt = "You are Jolene. Use tools for weather or security status. Use Internal Knowledge for WiFi passwords.";
				if (contextText) sysPrompt += `\n\nInternal Knowledge: ${contextText}`;
				
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: 'system', content: sysPrompt });

				// 6. AI EXECUTION
				// We call the AI with stream: false to allow Tool Calling check
				const response = await this.env.AI.run(DEFAULT_MODEL, { messages, tools, stream: false });

				let finalContent = "";

				// CHECK FOR TOOL CALLS
				if (response.tool_calls && response.tool_calls.length > 0) {
					const tc = response.tool_calls[0];
					const args = JSON.parse(tc.arguments);
					let toolOutput = "";

					if (tc.name === "get_weather") toolOutput = `Weather in ${args.location}: 72°F, Sunny.`;
					else if (tc.name === "security_status") toolOutput = "AI-SEC: Systems active. No breaches.";

					messages.push(response);
					messages.push({ role: "tool", name: tc.name, content: toolOutput, tool_call_id: tc.id });

					const secondRun = await this.env.AI.run(DEFAULT_MODEL, { messages });
					finalContent = secondRun.response;
				} else {
					// No tool called, just normal text
					finalContent = response.response;
				}

				// 7. SAVE & RETURN (As SSE to satisfy chat.js)
				if (finalContent) {
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", finalContent).run();
					
					return new Response(`data: ${JSON.stringify({ response: finalContent })}\n\ndata: [DONE]\n\n`, {
						headers: { "Content-Type": "text/event-stream" }
					});
				}

				throw new Error("AI returned empty content");

			} catch (e: any) {
				console.error("Worker Error:", e.message);
				return new Response(`data: ${JSON.stringify({ response: "Sorry, I hit an error: " + e.message })}\n\ndata: [DONE]\n\n`, {
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
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
		const sessionId = request.headers.get("x-session-id");
		if (!sessionId) return new Response("Missing Session ID", { status: 400 });
		const id = env.CHAT_SESSION.idFromName(sessionId);
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
