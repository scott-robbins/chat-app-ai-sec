import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONAL_GROUND_TRUTH = `
IDENTITY: You are Jolene, Scott's smart-aleck AI Agent. Not the dog.
THE NAMESAKE: Named after Scott's tan dachshund. The name was inspired by Ray LaMontagne's "Jolene" playing during the credits of 'The Town' while Scott and Renee watched.
FAMILY: Wife Renee (met 1993, Portuguese/Indian), Daughter Bryana, Grandkids Callan & Josie.
FAVORITES: Bacardi Rum. Grandkids' song "Engine #9".
WORK: Cloudflare SE. Office=Basement, Theater=Upstairs.
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

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		
		// HYBRID ROUTING FIX
		const isOpenAI = model.toLowerCase().includes("gpt");
		const provider = isOpenAI ? "openai" : "anthropic";
		const finalModel = isOpenAI ? "gpt-4o" : "claude-3-opus-20240229";
		
		const url = isOpenAI 
			? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/openai/chat/completions`
			: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/v1/messages`;

		const headers: any = { "Content-Type": "application/json" };
		if (isOpenAI) {
			headers["Authorization"] = `Bearer ${this.env.OPENAI_API_KEY}`;
		} else {
			headers["x-api-key"] = this.env.ANTHROPIC_API_KEY;
			headers["anthropic-version"] = "2023-06-01";
		}

		const body = isOpenAI 
			? { model: finalModel, messages: [{role: "system", content: systemPrompt}, ...chatMessages], max_tokens: 1024 }
			: { model: finalModel, system: systemPrompt, messages: chatMessages, max_tokens: 1024 };

		try {
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
			const data: any = await res.json();
			if (data.error) return `⚠️ ${provider.toUpperCase()} ERROR: ${data.error.message}`;
			return isOpenAI ? data.choices[0].message.content : data.content[0].text;
		} catch (e) { return "Wiring snag. Hit me again."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// FIX: COMMAND CENTER DASHBOARD (D1, R2, KV)
		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "SARCASTIC";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare SE`,
				messages: history.results || [],
				messageCount: history.results?.length || 0, // RESTORES D1 COUNTER
				knowledgeAssets: storage.objects.map(o => o.key), // RESTORES R2 LIST
				personality: personality.toUpperCase(), // RESTORES KV STATUS
				mode: "PERSONAL"
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase();

				// AGGRESSIVE SPORTS SEARCH (No more Nets/Celtics hallucinations)
				let liveContext = "";
				if (["nba", "playoff", "ufc", "fight", "score", "celtics"].some(kw => lowMsg.includes(kw))) {
					const tRes = await fetch('https://api.tavily.com/search', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ 
							api_key: this.env.TAVILY_API_KEY, 
							query: `${userMsg} live scores schedule 2026`, 
							search_depth: "advanced", 
							max_results: 10 
						})
					});
					const tData: any = await tRes.json();
					liveContext = tData.results?.map((r: any) => r.content).join("\n");
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				const systemPrompt = `You are Jolene, Scott's smart-aleck agent. 
IDENTITY: ${PERSONAL_GROUND_TRUTH}
CONTEXT: LIVE: ${liveContext} | MEMORY: ${docContext}
STYLE: Be witty, high-level snarky, and use EMOJIS (🥊, 🛍️, 🥃). If asked about NBA, use the LIVE context only—it is 2026, the Celtics are out!`;

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
