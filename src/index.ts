import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const PUBLIC_R2_URL = "https://pub-20c45c92e45947c1bac6958b971f59a1.r2.dev";
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
			return data.answer ? `CURRENT LIVE DATA: ${data.answer}` : data.results.map((r: any) => r.content).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = "Friday, April 24, 2026"; // Lock today's date for the Celtics game
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. PROFILE & KNOWLEDGE ---
		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const profile = await this.env.SETTINGS.get(`global_user_profile`) || "Scott E Robbins | Senior Solutions Engineer";
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({ 
				profile, 
				knowledgeAssets: storage.objects.map(o => o.key), 
				status: "Live", 
				mode: activeMode 
			}), { headers });
		}

		// --- 2. CHAT & PERSISTENCE (GET for History, POST for Chat) ---
		if (url.pathname === "/api/chat") {
			// GET: Explicitly handle history fetch for frontend persistence
			if (request.method === "GET") {
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC").bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results }), { headers });
			}

			// POST: Handle new messages
			if (request.method === "POST") {
				try {
					const body = await request.json() as any;
					let messages = body.messages || [];
					const userMsg = messages[messages.length - 1]?.content || "";

					if (userMsg === "!!RESET_HISTORY") {
						await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
						return new Response(`data: ${JSON.stringify({ response: "History Purged." })}\n\ndata: [DONE]\n\n`);
					}

					const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

					// --- LIVE SEARCH (MANDATORY FOR SPORTS) ---
					let searchResults = "";
					const needsWeb = ["celtics", "76ers", "game", "tonight", "score"].some(k => userMsg.toLowerCase().includes(k));
					if (needsWeb) {
						searchResults = await this.searchWeb(`Boston Celtics vs Philadelphia 76ers tonight ${today}`);
					}

					// --- VECTOR SEARCH ---
					const searchKey = activeMode === 'personal' 
						? `Grandkids Callan 3 Josie 2 wife Renee daughter Bryana dogs Jolene Hanna` 
						: `CS 4750 Syllabus Advisor Thomas Jefferson Room 1743`;

					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [searchKey + " " + userMsg] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, filter: { segment: activeMode }, returnMetadata: "all" });
					const context = matches.matches.map(m => m.metadata.text).join("\n");

					const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 10").bind(sessionId).all();
					
					const sysPrompt = `You are Jolene. Mode: ${activeMode}. Today is ${today}.
SCOTT'S LIFE: Wife is Renee. Daughter is Bryana (31). Grandkids are Callan (3) and Josie (2). Dogs are Jolene and Hanna.
CONTEXT DATA: ${context}
WEB DATA: ${searchResults}

RULES:
1. ALWAYS prioritize WEB DATA for tonight's sports. If Web says Celtics play the 76ers tonight, state that.
2. If asked about grandkids, identify Callan and Josie.
3. Be professional and accurate.`;

					const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
						messages: [{ role: "system", content: sysPrompt }, ...historyResults.results, { role: "user", content: userMsg }] 
					});

					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
						.bind(sessionId, "user", userMsg, sessionId, "assistant", chatRun.response).run();

					return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
				} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: e.message })}\n\ndata: [DONE]\n\n`); }
			}
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
