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
			if (data.answer) return `VERIFIED REAL-TIME DATA: ${data.answer}`;
			return data.results.map((r: any) => `Source: ${r.url}\nContent: ${r.content}`).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

		// --- 1. ANALYTICS ---
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

		// --- 2. DELETE/WIPE ---
		if (url.pathname === "/api/delete-file" && request.method === "POST") {
			try {
				const { key } = await request.json() as any;
				await this.env.DOCUMENTS.delete(key);
				return new Response(JSON.stringify({ message: "Deleted successfully" }));
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- 3. MEMORIZE (GRANULAR INDEXING) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const textToIndex = await file.text();
				const segment = file.name.toUpperCase().includes("UVA") ? "uva" : "personal";
				
				// Break into individual phrases for high-precision matching
				const lines = textToIndex.split('\n').filter(l => l.trim().length > 2);
				for (const line of lines) {
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [line] });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text: line, fileName: file.name, sessionId, segment: segment } 
					}]);
				}
				await this.env.DOCUMENTS.put(`uploads/${sessionId}/${file.name}`, await file.arrayBuffer());
				return new Response(JSON.stringify({ message: `Knowledge Absorbed into ${segment}!` }));
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
		}

		// --- 4. CHAT (HIGH-PRECISION RECALL) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMsg = messages[messages.length - 1]?.content || "";

				// --- MANUAL OVERRIDES ---
				if (latestUserMsg === "!!WIPE_SYSTEM") {
					const objects = await this.env.DOCUMENTS.list();
					for (const obj of objects.objects) { await this.env.DOCUMENTS.delete(obj.key); }
					return new Response(`data: ${JSON.stringify({ response: "SYSTEM WIPE COMPLETE." })}\n\ndata: [DONE]\n\n`);
				}
				if (latestUserMsg === "!!RESET_HISTORY") {
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "HISTORY CLEARED." })}\n\ndata: [DONE]\n\n`);
				}

				if (latestUserMsg.toLowerCase().includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					return new Response(`data: ${JSON.stringify({ response: "System: Switched to UVA Academic Mode." })}\n\ndata: [DONE]\n\n`);
				}
				if (latestUserMsg.toLowerCase().includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					return new Response(`data: ${JSON.stringify({ response: "System: Switched to Personal Mode." })}\n\ndata: [DONE]\n\n`);
				}

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMsg).run();

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- ENHANCED EXHAUSTIVE RETRIEVAL (TOPK: 30) ---
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { 
					topK: 30, 
					returnMetadata: "all", 
					filter: { segment: activeMode } 
				});
				const contextText = matches.matches.map(m => `• ${m.metadata.text}`).join("\n");

				let sysPrompt = `You are Jolene, a sophisticated professional assistant. 
MODE: ${activeMode === 'uva' ? 'UVA Academic Agent' : 'Personal Executive Assistant'}
Today: ${today}

### MANDATORY DATA SOURCE FROM UPLOADED FILES:
${contextText}

### STRICT INSTRUCTIONS:
1. You MUST answer using the "MANDATORY DATA SOURCE" above.
2. If the user asks for a job title, you MUST provide the full title (e.g., Senior Solutions Engineer).
3. If the user asks for a daughter's name, identify her as Bryana.
4. DO NOT summarize or guess titles like "Executive." Read the lines exactly.
5. Tone: Formal and helpful. No dog persona.`;

				messages.unshift({ role: "system", content: sysPrompt });
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages });
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").bind(sessionId, "assistant", chatRun.response).run();
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
