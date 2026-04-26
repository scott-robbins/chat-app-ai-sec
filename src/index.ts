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
		} catch (e) {
			console.error("D1 Persistence Error:", e);
		}
	}

	// --- HELPER: UNIVERSAL AI BROKER ---
	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) {
				if (msg.role === 'user') chatMessages.push(msg);
			} else {
				if (msg.role !== chatMessages[chatMessages.length - 1].role) {
					chatMessages.push(msg);
				}
			}
		}

		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else {
			chatMessages.push({ role: "user", content: userQuery });
		}

		if (model.startsWith("@cf/")) {
			const run: any = await this.env.AI.run(model as any, { 
				messages: [{ role: "system", content: systemPrompt }, ...chatMessages] 
			});
			return run.response || run;
		}

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}`;

		if (model.includes("gpt")) {
			const res = await fetch(`${gatewayBase}/openai/chat/completions`, {
				method: "POST",
				headers: { "Authorization": `Bearer ${this.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages] })
			});
			const data: any = await res.json();
			if (data.error) throw new Error(data.error.message);
			return data.choices[0].message.content;
		}

		if (model.includes("claude")) {
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
			if (data.error) throw new Error(`Claude Error: ${data.error.message || JSON.stringify(data.error)}`);
			return data.content[0].text;
		}
		throw new Error(`Model ${model} not supported.`);
	}

	async tavilySearch(query: string) {
		try {
			const response = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					api_key: this.env.TAVILY_API_KEY || "",
					query: `${query} current status April 2026`,
					search_depth: "advanced",
					include_answer: true,
					max_results: 5
				})
			});
			const data: any = await response.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No results found.";
		} catch (e) { return "Web search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: "Scott E Robbins | Senior Solutions Engineer",
				messages: history.results || [],
				messageCount: stats?.total || 0,
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

				// 1. Mode Switches
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const res = "### 🎓 UVA Mode Activated";
					await this.saveMsg(sessionId, 'user', userMsg);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = "### 🏠 Personal Mode Activated";
					await this.saveMsg(sessionId, 'user', userMsg);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// 2. Fetch History & Context
				const historyRows = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 6").bind(sessionId).all();
				const chatHistory = (historyRows.results || []).reverse();

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				
				// Search documents
				const searchBoost = (lowMsg.includes("family") || lowMsg.includes("namesake")) ? "Scott Robbins Renee Bryana dogs " : "";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [searchBoost + userMsg] });
				const vectorResults = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, returnMetadata: "all" });
				const docContext = vectorResults.matches.map(m => m.metadata.text).join("\n\n");
				
				// Search web
				let webContext = "";
				if (activeMode === 'personal') webContext = await this.tavilySearch(userMsg);

				// 3. Prompt Logic
				const today = "Sunday, April 26, 2026";
				const systemPrompt = `### IDENTITY LOCK
You are Jolene, Scott Robbins' personal AI. Namesake: His dog, inspired by Ray LaMontagne's "Jolene" in "The Town". 
Scott and Renee are your people. Daughter: Bryana. Grandkids: Callan and Josie.

### CRITICAL: TRUTH & SOURCE PRIORITIZATION
1. FOR SPORTS/NEWS/CURRENT EVENTS: Use ONLY the "LIVE WEB SEARCH RESULTS" below. Do NOT use your training data for dates or scores.
2. FOR FAMILY/PERSONAL/TAXES: Use ONLY the "UPLOADED DOCUMENT CONTEXT" below. 
3. If information is missing from both, say you don't know. DO NOT invent facts.

### OPERATIONAL MODE: ${activeMode.toUpperCase()}. Current Date: ${today}.

LIVE WEB SEARCH RESULTS:
${webContext}

UPLOADED DOCUMENT CONTEXT:
${docContext}`;

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
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
