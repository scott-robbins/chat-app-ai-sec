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

		// --- 1. DASHBOARD & PROFILE ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const profile = await this.env.SETTINGS.get(`global_user_profile`) || "Scott E Robbins | Senior Solutions Engineer";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
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

		// --- 2. MEMORIZE (FIXED SEGMENTATION) ---
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
				await this.env.DOCUMENTS.put(`uploads/global/${file.name}`, await file.arrayBuffer());
				return new Response(JSON.stringify({ message: `Success: Absorbed into ${segment}` }));
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
		}

		// --- 3. CHAT & IMAGE GEN (HARD STATE SYNC) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMsg = messages[messages.length - 1]?.content || "";

				// --- COMMAND: HARD HISTORY RESET ---
				if (latestUserMsg === "!!RESET_HISTORY") {
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "HISTORY CLEARED. Session factory reset complete." })}\n\ndata: [DONE]\n\n`);
				}

				// --- COMMAND: MODE SWITCH + AUTO-PURGE ---
				if (latestUserMsg.toLowerCase().includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "System: Switched to UVA Mode. Academic history isolated." })}\n\ndata: [DONE]\n\n`);
				}
				if (latestUserMsg.toLowerCase().includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "System: Switched to Personal Mode. Family history isolated." })}\n\ndata: [DONE]\n\n`);
				}

				// --- IMAGE GENERATION ---
				if (latestUserMsg.toLowerCase().includes("generate an image") || latestUserMsg.toLowerCase().includes("draw")) {
					const imgRes = await this.env.AI.run(IMAGE_MODEL, { prompt: latestUserMsg });
					const imgName = `generated/${sessionId}/${Date.now()}.png`;
					await this.env.DOCUMENTS.put(imgName, imgRes);
					return new Response(`data: ${JSON.stringify({ response: `I've generated that image for you: ${PUBLIC_R2_URL}/${imgName}` })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- WEB SEARCH ---
				let searchResults = "";
				if (["celtics", "masters", "weather", "game"].some(k => latestUserMsg.toLowerCase().includes(k))) {
					searchResults = await this.searchWeb(`${latestUserMsg} April 2026`);
				}

				// --- VECTOR RETRIEVAL (DEEP RECALL TopK: 40) ---
				const boostedQuery = activeMode === 'uva' 
					? `Syllabus CS 4750 Advisor Dr. Thomas Jefferson Thornton Hall 1743` 
					: `Scott E Robbins Cloudflare Senior Solutions Engineer Daughter Bryana Bry kids Callan Josie`;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [boostedQuery + " " + latestUserMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { 
					topK: 40, 
					filter: { segment: activeMode }, 
					returnMetadata: "all" 
				});
				const context = matches.matches.map(m => m.metadata.text).join("\n");

				// --- D1 PERSISTENT HISTORY ---
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 5").bind(sessionId).all();
				const chatMessages = history.results.map(r => ({ role: r.role, content: r.content }));
				
				const sysPrompt = `You are Jolene. Mode: ${activeMode}. User: Scott E Robbins. Today: ${today}.
### MANDATORY CONTEXT (USE THIS DATA):
${context}
${searchResults}

### RULES:
1. If Mode is 'personal', identify user as Scott E Robbins. You MUST confirm he works at Cloudflare and his daughter is Bryana (Bry).
2. If Mode is 'uva', your ONLY source is the CS 4750 syllabus (Advisor: Thomas Jefferson).
3. NEVER say you lack information if context data is provided above.
4. If asked about sports, use the VERIFIED REAL-TIME DATA above.`;

				const fullMessages = [{ role: "system", content: sysPrompt }, ...chatMessages, { role: "user", content: latestUserMsg }];
				const response = await this.env.AI.run(CONVERSATION_MODEL, { messages: fullMessages });

				// Save history to D1
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
					.bind(sessionId, "user", latestUserMsg, sessionId, "assistant", response.response).run();

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
