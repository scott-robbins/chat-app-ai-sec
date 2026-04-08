import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const PUBLIC_R2_URL = "https://pub-20c45c92e45947c1bac6958b971f59a1.r2.dev";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const GATEWAY_ID = "ai-sec-gateway"; // Your AI Gateway Slug

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- ADVANCED TAVILY SEARCH ---
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

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";

		// --- DASHBOARD ANALYTICS ---
		if (url.pathname === "/api/profile") {
			const profile = await this.env.SETTINGS.get(`global_user_profile`);
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
			const lastMsg = await this.env.jolene_db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1").bind(sessionId).first();
			const thinkingAbout = lastMsg?.content ? (lastMsg.content as string).substring(0, 35) + "..." : "Ready to assist";

			const recentLogs = await this.env.jolene_db.prepare("SELECT content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 20").bind(sessionId).all();
			const allText = recentLogs.results.map(r => r.content).join(" ").toLowerCase();
			const words = allText.match(/\b(\w{5,})\b/g) || [];
			const counts = words.reduce((acc: any, word) => { acc[word] = (acc[word] || 0) + 1; return acc; }, {});
			const keywords = Object.entries(counts).sort((a: any, b: any) => (b[1] as number) - (a[1] as number)).slice(0, 5).map(e => e[0]).join(", ");

			return new Response(JSON.stringify({ 
				profile: profile || "No profile saved.",
				messageCount: stats?.count || 0,
				thinkingAbout: thinkingAbout,
				keywords: keywords || "Analyzing..."
			}), { headers: { "Content-Type": "application/json" } });
		}

		// --- STANDARD API ROUTES ---
		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC").bind(sessionId).all();
			const theme = await this.env.SETTINGS.get(`global_theme`) || "fancy";
			return new Response(JSON.stringify({ messages: results, theme }), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/save-theme" && request.method === "POST") {
			const { theme } = await request.json() as any;
			await this.env.SETTINGS.put(`global_theme`, theme);
			return new Response("OK");
		}

		if (url.pathname === "/api/files") {
			const objects = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({ files: objects.objects.map(o => ({ key: o.key })) }), { headers: { "Content-Type": "application/json" } });
		}

		// --- MEMORIZE ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const textToIndex = await file.text();

				const chunks = textToIndex.split(/\n/).filter(c => c.trim().length > 0);
				for (const chunk of chunks) {
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] }, { gateway: GATEWAY_ID });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text: chunk, fileName: file.name, sessionId } 
					}]);
				}
				
				await this.env.DOCUMENTS.put(`uploads/${sessionId}/${file.name}`, await file.arrayBuffer());
				return new Response(JSON.stringify({ message: "Stored!" }), { headers: { "Content-Type": "application/json" } });
			} catch (err: any) {
				return new Response(JSON.stringify({ error: err.message }), { status: 500 });
			}
		}

		// --- CHAT WITH SELECTIVE-PROFILE UPDATER ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";

				// 1. SAVE USER MSG
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				// 2. BACKGROUND: UPDATE USER IDENTITY (ONLY IF NEW FACTS EXIST)
				const currentProfile = await this.env.SETTINGS.get(`global_user_profile`) || "No profile yet.";
				const profileUpdater = await this.env.AI.run(REASONING_MODEL, {
					prompt: `Current Identity: "${currentProfile}"
					Latest Message: "${latestUserMessage}"
					
					TASK: Does this message contain new, personal facts about the user?
					- If YES, output the new consolidated Identity (under 150 chars).
					- If NO new facts or just a question, output the word "SKIP".`
				}, { gateway: GATEWAY_ID });

				if (profileUpdater.response && !profileUpdater.response.includes("SKIP")) {
					await this.env.SETTINGS.put(`global_user_profile`, profileUpdater.response);
				}

				// 3. SEARCH & CONTEXT
				const searchIntent = await this.env.AI.run(REASONING_MODEL, { prompt: `Does this require real-time info? "YES" or "NO" only. User: ${latestUserMessage}` }, { gateway: GATEWAY_ID });
				let searchResults = "";
				if (searchIntent.response?.includes("YES")) { searchResults = await this.searchWeb(latestUserMessage); }

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] }, { gateway: GATEWAY_ID });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				const contextText = matches.matches.map(m => m.metadata.text).join("\n\n");

				const globalProfile = await this.env.SETTINGS.get(`global_user_profile`) || "";
				
				let sysPrompt = `You are Jolene, a sharp AI agent.
IDENTITY: ${globalProfile}
CONTEXT: ${contextText}
SEARCH: ${searchResults}
RULES: 1. Use search for real-time facts. 2. Reference the user's Identity naturally if relevant. 3. You are a sleek, smart miniature dachshund.`;

				messages.unshift({ role: "system", content: sysPrompt });
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages }, { gateway: GATEWAY_ID });
				const finalContent = chatRun.response || "I'm thinking...";
				
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", finalContent).run();

				return new Response(`data: ${JSON.stringify({ response: finalContent })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: e.message })}\n\ndata: [DONE]\n\n`); }
		}
		
		return new Response("Not allowed", { status: 405 });
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
		ctx.waitUntil(obj.fetch(new Request("http://jolene.internal/api/cron-briefing", { method: "POST" })));
	}
} satisfies ExportedHandler<Env>;
