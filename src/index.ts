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
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					api_key: this.env.TAVILY_API_KEY,
					query: query,
					search_depth: "advanced",
					include_answer: true,
					max_results: 5
				})
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

		// --- 1. DASHBOARD & ANALYTICS ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const kvKey = activeMode === "uva" ? `uva_student_profile` : `global_user_profile`;
				const profile = await this.env.SETTINGS.get(kvKey) || "Standard Profile";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
				const storage = await this.env.DOCUMENTS.list();
				const assets = storage.objects.map(o => o.key).filter(key => !key.endsWith('/'));
				return new Response(JSON.stringify({ 
					profile, 
					messageCount: stats?.count || 0, 
					knowledgeAssets: assets, 
					status: "Live", 
					mode: activeMode 
				}), { headers: { "Content-Type": "application/json" } });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- 2. DELETE FILE (FIXED PATH LOGIC) ---
		if (url.pathname === "/api/delete-file" && request.method === "POST") {
			try {
				const { key } = await request.json() as any;
				// R2 delete requires the exact key as it appears in the sidebar list
				await this.env.DOCUMENTS.delete(key);
				return new Response(JSON.stringify({ message: "Deleted successfully" }));
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- 3. MEMORIZE (LINE-BY-LINE INDEXING) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const textToIndex = await file.text();
				const segment = file.name.toUpperCase().includes("UVA") ? "uva" : "personal";
				
				// Granular indexing: process every line so specific facts aren't lost
				const lines = textToIndex.split('\n').filter(l => l.trim().length > 5);
				for (const line of lines) {
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [line] });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text: line, fileName: file.name, sessionId, segment: segment } 
					}]);
				}
				// Save with full path to match the UI expectations
				await this.env.DOCUMENTS.put(`uploads/${sessionId}/${file.name}`, await file.arrayBuffer());
				return new Response(JSON.stringify({ message: `Knowledge Absorbed into ${segment}!` }));
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
		}

		// --- 4. CHAT LOGIC ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMsg = messages[messages.length - 1]?.content || "";

				// State Switches
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

				// --- NUCLEAR RETRIEVAL (TopK: 10) ---
				const boostedQuery = `${activeMode} context: ${latestUserMsg}`;
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [boostedQuery] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { 
					topK: 10, 
					returnMetadata: "all", 
					filter: { segment: activeMode } 
				});
				const contextText = matches.matches.map(m => m.metadata.text).join("\n");

				// Search logic
				const searchCheck = await this.env.AI.run(REASONING_MODEL, { 
					prompt: `Today is ${today}. Does "${latestUserMsg}" require LIVE info? Respond ONLY 'YES' or 'NO'.` 
				});
				let searchResults = "";
				if (searchCheck.response?.includes("YES")) { searchResults = await this.searchWeb(latestUserMsg); }

				// --- FINAL SYSTEM PROMPT ---
				let sysPrompt = `You are Jolene, a sophisticated professional assistant. 
MODE: ${activeMode === 'uva' ? 'UVA Academic Agent' : 'Personal Executive Assistant'}
Today: ${today}

### MANDATORY DATA SOURCE:
${contextText}

### RULES:
1. You MUST use the "MANDATORY DATA SOURCE" for all personal or academic facts.
2. If the user asks about family, syllabus details, or names, and it is in the text above, you MUST provide it exactly.
3. If it is NOT in the text, say: "I don't see that specific detail in the uploaded files."
4. Tone: Helpful and professional. NEVER use a dog persona.`;

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
