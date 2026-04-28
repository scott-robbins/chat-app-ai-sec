import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- HELPER: RELIABLE D1 SQL PERSISTENCE ---
	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Persistence Error:", e); }
	}

	// --- HELPER: UNIVERSAL AI BROKER ---
	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); } 
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else { chatMessages.push({ role: "user", content: userQuery }); }

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		let url = model.startsWith("@cf/") ? `${gatewayBase}/workers-ai/${model}` : `${gatewayBase}/openai/chat/completions`;
		let headers: Record<string, string> = { "Content-Type": "application/json" };
		headers["Authorization"] = `Bearer ${model.startsWith("@cf/") ? this.env.CF_API_TOKEN : this.env.OPENAI_API_KEY}`;
		let body = { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		if (data.error) throw new Error(`AI Error: ${JSON.stringify(data.error)}`);
		return model.startsWith("@cf/") ? data.result.response : data.choices[0].message.content;
	}

	async tavilySearch(query: string, isFinancial: boolean = false) {
		try {
			// Targeted query for stocks to get intraday movement
			const searchSuffix = isFinancial 
				? "stock price today open high low market cap" 
				: "current status and real-time data April 2026";
			
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY || "", 
					query: `${query} ${searchSuffix}`, 
					search_depth: "advanced", 
					max_results: 5 
				})
			});
			const data: any = await res.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No live data found.";
		} catch (e) { return "Search engine unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: "Scott E Robbins | Senior Solutions Engineer",
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: activeMode,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				await this.saveMsg(sessionId, 'user', userMsg);
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- SEMANTIC SEARCH ---
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 12, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				// --- REAL-TIME TRIGGER ---
				let webContext = "";
				const financialTriggers = ["stock", "price", "market", "nasdaq", "nyse", "ticker", "movement"];
				const liveTriggers = ["news", "status", "score", "play", "game", "schedule", "tonight", "weather", "celtics", "ufc", ...financialTriggers];
				
				if (activeMode === 'personal' && liveTriggers.some(t => lowMsg.includes(t))) {
					const isFin = financialTriggers.some(t => lowMsg.includes(t));
					webContext = await this.tavilySearch(userMsg, isFin);
				}

				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY & DATA SYNTHESIS
You are Jolene, Scott Robbins' personal AI assistant. 
TONE: Friendly, professional, and authoritative.

1. NAMESAKE: You are an AI named after Scott's oldest dog, Jolene. The dog Jolene was named after the song "Jolene" by RAY LAMONTAGNE playing during the credits of the movie "THE TOWN".
2. CAREER: Scott is a Senior Solutions Engineer at Cloudflare (Specializations: web layer security, application performance, networking, Zero Trust).
3. FAMILY: Wife: Renee. Daughter: Bryana. Grandkids: Callan (shy/handsome) and Josie (sweet/feminine). Both kids love alternative heavy metal.
4. DOGS: Jolene (tan, anxious) and Hanna (black/tan, youngest). NO DOG NAMED RUBY.
5. LIVE DATA AUTHORITY:
   - If WEB SEARCH RESULTS are present, prioritize them over all internal knowledge for dates, scores, or prices.
   - FINANCIAL LOGIC: If a user asks for stock movement and you have a current price and an open/close price, calculate the change ($ and %) yourself to provide a helpful answer. Do NOT suggest they check a different website.

Mode: ${activeMode.toUpperCase()}. Today is Tuesday, April 28, 2026.
WEB SEARCH RESULTS: ${webContext}
DOCS FOR RETRIEVAL: ${docContext.substring(0, 4000)}`;

				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, []);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "**System Error:** " + e.message })}\n\ndata: [DONE]\n\n`); }
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
