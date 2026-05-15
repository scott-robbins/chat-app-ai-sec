import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONAL_GROUND_TRUTH = `
IDENTITY: You are Jolene, Scott Robbins' smart-aleck AI Agent. 
JOB: Senior Solutions Engineer at Cloudflare. Office=Basement, Theater=Upstairs.
FAMILY: Wife Renee (Portuguese/Indian), Daughter Bryana, Grandkids Callan & Josie.
FAVORITES: Bacardi Rum. Grandkids' song "Engine #9" (Rock Show). Met Renee in 1993.
`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Error:", e); }
	}

	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitized = history.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim());
		for (const msg of sanitized) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); }
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
			chatMessages.push({ role: "user", content: userQuery });
		}

		// STABLE GATEWAY PATH
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/v1/messages`;
		
		let finalModel = model.includes("sonnet") ? "claude-3-5-sonnet-20240620" : "claude-3-opus-20240229";

		try {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.env.ANTHROPIC_API_KEY || "",
					"anthropic-version": "2023-06-01"
				},
				body: JSON.stringify({ model: finalModel, system: systemPrompt, messages: chatMessages, max_tokens: 1024 })
			});
			const data: any = await res.json();
			if (data.content && data.content.length > 0) return data.content[0].text;
			return data.error ? `⚠️ AI ERROR: ${data.error.message}` : "Brain blip. Try again.";
		} catch (e) { return "Wiring issue."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// FIX: Dashboard Metrics
		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "sarcastic";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare Solutions Engineer`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				personality: personality.toUpperCase(),
				mode: "PERSONAL"
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;

				// 1. ADVANCED TAVILY (The Fight Card Fix)
				let liveContext = "";
				if (["mma", "ufc", "fight", "card"].some(kw => userMsg.toLowerCase().includes(kw))) {
					const tRes = await fetch('https://api.tavily.com/search', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query: `${userMsg} full fight card matchups`, search_depth: "advanced", max_results: 12 })
					});
					const tData: any = await tRes.json();
					liveContext = tData.results?.map((r: any) => r.content).join("\n");
				}

				// 2. VECTOR SEARCH (Identity DNA)
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 20, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				const systemPrompt = `You are Jolene, Scott's sarcastic agent. 
IDENTITY DNA: ${PERSONAL_GROUND_TRUTH}
CONTEXT: LIVE: ${liveContext} | MEMORY: ${docContext}
STYLE: Be witty and high-level snarky. Use emojis (🥊, 🛍️, 🥃). Mention Renee's heritage and the grandkids' favorite song "Engine #9". No boring lists.`;

				const chatTxt = await this.runAI(body.model || "opus", systemPrompt, userMsg, recentContext);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
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
