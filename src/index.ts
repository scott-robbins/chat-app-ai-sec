import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

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
			if (data.answer) return `SUMMARY: ${data.answer}`;
			return data.results.map((r: any) => r.content).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";

		// --- PROACTIVE MONITOR ROUTE (Triggered by Cron) ---
		if (url.pathname === "/api/monitor-task" && request.method === "POST") {
			const profile = await this.env.SETTINGS.get(`global_user_profile`) || "Technology and AI";
			const lastNews = await this.env.SETTINGS.get(`last_monitored_news`) || "";
			
			// 1. Search for latest updates based on user profile
			const searchResults = await this.searchWeb(`Latest critical breaking news for: ${profile}`);
			
			// 2. Reasoning: Is this NEW information?
			const analysis = await this.env.AI.run(REASONING_MODEL, {
				prompt: `Last News Seen: "${lastNews}"\nNew Search Results: "${searchResults}"\n\nTask: Is there a significant NEW development here? If yes, write a 2-sentence alert. If no, reply "NO_UPDATE".`
			});

			if (analysis.response && !analysis.response.includes("NO_UPDATE")) {
				const alert = `🔔 **Jolene Proactive Alert:**\n\n${analysis.response}`;
				
				// Save to D1 so it appears in chat history
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", alert).run();
				
				// Update KV so we don't alert on this again
				await this.env.SETTINGS.put(`last_monitored_news`, analysis.response);
			}
			return new Response("Monitor Complete");
		}

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

		// --- STANDARD CHAT & HISTORY ROUTES ---
		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC").bind(sessionId).all();
			const theme = await this.env.SETTINGS.get(`global_theme`) || "fancy";
			return new Response(JSON.stringify({ messages: results, theme }), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				const currentProfile = await this.env.SETTINGS.get(`global_user_profile`) || "No profile yet.";
				const profileUpdater = await this.env.AI.run(REASONING_MODEL, {
					prompt: `Current Identity: "${currentProfile}"\nMessage: "${latestUserMessage}"\nUpdate identity with new facts. Concise.`
				});
				if (profileUpdater.response && profileUpdater.response !== currentProfile) {
					await this.env.SETTINGS.put(`global_user_profile`, profileUpdater.response);
				}

				const searchIntent = await this.env.AI.run(REASONING_MODEL, { prompt: `Does this require real-time info? "YES" or "NO" only. User: ${latestUserMessage}` });
				let searchResults = "";
				if (searchIntent.response?.includes("YES")) { searchResults = await this.searchWeb(latestUserMessage); }

				let contextText = "";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				contextText = matches.matches.map(m => m.metadata.text).join("\n\n");

				let sysPrompt = `You are Jolene, a sharp AI agent. Identity: ${currentProfile}\nContext: ${contextText}\nSearch: ${searchResults}`;
				messages.unshift({ role: "system", content: sysPrompt });
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages });
				const finalContent = chatRun.response || "I'm thinking...";
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", finalContent).run();

				return new Response(`data: ${JSON.stringify({ response: finalContent })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: e.message })}\n\ndata: [DONE]\n\n`); }
		}

		// R2 and Theme routes remain the same...
		if (url.pathname === "/api/save-theme" && request.method === "POST") {
			const { theme } = await request.json() as any;
			await this.env.SETTINGS.put(`global_theme`, theme);
			return new Response("OK");
		}
		if (url.pathname === "/api/files") {
			const objects = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({ files: objects.objects.map(o => ({ key: o.key })) }), { headers: { "Content-Type": "application/json" } });
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
		// Trigger the Monitor Task
		ctx.waitUntil(obj.fetch(new Request("http://jolene.internal/api/monitor-task", { method: "POST" })));
	}
} satisfies ExportedHandler<Env>;
