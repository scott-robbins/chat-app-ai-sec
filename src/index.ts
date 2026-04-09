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

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";

		// --- BRIEFING ROUTE ---
		if (url.pathname === "/api/cron-briefing") {
			try {
				const interests = "MMA/UFC, Boston Celtics, New England Patriots, Cloudflare news, major US politics, and premium streaming movies/TV (no network TV)";
				const newsContext = await this.searchWeb(`Latest news on ${interests}`);
				const briefingPrompt = `You are Jolene. Generate an executive morning briefing based on: ${newsContext}.`;
				const briefing = await this.env.AI.run(REASONING_MODEL, { prompt: briefingPrompt });
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", `☀️ **MORNING BRIEFING**\n\n${briefing.response}`).run();
				return new Response("OK");
			} catch (e) { return new Response("Error", { status: 500 }); }
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMsg = messages[messages.length - 1]?.content || "";

				// 1. IMAGE INTENT
				const lowerMsg = latestUserMsg.toLowerCase();
				if (lowerMsg.includes("generate an image") || lowerMsg.includes("draw") || lowerMsg.includes("picture of")) {
					const imageResponse = await this.env.AI.run(IMAGE_MODEL, { prompt: latestUserMsg });
					const fileName = `gen-${Date.now()}.png`;
					await this.env.DOCUMENTS.put(`images/${fileName}`, imageResponse);
					const imageUrl = `${PUBLIC_R2_URL}/images/${fileName}`;
					const msg = `I have generated that image for you. You can view it here: ${imageUrl}`;
					return new Response(`data: ${JSON.stringify({ response: msg })}\n\ndata: [DONE]\n\n`);
				}

				// 2. SEARCH & CONTEXT
				// We force the reasoning model to ignore its "I can't browse" training
				const searchIntent = await this.env.AI.run(REASONING_MODEL, { 
					prompt: `You have access to a real-time search tool. Does this user request require search? "YES" or "NO" only. User: ${latestUserMsg}` 
				});
				
				let searchResults = "";
				if (searchIntent.response?.includes("YES")) { 
					searchResults = await this.searchWeb(latestUserMsg); 
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				const contextText = matches.matches.map(m => m.metadata.text).join("\n\n");
				const globalProfile = await this.env.SETTINGS.get(`global_user_profile`) || "";
				
				// --- RESTORED SYSTEM PROMPT ---
				let sysPrompt = `You are Jolene, a highly sophisticated AI agent.
CAPABILITIES:
- You HAVE access to real-time internet search results (provided below).
- You HAVE access to an image generation model.
- You are professional, polished, and direct.

SEARCH DATA: ${searchResults}
USER IDENTITY: ${globalProfile}
DOC CONTEXT: ${contextText}

If search data is provided above, you MUST use it to answer the question. Never say "I don't have access to real-time data" if the search data is present.`;

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
	},
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const id = env.CHAT_SESSION.idFromName("global");
		const obj = env.CHAT_SESSION.get(id);
		ctx.waitUntil(obj.fetch(new Request("http://jolene.internal/api/cron-briefing", { method: "POST" })));
	}
} satisfies ExportedHandler<Env>;
