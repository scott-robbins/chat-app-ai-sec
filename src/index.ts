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
			return data.answer ? `VERIFIED REAL-TIME DATA: ${data.answer}` : data.results.map((r: any) => r.content).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

		// --- 1. DASHBOARD ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const profile = await this.env.SETTINGS.get(`global_user_profile`) || "Scott E Robbins | Senior Solutions Engineer";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
				
				// List all documents in R2 to show in Dashboard
				const storage = await this.env.DOCUMENTS.list();
				const assets = storage.objects.map(o => o.key);

				return new Response(JSON.stringify({ 
					profile, 
					messageCount: stats?.count || 0, 
					knowledgeAssets: assets, 
					status: "Live", 
					mode: activeMode 
				}), { headers: { "Content-Type": "application/json" } });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- 2. MEMORIZE (FIXED: NEVER PURGE R2 ON SWITCH) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const textToIndex = await file.text();
				const segment = file.name.toUpperCase().includes("UVA") ? "uva" : "personal";
				
				const lines = textToIndex.split('\n').filter(l => l.trim().length > 2);
				for (const line of lines) {
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [line] });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text: line, fileName: file.name, segment: segment } 
					}]);
				}
				// Save to R2 with a global prefix so switches don't lose them
				await this.env.DOCUMENTS.put(`uploads/global/${file.name}`, await file.arrayBuffer());
				return new Response(JSON.stringify({ message: `Success: Absorbed into ${segment}` }));
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
		}

		// --- 3. CHAT & IMAGE GEN ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userQuery = body.messages[body.messages.length - 1].content;

				// Handle Mode Switches (PURGE D1 ONLY, NOT R2)
				if (userQuery.toLowerCase().includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "System: Switched to UVA Mode. Chat history reset." })}\n\ndata: [DONE]\n\n`);
				}
				if (userQuery.toLowerCase().includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "System: Switched to Personal Mode. Chat history reset." })}\n\ndata: [DONE]\n\n`);
				}

				// Handle Image Generation
				if (userQuery.toLowerCase().includes("generate an image") || userQuery.toLowerCase().includes("draw")) {
					const imgRes = await this.env.AI.run(IMAGE_MODEL, { prompt: userQuery });
					const imgName = `generated/${sessionId}/${Date.now()}.png`;
					await this.env.DOCUMENTS.put(imgName, imgRes);
					return new Response(`data: ${JSON.stringify({ response: `I've generated that for you: ${PUBLIC_R2_URL}/${imgName}` })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- WEB SEARCH ---
				let searchResults = "";
				if (["celtics", "masters", "weather", "game"].some(k => userQuery.toLowerCase().includes(k))) {
					searchResults = await this.searchWeb(`${userQuery} April 2026`);
				}

				// --- VECTOR RETRIEVAL ---
				const boostedQuery = activeMode === 'uva' 
					? `Syllabus CS 4750 Advisor Dr. Thomas Jefferson Thornton Hall` 
					: `Scott E Robbins Cloudflare Senior Solutions Engineer Daughter Bryana`;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [boostedQuery + " " + userQuery] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { 
					topK: 20, 
					filter: { segment: activeMode }, 
					returnMetadata: "all" 
				});
				const context = matches.matches.map(m => m.metadata.text).join("\n");

				// --- D1 PERSISTENT HISTORY ---
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 5").bind(sessionId).all();
				const chatMessages = history.results.map(r => ({ role: r.role, content: r.content }));
				
				const sysPrompt = `You are Jolene. Mode: ${activeMode}. User: Scott E Robbins. Today: ${today}.
CONTEXT: ${context}
WEB DATA: ${searchResults}
RULES: 
1. If UVA mode, use only the CS 4750 syllabus. 
2. If Personal mode, you know Scott works at Cloudflare. 
3. Prioritize context and web data over general knowledge.`;

				const fullMessages = [{ role: "system", content: sysPrompt }, ...chatMessages, { role: "user", content: userQuery }];
				const response = await this.env.AI.run(CONVERSATION_MODEL, { messages: fullMessages });

				// Save to D1
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
					.bind(sessionId, "user", userQuery, sessionId, "assistant", response.response).run();

				return new Response(`data: ${JSON.stringify({ response: response.response })}\n\ndata: [DONE]\n\n`);
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
