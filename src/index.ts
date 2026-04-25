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
			return data.answer || "No specific web results found.";
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = "Friday, April 24, 2026"; 
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				
				return new Response(JSON.stringify({ 
					profile: "Scott E Robbins | Senior Solutions Engineer", 
					messages: history.results, 
					messageCount: stats?.total || 0,
					knowledgeAssets: storage.objects.map(o => o.key), 
					status: "Live",
					mode: activeMode,
					durableObject: { id: sessionId, state: "Active", location: "Cloudflare Edge" }
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase();

				// --- 1. DEDICATED MODE SWITCHER GATE ---
				if (lowMsg.includes("switch to uva mode") || lowMsg.includes("activate uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const uvaResponse = "### 🎓 UVA Mode Activated\nI have shifted my focus to your academic documents. I am now acting as your **UVA Academic Assistant**. I will prioritize the CS 4750 Syllabus for all retrieval requests.";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
						.bind(sessionId, "user", userMsg, sessionId, "assistant", uvaResponse).run();
					return new Response(`data: ${JSON.stringify({ response: uvaResponse })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const personalResponse = "### 🏠 Personal Mode Activated\nI am back in Personal Mode. I will prioritize your tax documents, family lore, and dog namesake history.";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
						.bind(sessionId, "user", userMsg, sessionId, "assistant", personalResponse).run();
					return new Response(`data: ${JSON.stringify({ response: personalResponse })}\n\ndata: [DONE]\n\n`);
				}

				// --- 2. STANDARD LOGIC ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				let webContext = "";
				if (["celtics", "tonight", "weather", "sports", "date"].some(k => lowMsg.includes(k))) {
					webContext = await this.searchWeb(`${userMsg} ${today}`);
				}

				const retrievalKey = activeMode === 'personal' 
					? `Scott Robbins Cloudflare Senior Solutions Engineer Renee Bryana Callan Josie Jolene Hanna tax engagement` 
					: `UVA CS 4750 Syllabus Instructor Advisor Thomas Jefferson Room Thornton Hall`;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 50, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");

				const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 15").bind(sessionId).all();
				
				const sysPrompt = `### IDENTITY:
- USER: Scott E Robbins. ASSISTANT: Jolene.
- CURRENT MODE: ${activeMode === 'uva' ? 'UVA Academic Assistant' : 'Personal Assistant'}.
- ORIGIN: Named after Scott's dog (named after Ray LaMontagne song). 

### CONTEXT:
DATE: ${today}
RETRIEVED_FILE_DATA: ${fileContext}
RETRIEVED_WEB_DATA: ${webContext}

### UVA RULES (ACTIVE IF MODE IS UVA):
1. Prioritize CS 4750 Syllabus info. If asked about an advisor or room, check FILE_DATA.
2. Maintain a scholarly but helpful academic persona.

### PERSONAL RULES (ACTIVE IF MODE IS PERSONAL):
1. Prioritize Tax Letter ($375 fee) and family info.`;

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
