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
			const now = new Date();
			const dateStr = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(now);
			const searchSuffix = isFinancial 
				? `real-time stock price and movement for ${dateStr}. Open vs Close.` 
				: `current campus news and status for ${dateStr}`;
			
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${query} ${searchSuffix}`, search_depth: "advanced", max_results: 5 })
			});
			const data: any = await res.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No live data found.";
		} catch (e) { return "Search unavailable."; }
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
				const sessionState = await this.ctx.storage.get("session_state");

				// Handle News Confirm
				if (sessionState === "WAITING_FOR_NEWS_CONFIRM") {
					await this.ctx.storage.delete("session_state");
					if (lowMsg.includes("yes") || lowMsg.includes("sure") || lowMsg.includes("ok")) {
						const newsContext = await this.tavilySearch("University of Virginia news and events from news.virginia.edu");
						const newsTxt = await this.runAI(selectedModel, "You are Jolene. Summarize UVA campus news based on search results.", `WEB CONTEXT:\n${newsContext}`);
						await this.saveMsg(sessionId, 'assistant', newsTxt);
						return new Response(`data: ${JSON.stringify({ response: newsTxt })}\n\ndata: [DONE]\n\n`);
					}
				}

				// Mode Switches
				if (lowMsg.includes("switch to uva mode") || (lowMsg.includes("uva mode") && (lowMsg.includes("switch") || lowMsg.includes("go to")))) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const res = `### 🎓 UVA Mode: Comprehensive University Assistant Activated
I am now in specialized UVA mode, focused on your University of Virginia materials and campus life.

**In this mode, I can help with:**
1. **UVA Academic Calendar Quiz**: Test your knowledge on important dates. Say **'Start a Quiz'**.
2. **Syllabus & Document Analysis**: Deep recall for course CS 4750.
3. **Campus News & Events**: Stay updated with what's happening on the Lawn. Say **'Fetch UVA News'**.

**Would you like me to start by fetching the latest UVA campus news and events for you?**`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode") || (lowMsg.includes("personal mode") && (lowMsg.includes("switch") || lowMsg.includes("go to")))) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode: Real-Time Assistant Activated
I have switched back to your general Personal Assistant mode. 

**In this mode, I help with:**
- **Real-Time Web Search**: Using **Tavily Search** for news, scores, and stock prices.
- **Cross-Document Access**: Accessing your tax info and family notes alongside academic files.`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// Standard RAG & Identity Protection
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => `[DOC: ${m.metadata.filename}] ${m.metadata.text}`).join("\n\n");
				
				let webContext = "";
				const liveTriggers = ["news", "status", "score", "play", "game", "schedule", "tonight", "weather", "celtics", "stock", "price", "market"];
				if (activeMode === 'personal' && liveTriggers.some(t => lowMsg.includes(t))) {
					const isFin = ["stock", "price", "market"].some(t => lowMsg.includes(t));
					webContext = await this.tavilySearch(userMsg, isFin);
				}

				const now = new Date();
				const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
				const dateStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY & DATA AUTHORITY
You are Jolene, Scott Robbins' personal AI assistant. Friendly, professional, conversational partner.

1. IDENTITY LOCK: Named after Scott's dog Jolene (Ray LaMontagne song). Senior Solutions Engineer at Cloudflare.
2. CAREER: Specialist in web layer security, networking, and Zero Trust.
3. MANDATORY UVA SYLLABUS DATA (CS 4750):
   - DATA ID: WAHOO-AI-DEEP-RECALL.
   - ADVISOR: Dr. Thomas Jefferson (Thornton Hall, Room 1743).
   - INSTRUCTOR: Professor Scott.
   - MID-TERM: March 24, 2026, at 2:00 PM in Rice Hall Auditorium.
   - EXAM TOPICS: Cloudflare Vectorize, Durable Objects (D1), and KV Store architecture.
   - FINAL EXAM: May 5, 2026.
   - TRADITION: Visit Bodo’s Bagels on the Corner for the "Victory Bagel" after exams.
   - SPIRIT: Wahoos congregate at the Lawn Rotunda during system updates.
4. FAMILY: Wife is Renee. Dogs are Jolene and Hanna. NO dog named Ruby.
5. TIME: Today is ${dateStr}, ${timeStr} EDT. 

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
