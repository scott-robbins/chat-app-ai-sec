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
				
				// UPDATE: Use the model the user selected in the UI
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
					{ name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { location: { type: "string" } } } },
					{ name: "sec_status", description: "Check security", parameters: { type: "object", properties: {} } }
				];

				let sysPrompt = "You are Jolene. Give a natural, conversational response. If you use a tool, summarize the result for a human.";
				if (contextText) sysPrompt += ` Knowledge: ${contextText}`;
				
				// Ensure system prompt is always at the start
				const sysIdx = messages.findIndex((m: any) => m.role === 'system');
				if (sysIdx !== -1) messages[sysIdx].content = sysPrompt;
				else messages.unshift({ role: "system", content: sysPrompt });

				// Use selectedModel here
				const response = await this.env.AI.run(selectedModel, { messages, tools, stream: false });

				let finalContent = "";

				if (response.tool_calls && response.tool_calls.length > 0) {
					const tc = response.tool_calls[0];
					const args = JSON.parse(tc.arguments);
					let toolOutput = (tc.name === "get_weather") ? `72°F in ${args.location}` : "AI-SEC Status: Systems Green.";
					
					messages.push(response);
					messages.push({ role: "tool", name: tc.name, content: toolOutput, tool_call_id: tc.id });

					const secondRun = await this.env.AI.run(selectedModel, { messages });
					finalContent = secondRun.response || secondRun.choices?.[0]?.message?.content || "";
				} else {
					finalContent = response.response || response.choices?.[0]?.message?.content || "";
					// Final check to make sure it's a string
					if (typeof finalContent !== 'string') finalContent = JSON.stringify(finalContent);
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
