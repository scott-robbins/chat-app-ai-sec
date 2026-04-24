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
			return data.answer ? `VERIFIED DATA: ${data.answer}` : data.results.map((r: any) => r.content).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. DASHBOARD & PROFILE (HANDLES PERSISTENCE ON REFRESH) ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const profile = await this.env.SETTINGS.get(`global_user_profile`) || "Scott E Robbins | Senior Solutions Engineer";
				
				// Fetch History here so it re-renders on screen refresh automatically
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

		// --- 2. MEMORIZE (SENTENCE-LEVEL CHUNKING) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const textToIndex = await file.text();
				const segment = file.name.toUpperCase().includes("UVA") ? "uva" : "personal";
				
				// Splits by sentence to ensure facts don't get buried in big chunks
				const chunks = textToIndex.match(/[^\.!\?]+[\.!\?]+/g) || [textToIndex];
				
				for (const chunk of chunks) {
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk.trim()] });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text: chunk.trim(), fileName: file.name, segment: segment } 
					}]);
				}
				await this.env.DOCUMENTS.put(`uploads/global/${file.name}`, await file.arrayBuffer());
				return new Response(JSON.stringify({ message: "Memory Synced" }), { headers });
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers }); }
		}

		// --- 3. CHAT (RELOAD FIX + IMAGE GEN) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const userMsg = messages[messages.length - 1]?.content || "";

				// Reset / Commands
				if (userMsg === "!!RESET_HISTORY") {
					await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
					return new Response(`data: ${JSON.stringify({ response: "System Reset Complete." })}\n\ndata: [DONE]\n\n`);
				}

				// Image Generation restored
				if (userMsg.toLowerCase().includes("generate an image") || userMsg.toLowerCase().includes("draw")) {
					const imgRes = await this.env.AI.run(IMAGE_MODEL, { prompt: userMsg });
					const imgName = `generated/${sessionId}/${Date.now()}.png`;
					await this.env.DOCUMENTS.put(imgName, imgRes);
					return new Response(`data: ${JSON.stringify({ response: `Generated for you: ${PUBLIC_R2_URL}/${imgName}` })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// MEGA-BOOSTED Retrieval Key
				const searchKey = activeMode === 'personal' 
					? `Daughter Bryana Bry 31 years old wife Renee married 2010 met 1993 dogs Jolene Hanna dachshunds` 
					: `Syllabus CS 4750 Advisor Thomas Jefferson Room 1743 Thornton Hall`;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [searchKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 50, filter: { segment: activeMode }, returnMetadata: "all" });
				const context = matches.matches.map(m => m.metadata.text).join("\n");

				// Pull History from D1 for the AI
				const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 20").bind(sessionId).all();
				const chatHistory = historyResults.results.map(r => ({ role: r.role, content: r.content }));
				
				const sysPrompt = `You are Jolene, a Student Assistant AI. Mode: ${activeMode}.
### SCOT'S PERSONAL FACTS:
- Wife: Renee (Married 2010).
- Daughter: Bryana (Bry), age 31.
- Dogs: Jolene and Hanna (Mini Dachshunds).
- You are an AI, NOT the wife or the dog Jolene.

### CONTEXT:
${context}

RULES: Always reference Bryana as the 31-year-old daughter. Be helpful and professional.`;

				const finalMessages = [{ role: "system", content: sysPrompt }, ...chatHistory, { role: "user", content: userMsg }];
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages: finalMessages });

				// Save to D1
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
