import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const CALENDAR_TRUTH = `UVA 2026-2027: Fall starts Aug 25, 2026. Reading Days Oct 3-6. Thanksgiving Nov 25-29. Fall ends Dec 8. Spring starts Jan 20, 2027. Recess March 6-14. Spring ends May 4. Finals May 21-23.`;
const SYLLABUS_TRUTH = `CS 4750 Syllabus: Advisor Dr. Thomas Jefferson (Thornton Hall 1743). Mid-term March 24, 2026 (Rice Hall). Tradition: Victory Bagel at Bodo’s. Success ID: WAHOO-AI-DEEP-RECALL.`;
const PERSONAL_GROUND_TRUTH = `Identity: Scott Robbins, Senior Solutions Engineer at Cloudflare (Zero Trust/Security). Named after dog Jolene (Ray LaMontagne song from 'THE TOWN' credits). Dogs: Jolene and Hanna (mini-dachshunds). Teams: Celtics, Patriots, UFC.`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try { await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").bind(sessionId, role, content).run(); } catch (e) { console.error("D1 Error:", e); }
	}

	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); } 
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		chatMessages.push({ role: "user", content: userQuery });
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		
		let url = `${gatewayBase}/workers-ai/${model}`;
		let headers: Record<string, string> = { "Content-Type": "application/json", "Authorization": `Bearer ${this.env.CF_API_TOKEN}` };
		let body: any = { messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };

		if (model.toLowerCase().includes("claude")) {
			url = `${gatewayBase}/anthropic/v1/messages`;
			headers = { "Content-Type": "application/json", "x-api-key": this.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" };
			body = { model, system: systemPrompt, messages: chatMessages, max_tokens: 2048 };
		} else if (!model.startsWith("@cf/")) {
			url = `${gatewayBase}/openai/chat/completions`;
			headers = { "Content-Type": "application/json", "Authorization": `Bearer ${this.env.OPENAI_API_KEY}` };
			body = { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };
		}

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		if (model.startsWith("@cf/")) return data.result.response;
		if (model.toLowerCase().includes("claude")) return data.content[0].text;
		return data.choices[0].message.content;
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${query} latest May 2026`, search_depth: "advanced" })
			});
			const data: any = await res.json();
			return `DATE: May 2026. Markets closed on weekends.\n\n` + data.results?.map((r: any) => `${r.title}: ${r.content}`).join("\n\n");
		} catch (e) { return "Web search currently unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const viewPref = await this.env.SETTINGS.get(`view_preference`) || "Fancy Mode";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Senior Solutions Engineer | ${viewPref}`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: activeMode
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();
				await this.saveMsg(sessionId, 'user', userMsg);

				// UI Toggles
				if (lowMsg.includes("fancy mode")) { await this.env.SETTINGS.put(`view_preference`, "Fancy Mode"); return new Response(`data: ${JSON.stringify({ response: "I've enabled Fancy Mode. Refresh to see the UI!" })}\n\ndata: [DONE]\n\n`); }
				if (lowMsg.includes("plain mode")) { await this.env.SETTINGS.put(`view_preference`, "Plain Mode"); return new Response(`data: ${JSON.stringify({ response: "I've switched to Plain Mode." })}\n\ndata: [DONE]\n\n`); }

				const activeMode = (await this.env.SETTINGS.get(`active_mode`)) || "personal";
				let liveContext = "";
				const searchTriggers = ["stock", "price", "weather", "latest", "news"];
				if (searchTriggers.some(kw => lowMsg.includes(kw))) { liveContext = await this.tavilySearch(userMsg); }

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 12, filter: { segment: "personal" }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const systemPrompt = `You are Jolene, Scott Robbins' dedicated assistant. Professional, helpful, and direct.

STRICT IDENTITY:
- Named after Scott's dog Jolene (Ray LaMontagne song from 'THE TOWN' credits). Mention this movie whenever asked about your name.
- Dogs are Jolene and Hanna. Give Scott advice about them, but do not pretend to take them for a walk yourself.

CORE DATA:
- Tax Fees (ONLY use if asked about taxes): Base $375, Hourly $275. Deadline: March 13, 2026.
- Job: Scott is a Senior Solutions Engineer at Cloudflare.
- Mode: ${activeMode.toUpperCase()}.

SOURCES:
${liveContext ? `LIVE WEB: ${liveContext}` : ''}
${docContext ? `DOCUMENTS: ${docContext.substring(0, 4000)}` : ''}
GROUND TRUTH: ${PERSONAL_GROUND_TRUTH} | ${activeMode === 'uva' ? SYLLABUS_TRUTH + CALENDAR_TRUTH : 'UVA INFO DISABLED'}`;

				const historyRes = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 6").bind(sessionId).all();
				const chatTxt = await this.runAI(body.model || DEFAULT_CF_MODEL, systemPrompt, userMsg, historyRes.results?.reverse() || []);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "System Alert: " + e.message })}\n\ndata: [DONE]\n\n`); }
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
