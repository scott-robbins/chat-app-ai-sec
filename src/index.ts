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
			return data.answer ? `VERIFIED LIVE DATA: ${data.answer}` : data.results.map((r: any) => r.content).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = "Friday, April 24, 2026"; 
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. PROFILE & AUTO-HYDRATION (The Persistence Fix) ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const profile = await this.env.SETTINGS.get(`global_user_profile`) || "Scott E Robbins | Senior Solutions Engineer";
				
				// WE BUNDLE THE HISTORY HERE: Since the UI calls this on load, 
                // this "force-feeds" the old chat back to the screen.
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				
				const storage = await this.env.DOCUMENTS.list();
				const assets = storage.objects.map(o => o.key);

				return new Response(JSON.stringify({ 
					profile, 
					messages: history.results, 
					messageCount: history.results.length,
					knowledgeAssets: assets, 
					status: "Live", 
					mode: activeMode 
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 2. CHAT & IMAGE GENERATION ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const userMsg = messages[messages.length - 1]?.content || "";

				// Reset Logic
				if (userMsg === "!!RESET_HISTORY") {
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "System Factory Reset Complete." })}\n\ndata: [DONE]\n\n`);
				}

				// Image Generation
				if (userMsg.toLowerCase().includes("generate an image") || userMsg.toLowerCase().includes("draw")) {
					const imgRes = await this.env.AI.run(IMAGE_MODEL, { prompt: userMsg });
					const imgName = `generated/${sessionId}/${Date.now()}.png`;
					await this.env.DOCUMENTS.put(imgName, imgRes);
					return new Response(`data: ${JSON.stringify({ response: `Generated: ${PUBLIC_R2_URL}/${imgName}` })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- WEB SEARCH (SPORTS/LIVE DATA) ---
				let searchResults = "";
				const sportsTrigger = ["celtics", "76ers", "game", "tonight", "score", "weather"].some(k => userMsg.toLowerCase().includes(k));
				if (sportsTrigger) {
					searchResults = await this.searchWeb(`${userMsg} for ${today}`);
				}

				// --- VECTOR SEARCH (TopK: 50) ---
				const searchKey = activeMode === 'personal' 
					? `Wife Renee married 2010 met 1993 daughter Bryana 31 grandkids Callan 3 Josie 2 dogs Jolene Hanna` 
					: `Syllabus CS 4750 Advisor Thomas Jefferson Room 1743 Thornton Hall`;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [searchKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 50, filter: { segment: activeMode }, returnMetadata: "all" });
				const context = matches.matches.map(m => m.metadata.text).join("\n");

				// Pull History for LLM Context
				const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 20").bind(sessionId).all();
				const chatHistory = historyResults.results.map(r => ({ role: r.role, content: r.content }));
				
				const sysPrompt = `You are Jolene, Scott's AI Assistant. Mode: ${activeMode}.
### FACTS:
- Wife: Renee.
- Daughter: Bryana (31).
- Grandkids: Callan (3) and Josie (2).
- Dogs: Jolene and Hanna.
- You are an AI, NOT a human.

### CONTEXT & SEARCH:
${context}
${searchResults}

RULES: Identify grandkids Callan and Josie by name and age. Use Web Data for sports.`;

				const finalMessages = [{ role: "system", content: sysPrompt }, ...chatHistory, { role: "user", content: userMsg }];
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages: finalMessages });

				// Persist to D1 SQL
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
