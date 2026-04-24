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
			return data.answer ? `VERIFIED LIVE SPORTS DATA: ${data.answer}` : data.results.map((r: any) => r.content).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = "Friday, April 24, 2026"; 
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. PROFILE (NOW WITH AUTO-HISTORY BUNDLING) ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const profile = await this.env.SETTINGS.get(`global_user_profile`) || "Scott E Robbins | Senior Solutions Engineer";
				
				// CRITICAL: Fetch history here so the frontend gets it via the profile call
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				
				const storage = await this.env.DOCUMENTS.list();
				const assets = storage.objects.map(o => o.key);

				return new Response(JSON.stringify({ 
					profile, 
					messages: history.results, // Bundled for persistence on refresh
					messageCount: history.results.length,
					knowledgeAssets: assets, 
					status: "Live", 
					mode: activeMode 
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 2. CHAT & IMAGE GEN ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
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

				// --- VECTOR RETRIEVAL ---
				const searchKey = activeMode === 'personal' 
					? `Wife Renee married 2010 met 1993 daughter Bryana 31 grandkids Callan 3 Josie 2 dogs Jolene Hanna` 
					: `Syllabus CS 4750 Advisor Thomas Jefferson Room 1743 Thornton Hall`;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [searchKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 50, filter: { segment: activeMode }, returnMetadata: "all" });
				const context = matches.matches.map(m => m.metadata.text).join("\n");

				// Pull D1 History for the LLM
				const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 20").bind(sessionId).all();
				const chatHistory = historyResults.results.map(r => ({ role: r.role, content: r.content }));
				
				const sysPrompt = `You are Jolene. Mode: ${activeMode}. Today is ${today}.
SCOTT'S LIFE: Wife is Renee[cite: 3]. Daughter is Bryana (31)[cite: 5]. Grandkids are Callan (3) and Josie (2)[cite: 7]. Dogs are Jolene and Hanna[cite: 11, 12].
CONTEXT: ${context}
WEB: ${searchResults}

RULES:
1. Use Web Data for sports TONIGHT. If Web says Celtics play 76ers, that is the truth.
2. Identify Callan and Josie as grandkids.
3. You are an AI assistant, not a human family member.`;

				const finalMessages = [{ role: "system", content: sysPrompt }, ...chatHistory, { role: "user", content: userMsg }];
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages: finalMessages });

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
