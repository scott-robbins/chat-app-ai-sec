import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const PUBLIC_R2_URL = "https://pub-20c45c92e45947c1bac6958b971f59a1.r2.dev";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const GATEWAY_ID = "ai-sec-gateway"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async searchWeb(query: string): Promise<string> {
		try {
			const response = await fetch("https://api.tavily.com/search", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query: query, search_depth: "advanced", include_answer: true, max_results: 5 })
			});
			const data = await response.json() as any;
			if (data.answer) return `VERIFIED REAL-TIME DATA (Today: April 22, 2026): ${data.answer}`;
			return data.results.map((r: any) => `Source: ${r.url}\nContent: ${r.content}`).join("\n\n");
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
				const kvKey = activeMode === "uva" ? `uva_student_profile` : `global_user_profile`;
				const profile = await this.env.SETTINGS.get(kvKey) || "Standard Profile";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
				const storage = await this.env.DOCUMENTS.list();
				const assets = storage.objects.map(o => o.key).filter(key => !key.endsWith('/'));
				return new Response(JSON.stringify({ profile, messageCount: stats?.count || 0, knowledgeAssets: assets, status: "Live", mode: activeMode }), { headers: { "Content-Type": "application/json" } });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- 2. MEMORIZE (LINE-BY-LINE INDEXING) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const textToIndex = await file.text();
				const segment = file.name.toUpperCase().includes("UVA") ? "uva" : "personal";
				const lines = textToIndex.split('\n').filter(l => l.trim().length > 2);
				for (const line of lines) {
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [line] });
					await this.env.VECTORIZE.insert([{ id: crypto.randomUUID(), values: emb.data[0], metadata: { text: line, fileName: file.name, segment: segment } }]);
				}
				await this.env.DOCUMENTS.put(`uploads/${sessionId}/${file.name}`, await file.arrayBuffer());
				return new Response(JSON.stringify({ message: `Success: Absorbed into ${segment}` }));
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
		}

		// --- 3. CHAT (HARD STATE SYNC INTEGRATED) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMsg = messages[messages.length - 1]?.content || "";

				// Mode Switches with IMMEDIATE History Purge to prevent state confusion
				if (latestUserMsg.toLowerCase().includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "System: Switched to UVA Academic Mode. History Reset." })}\n\ndata: [DONE]\n\n`);
				}
				if (latestUserMsg.toLowerCase().includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "System: Switched to Personal Mode. History Reset." })}\n\ndata: [DONE]\n\n`);
				}
				if (latestUserMsg === "!!RESET_HISTORY") {
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "HISTORY CLEARED." })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- WEB SEARCH TRIGGER ---
				let searchResults = "";
				const webKeywords = ["celtics", "masters", "weather", "game", "score", "schedule", "who is", "when is"];
				if (webKeywords.some(k => latestUserMsg.toLowerCase().includes(k))) {
					searchResults = await this.searchWeb(`${latestUserMsg} April 2026`);
				}

				// --- VECTOR SEARCH (TopK: 40) ---
				const boostedQuery = activeMode === 'uva' ? `Syllabus CS 4750 Advisor Room Thornton Hall 1743 Dr. Thomas Jefferson` : latestUserMsg;
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [boostedQuery] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { 
					topK: 40, 
					returnMetadata: "all", 
					filter: { segment: activeMode } 
				});
				const contextText = matches.matches.map(m => m.metadata.text).join("\n");

				// --- DYNAMIC SYSTEM PROMPT ---
				let sysPrompt = `You are Jolene. CURRENT MODE: ${activeMode}. Today: ${today}.

### VERIFIED CONTEXT (MANDATORY SOURCE):
${contextText}
${searchResults}

### STRICT RULES:
1. Identify user as Scott E Robbins.
2. If Mode is 'uva', your student is Scott E Robbins. Identify advisor as Dr. Thomas Jefferson in Thornton Hall 1743.
3. If Mode is 'uva', NEVER mention family details or job titles from Personal Mode.
4. If searchResults are present, ALWAYS use them for sports/current events even in UVA mode.
5. If details are in the Context, provide them exactly. Do not say unavailable.`;

				messages.unshift({ role: "system", content: sysPrompt });
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages });
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", chatRun.response).run();
				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
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
