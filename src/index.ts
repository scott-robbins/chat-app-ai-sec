import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
// FIXED: Corrected model name from 'get-base' to 'bge-base'
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
			const now = new Date();
			const dateStr = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(now);
			const searchSuffix = isFinancial 
				? `real-time stock price and intraday movement for ${dateStr}. Identify Opening Price and Last/Closing Price distinctly.` 
				: `current status and real-time news for ${dateStr}`;
			
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${query} ${searchSuffix}`, search_depth: "advanced", max_results: 5 })
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

				// --- DYNAMIC VECTOR SEARCH (HARDENED FOR PDFS) ---
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				
				// RECALL FIX: If looking for specific docs/taxes, search ALL segments
				const searchFilter = (lowMsg.includes("tax") || lowMsg.includes("letter") || lowMsg.includes("fee") || lowMsg.includes("cozby")) 
					? {} // Search everything
					: { segment: activeMode };

				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, filter: searchFilter, returnMetadata: "all" });
				const docContext = matches.matches.map(m => `[DOC: ${m.metadata.filename}] ${m.metadata.text}`).join("\n\n");
				
				// --- REAL-TIME TRIGGER ---
				let webContext = "";
				const liveTriggers = ["news", "status", "score", "play", "game", "schedule", "tonight", "weather", "celtics", "stock", "price", "market"];
				if (activeMode === 'personal' && liveTriggers.some(t => lowMsg.includes(t))) {
					const isFin = ["stock", "price", "market"].some(t => lowMsg.includes(t));
					webContext = await this.tavilySearch(userMsg, isFin);
				}

				const now = new Date();
				const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
				const dateStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY & DATA INTEGRITY
You are Jolene, Scott Robbins' personal AI assistant. 
TONE: Friendly, professional, conversational.

1. IDENTITY LOCK: Named after Scott's dog Jolene. The dog Jolene was named after the song "Jolene" by RAY LAMONTAGNE playing during the credits of the movie "THE TOWN".
2. CAREER LOCK: Scott is a Senior Solutions Engineer at Cloudflare specializing in: web layer security, application performance products, networking/network security, software development products, and Zero Trust.
3. NO HALLUCINATIONS: When asked about a document (like a Tax Engagement Letter), prioritize the provided DOCS context. Use exact figures: $375 base fee, $275 hourly rate.
4. FAMILY FACTS: Dogs are Jolene and Hanna. NO dog named Ruby. Wife is Renee.
5. MARKET AWARENESS: Today is ${dateStr}, ${timeStr} EDT. 

Mode: ${activeMode.toUpperCase()}.
WEB SEARCH: ${webContext}
DOCS CONTEXT: ${docContext.substring(0, 5000)}`;

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
