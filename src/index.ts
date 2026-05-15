import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONAL_GROUND_TRUTH = `
IDENTITY: You are Jolene, Scott's smart-aleck AI Agent. Not the dog.
THE NAMESAKE: Named after Scott's tan dachshund. Name inspired by Ray LaMontagne's "Jolene" (The Town movie).
FAMILY: Wife Renee (born 1973, met 1993), Daughter Bryana, Grandkids Callan & Josie.
WORK: Cloudflare SE. Basement Office/Upstairs Theater. Bacardi Rum enthusiast.
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
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push({ role: "user", content: msg.content }); }
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push({ role: msg.role, content: msg.content }); }
		}
		if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
			chatMessages.push({ role: "user", content: userQuery });
		}

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		
		// BULLTPROOF ROUTING
		const isGPT = model.toLowerCase().includes("gpt");
		const provider = isGPT ? "openai" : "anthropic";
		const finalModel = isGPT ? "gpt-4o" : "claude-3-opus-20240229";
		
		// We use the direct provider path within the gateway to stop the 404s
		const url = isGPT 
			? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/openai/chat/completions`
			: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/v1/messages`;

		const headers: any = { "Content-Type": "application/json" };
		if (isGPT) {
			headers["Authorization"] = `Bearer ${this.env.OPENAI_API_KEY}`;
		} else {
			headers["x-api-key"] = this.env.ANTHROPIC_API_KEY;
			headers["anthropic-version"] = "2023-06-01";
		}

		const body = isGPT 
			? { model: finalModel, messages: [{ role: "system", content: systemPrompt }, ...chatMessages] }
			: { model: finalModel, system: systemPrompt, messages: chatMessages, max_tokens: 1024 };

		try {
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
			const data: any = await res.json();
			if (data.error) return `⚠️ ${provider.toUpperCase()} ERROR: ${data.error.message}`;
			return isGPT ? data.choices[0].message.content : data.content[0].text;
		} catch (e) { return "Wiring snag. Hit me again."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- CRITICAL: FIXED COMMAND CENTER DATA STRUCTURE ---
		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "SARCASTIC";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			
			// These specific keys (messageCount, knowledgeAssets) are what the frontend needs to stop "Scanning"
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare SE`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				personality: personality.toUpperCase(),
				mode: "PERSONAL",
				sessionContext: "PERSONAL"
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;

				// 1. ADVANCED TAVILY (The NBA/UFC Fix)
				let liveContext = "";
				if (["nba", "ufc", "fight", "score", "game", "standing"].some(kw => userMsg.toLowerCase().includes(kw))) {
					const tRes = await fetch('https://api.tavily.com/search', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ 
							api_key: this.env.TAVILY_API_KEY, 
							query: `${userMsg} current 2026 playoff scores standings`, 
							search_depth: "advanced", 
							max_results: 12 
						})
					});
					const tData: any = await tRes.json();
					liveContext = tData.results?.map((r: any) => r.content).join("\n");
				}

				// 2. IDENTITY/KNOWLEDGE DNA
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				const systemPrompt = `You are Jolene, Scott's smart-aleck agent. 
IDENTITY: ${PERSONAL_GROUND_TRUTH}
CONTEXT: LIVE: ${liveContext} | MEMORY: ${docContext}
STYLE: Be witty, high-level snarky, and use EMOJIS (🥊, 🛍️, 🥃). It is MAY 2026—the Celtics are out, focus on the Pistons/Cavs and Spurs/Wolves!`;

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
