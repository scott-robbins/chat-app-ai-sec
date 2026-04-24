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

		// --- 1. DASHBOARD & PROFILE ---
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
					durableObject: {
						id: sessionId,
						state: "Active",
						location: "Cloudflare Edge"
					}
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 2. MEMORIZE (R2 Write & Vector Indexing) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				await this.env.DOCUMENTS.put(file.name, await file.arrayBuffer(), {
					customMetadata: { segment: activeMode }
				});

				const text = await file.text();
				const chunks = text.match(/[\s\S]{1,1500}/g) || [];
				
				for (const chunk of chunks) {
					const embedding = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
					await this.env.VECTORIZE.insert([{
						id: crypto.randomUUID(),
						values: embedding.data[0],
						metadata: { text: chunk, segment: activeMode, source: file.name }
					}]);
				}

				return new Response(JSON.stringify({ success: true }), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 3. CHAT ENGINE ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;

				if (userMsg === "!!RESET_HISTORY") {
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "System Memory Reset." })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				let webContext = "";
				if (["celtics", "76ers", "tonight", "weather", "sports", "date"].some(k => userMsg.toLowerCase().includes(k))) {
					webContext = await this.searchWeb(`${userMsg} ${today}`);
				}

				// Enhanced Retrieval Key to include Tax/Cozby keywords
				const retrievalKey = activeMode === 'personal' 
					? `Scott Robbins Cloudflare Senior Solutions Engineer Renee Bryana Callan Josie Jolene Hanna dachshunds 2025 Tax Engagement Letter Cozby CPA fees deadlines base fee hourly rate` 
					: `Syllabus CS 4750 Advisor Dr. Thomas Jefferson Thornton Hall`;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 50, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");

				const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 15").bind(sessionId).all();
				
				const sysPrompt = `### IDENTITY & ORIGIN:
- USER: Scott E Robbins (Senior Solutions Engineer at Cloudflare).
- ASSISTANT: Jolene (Professional AI).
- NAMING: You were named after Scott's oldest dog, Jolene (a Mini Dachshund). 
- MUSIC LORE: The dog Jolene was named after the **Ray LaMontagne song "Jolene"**.
- CRITICAL: You are an AI named after a dog who was named after a song. You were NOT named after the Dolly Parton song. Do not mention Dolly Parton.

### FAMILY & PETS:
- Wife Renee (m. 2010), Daughter Bryana (31), Grandkids Callan (3) & Josie (2).
- Dogs: Jolene (Your Namesake) and Hanna (Youngest). Both are Mini Dachshunds.

### CONTEXT:
DATE: ${today}
RETRIEVED_FILE_DATA: ${fileContext}
RETRIEVED_WEB_DATA: ${webContext}

### RULES:
1. TAX DATA: Use RETRIEVED_FILE_DATA to answer questions about the 2025 Tax Engagement Letter. Look for the base fee ($375), hourly rate ($275), and information deadline (March 13, 2026).
2. MANDATORY: Scott's dogs are JOLENE and HANNA. 
3. ORIGIN: If asked about your name, clarify that you were named after Scott's dog, who was named after the Ray LaMontagne song.`;

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
