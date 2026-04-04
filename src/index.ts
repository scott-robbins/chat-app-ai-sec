import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "default";

		// --- GET HISTORY ---
		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare(
				"SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
			).bind(sessionId).all();
			return new Response(JSON.stringify({ messages: results }), { headers: { "Content-Type": "application/json" } });
		}

		// --- CHAT ENDPOINT ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";
				
				// Capture the model from the UI selector
				const selectedModel = body.model || DEFAULT_MODEL;

				// 1. Log User Message to D1
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				// 2. RAG Logic (Vector Search)
				let contextText = "";
				try {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 1, returnMetadata: "all" });
					if (matches.matches.length > 0 && matches.matches[0].score > 0.6) {
						contextText = matches.matches[0].metadata?.text;
					}
				} catch (e) {
					console.error("Vectorize error:", e);
				}

				// 3. Updated Tools Definition (New API Syntax)
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

				// 4. Prepare System Prompt
				let sysPrompt = "You are Jolene. Give a natural, conversational response. If you use a tool, summarize the result for a human.";
				if (contextText) sysPrompt += ` Use this Knowledge for context: ${contextText}`;
				
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: "system", content: sysPrompt });

				// 5. Initial AI Call (Check for Tool Calling)
				const response = await this.env.AI.run(selectedModel, { messages, tools, stream: false });

				let finalContent = "";

				// 6. Handle Tool Calls if the AI decides to use them
				if (response.tool_calls && response.tool_calls.length > 0) {
					const tc = response.tool_calls[0];
					const args = JSON.parse(tc.arguments);
					
					let toolOutput = "";
					if (tc.name === "get_weather") {
						toolOutput = `The current weather in ${args.location || 'your area'} is 72°F and sunny.`;
					} else if (tc.name === "sec_status") {
						toolOutput = "AI-SEC Protocol: All firewalls active. Security gates closed. No unauthorized access detected.";
					}
					
					// Add the tool's result to the message chain
					messages.push(response);
					messages.push({ 
						role: "tool", 
						name: tc.name, 
						content: toolOutput, 
						tool_call_id: tc.id 
					});

					// Second call to get the final conversational response
					const secondRun = await this.env.AI.run(selectedModel, { messages });
					finalContent = secondRun.response || secondRun.choices?.[0]?.message?.content || "I've checked that for you, but I'm having trouble phrasing the update.";
				} else {
					// Standard text response (RAG or General)
					finalContent = response.response || response.choices?.[0]?.message?.content || "";
					if (typeof finalContent !== 'string') finalContent = JSON.stringify(finalContent);
				}

				// 7. Save Assistant Response to D1
				await this.env.jolene_db.prepare("INSERT INTO messages (session_
