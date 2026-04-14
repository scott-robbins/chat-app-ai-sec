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

	// --- TAVILY SEARCH ---
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

		// --- 1. DASHBOARD: ANALYTICS & MODE ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const kvKey = activeMode === "uva" ? `uva_student_profile` : `global_user_profile`;
				const profile = await this.env.SETTINGS.get(kvKey) || "Standard Profile";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
				const storage = await this.env.DOCUMENTS.list();
				const assets = storage.objects.map(o => o.key).filter(key => !key.endsWith('/'));
				return new Response(JSON.stringify({ 
					profile: profile, 
					messageCount: stats?.count || 0, 
					knowledgeAssets: assets, 
					status: "Live", 
					mode: activeMode 
				}), { headers: { "Content-Type": "application/json" } });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- 2. HISTORY FETCH ---
		if (url.pathname === "/api/history") {
			const messages = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC").bind(sessionId).all();
			return new Response(JSON.stringify(messages.results), { headers: { "Content-Type": "application/json" } });
		}

		// --- 3. DELETE FILE ---
		if (url.pathname === "/api/delete-file" && request.method === "POST") {
			const { key } = await request.json() as any;
			await this.env.DOCUMENTS.delete(key);
			return new Response(JSON.stringify({ message: "Deleted" }));
		}

		// --- 4. MEMORIZE (SEGMENTED TAGGING) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const textToIndex = await file.text();
				const segment = file.name.toUpperCase().includes("UVA") ? "uva" : "personal";
				const chunks = textToIndex.split(/\n\n/).filter(c => c.trim().length > 0);
				for (const chunk of chunks) {
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text: chunk, fileName: file.name, sessionId, segment: segment } 
					}]);
				}
				await this.env.DOCUMENTS.put(`uploads/${sessionId}/${file.name}`, await file.arrayBuffer());
				return new Response(JSON.stringify({ message: `Stored in ${segment}` }));
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
		}

		// --- 5. CHAT LOGIC ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMsg = messages[messages.length - 1]?.content || "";

				// Context Switch Hooks
				if (latestUserMsg.toLowerCase().includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const msg = "System: Switched to UVA Academic Mode. How can I help with your studies, Wahoo?";
					return new Response(`data: ${JSON.stringify({ response: msg })}\n\ndata: [DONE]\n\n`);
				}
				if (latestUserMsg.toLowerCase().includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const msg = "System: Switched to Personal Mode. Family and sports focus active.";
					return new Response(`data: ${JSON.stringify({ response: msg })}\n\ndata: [DONE]\n\n`);
				}

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMsg).run();

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const kvKey = activeMode === "uva" ? `uva_student_profile` : `global_user_profile`;
				const currentProfile = await this.env.SETTINGS.get(kvKey) || "New Profile";

				// --- IDENTITY MODULE (STRICT FACT EXTRACTION) ---
				const profileCheck = await this.env.AI.run(REASONING_MODEL, {
					messages: [
						{ role: 'system', content: `Extract permanent user facts for a ${activeMode} profile. IGNORE questions and AI chatter. Output ONLY a clean comma-separated string or 'NONE'.` },
						{ role: 'user', content: `Current: "${currentProfile}"\nNew: "${latestUserMsg}"` }
					]
				});
				const cleaned = profileCheck.response?.replace(/^["']|["']$/g, '').trim() || "";
				if (cleaned && cleaned !== "NONE" && cleaned.length < 500) {
					await this.env.SETTINGS.put(kvKey, cleaned);
				}

				// --- VECTOR MEMORY (FILTERED) ---
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { 
					topK: 5, 
					returnMetadata: "all",
					filter: { segment: activeMode } 
				});
				const contextText = matches.matches.map(m => m.metadata.text).join("\n\n");

				// Search Logic
				const subjectCheck = await this.env.AI.run(REASONING_MODEL, {
					prompt: `Review context. Identify subject. Ignore dog persona. Output name ONLY or 'NONE'.`
				});
				const primarySubject = subjectCheck.response && !subjectCheck.response.includes("NONE") ? subjectCheck.response.replace(/^["']|["']$/g, '').trim() : "";

				const searchCheck = await this.env.AI.run(REASONING_MODEL, { 
					prompt: `Today is ${today}. Does "${latestUserMsg}" require LIVE info? Respond ONLY 'YES' or 'NO'.` 
				});
				
				let searchResults = "";
				if (searchCheck.response?.includes("YES")) { 
					searchResults = await this.searchWeb(`LIVE score and play-by-play for ${primarySubject || latestUserMsg} on ${today}`); 
				}

				// Final System Prompt
				let sysPrompt = `You are Jolene, a sophisticated professional assistant. 
MODE: ${activeMode === 'uva' ? 'UVA Academic Success Agent' : 'Personal Executive Assistant'}
Today: ${today}
Subject: ${primarySubject}
Search: ${searchResults}
Memory: ${contextText}
Profile: ${currentProfile}
Constraint: NEVER adopt a dog persona. If in UVA mode, use an academic tone.`;

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

// MANDATORY ES MODULE EXPORT
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
