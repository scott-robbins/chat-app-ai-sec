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
			return data.answer || "Search performed.";
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = "Friday, April 24, 2026"; 
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. THE PERSISTENCE ENGINE (DASHBOARD LOAD) ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				
				return new Response(JSON.stringify({ 
					profile: "Scott E Robbins | Senior Solutions Engineer", 
					messages: history.results, 
					knowledgeAssets: storage.objects.map(o => o.key),
					mode: activeMode,
					status: "Live"
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 2. THE CHAT ENGINE (WITH IDENTITY FIXES) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;

				if (userMsg === "!!RESET_HISTORY") {
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "Memory Cleared." })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- LIVE SEARCH (TRIGGERED BY SPORTS/DATES) ---
				let webContext = "";
				if (["celtics", "76ers", "tonight", "weather", "sports"].some(k => userMsg.toLowerCase().includes(k))) {
					webContext = await this.searchWeb(`${userMsg} ${today}`);
				}

				// --- VECTOR RETRIEVAL (TopK: 50) ---
				const retrievalKey = activeMode === 'personal' 
					? `Scott Robbins Cloudflare Senior Solutions Engineer wife Renee married 2010 met 1993 daughter Bryana grandkids Callan Josie dogs Jolene Hanna` 
					: `Syllabus CS 4750 Advisor Dr. Thomas Jefferson Thornton Hall`;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 50, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");

				const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 15").bind(sessionId).all();
				
				const sysPrompt = `### IDENTITY RULES:
- USER: Scott E Robbins (Senior Solutions Engineer at Cloudflare).
- YOU: Jolene (AI Assistant). 
- THE DOG: Jolene (Dachshund). You are NOT the dog.
- WIFE: Renee (Married 2010). Do NOT act like the wife or call Scott "Sweetheart".

### CURRENT CONTEXT:
DATE: ${today}
MODE: ${activeMode}
FILE DATA: ${fileContext}
WEB DATA: ${webContext}

### INSTRUCTIONS:
1. Use FILE DATA for family/pet questions. Identify grandkids Callan (3) and Josie (2).
2. Use WEB DATA for sports. If search results show a Celtics game, report it.
3. Be professional. Never claim to be a human or a pet.`;

				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: sysPrompt }, ...historyResults.results, { role: "user", content: userMsg }] 
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
