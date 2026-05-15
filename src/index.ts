import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise.",
	sarcastic: "You are a witty, snarky assistant. Use high-level sass. If Scott asks about Renee, she's probably shopping. Use emojis liberally (🥊, 🥃, 🐕, 🛍️). No dry lists.",
	cyber: "You are a Cybersecurity Elite assistant."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY:
- IDENTITY: You are an AI named Jolene, named after Scott's tan mini-dachshund. 
- THE NAMESAKE RULE: You are NOT named after Dolly Parton. Strictly forbidden. You are named after the dog; your theme song is Ray LaMontagne's "Jolene" (The Town version).
- FAMILY: Wife Renee (met 1993, Portuguese/Indian heritage), Daughter Bryana, Grandkids Callan & Josie.
- DOGS: Jolene (tan dachshund) & Hanna (black/tan).
- LOCATION: Plymouth, MA (The Pinehills). Office = Basement. Theater = Upstairs.
- FAVS: Bacardi Rum, Grandkids' favorite song "Engine #9" (The Rock Show).
`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			// Forced execution to ensure D1 increments properly
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Persistence Error:", e); }
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
		
		let provider = model.toLowerCase().includes("gpt") ? "openai" : "anthropic";
		let finalModel = provider === "openai" ? "gpt-4o" : "claude-3-opus-20240229";
		
		// DIRECT PATHING FIX
		const url = provider === "anthropic" 
			? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/v1/messages`
			: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/openai/chat/completions`;

		const headers: any = { "Content-Type": "application/json" };
		if (provider === "openai") {
			headers["Authorization"] = `Bearer ${this.env.OPENAI_API_KEY}`;
		} else {
			headers["x-api-key"] = this.env.ANTHROPIC_API_KEY;
			headers["anthropic-version"] = "2023-06-01";
		}

		const body = provider === "anthropic" 
			? { model: finalModel, system: systemPrompt, messages: chatMessages, max_tokens: 1024 }
			: { model: finalModel, messages: [{role: "system", content: systemPrompt}, ...chatMessages], max_tokens: 1024 };

		try {
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
			const data: any = await res.json();
			if (data.error) return `⚠️ ${provider.toUpperCase()} ERROR: ${data.error.message}`;
			return provider === "anthropic" ? data.content[0].text : data.choices[0].message.content;
		} catch (e) { return "I hit a snag in the wiring. Hit me again."; }
	}

	async tavilySearch(query: string) {
		try {
			// SEARCH DEPTH FIX
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY, 
					query: `${query} full fight card schedule betting odds matchups`, 
					search_depth: "advanced", 
					include_answer: true, 
					max_results: 15 
				})
			});
			const data: any = await res.json();
			return `[LIVE INTEL]\nAnswer: ${data.answer || "Refining search..."}\nSources: ${data.results?.map((r: any) => `- ${r.content}`).join("\n")}\n[/END]`;
		} catch (e) { return "Search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "sarcastic";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare SE`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				personality: personality,
				mode: "personal"
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const currentPers = await this.env.SETTINGS.get(`personality`) || "sarcastic";

				// Force D1 save for user message before AI call
				await this.saveMsg(sessionId, 'user', userMsg);

				let liveContext = "";
				if (["mma", "ufc", "fight", "card", "weather"].some(kw => userMsg.toLowerCase().includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				const systemPrompt = `### IDENTITY LOCK: 
${PERSONAL_GROUND_TRUTH}
### CONTEXT:
LIVE: ${liveContext} | MEMORY: ${docContext}
### STYLE:
${PERSONALITIES[currentPers as keyof typeof PERSONALITIES]}
- MANDATE: Named after the dog. Theme song is Ray LaMontagne's "Jolene" (The Town). Strictly NO Dolly Parton.
- MANDATE: Use emojis (🥊, 🥃, 🐕). Synthesis only, no lists.`;

				const chatTxt = await this.runAI(body.model || "opus", systemPrompt, userMsg, recentContext);
				
				// Force D1 save for assistant message
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
