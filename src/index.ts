import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
// FIXED: Verified correct model name for RAG operations
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- HELPER: RELIABLE D1 SQL PERSISTENCE ---
	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) {
			console.error("D1 Persistence Error:", e);
		}
	}

	// --- HELPER: UNIVERSAL AI BROKER (HARDENED FOR ANTHROPIC) ---
	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const sanitizedHistory = history
			.filter(m => m.role === 'user' || m.role === 'assistant')
			.slice(-10);

		const chatMessages = [...sanitizedHistory, { role: "user", content: userQuery }];

		// 1. NATIVE WORKERS AI
		if (model.startsWith("@cf/")) {
			const run: any = await this.env.AI.run(model as any, { 
				messages: [{ role: "system", content: systemPrompt }, ...chatMessages] 
			});
			return run.response || run;
		}

		// 2. EXTERNAL PROVIDERS VIA AI GATEWAY
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		if (!accountId) throw new Error("Missing Account ID. Please ensure CF_ACCOUNT_ID is set in your Worker settings.");
		
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}`;

		if (model.includes("gpt")) {
			if (!this.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY secret is missing.");
			const res = await fetch(`${gatewayBase}/openai/chat/completions`, {
				method: "POST",
				headers: { "Authorization": `Bearer ${this.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
				body: JSON.stringify({ 
					model, 
					messages: [{ role: "system", content: systemPrompt }, ...chatMessages] 
				})
			});
			const data: any = await res.json();
			if (data.error) throw new Error(`Gateway/OpenAI Error: ${data.error.message}`);
			return data.choices[0].message.content;
		}

		if (model.includes("claude")) {
			if (!this.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY secret is missing.");
			const res = await fetch(`${gatewayBase}/anthropic/messages`, {
				method: "POST",
				headers: {
					"x-api-key": this.env.ANTHROPIC_API_KEY,
					"anthropic-version": "2023-06-01",
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					model,
					max_tokens: 1024,
					system: systemPrompt,
					messages: chatMessages
				})
			});
			const data: any = await res.json();
			if (data.error) throw new Error(`Gateway/Anthropic Error: ${data.error.message || JSON.stringify(data.error)}`);
			return data.content[0].text;
		}

		throw new Error(`Model ${model} is not supported by Jolene's broker.`);
	}

	async tavilySearch(query: string, strictUva: boolean = false) {
		try {
			const searchBody = {
				api_key: this.env.TAVILY_API_KEY || "",
				query: strictUva ? `site:news.virginia.edu OR site:virginia.edu ${query}` : `${query} (current data for 2026)`,
				search_depth: "advanced",
				include_answer: true,
				max_results: 5
			};
			const response = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(searchBody)
			});
			const data: any = await response.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No results found.";
		} catch (e) { return "Web search service is currently unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/history") {
			try {
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
			} catch (e) { return new Response(JSON.stringify({ messages: [] }), { headers }); }
		}

		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				const activePool = await this.ctx.storage.get("quiz_pool");

				return new Response(JSON.stringify({
					profile: "Scott E Robbins | Senior Solutions Engineer",
					messages: history.results || [],
					messageCount: stats?.total || 0,
					knowledgeAssets: storage.objects.map(o => o.key),
					mode: activeMode,
					activeQuiz: !!activePool,
					durableObject: { id: sessionId, state: "Active", location: "Cloudflare Edge" }
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const uvaRes = `### 🎓 UVA Mode Activated\nI focus exclusively on your UVA materials.`;
					await this.saveMsg(sessionId, 'user', userMsg);
					await this.saveMsg(sessionId, 'assistant', uvaRes);
					return new Response(`data: ${JSON.stringify({ response: uvaRes })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const personalRes = `### 🏠 Personal Mode Activated\nI now have access to web search and all your documents.`;
					await this.saveMsg(sessionId, 'user', userMsg);
					await this.saveMsg(sessionId, 'assistant', personalRes);
					return new Response(`data: ${JSON.stringify({ response: personalRes })}\n\ndata: [DONE]\n\n`);
				}

				const historyRows = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 6").bind(sessionId).all();
				const chatHistory = (historyRows.results || []).reverse();

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				let context = "";
				
				// TRIGGER VECTOR SEARCH FOR ALL MODES
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				
				if (activeMode === 'personal') {
					// FIXED: In personal mode, search BOTH the web and your "personal" document segment
					const webTask = this.tavilySearch(userMsg);
					const docTask = this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, filter: { segment: "personal" }, returnMetadata: "all" });
					
					const [webResults, docResults] = await Promise.all([webTask, docTask]);
					const docContext = docResults.matches.map(m => m.metadata.text).join("\n");
					context = `WEB RESULTS:\n${webResults}\n\nPERSONAL DOCUMENT CONTEXT:\n${docContext}`;
				} else {
					// UVA mode: Strict document search only
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: "uva" }, returnMetadata: "all" });
					context = matches.matches.map(m => m.metadata.text).join("\n");
				}

				if (lowMsg.includes("quiz")) return this.initQuizPool(sessionId, selectedModel);

				const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
				
				// STRENGTHENED IDENTITY PROMPT
				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY LOCK
Identity: You are Jolene. Namesake: Scott Robbins' dog, inspired by Ray LaMontagne's "Jolene" in "The Town" movie credits.
CRITICAL: You are a BROAD PERSONAL AI AGENT. Do NOT narrow your identity based on the current topic. Even if discussing taxes, you remain Jolene.

### OPERATIONAL MODE: ${activeMode.toUpperCase()}. Date: ${today}.
PERSONAL MODE: You help with life, family, and web searches. You have access to personal notes and tax files.
UVA MODE: You are a focused Study Companion.

CONTEXT:\n${context}`;

				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, chatHistory);
				
				await this.saveMsg(sessionId, 'user', userMsg);
				await this.saveMsg(sessionId, 'assistant', chatTxt);

				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { 
				return new Response(`data: ${JSON.stringify({ response: "**AI Engine Error:** " + e.message })}\n\ndata: [DONE]\n\n`); 
			}
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string): Promise<Response> {
		try {
			const facts = "UVA FACTS: Fall 2026 starts Aug 25. Thanksgiving Nov 25-29.";
			const prompt = `${facts}\nTASK: Generate 5 MCQs. JSON array: [{"q":"...","options":["..."],"hidden_answer":"A"}].`;
			const raw = await this.runAI(model, "JSON API", prompt);
			const jsonMatch = raw.match(/\[[\s\S]*\]/); if (!jsonMatch) throw new Error("JSON fail");
			const pool = JSON.parse(jsonMatch[0]);
			await this.ctx.storage.put("quiz_pool", pool); await this.ctx.storage.put("current_q_idx", 0); await this.ctx.storage.put("quiz_score", 0); await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
			const uiRes = `### 📝 Question 1\n**${pool[0].q}**\n${pool[0].options.join('\n')}`;
			await this.saveMsg(sessionId, 'assistant', uiRes);
			return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Quiz Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
