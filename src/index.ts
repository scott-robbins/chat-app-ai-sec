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

		// --- 1. NEW: CRON BRIEFING ROUTE ---
		if (url.pathname === "/api/cron-briefing") {
			try {
				const interests = "MMA/UFC, Boston Celtics, New England Patriots, Cloudflare news, major US politics, and premium streaming movies/TV series (excluding NBC, ABC, CBS)";
				const newsContext = await this.searchWeb(`Latest news on ${interests}`);
				
				const briefingPrompt = `You are Jolene, a polished executive assistant. 
				Generate a morning briefing based on this news: ${newsContext}. 
				Focus on these interests: ${interests}. 
				Keep it sophisticated, direct, and formatted with clean headers. No dog references.`;

				const briefing = await this.env.AI.run(REASONING_MODEL, { prompt: briefingPrompt }, { gateway: GATEWAY_ID });
				const finalBriefing = `☀️ **GOOD MORNING BRIEFING**\n\n${briefing.response}`;

				// Save to D1 so it's in your chat history when you wake up
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", finalBriefing).run();

				return new Response("Briefing success");
			} catch (e) {
				return new Response("Briefing failed", { status: 500 });
			}
		}

		// --- 2. DASHBOARD ANALYTICS ---
		if (url.pathname === "/api/profile") {
			const profile = await this.env.SETTINGS.get(`global_user_profile`);
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
			return new Response(JSON.stringify({ 
				profile: profile || "No profile saved.",
				messageCount: stats?.count || 0
			}), { headers: { "Content-Type": "application/json" } });
		}

		// --- 3. CHAT LOGIC ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMessage = messages[messages.length - 1]?.content || "";

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMessage).run();

				// IMAGE INTENT
				const imageKeywords = ["generate an image", "draw a", "picture of", "render a"];
				if (imageKeywords.some(k => latestUserMessage.toLowerCase().includes(k))) {
					const imageResponse = await this.env.AI.run(IMAGE_MODEL, { prompt: latestUserMessage });
					const fileName = `jolene-gen-${Date.now()}.png`;
					await this.env.DOCUMENTS.put(`images/${fileName}`, imageResponse);
					const imageUrl = `${PUBLIC_R2_URL}/images/${fileName}`;
					const assistantResponse = `I have generated that image for you. You can view it here: ${imageUrl}`;

					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
						.bind(sessionId, "assistant", assistantResponse).run();

					return new Response(`data: ${JSON.stringify({ response: assistantResponse })}\n\ndata: [DONE]\n\n`);
				}

				// STANDARD CHAT
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				const contextText = matches.matches.map(m => m.metadata.text).join("\n\n");
				const globalProfile = await this.env.SETTINGS.get(`global_user_profile`) || "";
				
				let sysPrompt = `You are Jolene, a highly sophisticated AI agent. 
				Context: ${contextText}. Reference files only if relevant. 
				Persona: You are professional, direct, and polished. You are named after a dog but are a digital entity.
				Capability: You can generate images if asked explicitly.`;

				messages.unshift({ role: "system", content: sysPrompt });
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages });
				const finalContent = chatRun.response || "Analyzing...";
				
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", finalContent).run();

				return new Response(`data: ${JSON.stringify({ response: finalContent })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { 
				return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); 
			}
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
		// Trigger the 9am Briefing via internal DO call
		ctx.waitUntil(obj.fetch(new Request("http://jolene.internal/api/cron-briefing", { method: "POST" })));
	}
} satisfies ExportedHandler<Env>;
