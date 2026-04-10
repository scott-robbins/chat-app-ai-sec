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
			if (data.answer) return `VERIFIED FACTUAL SUMMARY: ${data.answer}`;
			return data.results.map((r: any) => `Source: ${r.url}\nContent: ${r.content}`).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	// --- ENCAPSULATED BRIEFING LOGIC ---
	async runMorningBriefing(sessionId: string) {
		try {
			const interests = "MMA/UFC, Boston Celtics, New England Patriots, Cloudflare news, major US politics, and premium streaming movies/TV series (no NBC/ABC/CBS)";
			const newsContext = await this.searchWeb(`Latest news on ${interests}`);
			
			const briefingPrompt = `You are Jolene. Generate a polished executive morning briefing based on this news: ${newsContext}. Focus on: ${interests}. Keep it professional, direct, and formatted with headers.`;

			const briefing = await this.env.AI.run(REASONING_MODEL, { prompt: briefingPrompt }, { gateway: GATEWAY_ID });
			const finalBriefing = `☀️ **GOOD MORNING BRIEFING**\n\n${briefing.response}`;

			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, "assistant", finalBriefing).run();

			return finalBriefing;
		} catch (e) {
			console.error("Briefing Error:", e);
			return null;
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";

		// --- 1. DASHBOARD: ANALYTICS & FULL R2 PATHS ---
		if (url.pathname === "/api/profile") {
			try {
				const profile = await this.env.SETTINGS.get(`global_user_profile`) || "Standard Agent Profile";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
				
				const storage = await this.env.DOCUMENTS.list();
				
				const assets = storage.objects
					.map(o => o.key)
					.filter(key => !key.endsWith('/'));

				return new Response(JSON.stringify({ 
					profile: profile,
					messageCount: stats?.count || 0,
					knowledgeAssets: assets,
					status: "Live"
				}), { headers: { "Content-Type": "application/json" } });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- HISTORY FETCH ROUTE ---
		if (url.pathname === "/api/history") {
			try {
				const messages = await this.env.jolene_db.prepare(
					"SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC"
				).bind(sessionId).all();
				return new Response(JSON.stringify(messages.results), { headers: { "Content-Type": "application/json" } });
			} catch (e) { return new Response("History load failed", { status: 500 }); }
		}

		// --- 2. DELETE INDIVIDUAL R2 FILE ---
		if (url.pathname === "/api/delete-file" && request.method === "POST") {
			try {
				const { key } = await request.json() as any;
				await this.env.DOCUMENTS.delete(key);
				return new Response(JSON.stringify({ message: "File deleted successfully" }));
			} catch (e) { return new Response(JSON.stringify({ error: "Delete failed" }), { status: 500 }); }
		}

		// --- 3. SAFE WIPE ROUTE ---
		if (url.pathname === "/api/wipe-knowledge" && request.method === "POST") {
			try {
				await this.env.SETTINGS.delete(`global_user_profile`);
				await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
				return new Response(JSON.stringify({ message: "Identity and History cleared." }));
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- 4. MANUAL BRIEFING TRIGGER ---
		if (url.pathname === "/api/cron-briefing") {
			const result = await this.runMorningBriefing(sessionId);
			return result ? new Response(result) : new Response("Failed", { status: 500 });
		}

		// --- 5. MEMORIZE: LEARN FROM UPLOADS ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const textToIndex = await file.text();

				const chunks = textToIndex.split(/\n\n/).filter(c => c.trim().length > 0);
				for (const chunk of chunks) {
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] }, { gateway: GATEWAY_ID });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text: chunk, fileName: file.name, sessionId } 
					}]);
				}
				
				await this.env.DOCUMENTS.put(`uploads/${sessionId}/${file.name}`, await file.arrayBuffer());
				return new Response(JSON.stringify({ message: "Knowledge Absorbed!" }));
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
		}

		// --- 6. CHAT LOGIC ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMsg = messages[messages.length - 1]?.content || "";

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMsg).run();

				// --- STRICT IDENTITY MANAGEMENT MODULE ---
				const kvProfileKey = `global_user_profile`;
				const currentProfileString = await this.env.SETTINGS.get(kvProfileKey) || "New User Profile";

				const profileCheck = await this.env.AI.run(REASONING_MODEL, {
					messages: [
						{ 
							role: 'system', 
							content: 'You are an identity management module. Your job is to consolidate new user facts into a clean, comma-separated string. DO NOT provide reasoning. DO NOT talk about your process. Output ONLY the consolidated fact string, or "NONE" if there is nothing new. Keep existing identity facts (Name, Title) if they remain true.' 
						},
						{ 
							role: 'user', 
							content: `Current consolidated identity string: "${currentProfileString}"\n\nNew user input: "${latestUserMsg}"` 
						}
					]
				}, { gateway: GATEWAY_ID });

				const cleanedCheck = profileCheck.response?.replace(/^["']|["']$/g, '').trim() || "";

				if (cleanedCheck && cleanedCheck !== "NONE" && !cleanedCheck.includes("Analyzing the message")) {
					await this.env.SETTINGS.put(kvProfileKey, cleanedCheck);
				}

				const lowerMsg = latestUserMsg.toLowerCase();
				if (lowerMsg.includes("generate an image") || lowerMsg.includes("draw") || lowerMsg.includes("picture of")) {
					const imageResponse = await this.env.AI.run(IMAGE_MODEL, { prompt: latestUserMsg });
					const fileName = `gen-${Date.now()}.png`;
					await this.env.DOCUMENTS.put(`images/${fileName}`, imageResponse);
					const imageUrl = `${PUBLIC_R2_URL}/images/${fileName}`;
					const msg = `I have generated that image for you. You can view it here: ${imageUrl}`;
					
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", msg).run();
					return new Response(`data: ${JSON.stringify({ response: msg })}\n\ndata: [DONE]\n\n`);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMsg] }, { gateway: GATEWAY_ID });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, returnMetadata: "all" });
				const contextText = matches.matches.map(m => m.metadata.text).join("\n\n");

				const searchIntent = await this.env.AI.run(REASONING_MODEL, { 
					prompt: `Does this require real-time info? YES/NO. User: ${latestUserMsg}` 
				}, { gateway: GATEWAY_ID });
				
				let searchResults = "";
				if (searchIntent.response?.includes("YES")) { 
					searchResults = await this.searchWeb(latestUserMsg); 
				}

				const globalProfile = await this.env.SETTINGS.get(kvProfileKey) || "";
				
				// --- REFINED PERSONALITY PROMPT (Fixed Persona) ---
				let sysPrompt = `You are Jolene, a sophisticated and direct AI assistant. 
                Maintain a professional, helpful, and straightforward tone. 
                Do not adopt any personas related to animals or pets. 
                
                USER IDENTITY: ${globalProfile}
                SEARCH DATA: ${searchResults}
                YOUR MEMORY: ${contextText}`;

				messages.unshift({ role: "system", content: sysPrompt });
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages }, { gateway: GATEWAY_ID });
				const finalContent = chatRun.response || "Analyzing...";
				
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", finalContent).run();

				return new Response(`data: ${JSON.stringify({ response: finalContent })}\n\ndata: [DONE]\n\n`);
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
	},
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const id = env.CHAT_SESSION.idFromName("global");
		const obj = env.CHAT_SESSION.get(id);
		ctx.waitUntil(obj.runMorningBriefing("global"));
	}
} satisfies ExportedHandler<Env>;
