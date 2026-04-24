import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async searchWeb(query: string): Promise<string> {
		try {
			const response = await fetch("https://api.tavily.com/search", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query, search_depth: "advanced", include_answer: true, max_results: 5 })
			});
			const data = await response.json() as any;
			return data.answer || "Search did not yield a specific result.";
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = "Friday, April 24, 2026"; 
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. PROFILE & REFRESH PERSISTENCE ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				
				// Returning 'messages' inside the profile object to force frontend persistence
				return new Response(JSON.stringify({ 
					profile: "Scott E Robbins | Senior Solutions Engineer", 
					messages: history.results, 
					knowledgeAssets: storage.objects.map(o => o.key), 
					status: "Live",
					mode: activeMode 
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 2. CHAT ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;

				if (userMsg === "!!RESET_HISTORY") {
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "System Memory Reset." })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- DYNAMIC SEARCH & RETRIEVAL ---
				let webContext = "";
				if (["celtics", "76ers", "tonight", "weather"].some(k => userMsg.toLowerCase().includes(k))) {
					webContext = await this.searchWeb(`${userMsg} tonight ${today}`);
				}

				// Unified Retrieval Key for Personal Mode
				const retrievalQuery = activeMode === 'personal' 
					? `wife Renee daughter Bryana dogs Jolene Hanna dachshunds grandkids Callan Josie` 
					: `Syllabus CS 4750 Advisor Thomas Jefferson Room 1743`;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalQuery + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 20, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");

				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 10").bind(sessionId).all();
				
				const sysPrompt = `You are Jolene, Scott's AI Assistant. Mode: ${activeMode}.
DATE: ${today}.
### DOCUMENT CONTEXT:
${fileContext}
### WEB CONTEXT:
${webContext}

### INSTRUCTIONS:
1. Identify family/pets ONLY using DOCUMENT CONTEXT. 
   - Grandkids: Callan (3), Josie (2)[cite: 7]. 
   - Dogs: Jolene (oldest), Hanna (youngest). Both mini dachshunds[cite: 11, 12].
2. Use WEB CONTEXT for sports/dates.
3. If information is in the DOCUMENT CONTEXT, do not say you don't have it.`;

				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: sysPrompt }, ...history.results, { role: "user", content: userMsg }] 
				});

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
					.bind(sessionId, "user", userMsg, sessionId, "assistant", chatRun.response).run();

				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
