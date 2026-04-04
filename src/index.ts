import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

// Set Llama 3.2 Vision as the default engine
const DEFAULT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "default";

		// --- API: FETCH SESSION HISTORY ---
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

		// --- API: CHAT ENDPOINT ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";
				
				// Respect model choice from UI, fallback to 3.2 Vision
				const selectedModel = body.model || DEFAULT_MODEL;

				// 1. Persist User Message to D1
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				// 2. Vector Search (RAG) for WiFi Passwords & Internal Docs
				let contextText = "";
				try {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 1, returnMetadata: "all" });
					if (matches.matches.length > 0 && matches.matches[0].score > 0.6) {
						contextText = matches.matches[0].metadata?.text;
					}
				} catch (e) {
					console.error("Vectorize retrieval failed:", e);
				}

				// 3. Tool Definitions (Modern API Syntax)
				const tools = [
					{
						type: "function",
						function: {
							name: "get_weather",
							description: "Get current weather for a specific location",
							parameters: {
								type: "object",
								properties: {
									location: { type: "string", description: "The city name" }
								},
								required: ["location"]
							}
						}
					},
					{
						type: "function",
						function: {
							name: "sec_status",
							description: "Check the status of the AI-SEC security systems",
							parameters: { type: "object", properties: {} }
						}
					}
				];

				// 4. System Prompt Construction
				let sysPrompt = "You are Jolene. Give a natural, conversational response. If you use a tool, summarize the result for a human.";
				if (contextText) sysPrompt += ` Use this Knowledge for context: ${contextText}`;
				
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: "system", content: sysPrompt });

				// 5. Initial Execution (Check for Tool Calling Intent)
				const response = await this.env.AI.run(selectedModel, { messages, tools, stream: false });

				let finalContent = "";

				// 6. Handle Tool Invocation
				if (response.tool_calls && response.tool_calls.length > 0) {
					const tc = response.tool_calls[0];
					const args = JSON.parse(tc.arguments);
					
					let toolOutput = "";
					if (tc.name === "get_weather") {
						toolOutput = `The current weather in ${args.location || 'the area'} is 72°F and sunny.`;
					} else if (tc.name === "sec_status") {
						toolOutput = "AI-SEC Status: Firewalls at 100%. Security gates locked. No active breaches.";
					}
					
					// Add the tool sequence to message history
					messages.push(response);
					messages.push({ 
						role: "tool", 
						name: tc.name, 
						content: toolOutput, 
						tool_call_id: tc.id 
					});

					// Re-run to generate human-readable text
					const secondRun = await this.env.AI.run(selectedModel, { messages });
					finalContent = secondRun.response || secondRun.choices?.[0]?.message?.content || "";
				} else {
					// Handle Standard Output
					finalContent = response.response || response.choices?.[0]?.message?.content || "";
					// Ensure we aren't sending an object back to the UI
					if (typeof finalContent !== 'string') finalContent = JSON.stringify(finalContent);
				}

				// 7. Persist Assistant Response to D1
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", finalContent).run();

				// 8. Stream output in SSE format to Frontend
				return new Response(`data: ${JSON.stringify({ response: finalContent })}\n\ndata: [DONE]\n\n`, {
					headers: { "Content-Type": "text/event-stream" }
				});

			} catch (e: any) {
				console.error("Chat Error:", e.message);
				return new Response(`data: ${JSON.stringify({ response: "I encountered an error: " + e.message })}\n\ndata: [DONE]\n\n`, {
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
